import { ErroDeValidacao } from './erros.js';

/**
 * Telefone brasileiro e o ponto onde mais erro acontece na Credigest:
 * o cliente digita "(71) 98812-7107", "71 98812-7107", "+55 71 98812-7107"
 * ou "71988127107", e o WhatsApp so aceita digitos com codigo do pais.
 *
 * Aqui a regra e sempre a mesma: NAO adivinhar, ou corrigir magicamente
 * ou recusar com mensagem que diz o que estava errado.
 */

const CODIGO_PAIS = '55';

/**
 * DDDs realmente em uso no Brasil. Validar contra a lista pega erro de
 * digitacao (DDD 10, 20, 23...) em vez de gerar um link wa.me que nunca
 * abre.
 */
const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

/** Deixa apenas digitos. */
export function somenteDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

/**
 * Monta o numero no formato internacional (E.164 sem '+'),
 * isto e, 55 + DDD + numero. Ex.: '5571988127107'.
 *
 * Aceita o numero em varias formas porque o usuario digita do jeito que
 * quiser:
 *   numero = '988127107'      (so o celular)
 *   numero = '71988127107'     (DDD + celular)
 *   numero = '55 71 988127107' (com pais)
 *
 * @param {{ddd: string|number, numero: string|number}} dados
 * @returns {string} apenas digitos, comecando com 55
 * @throws {ErroDeValidacao} se faltar DDD, o DDD nao existir, ou o numero
 *         nao tiver 8 ou 9 digitos.
 */
export function normalizarE164({ ddd, numero }) {
  const digitosDdd = somenteDigitos(ddd);
  const digitosNumero = somenteDigitos(numero);

  if (digitosDdd === '') {
    throw new ErroDeValidacao(
      'DDD nao informado. Informe o DDD do cliente (ex.: 71).',
      { codigo: 'DDD_AUSENTE', detalhes: { ddd: ddd ?? null } }
    );
  }
  if (digitosNumero === '') {
    throw new ErroDeValidacao('telefone do cliente nao informado', {
      codigo: 'TELEFONE_AUSENTE',
    });
  }
  if (digitosDdd.length !== 2) {
    throw new ErroDeValidacao(
      `DDD invalido: "${ddd}". DDD tem 2 digitos.`,
      { codigo: 'DDD_INVALIDO', detalhes: { ddd } }
    );
  }

  const dddNumero = Number(digitosDdd);
  if (!DDDS_VALIDOS.has(dddNumero)) {
    throw new ErroDeValidacao(`DDD ${digitosDdd} nao existe no Brasil`, {
      codigo: 'DDD_INEXISTENTE',
      detalhes: { ddd: digitosDdd },
    });
  }

  // Descarta o DDD que o usuario ja tenha colado junto com o numero,
  // para nao sair "55 71 71 98812-7107".
  let corpo;
  if (digitosNumero.length === 13 && digitosNumero.startsWith(CODIGO_PAIS)) {
    corpo = digitosNumero; // ja veio com pais
    if (!corpo.startsWith(CODIGO_PAIS + digitosDdd)) {
      throw new ErroDeValidacao(
        `telefone comeca com +${corpo.slice(0, 2)} mas o DDD informado e ${digitosDdd}`,
        { codigo: 'DDD_DIVERGENTE_DO_TELEFONE', detalhes: { ddd: digitosDdd, telefone: corpo } }
      );
    }
  } else if (digitosNumero.length === 11) {
    if (!digitosNumero.startsWith(digitosDdd)) {
      throw new ErroDeValidacao(
        `telefone comeca com DDD ${digitosNumero.slice(0, 2)} mas o DDD informado e ${digitosDdd}`,
        { codigo: 'DDD_DIVERGENTE_DO_TELEFONE', detalhes: { ddd: digitosDdd, telefone: digitosNumero } }
      );
    }
    corpo = digitosNumero;
  } else {
    corpo = digitosDdd + digitosNumero; // 8 ou 9 digitos: o numero "puro"
  }

  const semPais = corpo.startsWith(CODIGO_PAIS) && corpo.length === 13 ? corpo.slice(2) : corpo;

  if (semPais.length !== 10 && semPais.length !== 11) {
    throw new ErroDeValidacao(
      `telefone invalido: "${numero}". Use 8 digitos (fixo) ou 9 digitos (celular).`,
      { codigo: 'TELEFONE_INVALIDO', detalhes: { telefone: digitosNumero } }
    );
  }

  const numeroLocal = semPais.slice(2);
  if (numeroLocal.length === 9 && !numeroLocal.startsWith('9')) {
    throw new ErroDeValidacao(
      `celular de 9 digitos tem que comecar com 9: "${numeroLocal}"`,
      { codigo: 'CELULAR_INVALIDO', detalhes: { telefone: numeroLocal } }
    );
  }

  return CODIGO_PAIS + semPais;
}

/**
 * '5571988127107' -> '+55 71 98812-7107' (so para exibir).
 *
 * BUG CORRIGIDO AQUI: a versao anterior testava `numero.length === 11`,
 * mas `numero` ja vem SEM pais e SEM DDD, entao nunca tem 11 digitos —
 * as duas ramificacoes de formatacao eram inalcancaveis e todo mundo
 * caia no fallback cru ('+5571988127107'). O comprimento a testar e o do
 * numero local: 9 (celular) ou 10 (fixo antigo).
 */
export function formatarParaExibicao(e164) {
  const d = somenteDigitos(e164);
  if (d.length < 4) return `+${d}`;

  const pais = d.slice(0, 2);
  const ddd = d.slice(2, 4);
  const numero = d.slice(4);

  // So formata no padrao brasileiro. Numero de outro pais fica em
  // digitos, porque chutar agrupamento errado e pior que nao agrupar.
  if (pais !== CODIGO_PAIS) return `+${pais} ${ddd} ${numero}`;

  if (numero.length === 9) return `+${pais} ${ddd} ${numero.slice(0, 5)}-${numero.slice(5)}`;
  if (numero.length === 10 || numero.length === 8) {
    return `+${pais} ${ddd} ${numero.slice(0, 4)}-${numero.slice(4)}`;
  }

  return `+${d}`;
}