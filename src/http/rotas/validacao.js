import { ErroDeValidacao } from '../../utilitarios/erros.js';
import { paraCentavos } from '../../utilitarios/dinheiro.js';

/**
 * Validadores de entrada.
 *
 * A API NUNCA confia no que o frontend mandou. O painel pode estar
 * errado, desatualizado ou ser editado via DevTools. A regra vale no
 * servidor: se o dado nao passou por aqui, ele nao entra no banco.
 *
 * Erros sao sempre com codigo estavel (`codigo: 'CPF_INVALIDO'`) para o
 * frontend poder reagir sem fazer parse de texto em portugues.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

export function exigir(corpo, campos) {
  const faltando = campos.filter((c) => corpo[c] === undefined || corpo[c] === null || corpo[c] === '');
  if (faltando.length > 0) {
    throw new ErroDeValidacao(`campo(s) obrigatorio(s): ${faltando.join(', ')}`, {
      codigo: 'CAMPOS_OBRIGATORIOS',
      detalhes: { campos: faltando },
    });
  }
  return corpo;
}

export function textoObrigatorio(valor, campo, { min = 1, max = 255 } = {}) {
  const limpo = String(valor ?? '').trim();
  if (limpo.length < min) {
    throw new ErroDeValidacao(`"${campo}" precisa ter ao menos ${min} caractere(s)`, {
      codigo: 'CAMPO_INVALIDO',
      detalhes: { campo },
    });
  }
  if (limpo.length > max) {
    throw new ErroDeValidacao(`"${campo}" passou de ${max} caracteres`, {
      codigo: 'CAMPO_MUITO_LONGO',
      detalhes: { campo, max },
    });
  }
  return limpo;
}

export function emailOpcional(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return null;
  const limpo = String(valor).trim().toLowerCase();
  if (!EMAIL.test(limpo)) {
    throw new ErroDeValidacao(`e-mail invalido: "${valor}"`, {
      codigo: 'EMAIL_INVALIDO',
      detalhes: { email: valor },
    });
  }
  return limpo;
}

export function dataOpcional(valor, campo) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return null;
  const limpo = String(valor).trim();
  if (!DATA_ISO.test(limpo)) {
    throw new ErroDeValidacao(`"${campo}" tem que estar no formato AAAA-MM-DD`, {
      codigo: 'DATA_INVALIDA',
      detalhes: { campo, recebido: limpo },
    });
  }
  return limpo;
}

export function idInteiro(valor, campo) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ErroDeValidacao(`"${campo}" precisa ser um id inteiro positivo (recebido: "${valor}")`, {
      codigo: 'ID_INVALIDO',
      detalhes: { campo, recebido: valor },
    });
  }
  return n;
}

export { paraCentavos };

/** Le e valida os filtros de listagem (com teto, para nao travar o banco). */
export function filtrosDeListagem(query) {
  const limite = Math.min(Number(query.limite) || 50, 200);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { limite, offset };
}