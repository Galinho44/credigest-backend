import { config } from '../config.js';
import { logger } from '../logger.js';
import { paraReaisGateway } from '../utilitarios/dinheiro.js';
import { ErroDoGateway } from '../utilitarios/erros.js';

/**
 * Adaptador do gateway Asaas.
 *
 * Fluxo de Pix no Asaas (documentacao oficial):
 *   1. POST /v3/customers                    -> cria/recupera o cliente
 *   2. POST /v3/payments  (billingType=PIX)  -> cria a cobranca
 *   3. GET  /v3/payments/{id}/pixQrCode      -> pega copia-e-cola + imagem
 *
 * Detalhe que costuma morder: o passo 1 e' obrigatorio porque toda cobranca
 * do Asaas pertence a um customer. Sem ele o POST /payments volta 400.
 *
 * Erros do Asaas chegam como JSON { errors: [{ message, description }] }.
 * A funcao `traduzirErro` transforma isso em erro com mensagem util,
 * porque "HTTP 400" sozinho nao diz o que o programador precisa corrigir.
 */

/** Cliente HTTP do Asaas com timeout. */
async function chamar(metodo, caminho, corpo) {
  const url = `${config.gateway.asaas.baseUrl}${caminho}`;

  // AbortController e' o que impede uma conexao travada de segurar a
  // request do usuario para sempre. fetch sozinho espera indefinidamente.
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), config.gateway.timeoutMs);

  try {
    const resposta = await fetch(url, {
      method: metodo,
      signal: controlador.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // O Asaas autentica por header, nao por Bearer.
        access_token: config.gateway.asaas.token,
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });

    const texto = await resposta.text();
    let dados = null;
    if (texto) {
      try {
        dados = JSON.parse(texto);
      } catch {
        dados = { bruto: texto };
      }
    }

    if (!resposta.ok) {
      throw traduzirErro(resposta.status, dados, metodo, caminho);
    }

    return dados;
  } catch (erro) {
    if (erro instanceof ErroDoGateway) throw erro;
    if (erro.name === 'AbortError') {
      throw new ErroDoGateway(
        `gateway nao respondeu em ${config.gateway.timeoutMs}ms`,
        { codigo: 'GATEWAY_TIMEOUT', gateway: 'asaas', causa: erro }
      );
    }
    throw new ErroDoGateway(
      `falha de rede ao falar com o Asaas: ${erro.message}`,
      { codigo: 'GATEWAY_INDISPONIVEL', gateway: 'asaas', causa: erro }
    );
  } finally {
    clearTimeout(temporizador);
  }
}

/** Converte a resposta de erro do Asaas em ErroDoGateway com mensagem util. */
function traduzirErro(status, dados, metodo, caminho) {
  const lista = dados?.errors;
  const detalhe = Array.isArray(lista) && lista.length
    ? lista.map((e) => e.description || e.message).join('; ')
    : (dados?.bruto ? String(dados.bruto).slice(0, 200) : '');

  // 401/403 e' problema de credencial, nao de logica: mensagem diferente.
  if (status === 401 || status === 403) {
    return new ErroDoGateway(
      'Asaas recusou a credencial (ASAAS_ACCESS_TOKEN invalido ou sem permissao)',
      { codigo: 'GATEWAY_NAO_AUTORIZADO', status: 502, gateway: 'asaas', resposta: dados }
    );
  }

  return new ErroDoGateway(
    `Asaas respondeu ${status} em ${metodo} ${caminho}${detalhe ? `: ${detalhe}` : ''}`,
    { codigo: 'GATEWAY_ERRO_DE_REGRA', status: 502, gateway: 'asaas', resposta: dados }
  );
}

/** Passo 1: garante que o cliente exista no Asaas. */
async function garantirCliente({ cliente }) {
  if (cliente.id_cliente_gateway) {
    return { id: cliente.id_cliente_gateway };
  }

  const corpo = {
    name: cliente.nome,
    mobilePhone: `${cliente.ddd}${cliente.telefone}`, // Asaas quer so digitos, com DDD
  };
  if (cliente.email) corpo.email = cliente.email;
  if (cliente.documento) corpo.cpfCnpj = cliente.documento;

  const criado = await chamar('POST', '/customers', corpo);
  return { id: criado.id, corpo: criado };
}

/**
 * Passo 2: cria a cobranca Pix.
 * `externalReference` e' o nosso id de divida: e' por ele que se localiza
 * a cobranca no painel do Asaas quando algo dá errado.
 */
async function criarPagamento({ idClienteAsaas, valorCentavos, descricao, referencia, vencimento }) {
  const corpo = {
    customer: idClienteAsaas,
    billingType: 'PIX',
    value: paraReaisGateway(valorCentavos),
    dueDate: vencimento ?? new Date().toISOString().slice(0, 10),
    description: descricao.slice(0, 120),
  };
  if (referencia) corpo.externalReference = String(referencia).slice(0, 100);

  const pagamento = await chamar('POST', '/payments', corpo);
  return { id: pagamento.id, corpo: pagamento };
}

/** Passo 3: pega o "copia e cola" e a imagem do QR Code. */
async function buscarPixQrCode(idPagamento) {
  const dados = await chamar('GET', `/payments/${encodeURIComponent(idPagamento)}/pixQrCode`);
  const qr = dados?.qrCode;

  if (!qr || !qr.payload) {
    throw new ErroDoGateway(
      'Asaas criou a cobrança mas nao devolveu o QR Code Pix',
      { codigo: 'GATEWAY_QRCODE_AUSENTE', gateway: 'asaas', resposta: dados }
    );
  }

  return {
    copiaECola: qr.payload,
    // O Asaas devolve a imagem em base64 dentro do JSON. Transformar em
    // data URI e' o que o <img src> do painel consegue mostrar direto.
    qrCodeUrl: qr.encodedImage ? `data:image/png;base64,${qr.encodedImage}` : null,
    expiraEm: qr.expirationDate ?? null,
  };
}

/**
 * API publica do adaptador. Mesma forma do gateway simulado, para que o
 * servico de cobranca nao saiba (e nao precise saber) qual esta usando.
 */
export async function criarCobrancaPix({ valorCentavos, descricao, referencia, vencimento, cliente }) {
  const inicio = Date.now();
  const { id: idClienteAsaas } = await garantirCliente({ cliente });
  const { id: idPagamento } = await criarPagamento({
    idClienteAsaas,
    valorCentavos,
    descricao,
    referencia,
    vencimento,
  });
  const pix = await buscarPixQrCode(idPagamento);

  logger.info('cobranca pix criada no asaas', {
    idPagamento,
    idClienteAsaas,
    valorCentavos,
    ms: Date.now() - inicio,
  });

  return {
    id: idPagamento,
    status: 'PENDING',
    valorCentavos,
    copiaECola: pix.copiaECola,
    qrCodeUrl: pix.qrCodeUrl,
    expiraEm: pix.expiraEm,
    descricao,
    referencia,
    // O `cliente` devolvido aqui precisa ser o do GATEWAY, com o `id`
    // que o Asaas gerou. Se for o cliente local, `resultado.cliente.id`
    // fica undefined e o `id_cliente_gateway` nunca e' salvo — a proxima
    // cobranca cria o cliente DE NOVO no Asaas, duplicando o cadastro a
    // cada cobranca emitida.
    cliente: { ...cliente, id: idClienteAsaas },
    simulado: false,
  };
}

export const nome = 'asaas';