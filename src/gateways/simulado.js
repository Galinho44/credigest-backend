import { randomUUID, createHash } from 'node:crypto';

import { config } from '../config.js';
import { paraReaisGateway } from '../utilitarios/dinheiro.js';

/**
 * Gateway SIMULADO.
 *
 * Gera um Pix com cara de Pix mas que NINGUEM consegue pagar. Existe
 * para dar duas coisas:
 *
 *  1. rodar a Credigest inteira sem conta em nenhum gateway e sem dinheiro
 *     real, das migrations ate o painel;
 *  2. escrever teste automatizado que depende de comportamento
 *     deterministico (o `montarEventoPagamento` abaixo monta o webhook
 *     que os testes e o botao "simular pagamento" do painel enviam).
 *
 * A linha do "copia e cola" segue o layout do EMV QRCPS, que e' o que o
 * celular le. Assim da para conferir o formato do campo sem precisar de
 * chave Pix de verdade.
 */

/**
 * Monta o payload "copia e cola" no formato EMV QRCPS do Pix (BR Code).
 * O celular le esse texto; nao e um texto qualquer.
 */
function montarPayloadPix({ valorCentavos, recebedor, cidade, txid }) {
  const valor = paraReaisGateway(valorCentavos).toFixed(2);
  const campo = (id, valorCampo) => `${id}${String(valorCampo.length).padStart(2, '0')}${valorCampo}`;

  const partes = [
    campo('00', '01'), // payload format indicator
    campo('01', '12'), // point of initiation method: dinamico
    campo('26', campo('00', 'br.gov.bcb.pix') + campo('01', txid)), // merchant account
    campo('52', '0000'), // merchant category code
    campo('53', '986'), // moeda: BRL
    campo('54', valor),
    campo('58', 'BR'),
    campo('59', recebedor),
    campo('60', cidade),
    campo('62', campo('05', txid)), // dados extras
  ];

  // Checksum CRC16-CCITT do "PAYLOAD" + campos, em hexadecimal maiusculo.
  const semChecksum = partes.join('');
  const crc = crc16(`${semChecksum}6304`);
  return `${semChecksum}63${String(crc.length).padStart(2, '0')}${crc}`;
}

/** CRC16-CCITT (polinomio 0x1021), usado pelo Pix. */
function crc16(texto) {
  let crc = 0xffff;
  for (let i = 0; i < texto.length; i++) {
    crc ^= texto.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * @returns {{id: string, status: string, pix: {copiaECola: string, qrCodeUrl: string|null, expiraEm: string}}}
 */
export function criarCobrancaPix({ valorCentavos, descricao, referencia, cliente }) {
  const id = `pay_sim_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const txid = createHash('sha256').update(`${id}|${valorCentavos}`).digest('hex').slice(0, 25);

  const copiaECola = montarPayloadPix({
    valorCentavos,
    recebedor: config.gateway.pix.recebedor,
    cidade: config.gateway.pix.cidade,
    txid,
  });

  return {
    id,
    status: 'PENDING',
    valorCentavos,
    copiaECola,
    // Sem imagem de verdade: um QR Code de mentira seria pior que
    // nenhum, porque da pra escanear e parece que funciona.
    qrCodeUrl: null,
    expiraEm: new Date(Date.now() + 30 * 86400_000).toISOString(),
    descricao,
    referencia,
    cliente,
    simulado: true,
  };
}

/** Monta o corpo do webhook que o gateway simulado "enviaria". */
export function montarEventoPagamento({ idCobranca, status = 'RECEIVED', idEvento = `evt_sim_${randomUUID().slice(0, 18)}`, valor = null }) {
  return {
    id: idEvento,
    event: status === 'RECEIVED' ? 'PAYMENT_RECEIVED' : 'PAYMENT_CONFIRMED',
    dateCreated: new Date().toISOString().slice(0, 19).replace('T', ' '),
    payment: {
      object: 'payment',
      id: idCobranca,
      status,
      value: valor,
    },
  };
}

export const nome = 'simulado';