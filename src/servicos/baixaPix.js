import { banco } from '../banco/conexao.js';
import { logger } from '../logger.js';
import { gateway } from '../gateways/index.js';
import { ErroDeValidacao } from '../utilitarios/erros.js';
import { paraCentavos } from '../utilitarios/dinheiro.js';
import { normalizarStatusGateway } from '../utilitarios/statusGateway.js';

import * as eventosRepo from '../dominio/repositorios/eventosWebhook.js';
import * as cobrancasRepo from '../dominio/repositorios/cobrancas.js';

/**
 * Servico de baixa automatica via webhook.
 *
 * Este e o arquivo mais importante do projeto: ele decide que dinheiro
 * entrou. Dois Attacks contra ele:
 *
 *   1. EVENTO REPETIDO. O Asaas entrega webhook "at least once" (a
 *      documentacao oficial diz isso). O mesmo `evt_...` chega varias
 *      vezes. Baixa duas vezes = data de pagamento mudando ePossivel
 *      pagamento duplicado contabilizado.
 *
 *   2. EVENTO FORJADO. Alguem descobrir a URL do webhook e mandar
 *      `{"event":"PAYMENT_RECEIVED"}` para dar baixa numa divida que
 *      ninguem pagou. Por isso a validacao do token acontece na ROTA,
 *      antes de qualquer escrita, e e' comparacao em tempo constante.
 *
 * Como fica segura:
 *   - `eventos_webhook.id_evento` e' PRIMARY KEY. INSERT OR IGNORE
 *     devolve changes=0 na repeticao -> sabemos que ja veio.
 *   - o registro do evento e a baixa rodam na MESMA transacao: se a baixa
 *     falhar, o registro do evento tb some e o reenvio do gateway
 *     processa de novo. Nada fica preso como "ja recebido" sem ter sido
 *     processado.
 *   - `cobrancas.pago_em IS NULL` no WHERE torna o UPDATE naturalmente
 *     idempotente, mesmo fora da protecao do evento.
 *
 * Regra do dinheiro: NUNCA sobrescrever um pagamento ja confirmado com um
 * evento posterior. Confirmar dinheiro e definitivo.
 */

/** Eventos que mean "o cliente pagou". */
const EVENTOS_DE_PAGAMENTO = new Set(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED']);

/** Eventos que espelham mudanca de status sem baixa. */
const EVENTOS_DE_STATUS = new Set(['PAYMENT_UPDATED', 'PAYMENT_CREATED']);

/**
 * Processa um evento de webhook do gateway.
 *
 * @param {object} evento  corpo cru do webhook
 * @returns {{
 *   recebido: true,
 *   duplicado: boolean,
 *   evento: string,
 *   resultado: string,
 *   cobranca: object|null,
 *   mensagem: string
 * }}
 */
export function processarEvento(evento) {
  // ---------- 1. Valida o formato ----------
  validarFormato(evento);

  const gw = gateway().nome;
  const idEvento = evento.id;
  const tipo = evento.event;
  const pagamento = evento.payment ?? null;
  const idTransacaoGateway = pagamento?.id ?? null;

  // ---------- 2. Fora do que sabemos fazer: registra e segue ----------
  if (!EVENTOS_DE_PAGAMENTO.has(tipo) && !EVENTOS_DE_STATUS.has(tipo)) {
    logger.info('evento de webhook ignorado (tipo sem acao)', { tipo, id_evento: idEvento });
    return {
      recebido: true,
      duplicado: false,
      evento: tipo,
      resultado: 'IGNORADO',
      cobranca: null,
      mensagem: `evento ${tipo} nao altera baixa de divida`,
    };
  }

  // ---------- 3. Transacao: registra o evento + aplica a mudanca ----------
  //
  // Tudo junto ou nada. Se o registro do evento entrasse fora da
  // transacao e a baixa falhasse, o reenvio do gateway seria descartado
  // como duplicado e a divida ficaria pendente para sempre.
  const resultado = banco().emTransacao(() => {
    const registro = eventosRepo.registrarRecebimento({
      idEvento,
      gateway: gw,
      tipo,
      idTransacaoGateway,
    });

    if (!registro.novo) {
      return { duplicado: true, resultado: 'DUPLICADO', cobranca: null };
    }

    let cobranca = null;
    let acao;

    if (EVENTOS_DE_PAGAMENTO.has(tipo)) {
      if (!idTransacaoGateway) {
        throw new ErroDeValidacao(
          `evento ${tipo} sem payment.id: nao da para saber qual cobranca baixar`,
          { codigo: 'WEBHOOK_SEM_PAYMENT_ID' }
        );
      }

      const baixa = cobrancasRepo.registrarBaixa({
        gateway: gw,
        idTransacaoGateway,
        idPagamentoGateway: idTransacaoGateway,
        pagoEm: extrairDataPagamento(evento),
        valorPagoCentavos: extrairValorPago(pagamento),
        // Traduzido: o gateway manda 'RECEIVED'/'CONFIRMED' e o banco
        // guarda 'RECEBIDO'/'CONFIRMADO'. Gravar a string crua deixaria a
        // coluna com dois idiomas e o painel sem filtro confiável.
        statusGateway: normalizarStatusGateway(pagamento?.status) ?? 'RECEBIDO',
      });

      cobranca = baixa.cobranca;
      acao = baixa.alterada ? 'BAIXA_APLICADA' : 'JA_ESTAVA_PAGA';
    } else {
      // PAYMENT_UPDATED / PAYMENT_CREATED: so espelha o status, nunca
      // mexe em pago_em. Um evento de status NAO pode pagar divida.
      if (idTransacaoGateway) {
        cobrancasRepo.sincronizarStatusGateway({
          gateway: gw,
          idTransacaoGateway,
          statusGateway: normalizarStatusGateway(pagamento?.status) ?? 'PENDENTE',
        });
        cobranca = cobrancasRepo.buscarPorTransacaoDoGateway(gw, idTransacaoGateway);
      }
      acao = 'STATUS_SINCRONIZADO';
    }

    eventosRepo.marcarProcessado(idEvento, { resultado: acao });
    const ehDuplicado = acao === 'JA_ESTAVA_PAGA' || acao === 'DUPLICADO';
    return { duplicado: ehDuplicado, resultado: acao, cobranca };
  });

  if (resultado.duplicado) {
    logger.info('webhook duplicado ignorado', { id_evento: idEvento, evento: tipo });
  } else {
    logger.info('webhook processado', {
      id_evento: idEvento,
      evento: tipo,
      resultado: resultado.resultado,
      id_transacao_gateway: idTransacaoGateway,
      divida_id: resultado.cobranca?.divida_id ?? null,
    });
  }

  return {
    recebido: true,
    duplicado: resultado.duplicado,
    evento: tipo,
    resultado: resultado.resultado,
    cobranca: resultado.cobranca,
    mensagem: mensagensPorResultado[resultado.resultado] ?? 'processado',
  };
}

const mensagensPorResultado = {
  DUPLICADO: 'evento ja havia sido processado; nada foi alterado',
  BAIXA_APLICADA: 'divida baixada com sucesso',
  JA_ESTAVA_PAGA: 'cobranca ja estava paga; nada foi alterado',
  STATUS_SINCRONIZADO: 'status do gateway sincronizado (sem baixa)',
};

/**
 * Rejeita payload que nao tem a forma minima.
 *
 * Validar ANTES de escrever no banco: um `{}` doido nao pode criar
 * registro de evento fantasma e nem estourar com TypeError la dentro.
 */
function validarFormato(evento) {
  if (!evento || typeof evento !== 'object' || Array.isArray(evento)) {
    throw new ErroDeValidacao('corpo do webhook nao e um objeto JSON', {
      codigo: 'WEBHOOK_CORPO_INVALIDO',
    });
  }
  if (!evento.id || typeof evento.id !== 'string') {
    throw new ErroDeValidacao('webhook sem o campo "id" (id do evento)', {
      codigo: 'WEBHOOK_SEM_ID',
    });
  }
  if (!evento.event || typeof evento.event !== 'string') {
    throw new ErroDeValidacao('webhook sem o campo "event"', {
      codigo: 'WEBHOOK_SEM_EVENTO',
    });
  }
}

/**
 * Data e hora do pagamento.
 *
 * O Asaas manda `datePayment` como "AAAA-MM-DD HH:MM:SS" (sem fuso), e o
 * evento traz `dateCreated`. Prefere a do pagamento; se nao vier, usa o
 * momento da recebimento. Nunca inventa uma data que nao veio.
 */
function extrairDataPagamento(evento) {
  const bruto = evento.payment?.datePayment ?? evento.payment?.paymentDate ?? null;

  if (!bruto) return new Date().toISOString();

  const data = new Date(bruto.replace(' ', 'T') + (bruto.includes('Z') ? '' : 'Z'));
  if (Number.isNaN(data.getTime())) {
    logger.warn('data de pagamento ilegivel, usando agora', { bruto });
    return new Date().toISOString();
  }
  return data.toISOString();
}

/**
 * Valor efetivamente pago, em centavos, ou null se o gateway nao mandou.
 *
 * So converte o que veio. A conferencia contra o valor cobrado fica em
 * `conferirDivergencia`: se o gateway disser que caiu R$ 500 numa cobranca
 * de R$ 100, a baixa NAO volta (o dinheiro entrou de verdade) mas vira
 * alerta. Quem manda no saldo a Credigest, nao o gateway.
 */
function extrairValorPago(pagamento) {
  if (!pagamento || pagamento.value === null || pagamento.value === undefined) return null;

  let centavos;
  try {
    centavos = paraCentavos(pagamento.value);
  } catch {
    logger.warn('valor pago ilegivel no webhook', { value: pagamento.value });
    return null;
  }

  return centavos;
}

/**
 * Confere se o valor pago bate com o valor cobrado.
 * Chamado depois da baixa, so para gerar alerta: a baixa nao volta
 * (dinheiro entrou), mas o divergence precisa aparecer.
 */
export function conferirDivergencia(cobranca) {
  if (!cobranca?.valor_pago_centavos) return null;

  const diff = cobranca.valor_pago_centavos - cobranca.valor_centavos;
  if (diff === 0) return null;

  const alerta = {
    cobranca_id: cobranca.id,
    gateway: cobranca.gateway,
    id_transacao_gateway: cobranca.id_transacao_gateway,
    valor_cobrado_centavos: cobranca.valor_centavos,
    valor_pago_centavos: cobranca.valor_pago_centavos,
    diferenca_centavos: diff,
  };

  logger.error('valor pago difere do valor cobrado', alerta);
  return alerta;
}