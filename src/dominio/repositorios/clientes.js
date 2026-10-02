import { banco } from '../../banco/conexao.js';
import { ErroNaoEncontrado, ErroDeConflito } from '../../utilitarios/erros.js';
import { normalizarE164, somenteDigitos } from '../../utilitarios/telefone.js';

/**
 * Repositorio de clientes.
 *
 * O telefone e validado e normalizado ANTES de gravar, e o que vai para
 * o banco ja e o digito puro (55+DDD+numero). Guardar "(71) 98812-7107"
 * no banco e o que faz o link do WhatsApp falhar depois.
 */

export function criar(dados) {
  const e164 = normalizarE164({ ddd: dados.ddd, numero: dados.telefone });
  const db = banco().db;

  if (dados.documento) {
    const documento = somenteDigitos(dados.documento);
    const existente = db.prepare('SELECT id FROM clientes WHERE documento = ?').get(documento);
    if (existente) {
      throw new ErroDeConflito(
        `ja existe um cliente com o documento ${documento} (id ${existente.id})`,
        { codigo: 'CLIENTE_DUPLICADO', detalhes: { cliente_id: existente.id } }
      );
    }
  }

  const info = db
    .prepare(
      `INSERT INTO clientes (nome, email, ddd, telefone, documento)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      String(dados.nome).trim(),
      dados.email ? String(dados.email).trim().toLowerCase() : null,
      e164.slice(2, 4),
      e164.slice(4),
      dados.documento ? somenteDigitos(dados.documento) : null
    );

  return buscarPorId(Number(info.lastInsertRowid));
}

export function buscarPorId(id) {
  const linha = banco().db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
  if (!linha) throw new ErroNaoEncontrado('cliente', id);
  return linha;
}

export function buscarPorDocumento(documento) {
  return (
    banco().db
      .prepare('SELECT * FROM clientes WHERE documento = ?')
      .get(somenteDigitos(documento)) ?? null
  );
}

export function listar({ limite = 50, offset = 0 } = {}) {
  return banco().db
    .prepare('SELECT * FROM clientes ORDER BY nome COLLATE NOCASE LIMIT ? OFFSET ?')
    .all(limite, offset);
}

export function atualizar(id, dados) {
  const atual = buscarPorId(id);
  const db = banco().db;

  const e164 = dados.telefone !== undefined
    ? normalizarE164({ ddd: dados.ddd ?? atual.ddd, numero: dados.telefone })
    : normalizarE164({ ddd: atual.ddd, numero: atual.telefone });

  const documento = dados.documento !== undefined
    ? (dados.documento ? somenteDigitos(dados.documento) : null)
    : atual.documento;

  if (documento) {
    const dono = db.prepare('SELECT id FROM clientes WHERE documento = ? AND id <> ?').get(documento, id);
    if (dono) {
      throw new ErroDeConflito(`documento ${documento} pertence ao cliente ${dono.id}`, {
        codigo: 'CLIENTE_DUPLICADO',
        detalhes: { cliente_id: dono.id },
      });
    }
  }

  db.prepare(
    `UPDATE clientes SET nome = ?, email = ?, ddd = ?, telefone = ?, documento = ?
     WHERE id = ?`
  ).run(
    String(dados.nome ?? atual.nome).trim(),
    dados.email !== undefined ? (dados.email ? String(dados.email).trim().toLowerCase() : null) : atual.email,
    e164.slice(2, 4),
    e164.slice(4),
    documento,
    id
  );

  return buscarPorId(id);
}

/**
 * Remove o cliente. Recusado se ele tiver dividas ou cobrancas.
 *
 * Nao apaga em cascata: perder historico financeiro sem querer e' pior do
 * que recusar a operacao. O chamador precisa limpar antes (ou cancelar).
 */
export function remover(id) {
  buscarPorId(id);
  const db = banco().db;

  const dividas = db.prepare('SELECT COUNT(*) AS n FROM dividas WHERE cliente_id = ?').get(id).n;
  const cobrancas = db.prepare('SELECT COUNT(*) AS n FROM cobrancas WHERE cliente_id = ?').get(id).n;

  if (dividas > 0 || cobrancas > 0) {
    throw new ErroDeConflito(
      `cliente tem ${dividas} divida(s) e ${cobrancas} cobranca(s) registradas e nao pode ser removido`,
      { codigo: 'CLIENTE_COM_MOVIMENTO', detalhes: { dividas, cobrancas } }
    );
  }

  db.prepare('DELETE FROM clientes WHERE id = ?').run(id);
  return { removido: true, id };
}