import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { usarBancoDeTeste, silenciarLogs } from './helpers/banco.js';
import * as clientesRepo from '../src/dominio/repositorios/clientes.js';
import * as dividasRepo from '../src/dominio/repositorios/dividas.js';
import * as cobrancasRepo from '../src/dominio/repositorios/cobrancas.js';
import * as eventosRepo from '../src/dominio/repositorios/eventosWebhook.js';
import { gerarCobrancaPix, detalhar } from '../src/servicos/cobrancaPix.js';
import { processarEvento, conferirDivergencia } from '../src/servicos/baixaPix.js';
import { simulado } from '../src/gateways/index.js';
import { paraCentavos } from '../src/utilitarios/dinheiro.js';

silenciarLogs();

/*
 * Este arquivo é o coração do projeto: o caminho que o dinheiro
 * percorre, de ponta a ponta.
 *
 *   divida -> gera Pix -> cliente paga -> gateway manda webhook -> baixa
 *
 * Os testes que importam:
 *   - o webhook chega DUAS vezes (at least once) e nao pode baixar duas;
 *   - o valor pago diferente do cobrado vira alerta, nao silencio;
 *   - evento forjado sem pagamento conhecido nao quebra o sistema;
 *   - o Pix pendente nao bloqueia o proximo.
 */

let ctx;

beforeEach(() => { ctx = usarBancoDeTeste(); });
afterEach(() => { ctx.restaurar(); });

function criarCliente(over = {}) {
  return clientesRepo.criar({
    nome: 'Maria Aparecida Souza',
    ddd: '11',
    telefone: '987654321',
    email: null,
    ...over,
  });
}

function criarDivida(clienteId, valor = '850.00', descricao = 'Parcela 1/12') {
  return dividasRepo.criar({
    cliente_id: clienteId,
    descricao,
    valor_centavos: paraCentavos(valor),
    vencimento: null,
  });
}

// =====================================================================
describe('gerar Pix', () => {
  test('cria cobranca com valor EXATO da divida (sem multiplicar por 100)', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id, '850.00');

    const { cobranca, reutilizada } = await gerarCobrancaPix({
      cliente_id: cliente.id,
      divida_id: divida.id,
    });

    assert.equal(reutilizada, false);
    // O bug antigo: 85000 centavos viravam 8.500.000. Este assert é o que
    // impediria a conversão de voltar.
    assert.equal(cobranca.valor_centavos, 85000);
    assert.ok(cobranca.pix_copia_e_cola?.length > 20, 'deve trazer o código copia-e-cola');
    assert.equal(cobranca.status, 'PENDENTE');
    assert.equal(cobranca.pago_em, null);
  });

  test('o codigo Pix gerado carrega o valor correto', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id, '42.07');

    const { cobranca } = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id });

    // O payload EMV do Pix traz o valor no campo 54 ("54" + tamanho +
    // valor). Aqui: 54 05 42.07 — R$ 42,07. Se a conversão de dinheiro
    // tivesse bug, o campo viria com outro número.
    assert.match(cobranca.pix_copia_e_cola, /540542\.07/);
  });

  test('segunda chamada reaproveita o Pix em vez de emitir outro', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id);

    const primeira = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id });
    const segunda = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id });

    assert.equal(segunda.reutilizada, true);
    assert.equal(segunda.cobranca.id, primeira.cobranca.id);
    assert.equal(primeira.cobranca.id_transacao_gateway, segunda.cobranca.id_transacao_gateway);

    assert.equal(
      cobrancasRepo.listar({ limite: 50 }).filter((c) => c.divida_id === divida.id).length,
      1
    );
  });

  test('recusa gerar Pix para divida ja paga', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id);
    const { cobranca } = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id });

    processarEvento(
      simulado.montarEventoPagamento({ idCobranca: cobranca.id_transacao_gateway, valor: 850 })
    );

    await assert.rejects(
      () => gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id }),
      /ja esta paga/i
    );
  });

  test('recusa divida de outro cliente', async () => {
    const a = criarCliente({ nome: 'Cliente A', ddd: '11', telefone: '987654321' });
    const b = criarCliente({ nome: 'Cliente B', ddd: '21', telefone: '998877665' });
    const divida = criarDivida(a.id);

    await assert.rejects(
      () => gerarCobrancaPix({ cliente_id: b.id, divida_id: divida.id }),
      /pertence ao cliente/i
    );
  });

  test('registro de tentativa FALHADA não bloqueia nova tentativa', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id);

    // Reproduz o que sobra depois de uma falha de rede no gateway: a
    // linha existe (porque existe um Pix possível lá fora que a
    // Credigest não conhece), mas está marcada como ERRO e não tem
    // código copia-e-cola.
    //
    // Não dá para "quebrar" o gateway aqui: o namespace de um módulo ES
    // é congelado e não aceita monkey-patch. E o invariante que importa
    // não é a quebra — é o estado deixado para trás.
    const falhada = cobrancasRepo.criar({
      divida_id: divida.id,
      cliente_id: cliente.id,
      gateway: 'simulado',
      id_transacao_gateway: 'pay_orfao_sem_resposta',
      valor_centavos: 85000,
      status_gateway: 'FALHOU',
    });
    assert.equal(falhada.pix_copia_e_cola, null);

    // Sem a correção, o índice único e o filtro do serviço aceitariam
    // esta linha como "Pix pendente em aberto" e devolveriam um código
    // vazio — ou o INSERT bateria no índice e a divida travava para
    // sempre.
    assert.equal(cobrancasRepo.buscarPixPendenteDaDivida(divida.id), null);

    const { cobranca, reutilizada } = await gerarCobrancaPix({
      cliente_id: cliente.id,
      divida_id: divida.id,
    });

    assert.equal(reutilizada, false, 'não pode reaproveitar a tentativa quebrada');
    assert.ok(cobranca.pix_copia_e_cola, 'a nova tentativa deve trazer Pix de verdade');
    assert.equal(cobranca.valor_centavos, 85000);
  });
});

// =====================================================================
describe('baixa via webhook', () => {
  test('baixa a divida e marca como paga', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id, '850.00');
    const { cobranca } = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id });

    const evento = simulado.montarEventoPagamento({
      idCobranca: cobranca.id_transacao_gateway,
      valor: 850,
    });
    const r = processarEvento(evento);

    assert.equal(r.resultado, 'BAIXA_APLICADA');
    assert.equal(r.duplicado, false);

    const depois = detalhar(cobranca.id);
    assert.equal(depois.status, 'PAGO');
    assert.ok(depois.pago_em, 'deve ter data de pagamento');
    assert.equal(depois.valor_pago_centavos, 85000);

    const dividaDepois = dividasRepo.buscarPorId(divida.id);
    assert.equal(dividaDepois.status, 'PAGO');
    assert.equal(dividaDepois.saldo_centavos, 0);
  });

  test('evento repetido nao baixa duas vezes (idempotência)', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id);
    const { cobranca } = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id });

    const evento = simulado.montarEventoPagamento({
      idCobranca: cobranca.id_transacao_gateway,
      valor: 850,
    });

    const primeira = processarEvento(evento);
    const pagoEmOriginal = detalhar(cobranca.id).pago_em;

    const segunda = processarEvento(evento);
    const terceira = processarEvento(evento);

    assert.equal(primeira.resultado, 'BAIXA_APLICADA');
    assert.equal(segunda.resultado, 'DUPLICADO');
    assert.equal(terceira.duplicado, true);

    // A data de pagamento não pode mudar: se mudasse, o relatório do mês
    // mudaria junto.
    assert.equal(detalhar(cobranca.id).pago_em, pagoEmOriginal);

    const eventos = eventosRepo.listar();
    assert.equal(eventos.length, 1, 'o mesmo id de evento só pode ser registrado uma vez');
  });

  test('dois eventos DIFERENTES do mesmo pagamento também não dobram a baixa', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id);
    const { cobranca } = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id });

    // O Asaas pode mandar PAYMENT_RECEIVED e depois PAYMENT_CONFIRMED
    // como eventos distintos. São o mesmo dinheiro.
    processarEvento(
      simulado.montarEventoPagamento({
        idCobranca: cobranca.id_transacao_gateway,
        status: 'RECEIVED',
        valor: 850,
      })
    );
    const segunda = processarEvento(
      simulado.montarEventoPagamento({
        idCobranca: cobranca.id_transacao_gateway,
        status: 'CONFIRMED',
        valor: 850,
      })
    );

    assert.equal(segunda.resultado, 'JA_ESTAVA_PAGA');

    const dividaDepois = dividasRepo.buscarPorId(divida.id);
    assert.equal(dividaDepois.valor_pago_centavos, 85000, 'não pode contar o valor duas vezes');
  });

  test('evento de status NÃO paga a divida', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id);
    const { cobranca } = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id });

    // PAYMENT_UPDATED é evento que só espelha mudança de estado. Se ele
    // pagasse a dívida, qualquer "atualizei o status no painel do
    // gateway" viraria confirmação de pagamento.
    const r = processarEvento({
      id: 'evt_status_apenas',
      event: 'PAYMENT_UPDATED',
      dateCreated: '2026-01-01 10:00:00',
      payment: { id: cobranca.id_transacao_gateway, status: 'PENDING', value: 850 },
    });

    assert.equal(r.resultado, 'STATUS_SINCRONIZADO');
    assert.equal(detalhar(cobranca.id).status, 'PENDENTE');
    assert.equal(detalhar(cobranca.id).pago_em, null);
    assert.equal(detalhar(cobranca.id).status_gateway, 'PENDENTE');
  });

  test('evento sobre pagamento desconhecido é recusado com 404, sem mexer no banco', () => {
    // Um pagamento de outro sistema na mesma conta do Asaas é normal. O
    // `processarEvento` propaga o 404 e a ROTA é quem responde 200 para
    // o gateway não ficar reenviando. Aqui se confere a exceção crua.
    assert.throws(
      () => processarEvento(
        simulado.montarEventoPagamento({ idCobranca: 'pay_que_nao_existe', valor: 10 })
      ),
      (erro) => erro.status === 404 && erro.codigo === 'NAO_ENCONTRADO'
    );

    // A transação inteira voltou: nem o evento ficou registrado.
    assert.equal(eventosRepo.listar().length, 0);
  });

  test('payload sem id é recusado antes de tocar no banco', () => {
    assert.throws(() => processarEvento({ event: 'PAYMENT_RECEIVED' }), /campo "id"/i);
    assert.throws(() => processarEvento({ id: 'evt_1' }), /campo "event"/i);
    assert.throws(() => processarEvento(null), /objeto JSON/i);
    assert.throws(() => processarEvento('texto'), /objeto JSON/i);
    assert.throws(() => processarEvento([]), /objeto JSON/i);

    assert.equal(eventosRepo.listar().length, 0, 'nada pode ter sido gravado');
  });

  test('evento de pagamento sem payment.id é recusado', () => {
    assert.throws(
      () => processarEvento({ id: 'evt_2', event: 'PAYMENT_RECEIVED', payment: {} }),
      /sem payment\.id/i
    );
    assert.equal(eventosRepo.listar().length, 0);
  });

  test('baixa que falha não deixa o evento marcado como processado', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id);
    const { cobranca } = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id });

    // Sabota o UPDATE depois que o INSERT do evento aconteceu dentro da
    // transação. O rollback tem que levar o registro do evento junto.
    const db = ctx.banco;
    const original = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/UPDATE cobrancas/.test(sql)) throw new Error('banco caiu no meio');
      return original(sql);
    };

    const evento = simulado.montarEventoPagamento({
      idCobranca: cobranca.id_transacao_gateway,
      valor: 850,
    });
    assert.throws(() => processarEvento(evento), /banco caiu/);

    db.prepare = original;

    assert.equal(eventosRepo.jaRecebido(evento.id), false, 'o evento não pode ficar preso como recebido');
    assert.equal(detalhar(cobranca.id).status, 'PENDENTE');

    // E o reenvio do gateway funciona.
    const r = processarEvento(evento);
    assert.equal(r.resultado, 'BAIXA_APLICADA');
  });
});

// =====================================================================
describe('divergência de valor', () => {
  test('pagamento menor que o cobrado gera alerta', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id, '850.00');
    const { cobranca } = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id });

    processarEvento(
      simulado.montarEventoPagamento({ idCobranca: cobranca.id_transacao_gateway, valor: 800 })
    );

    const baixa = detalhar(cobranca.id);
    const alerta = conferirDivergencia(baixa);

    assert.ok(alerta, 'divergência de R$ 50,00 precisa aparecer');
    assert.equal(alerta.diferenca_centavos, -5000);
    assert.equal(alerta.valor_cobrado_centavos, 85000);

    // O dinheiro entrou: a baixa NÃO volta. Rejeitar o evento deixaria a
    // dívida pendente mesmo com o Pix pago.
    assert.equal(baixa.status, 'PAGO');
  });

  test('pagamento no valor exato não gera alerta', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id, '850.00');
    const { cobranca } = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id });

    processarEvento(
      simulado.montarEventoPagamento({ idCobranca: cobranca.id_transacao_gateway, valor: 850 })
    );

    assert.equal(conferirDivergencia(detalhar(cobranca.id)), null);
  });

  test('pagamento a maior não deixa a divida com saldo negativo', async () => {
    const cliente = criarCliente();
    const divida = criarDivida(cliente.id, '100.00');
    const { cobranca } = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: divida.id });

    processarEvento(
      simulado.montarEventoPagamento({ idCobranca: cobranca.id_transacao_gateway, valor: 150 })
    );

    const d = dividasRepo.buscarPorId(divida.id);
    assert.equal(d.status, 'PAGO');
    assert.equal(d.saldo_centavos, 0, 'saldo negativo seria "a Credigest deve ao cliente"');
    assert.equal(d.valor_pago_centavos, 15000);
  });
});

// =====================================================================
describe('resumo do painel', () => {
  test('soma só o que foi realmente pago', async () => {
    const cliente = criarCliente();
    const p1 = criarDivida(cliente.id, '850.00', 'Paga');
    const p2 = criarDivida(cliente.id, '420.50', 'Pendente');
    const p3 = criarDivida(cliente.id, '1200.00', 'Paga 2');

    const c1 = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: p1.id });
    const c3 = await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: p3.id });
    await gerarCobrancaPix({ cliente_id: cliente.id, divida_id: p2.id });

    processarEvento(
      simulado.montarEventoPagamento({ idCobranca: c1.cobranca.id_transacao_gateway, valor: 850 })
    );
    processarEvento(
      simulado.montarEventoPagamento({ idCobranca: c3.cobranca.id_transacao_gateway, valor: 1200 })
    );

    const r = dividasRepo.resumo();

    assert.equal(r.total_dividas, 3);
    assert.equal(r.dividas_pagas, 2);
    assert.equal(r.dividas_pendentes, 1);
    assert.equal(r.total_centavos, 247050);   // 850 + 420,50 + 1200
    assert.equal(r.recebido_centavos, 205000); // 850 + 1200
    // O bug da view 002: Pix pendente contava como pago e isto dava 0.
    assert.equal(r.a_receber_centavos, 42050); // só a pendente
  });

  test('divida sem nenhuma cobrança já aparece como pendente', () => {
    const cliente = criarCliente();
    criarDivida(cliente.id, '99.90');

    const d = dividasRepo.buscarPorId(dividasRepo.listar({ limite: 1 })[0].id);
    assert.equal(d.status, 'PENDENTE');
    assert.equal(d.valor_pago_centavos, 0);
    assert.equal(d.saldo_centavos, 9990);
  });
});