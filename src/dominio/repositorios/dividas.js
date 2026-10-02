import { banco } from '../../banco/conexao.js';
import { ErroNaoEncontrado, ErroDeValidacao } from '../../utilitarios/erros.js';
import { buscarPorId as buscarCliente } from './clientes.js';

/**
 * Repositorio de dividas.
 *
 * A divida NAO tem coluna de status. O status vem da view vw_dividas,
 * calculada a partir das cobrancas. Nao existe caminho de codigo que
 * atualize "status" de divida, porque nao existe a coluna.
 */

/**
 * @param {object} dados
 * @param {number} dados.valor_centavos  INTEIRO EM CENTAVOS. Nao reais.
 *   A conversao de "850.00" para 85000 acontece na rota HTTP
 *   (`paraCentavos`). Aqui ja e inteiro, porque dentro do dominio o
 *   dinheiro nao tem float.
 */
export function criar(dados) {
  buscarCliente(dados.cliente_id); // valida e da 404 se nao existir

  if (!Number.isInteger(dados.valor_centavos) || dados.valor_centavos <= 0) {
    throw new ErroDeValidacao(
      `valor_centavos precisa ser inteiro positivo (recebido: ${JSON.stringify(dados.valor_centavos)})`,
      { codigo: 'VALOR_CENTAVOS_INVALIDO' }
    );
  }

  const info = banco().db
    .prepare(
      `INSERT INTO dividas (cliente_id, descricao, valor_centavos, vencimento)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      dados.cliente_id,
      String(dados.descricao).trim(),
      dados.valor_centavos,
      dados.vencimento ?? null
    );

  return buscarPorId(Number(info.lastInsertRowid));
}

export function buscarPorId(id) {
  const linha = banco().db.prepare('SELECT * FROM vw_dividas WHERE id = ?').get(id);
  if (!linha) throw new ErroNaoEncontrado('divida', id);
  return linha;
}

export function listar({ cliente_id = null, status = null, limite = 50, offset = 0 } = {}) {
  const onde = [];
  const valores = [];

  if (cliente_id !== null) {
    onde.push('cliente_id = ?');
    valores.push(cliente_id);
  }
  if (status) {
    onde.push('status = ?');
    valores.push(String(status).toUpperCase());
  }

  const filtro = onde.length ? `WHERE ${onde.join(' AND ')}` : '';
  return banco().db
    .prepare(`SELECT * FROM vw_dividas ${filtro} ORDER BY criado_em DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...valores, limite, offset);
}

/** Resumo do painel. */
export function resumo() {
  const db = banco().db;
  const base = db.prepare('SELECT * FROM vw_dividas').all();

  const somar = (linhas, campo) => linhas.reduce((t, l) => t + (l[campo] ?? 0), 0);

  const pendentes = base.filter((l) => l.status === 'PENDENTE');
  const pagas = base.filter((l) => l.status === 'PAGO');

  return {
    total_dividas: base.length,
    dividas_pendentes: pendentes.length,
    dividas_pagas: pagas.length,
    total_centavos: somar(base, 'valor_centavos'),
    recebido_centavos: somar(pagas, 'valor_pago_centavos'),
    a_receber_centavos: somar(pendentes, 'saldo_centavos'),
    em_atraso: pendentes.filter((l) => l.vencimento && l.vencimento < new Date().toISOString().slice(0, 10)).length,
  };
}