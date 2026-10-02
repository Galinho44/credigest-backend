import { formatarBrasileiro } from '../utilitarios/dinheiro.js';
import { normalizarE164, formatarParaExibicao } from '../utilitarios/telefone.js';
import { ErroDeNegocio, ErroDeValidacao } from '../utilitarios/erros.js';

/**
 * Montagem da mensagem de cobranca por WhatsApp.
 *
 * O WhatsApp nao tem API oficial de mensagem avulsa: o que existe e um
 * link `wa.me` que ABRE a conversa com o texto ja escrito. O usuario
 * so precisa apertar enviar. E' o que a Credigest usa.
 *
 * O numero vai no formato internacional (55 + DDD + numero), que e o
 * unico que o wa.me aceita.
 */

const BASE_WHATSAPP = 'https://wa.me/';

/**
 * Texto da cobranra. Este e o texto que o cliente le no celular.
 *
 * @param {object} dados
 * @param {string} dados.nomeCliente
 * @param {number} dados.valorCentavos
 * @param {string} dados.pixCopiaECola
 * @param {string} [dados.descricao]  do que se trata o pagamento
 * @returns {string}
 */
export function montarMensagem({ nomeCliente, valorCentavos, pixCopiaECola, descricao = null }) {
  if (!nomeCliente || !String(nomeCliente).trim()) {
    throw new ErroDeValidacao('nome do cliente vazio: nao da para montar a mensagem', {
      codigo: 'NOME_CLIENTE_AUSENTE',
    });
  }
  if (!pixCopiaECola || !String(pixCopiaECola).trim()) {
    throw new ErroDeValidacao(
      'a cobranca ainda nao tem codigo Pix copia-e-cola',
      { codigo: 'PIX_AUSENTE' }
    );
  }

  const valor = formatarBrasileiro(valorCentavos);
  const assunto = descricao ? ` Referente a ${descricao}.` : '';

  return (
    `Ola, ${String(nomeCliente).trim()}! Aqui e da Credigest.${assunto} ` +
    `Segue o codigo Pix para o pagamento no valor de ${valor}: ` +
    `${String(pixCopiaECola).trim()} ` +
    `Qualquer duvida, estamos a disposicao!`
  );
}

/**
 * Link do WhatsApp com a mensagem ja preenchida.
 *
 * @param {string} e164           numero internacional, so digitos
 * @param {string} mensagem
 * @returns {string} URL completa
 */
export function montarLink({ e164, mensagem }) {
  const numero = String(e164).replace(/\D/g, '');
  if (!numero) {
    throw new ErroDeValidacao('numero de WhatsApp vazio', { codigo: 'TELEFONE_AUSENTE' });
  }
  return `${BASE_WHATSAPP}${numero}?text=${encodeURIComponent(mensagem)}`;
}

/**
 * Monta o pacote inteiro pronto para o botao do painel usar:
 * numero formatado, texto e link.
 *
 * O `cliente.ddd` e `cliente.telefone` vem do banco ja separados. Aqui
 * eles viram 55+DDD+numero. Se o telefone estiver errado, a excecao sai
 * daqui com codigo especifico e o painel mostra o motivo, em vez de
 * gerar um link que nao abre.
 *
 * @param {object} dados
 * @param {{nome: string, ddd: string, telefone: string}} dados.cliente
 * @param {{valor_centavos: number, pix_copia_e_cola: string, descricao?: string}} dados.cobranca
 * @returns {{e164: string, telefoneFormatado: string, mensagem: string, url: string}}
 */
export function prepararCobranca({ cliente, cobranca }) {
  if (!cliente) {
    throw new ErroDeNegocio('cobranca sem cliente vinculado', {
      status: 500,
      codigo: 'COBRANCA_SEM_CLIENTE',
    });
  }

  // A checagem vai AQUI, e nao nas rotas, porque os dois atalhos do painel
  // (/api/cobrancas/:id/whatsapp e /api/dividas/:id/whatsapp) passam por
  // esta funcao. Cobrar um cliente por algo que ele JA' pagou e' o tipo
  // de erro que destroys a confianca no sistema inteiro: o cliente paga
  // de novo porque ninguem o avisou, e o dinheiro sobra.
  //
  // `pago_em` e' a fonte da verdade, nao `status_gateway`: o status do
  // gateway e' o que o PROVEDOR acha, e pode demorar ou faltar. `pago_em`
  // so e' preenchido pela nossa transacao de baixa, junto com o evento.
  if (cobranca?.pago_em) {
    throw new ErroDeNegocio('esta cobranca ja foi paga. Nao ha nada a cobrar.', {
      status: 409,
      codigo: 'COBRANCA_JA_PAGA',
    });
  }

  if (!cobranca?.pix_copia_e_cola) {
    throw new ErroDeNegocio(
      'ainda nao existe codigo Pix para esta cobranca. Gere o Pix antes de enviar no WhatsApp.',
      { status: 409, codigo: 'PIX_NAO_GERADO' }
    );
  }

  const e164 = normalizarE164({ ddd: cliente.ddd, numero: cliente.telefone });
  const mensagem = montarMensagem({
    nomeCliente: cliente.nome,
    valorCentavos: cobranca.valor_centavos,
    pixCopiaECola: cobranca.pix_copia_e_cola,
    // `descricao_divida` vem da view vw_cobrancas (migration 004). Uma
    // cobranca avulsa tem 'Cobranca avulsa' como fallback.
    descricao: cobranca.descricao_divida ?? null,
  });

  return {
    e164,
    telefoneFormatado: formatarParaExibicao(e164),
    mensagem,
    url: montarLink({ e164, mensagem }),
  };
}