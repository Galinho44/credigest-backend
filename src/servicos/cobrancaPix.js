import { banco } from '../banco/conexao.js';
import { logger } from '../logger.js';
import { gateway } from '../gateways/index.js';
import { ErroDeNegocio, ErroNaoEncontrado } from '../utilitarios/erros.js';
import { paraCentavos } from '../utilitarios/dinheiro.js';
import { normalizarStatusGateway } from '../utilitarios/statusGateway.js';

import * as clientesRepo from '../dominio/repositorios/clientes.js';
import * as dividasRepo from '../dominio/repositorios/dividas.js';
import * as cobrancasRepo from '../dominio/repositorios/cobrancas.js';

/**
 * Servico de geracao de cobranca Pix.
 *
 * Duas responsabilidades que andam juntas:
 *   1. falar com o gateway;
 *   2. persistir o resultado.
 *
 * A ordem importa. Gasta-se API do gateway (que cobra dinheiro) antes de
 * gravar? Nao. A cobranca local e gravada ANTES da chamada externa, com
 * status PENDENTE e sem id do gateway. A resposta preenche a linha.
 *
 * Por que nessa ordem: se o processo morrer no meio, sobra uma cobranca
 * PENDENTE local, que um reconciliador pode encontrar. Se fizesse o
 * contrario, sobraria um Pix emitido no gateway que a Credigest nem sabe
 * que existe - dinheiro que pode entrar sem dar baixa.
 */

/**
 * Gera (ou reaproveita) uma cobranca Pix.
 *
 * @param {object} entrada
 * @param {number} entrada.cliente_id      quem vai pagar
 * @param {number} [entrada.divida_id]     divida a quitar. Se ausente, a
 *                                         cobranca fica avulsa.
 * @param {number|string} [entrada.valor]  em reais. Se ausente e houver
 *                                         divida_id, usa o valor da divida.
 * @returns {Promise<{cobranca: object, reutilizada: boolean}>}
 */
export async function gerarCobrancaPix({ cliente_id, divida_id = null, valor = null, vencimento = null }) {
  const cliente = clientesRepo.buscarPorId(cliente_id);

  let divida = null;
  let valorCentavos;

  if (divida_id !== null && divida_id !== undefined) {
    divida = dividasRepo.buscarPorId(divida_id);

    if (divida.cliente_id !== cliente.id) {
      throw new ErroDeNegocio(
        `divida ${divida.id} pertence ao cliente ${divida.cliente_id}, nao ao ${cliente.id}`,
        { status: 422, codigo: 'DIVIDA_DE_OUTRO_CLIENTE' }
      );
    }

    if (divida.status === 'PAGO') {
      throw new ErroDeNegocio(
        `divida ${divida.id} ("${divida.descricao}") ja esta paga`,
        { status: 409, codigo: 'DIVIDA_JA_PAGA' }
      );
    }

    // ---- IDEMPOTENCIA ----
    // Ja existe Pix em aberto para esta divida? Devolve o mesmo em vez de
    // emitir outro. Sem isso, chamar a rota duas vezes gera dois Pix e o
    // cliente pode pagar os dois. O indice unico do banco tambem impede,
    // mas aqui a falha ja chega como 409 em vez de "criou e deu erro".
    const jaExistente = cobrancasRepo.buscarPixPendenteDaDivida(divida.id);
    if (jaExistente) {
      logger.info('pix ja emitido para a divida, reaproveitando', {
        divida_id: divida.id,
        cobranca_id: jaExistente.id,
      });
      return { cobranca: jaExistente, reutilizada: true };
    }

    // ---- conversao de valor (aqui sim, porque `valor` chega em reais) ----
    //
    // `divida.valor_centavos` JA esta em centavos: passar isso pelo
    // paraCentavos() multiplicava por 100 (R$ 850,00 virava R$ 85.000,00).
    // O `??` decide a origem ANTES de converter.
    valorCentavos = valor !== null && valor !== undefined
      ? paraCentavos(valor)
      : divida.valor_centavos;
  } else {
    valorCentavos = paraCentavos(valor);
  }

  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) {
    throw new ErroDeNegocio('informe o valor da cobranca, ou um divida_id', {
      status: 422,
      codigo: 'VALOR_AUSENTE',
    });
  }

  // ---- 1. Grava local ANTES de chamar o gateway ----
  const cobranca = cobrancasRepo.criar({
    divida_id: divida?.id ?? null,
    cliente_id: cliente.id,
    gateway: gateway().nome,
    valor_centavos: valorCentavos,
    status_gateway: 'PENDENTE',
  });

  // ---- 2. Chama o gateway ----
  let resultado;
  try {
    resultado = await gateway().criarCobrancaPix({
      valorCentavos,
      descricao: divida ? divida.descricao : `Cobranca avulsa - ${cliente.nome}`,
      referencia: divida ? `divida:${divida.id}` : `cobranca:${cobranca.id}`,
      vencimento: vencimento ?? divida?.vencimento ?? null,
      cliente,
    });
  } catch (erro) {
    // O gateway falhou. A linha NAO e apagada: existe um Pix possivel no
    // gateway que a Credigest nao conhece, e historico de tentativa vale
    // mais que sumir do banco.
    //
    // Mas ela e marcada como ERRO, e isso e' obrigatorio. Se ficasse
    // PENDENTE, o indice unico (que filtra status_gateway = 'PENDENTE')
    // continuaria bloqueando um novo Pix para esta divida, e o retry
    // devolveria um registro sem codigo. Com ERRO, a divida volta a ficar
    // livre para a proxima tentativa, e a linha quebrada fica visivel
    // para reconciliacao.
    marcarCobrancaComoErro(cobranca.id, erro);

    logger.error('falha ao gerar pix no gateway; cobranca local marcada como ERRO', {
      cobranca_id: cobranca.id,
      divida_id: divida?.id ?? null,
      erro: erro.message,
      codigo: erro.codigo ?? null,
    });
    throw erro;
  }

  // ---- 3. Guarda o id do gateway e o Pix ----
  // O status passa por `normalizarStatusGateway`: o gateway fala inglês
  // ("PENDING") e o banco fala português ("PENDENTE"). Gravar direto
  // quebrava o índice único de um Pix pendente por dívida, que filtra
  // exatamente por 'PENDENTE'.
  banco().db
    .prepare(
      `UPDATE cobrancas
          SET id_transacao_gateway = ?,
              status_gateway       = ?,
              atualizado_em        = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?`
    )
    .run(resultado.id, normalizarStatusGateway(resultado.status) ?? 'PENDENTE', cobranca.id);

  const atualizada = cobrancasRepo.anexarPix(cobranca.id, {
    pix_copia_e_cola: resultado.copiaECola,
    qr_code_url: resultado.qrCodeUrl ?? null,
  });

  // Se o cliente ja existia no gateway, guarda o id para nao recriar.
  if (!cliente.id_cliente_gateway && resultado.cliente?.id) {
    salvarIdDoClienteNoGateway(cliente.id, resultado.cliente.id);
  }

  logger.info('cobranca pix gerada', {
    cobranca_id: atualizada.id,
    gateway: gateway().nome,
    id_transacao_gateway: resultado.id,
    valor_centavos: valorCentavos,
    cliente_id: cliente.id,
  });

  return { cobranca: atualizada, reutilizada: false };
}

/**
 * Marca a tentativa como falha do gateway.
 *
 * Não mexe em `pago_em` em hipótese nenhuma: se por algum caminho o
 * gateway já tivesse confirmado o pagamento antes de a chamada dar erro,
 * o dinheiro entrou e a baixa é do webhook — este UPDATE só escreve o
 * espelho de status, que é consulta, não verdade.
 */
function marcarCobrancaComoErro(cobrancaId, erro) {
  try {
    banco().db
      .prepare(
        `UPDATE cobrancas
            SET status_gateway = 'ERRO',
                atualizado_em  = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?`
      )
      .run(cobrancaId);
  } catch (erroInterno) {
    // Se nem isso der, o erro original do gateway continua sendo o que
    // sobe. Este é diagnóstico.
    logger.error('nao consegui marcar a cobranca como ERRO', {
      cobranca_id: cobrancaId,
      erro_principal: erro.message,
      erro_ao_marcar: erroInterno.message,
    });
  }
}

function salvarIdDoClienteNoGateway(clienteId, idGateway) {
  try {
    banco().db.prepare('UPDATE clientes SET id_cliente_gateway = ? WHERE id = ?').run(idGateway, clienteId);
  } catch (erro) {
    // Nao e' critico: a cobranca ja foi emitida. Loga e segue.
    logger.warn('nao consegui salvar o id do cliente no gateway', {
      cliente_id: clienteId,
      idGateway,
      erro: erro.message,
    });
  }
}

/** Detalhe da cobranca, ja no formato que o painel usa. */
export function detalhar(cobrancaId) {
  const cobranca = cobrancasRepo.buscarPorId(cobrancaId);
  if (!cobranca) throw new ErroNaoEncontrado('cobranca', cobrancaId);
  return cobranca;
}

export function listar(filtros) {
  return cobrancasRepo.listar(filtros);
}