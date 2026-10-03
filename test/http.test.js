import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { silenciarLogs, usarBancoDeTeste } from './helpers/banco.js';
import { config } from '../src/config.js';
import { criarAplicacao } from '../src/app.js';
import { conectar } from '../src/banco/conexao.js';
import { migrar } from '../src/banco/migrar.js';
import { simulado } from '../src/gateways/index.js';
import { gerarCobrancaPix } from '../src/servicos/cobrancaPix.js';

silenciarLogs();

/*
 * Testes sobre o HTTP de verdade: sobe o servidor numa porta livre e
 * fala com ele por fetch. Mockar a camada HTTP aqui não faria sentido —
 * justamente o que está em risco é a autenticação do webhook, e ela só
 * existe no header HTTP.
 */

const TOKEN = 'a'.repeat(48);

let servidor;
let base;
let ctx;

before(async () => {
  config.webhook.token = TOKEN;
  config.caminhoBanco = ':memory:';
  migrar(':memory:');
  servidor = criarAplicacao();

  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  // `close()` sozinho NÃO encerra o processo: o pool de sockets do
  // `fetch` (undici) mantém conexões abertas para reaproveitar, e o Node
  // espera elas terminarem. Sem `closeAllConnections()`, a suíte passa
  // mas o processo fica pendurado para sempre.
  await new Promise((resolve) => {
    servidor.close(resolve);
    servidor.closeAllConnections();
  });
  conectar().fechar();
  config.webhook.token = null;
});

beforeEach(() => {
  // Cada teste recomeça o banco: sem isso o total acumulado do resumo
  // quebraria as asserções.
  const db = conectar(':memory:');
  ctx = { banco: db.db };
  db.db.exec('DELETE FROM eventos_webhook; DELETE FROM cobrancas; DELETE FROM dividas; DELETE FROM clientes;');
});

async function postar(caminho, corpo, { token = TOKEN, tipo = 'application/json' } = {}) {
  return fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: {
      'content-type': tipo,
      ...(token === null ? {} : { 'asaas-access-token': token }),
    },
    body: JSON.stringify(corpo),
  });
}

/** Cria cliente + divida + Pix e devolve os ids. */
async function cenarioComPix(valor = 850) {
  const c = await postar('/api/clientes', {
    nome: 'Joao Teste', ddd: '11', telefone: '987654321',
  });
  const cliente = (await c.json()).dados;

  const d = await postar('/api/dividas', {
    cliente_id: cliente.id, descricao: 'Parcela 1/1', valor,
  });
  const divida = (await d.json()).dados;

  const p = await postar('/api/cobrancas', { cliente_id: cliente.id, divida_id: divida.id });
  const pJson = await p.json();

  return { cliente, divida, cobranca: pJson.dados, statusPix: p.status };
}

function eventoDePagamento(idTransacao, valor = 850, idEvento = 'evt_http_1') {
  return simulado.montarEventoPagamento({ idCobranca: idTransacao, status: 'RECEIVED', valor, idEvento });
}

// =====================================================================
describe('servidor: basico', () => {
  test('health check responde com o gateway em uso', async () => {
    const r = await fetch(`${base}/api/saude`);
    assert.equal(r.status, 200);
    // Mesmo envelope das outras rotas: o painel faz `saude.dados.gateway`.
    const { dados } = await r.json();
    assert.equal(dados.ok, true);
    assert.equal(dados.gateway, 'simulado');
  });

test('health check também respeita 405, como toda rota', async () => {
    // O health check vive fora do roteador, então não ganha 405 de graça.
    // Se ele responder 200 em POST, o painel ganha um atalho fantasma que
    // some no dia em que alguém mover a rota para dentro do /api/.
    const r = await fetch(`${base}/api/saude`, { method: 'POST' });
    assert.equal(r.status, 405);
    assert.deepEqual((await r.json()).erro.detalhes.permitidos, ['GET']);
  });

  test('rota inexistente é 404 com código', async () => {
    const r = await fetch(`${base}/api/nao-existe`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).erro.codigo, 'NAO_ENCONTRADO');
  });

  test('GET em rota que só existe para POST é 405, não 404', async () => {
    // A diferença importa para quem consome a API: 404 = não existe,
    // 405 = existe mas não posso fazer isso aqui.
    const r = await fetch(`${base}/api/cobrancas/1/simular-pagamento`);
    assert.equal(r.status, 405);
    const corpo = await r.json();
    assert.equal(corpo.erro.codigo, 'METODO_NAO_PERMITIDO');
    assert.deepEqual(corpo.erro.detalhes.permitidos, ['POST']);
  });

  test('JSON quebrado é 400, não 500', async () => {
    const r = await fetch(`${base}/api/clientes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ isso nao e json',
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).erro.codigo, 'JSON_INVALIDO');
  });

  test('content-type errado é 415', async () => {
    const r = await postar('/api/clientes', { nome: 'X' }, { tipo: 'text/plain' });
    assert.equal(r.status, 415);
    assert.equal((await r.json()).erro.codigo, 'CONTENT_TYPE_INVALIDO');
  });

  test('campo obrigatório ausente é 422 dizendo quais', async () => {
    // 422 e nao 400: a sintaxe do JSON estava boa, quem errou foi o
    // conteudo. A distincao importa para quem consome a API — 400
    // significa "nem deu para ler", 422 significa "li e não faz sentido".
    const r = await postar('/api/clientes', { nome: 'Sem Telefone' });
    assert.equal(r.status, 422);
    const corpo = await r.json();
    assert.equal(corpo.erro.codigo, 'CAMPOS_OBRIGATORIOS');
    assert.deepEqual(corpo.erro.detalhes.campos.sort(), ['ddd', 'telefone']);
  });

  test('telefone inválido é 422 com causa clara', async () => {
    const r = await postar('/api/clientes', { nome: 'Teste', ddd: '11', telefone: '123' });
    assert.equal(r.status, 422);
    assert.ok(/telefone/i.test((await r.json()).erro.mensagem));
  });

  test('id não numérico é 422', async () => {
    const r = await fetch(`${base}/api/clientes/abc`);
    assert.equal(r.status, 422);
    assert.equal((await r.json()).erro.codigo, 'ID_INVALIDO');
  });

  test('não vaza o conteúdo do .env por travessia de caminho', async () => {
    // Sem a checagem de prefixo, isto devolveria o arquivo de token.
    const r = await fetch(`${base}/../.env`);
    assert.ok(r.status === 404 || r.status === 400, `esperava 404, veio ${r.status}`);
    const corpo = await r.text();
    assert.ok(!corpo.includes('ASAAS'), 'o .env não pode aparecer na resposta');
  });
});

// =====================================================================
describe('cadastro pela API', () => {
  test('cria cliente e dívida, com valores em centavos', async () => {
    const { cliente, divida, cobranca, statusPix } = await cenarioComPix(850.50);

    assert.ok(cliente.id > 0);
    assert.equal(divida.valor_centavos, 85050, 'R$ 850,50 tem que virar 85050 centavos');
    assert.equal(cobranca.valor_centavos, 85050);
    assert.equal(statusPix, 201);
    assert.ok(cobranca.pix.copia_e_cola.length > 20);
  });

  test('cliente com e-mail inválido é recusado', async () => {
    const r = await postar('/api/clientes', {
      nome: 'Teste', ddd: '11', telefone: '987654321', email: 'nao-e-email',
    });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).erro.codigo, 'EMAIL_INVALIDO');
  });

  test('dívida de cliente inexistente é 404', async () => {
    const r = await postar('/api/dividas', { cliente_id: 9999, descricao: 'Xyz', valor: 10 });
    assert.equal(r.status, 404);
  });

  test('resumo do painel bate com o que foi criado', async () => {
    await cenarioComPix(100);
    const r = await fetch(`${base}/api/painel/resumo`);
    const { dados } = await r.json();
    assert.equal(dados.total_dividas, 1);
    assert.equal(dados.a_receber_centavos, 10000);
    assert.equal(dados.recebido_centavos, 0);
  });
});

// =====================================================================
describe('webhook: autenticacao', () => {
  test('SEM token é 401 e nada é baixado', async () => {
    const { divida, cobranca } = await cenarioComPix();
    const evento = eventoDePagamento(cobranca.id_transacao_gateway);

    const r = await postar('/api/webhooks/pix', evento, { token: null });

    assert.equal(r.status, 401);
    assert.equal((await r.json()).erro.codigo, 'TOKEN_INVALIDO');

    // O ponto que importa: a dívida continua pendente.
    const d = await (await fetch(`${base}/api/dividas/${divida.id}`)).json();
    assert.equal(d.dados.status, 'PENDENTE');
  });

  test('401 é idêntico com e sem header (não vaza oráculo)', async () => {
    await cenarioComPix();

    const semHeader = await postar('/api/webhooks/pix', { id: 'e', event: 'X' }, { token: null });
    const comErrado = await postar('/api/webhooks/pix', { id: 'e', event: 'X' }, { token: 'b'.repeat(48) });
    const comCurto = await postar('/api/webhooks/pix', { id: 'e', event: 'X' }, { token: 'curto' });

    assert.equal(semHeader.status, 401);
    assert.equal(comErrado.status, 401);
    assert.equal(comCurto.status, 401);

    // Se a mensagem dissesse "header ausente" ou "token curto", o
    // atacante saberia o formato válido sem tentar nada.
    const a = await semHeader.json();
    const b = await comErrado.json();
    const c = await comCurto.json();
    assert.equal(a.erro.mensagem, b.erro.mensagem);
    assert.equal(a.erro.mensagem, c.erro.mensagem);
    assert.equal(a.erro.codigo, c.erro.codigo);
  });

  test('com token correto, payload inválido passa a ser erro de payload', async () => {
    await cenarioComPix();
    // Com o token certo a autenticação deixa de ser o problema: um corpo
    // sem "id" tem de virar 400, não 401. Se voltasse 401 aqui, a
    // validação do token estaria curto-circuitando a leitura.
    const r = await postar('/api/webhooks/pix', {});
    assert.equal(r.status, 400);
    assert.equal((await r.json()).erro.codigo, 'WEBHOOK_SEM_ID');
  });

  test('token ERRADO é 401', async () => {
    await cenarioComPix();
    const r = await postar('/api/webhooks/pix', { id: 'e', event: 'PAYMENT_RECEIVED' }, { token: 'b'.repeat(48) });
    assert.equal(r.status, 401);
  });

  test('com token correto, baixa funciona', async () => {
    const { divida, cobranca } = await cenarioComPix(850);
    const r = await postar('/api/webhooks/pix', eventoDePagamento(cobranca.id_transacao_gateway, 850));

    assert.equal(r.status, 200);
    const corpo = await r.json();
    assert.equal(corpo.recebido, true);
    assert.equal(corpo.resultado, 'BAIXA_APLICADA');
    assert.equal(corpo.duplicado, false);

    const d = await (await fetch(`${base}/api/dividas/${divida.id}`)).json();
    assert.equal(d.dados.status, 'PAGO');
  });
});

// =====================================================================
describe('webhook: comportamento', () => {
  test('reenvio do mesmo evento devolve 200 e duplicado=true', async () => {
    const { divida, cobranca } = await cenarioComPix();
    const evento = eventoDePagamento(cobranca.id_transacao_gateway);

    await postar('/api/webhooks/pix', evento);
    const segunda = await postar('/api/webhooks/pix', evento);

    // 200 nos dois casos: o gateway só para de reenviar em 2xx.
    assert.equal(segunda.status, 200);
    assert.equal((await segunda.json()).duplicado, true);

    const d = await (await fetch(`${base}/api/dividas/${divida.id}`)).json();
    assert.equal(d.dados.valor_pago_centavos, 85000, 'não pode contar duas vezes');
  });

  test('payload inválido é 400 (o gateway deve parar de tentar)', async () => {
    await cenarioComPix();
    const r = await postar('/api/webhooks/pix', { event: 'PAYMENT_RECEIVED' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).erro.codigo, 'WEBHOOK_SEM_ID');
  });

  test('pagamento desconhecido é 200 com aviso (não gera retentativa)', async () => {
    await cenarioComPix();
    const r = await postar('/api/webhooks/pix', eventoDePagamento('pay_alheio', 10, 'evt_alheio'));

    assert.equal(r.status, 200);
    assert.equal((await r.json()).resultado, 'PAGAMENTO_DESCONHECIDO');
  });

  test('divergência de valor volta no corpo da resposta', async () => {
    const { cobranca } = await cenarioComPix(850);
    // Cliente pagou 800 de uma dívida de 850.
    const r = await postar('/api/webhooks/pix', eventoDePagamento(cobranca.id_transacao_gateway, 800));

    const corpo = await r.json();
    assert.equal(corpo.resultado, 'BAIXA_APLICADA');
    assert.ok(corpo.atencao, 'a divergência precisa ser visível na resposta');
    assert.equal(corpo.atencao.diferenca_centavos, -5000);
  });

  test('evento sem pagamento não derruba o processo', async () => {
    await cenarioComPix();
    const r = await postar('/api/webhooks/pix', { id: 'evt_vazio', event: 'PAYMENT_RECEIVED' });
    assert.equal(r.status, 400);
  });
});

// =====================================================================
describe('WhatsApp pela API', () => {
  test('monta link wa.me com a mensagem preenchida', async () => {
    const { divida, cobranca } = await cenarioComPix(850);

    const r = await fetch(`${base}/api/cobrancas/${cobranca.id}/whatsapp`);
    assert.equal(r.status, 200);
    const { dados } = await r.json();

    assert.equal(dados.e164, '5511987654321');
    assert.match(dados.url, /^https:\/\/wa\.me\/5511987654321\?text=/);

    const texto = decodeURIComponent(dados.url.split('?text=')[1]);
    assert.match(texto, /Joao Teste/);
    assert.match(texto, /R\$ 850,00/);
    assert.match(texto, /Credigest/);
    assert.match(texto, /Parcela 1\/1/);
    assert.ok(texto.includes(cobranca.pix.copia_e_cola), 'o código Pix tem que estar na mensagem');
  });

  test('atalho pela dívida acha o Pix em aberto', async () => {
    const { divida } = await cenarioComPix(1200);
    const r = await fetch(`${base}/api/dividas/${divida.id}/whatsapp`);
    assert.equal(r.status, 200);
    assert.match(decodeURIComponent((await r.json()).dados.url), /R\$ 1\.200,00/);
  });

  test('divida sem Pix em aberto é 409 com instrução', async () => {
    const c = await postar('/api/clientes', { nome: 'Sem Pix', ddd: '21', telefone: '998877665' });
    const cliente = (await c.json()).dados;
    const d = await postar('/api/dividas', { cliente_id: cliente.id, descricao: 'Ainda sem Pix', valor: 50 });
    const divida = (await d.json()).dados;

    const r = await fetch(`${base}/api/dividas/${divida.id}/whatsapp`);
    assert.equal(r.status, 409);
    assert.equal((await r.json()).erro.codigo, 'PIX_NAO_GERADO');
  });

  test('cobranca JA PAGA nao gera link de WhatsApp', async () => {
    // Regressao de produto achada no teste ponta a ponta contra o
    // servidor de verdade: o painel gerava link para cobranca quitada,
    // e o cliente recebia "pague R$ 123,45" de algo que ja tinha pago.
    const { divida, cobranca } = await cenarioComPix();

    const antes = await fetch(`${base}/api/cobrancas/${cobranca.id}/whatsapp`);
    assert.equal(antes.status, 200);
    assert.ok((await antes.json()).dados.url.startsWith('https://wa.me/55'));

    const sim = await (await postar(`/api/cobrancas/${cobranca.id}/simular-pagamento`, {})).json();
    assert.equal(sim.dados.resultado, 'BAIXA_APLICADA');

    // Depois de pagar, tem de recusar nos DOIS atalhos do painel.
    for (const caminho of [
      `/api/cobrancas/${cobranca.id}/whatsapp`,
      `/api/dividas/${divida.id}/whatsapp`,
    ]) {
      const r = await fetch(`${base}${caminho}`);
      assert.equal(r.status, 409, `${caminho} deveria recusar`);
      assert.equal((await r.json()).erro.codigo, 'COBRANCA_JA_PAGA');
    }
  });

  test('simulação de pagamento aplica a baixa', async () => {
    const { divida, cobranca } = await cenarioComPix(670);

    const r = await postar(`/api/cobrancas/${cobranca.id}/simular-pagamento`, {});
    assert.equal(r.status, 200);
    assert.equal((await r.json()).dados.resultado, 'BAIXA_APLICADA');

    const d = await (await fetch(`${base}/api/dividas/${divida.id}`)).json();
    assert.equal(d.dados.status, 'PAGO');
  });
});

// =====================================================================
describe('painel estatico', () => {
  test('serve o index.html', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const html = await r.text();
    assert.match(html, /Credigest/);
    assert.match(html, /estilo\.css/);
  });

  test('serve o css e o js do painel', async () => {
    const css = await fetch(`${base}/estilo.css?v=1`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const js = await fetch(`${base}/app.js?v=1`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  });
});