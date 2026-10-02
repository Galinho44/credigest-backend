/* =====================================================================
   Credigest — painel (JS puro, sem framework)

   Três decisões que valem explicar:

   1. NADA de innerHTML com dado do usuário. Todo texto entra por
      textContent. Se um cliente se chama "<img onerror=...>", o painel
      mostra o nome e não executa nada. Montar a tela com template string
      seria um XSS esperando alguém cadastrar um nome.

   2. Todo botão que chama a rede entra em estado "carregando" e sai
      mesmo em erro (finally). Botão que trava para sempre depois de
      uma falha é pior que botão que não existe.

   3. Falha sempre aparece na tela. `api()` lança; quem chama decide a
      mensagem. Nada de console.log silencioso.
   ===================================================================== */

const api = {
  async chamar(caminho, { metodo = 'GET', corpo } = {}) {
    const opcoes = { method: metodo, headers: {} };
    if (corpo !== undefined) {
      opcoes.headers['content-type'] = 'application/json';
      opcoes.body = JSON.stringify(corpo);
    }

    let resposta;
    try {
      resposta = await fetch(caminho, opcoes);
    } catch (erro) {
      // Servidor fora do ar: fetch nem chegou a dar status.
      throw new ErroApi('não consegui falar com o servidor. ele está rodando?', 0, 'SERVIDOR_FORA');
    }

    let dados = null;
    const texto = await resposta.text();
    if (texto) {
      try { dados = JSON.parse(texto); } catch { /* resposta não-JSON */ }
    }

    if (!resposta.ok) {
      throw new ErroApi(
        dados?.erro?.mensagem ?? `erro ${resposta.status}`,
        resposta.status,
        dados?.erro?.codigo ?? 'ERRO_DESCONHECIDO'
      );
    }
    return dados;
  },
};

class ErroApi extends Error {
  constructor(mensagem, status, codigo) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
  }
}

// ---------------------------------------------------------------------
// utilidades
// ---------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const brl = (centavos) =>
  (Number(centavos ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Aceita "850.00", "850,00", "1.200,50", "1200". */
function paraNumero(valor) {
  if (typeof valor === 'number') return valor;
  const limpo = String(valor).trim().replace(/\s/g, '');
  if (!limpo) return NaN;

  const temVirgula = limpo.includes(',');
  const normalizado = temVirgula ? limpo.replace(/\./g, '').replace(',', '.') : limpo;
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : NaN;
}

let temporizadorAviso;
function avisar(texto, tipo = 'ok') {
  const caixa = $('#aviso');
  caixa.textContent = texto;
  caixa.className = `aviso aviso--${tipo}`;
  caixa.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { caixa.hidden = true; }, tipo === 'erro' ? 7000 : 3500);
}

/** Liga o estado de carregamento a um botão e devolve a função para desfazer. */
function carregando(botao, ativo, rotulo = '…') {
  if (!botao) return () => {};
  const textoOriginal = botao.textContent;
  botao.disabled = ativo;
  if (ativo) botao.textContent = rotulo;
  return () => {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  };
}

const hoje = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------
// estado
// ---------------------------------------------------------------------

const estado = { dividas: [], clientes: [], filtro: '', gateway: 'simulado' };

// ---------------------------------------------------------------------
// telas
// ---------------------------------------------------------------------

async function carregarTudo() {
  try {
    const [saude, resumo, dividas] = await Promise.all([
      api.chamar('/api/saude'),
      api.chamar('/api/painel/resumo'),
      api.chamar('/api/dividas?limite=200'),
    ]);

    estado.gateway = saude.dados.gateway;
    $('#gateway-rotulo').textContent =
      saude.dados.gateway === 'simulado'
        ? 'modo simulado — nenhum Pix real é emitido'
        : `gateway ${saude.dados.gateway} — Pix real`;

    pintarResumo(resumo.dados);
    estado.dividas = dividas.dados ?? [];
    pintarLista();

    await carregarClientes();
  } catch (erro) {
    avisar(`Falha ao carregar: ${erro.message}`, 'erro');
  }
}

function pintarResumo(r) {
  $('#r-receber').textContent  = brl(r.a_receber_centavos);
  $('#r-recebido').textContent = brl(r.recebido_centavos);
  $('#r-atraso').textContent   = String(r.em_atraso);
  $('#r-pendentes').textContent = `${r.dividas_pendentes} de ${r.total_dividas}`;
}

async function carregarClientes() {
  const dados = await api.chamar('/api/clientes?limite=200');
  estado.clientes = dados.dados ?? [];

  const select = $('#select-cliente');
  const escolhido = select.value;
  select.replaceChildren();

  const vazio = document.createElement('option');
  vazio.value = '';
  vazio.textContent = estado.clientes.length ? 'selecione…' : 'cadastre um cliente primeiro';
  select.append(vazio);

  for (const c of estado.clientes) {
    const opt = document.createElement('option');
    opt.value = String(c.id);
    opt.textContent = `${c.nome} (${c.ddd} ${c.telefone})`;
    select.append(opt);
  }
  if (escolhido) select.value = escolhido;
}

function pintarLista() {
  const area = $('#lista');
  const vazio = $('#lista-vazia');
  area.replaceChildren();

  const filtradas = estado.filtro
    ? estado.dividas.filter((d) => d.status === estado.filtro)
    : estado.dividas;

  if (filtradas.length === 0) {
    vazio.hidden = false;
    vazio.textContent = estado.dividas.length
      ? 'nenhuma dívida com esse status.'
      : 'nenhuma dívida cadastrada ainda. crie a primeira acima.';
    return;
  }
  vazio.hidden = true;

  for (const d of filtradas) area.append(cartaoDivida(d));
}

function cartaoDivida(d) {
  const vencida = d.status === 'PENDENTE' && d.vencimento && d.vencimento < hoje();

  const el = document.createElement('article');
  el.className = `divida${d.status === 'PAGO' ? ' divida--paga' : ''}`;

  const topo = document.createElement('div');
  topo.className = 'divida__topo';

  const cliente = document.createElement('span');
  cliente.className = 'divida__cliente';
  cliente.textContent = d.cliente_nome;

  const selo = document.createElement('span');
  selo.className = `selo${d.status === 'PAGO' ? ' selo--paga' : ''}${vencida ? ' selo--vencida' : ''}`;
  selo.textContent = vencida ? 'vencida' : d.status.toLowerCase();

  topo.append(cliente, selo);

  const desc = document.createElement('p');
  desc.className = 'divida__desc';
  desc.textContent = d.descricao + (d.vencimento ? ` — vence ${d.vencimento}` : '');

  const valores = document.createElement('div');
  valores.className = 'divida__valores';

  const valor = document.createElement('span');
  valor.className = 'divida__valor';
  valor.textContent = brl(d.valor_centavos);

  const saldo = document.createElement('span');
  saldo.className = 'divida__saldo';
  saldo.textContent = d.status === 'PAGO'
    ? `pago em ${(d.pago_em ?? '').slice(0, 10)}`
    : `saldo ${brl(d.saldo_centavos)}`;

  valores.append(valor, saldo);

  const acoes = document.createElement('div');
  acoes.className = 'divida__acoes';

  if (d.status === 'PENDENTE') {
    acoes.append(
      botao('Gerar Pix', 'btn--primario btn--pequeno', (_ev, b) => gerarPix(d, b)),
      botao('WhatsApp', 'btn--whatsapp btn--pequeno', (ev, b) => enviarWhatsAppDaDivida(d, ev, b), iconeWhatsApp()),
    );
  }

  el.append(topo, desc, valores, acoes);
  return el;
}

function botao(texto, classes, aoClicar, svg = null) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${classes}`;
  if (svg) b.append(svg, document.createTextNode(texto));
  else b.textContent = texto;
  b.addEventListener('click', (ev) => aoClicar(ev, b));
  return b;
}

function iconeWhatsApp() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'btn__icone');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2m0 1.67c2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.42 5.82c0 4.54-3.7 8.25-8.25 8.25a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.11.82.83-3.04-.2-.31a8.18 8.18 0 0 1-1.26-4.39c0-4.54 3.7-8.24 8.23-8.24m4.52 3.59c-.24-.12-1.4-.69-1.62-.77-.21-.08-.37-.12-.53.12s-.61.77-.75.93c-.14.16-.27.18-.51.06-.24-.12-1-.37-1.9-1.18-.7-.63-1.18-1.4-1.32-1.64-.14-.24-.01-.37.11-.49.11-.11.24-.27.36-.41.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.53-1.27-.72-1.74-.19-.46-.39-.4-.53-.41h-.46c-.16 0-.42.06-.64.3-.22.24-.84.82-.84 2 0 1.18.86 2.32.98 2.48.12.16 1.69 2.58 4.1 3.62.57.25 1.02.39 1.37.5.58.18 1.1.16 1.52.1.46-.07 1.4-.58 1.6-1.13.2-.55.2-1.03.14-1.13-.06-.1-.21-.16-.44-.28');
  svg.append(path);
  return svg;
}

// ---------------------------------------------------------------------
// ação: gerar Pix
// ---------------------------------------------------------------------

async function gerarPix(divida, botao) {
  const parar = carregando(botao, true, 'gerando…');
  try {
    const r = await api.chamar('/api/cobrancas', {
      metodo: 'POST',
      corpo: { cliente_id: divida.cliente_id, divida_id: divida.id },
    });
    abrirModalPix(divida, r.dados);
    avisar(r.meta?.reutilizada ? 'Pix já existia para esta dívida.' : 'Pix gerado.');
    await carregarTudo();
  } catch (erro) {
    avisar(`Não consegui gerar o Pix: ${erro.message}`, 'erro');
  } finally {
    parar();
  }
}

function abrirModalPix(divida, cobranca) {
  const corpo = $('#modal-corpo');
  corpo.replaceChildren();

  const titulo = $('#modal-titulo');
  titulo.textContent = `Pix — ${divida.cliente_nome}`;

  const valor = document.createElement('p');
  valor.className = 'pix__valor';
  valor.textContent = brl(cobranca.valor_centavos);

  const descricao = document.createElement('p');
  descricao.className = 'divida__desc';
  descricao.textContent = divida.descricao;

  corpo.append(valor, descricao);

  if (cobranca.pix?.qr_code_url) {
    const img = document.createElement('img');
    img.className = 'pix__qr';
    img.src = cobranca.pix.qr_code_url;
    img.alt = `QR Code Pix de ${brl(cobranca.valor_centavos)}`;
    corpo.append(img);
  }

  const campo = document.createElement('div');
  campo.className = 'pix__campo';
  const rotulo = document.createElement('label');
  rotulo.textContent = 'Pix copia e cola';
  const copia = document.createElement('div');
  copia.className = 'pix__copia';
  copia.textContent = cobranca.pix?.copia_e_cola ?? '(o gateway não devolveu o código)';
  campo.append(rotulo, copia);
  corpo.append(campo);

  if (!copia.textContent.trim()) {
    const aviso = document.createElement('p');
    aviso.className = 'pix__aviso';
    aviso.textContent =
      'O gateway não devolveu o código copia-e-cola. Nada foi inventado aqui — verifique no painel do gateway.';
    corpo.append(aviso);
  }

  const acoes = document.createElement('div');
  acoes.className = 'pix__acoes';

  acoes.append(
    botao('Copiar código', 'btn btn--pequeno', async (ev, b) => {
      const parar = carregando(b, true, 'copiando…');
      try {
        await navigator.clipboard.writeText(copia.textContent);
        avisar('Código copiado.');
      } catch {
        avisar('Não consegui copiar. Selecione o código e copie à mão.', 'erro');
      } finally {
        parar();
      }
    }),
    botao('WhatsApp', 'btn--whatsapp btn--pequeno', (ev, b) => {
      pararModal();
      // Aqui temos o id da cobrança exato, então usa a rota da cobrança.
      enviarPorCobranca(cobranca.id, ev, b);
    }, iconeWhatsApp()),
  );

  if (estado.gateway === 'simulado') {
    acoes.append(
      botao('Simular pagamento', 'btn--pequeno', async (ev, b) => {
        const parar = carregando(b, true, 'simulando…');
        try {
          const r = await api.chamar(`/api/cobrancas/${cobranca.id}/simular-pagamento`, { metodo: 'POST' });
          const d = r.dados;
          if (d.duplicado) avisar('Essa cobrança já estava baixa.');
          else if (d.resultado === 'BAIXA_APLICADA') avisar('Baixa aplicada.');
          else avisar(`Resultado: ${d.resultado}.`);
          if (d.atencao) avisar(`Atenção: o valor pago difere do cobrado.`, 'erro');
          pararModal();
          await carregarTudo();
        } catch (erro) {
          avisar(`Falha na simulação: ${erro.message}`, 'erro');
        } finally {
          parar();
        }
      }),
    );
  }

  corpo.append(acoes);
  $('#modal-pix').showModal();
}

const pararModal = () => $('#modal-pix').close();

// ---------------------------------------------------------------------
// ação: WhatsApp
// ---------------------------------------------------------------------

/**
 * Abre a conversa já com a mensagem escrita.
 *
 * `wa.me` é a única via sem API oficial de mensagem avulsa: o link abre
 * o WhatsApp no celular do cliente com o texto pronto, e ele aperta
 * enviar. Não existe "a Credigest enviou" — existe "a Credigest
 * preparou". O texto aparece na tela para o usuário conferir antes de
 * mandar, porque o nome e o valor não podem estar errados.
 */
async function abrirWhatsApp(caminho, ev, botao) {
  ev.preventDefault?.();
  const parar = carregando(botao, true, 'abrindo…');
  try {
    const r = await api.chamar(caminho);
    window.open(r.dados.url, '_blank', 'noopener,noreferrer');
    avisar(`Mensagem pronta para ${r.dados.telefoneFormatado}.`);
  } catch (erro) {
    avisar(`Não consegui montar a mensagem: ${erro.message}`, 'erro');
  } finally {
    parar();
  }
}

const enviarPorCobranca = (cobrancaId, ev, botao) =>
  abrirWhatsApp(`/api/cobrancas/${cobrancaId}/whatsapp`, ev, botao);

const enviarWhatsAppDaDivida = (divida, ev, botao) =>
  abrirWhatsApp(`/api/dividas/${divida.id}/whatsapp`, ev, botao);

// ---------------------------------------------------------------------
// formulários
// ---------------------------------------------------------------------

$('#form-cliente').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const botao = form.querySelector('button');
  const parar = carregando(botao, true, 'salvando…');
  const f = new FormData(form);

  try {
    await api.chamar('/api/clientes', {
      metodo: 'POST',
      corpo: {
        nome: f.get('nome'),
        ddd: String(f.get('ddd')).replace(/\D/g, ''),
        telefone: String(f.get('telefone')).replace(/\D/g, ''),
        email: f.get('email') || null,
      },
    });
    form.reset();
    avisar('Cliente cadastrado.');
    await carregarTudo();
  } catch (erro) {
    avisar(`Não cadastrei: ${erro.message}`, 'erro');
  } finally {
    parar();
  }
});

$('#form-divida').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const botao = form.querySelector('button');
  const parar = carregando(botao, true, 'salvando…');
  const f = new FormData(form);
  const valor = paraNumero(f.get('valor'));

  if (!Number.isFinite(valor) || valor <= 0) {
    avisar('Valor inválido. Use 850,00 ou 850.00.', 'erro');
    parar();
    return;
  }

  try {
    await api.chamar('/api/dividas', {
      metodo: 'POST',
      corpo: {
        cliente_id: Number(f.get('cliente_id')),
        descricao: f.get('descricao'),
        valor: valor,
        vencimento: f.get('vencimento') || null,
      },
    });
    form.reset();
    avisar('Dívida criada.');
    await carregarTudo();
  } catch (erro) {
    avisar(`Não criei a dívida: ${erro.message}`, 'erro');
  } finally {
    parar();
  }
});

for (const ficha of document.querySelectorAll('.ficha')) {
  ficha.addEventListener('click', () => {
    document.querySelector('.ficha--ativa')?.classList.remove('ficha--ativa');
    ficha.classList.add('ficha--ativa');
    estado.filtro = ficha.dataset.filtro;
    pintarLista();
  });
}

$('#modal-fechar').addEventListener('click', pararModal);

// ---------------------------------------------------------------------
// início
// ---------------------------------------------------------------------
carregarTudo();