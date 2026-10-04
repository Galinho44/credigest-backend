import { banco } from '../../banco/conexao.js';
import { ErroNaoEncontrado } from '../../utilitarios/erros.js';

const TIPOS_VALIDOS = new Set(['cpf', 'cnpj', 'email', 'telefone', 'aleatoria']);

export function listar(usuarioId) {
  return banco().db
    .prepare('SELECT * FROM contas_bancarias WHERE usuario_id = ? ORDER BY padrao DESC, criado_em DESC')
    .all(usuarioId);
}

export function buscarPadrao(usuarioId) {
  return (
    banco().db
      .prepare('SELECT * FROM contas_bancarias WHERE usuario_id = ? AND padrao = 1 AND ativa = 1')
      .get(usuarioId) ?? null
  );
}

export function buscarPorId(usuarioId, id) {
  const linha = banco().db
    .prepare('SELECT * FROM contas_bancarias WHERE id = ? AND usuario_id = ?')
    .get(id, usuarioId);
  if (!linha) throw new ErroNaoEncontrado('conta bancaria', id);
  return linha;
}

export function criar(usuarioId, dados) {
  const { tipo_chave, chave_pix, nome_titular, banco: bancoNome, agencia, conta, conta_dv, padrao } = dados;

  if (!TIPOS_VALIDOS.has(tipo_chave)) {
    throw new Error(`Tipo de chave invalido: ${tipo_chave}. Use: ${Array.from(TIPOS_VALIDOS).join(', ')}`);
  }

  const db = banco().db;

  // Se vai ser padrao, remove padrao das outras
  if (padrao) {
    db.prepare('UPDATE contas_bancarias SET padrao = 0 WHERE usuario_id = ?').run(usuarioId);
  }

  const info = db
    .prepare(
      `INSERT INTO contas_bancarias (usuario_id, tipo_chave, chave_pix, nome_titular, banco, agencia, conta, conta_dv, padrao, ativa)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(usuarioId, tipo_chave, chave_pix, nome_titular, bancoNome, agencia ?? null, conta ?? null, conta_dv ?? null, padrao ? 1 : 0);

  return buscarPorId(usuarioId, Number(info.lastInsertRowid));
}

export function atualizar(usuarioId, id, dados) {
  const existente = buscarPorId(usuarioId, id);
  const db = banco().db;

  const tipo_chave = dados.tipo_chave ?? existente.tipo_chave;
  if (!TIPOS_VALIDOS.has(tipo_chave)) {
    throw new Error(`Tipo de chave invalido: ${tipo_chave}`);
  }

  // Se vai ser padrao, remove padrao das outras
  if (dados.padrao === true) {
    db.prepare('UPDATE contas_bancarias SET padrao = 0 WHERE usuario_id = ?').run(usuarioId);
  }

  const campos = [];
  const valores = [];

  if (dados.tipo_chave !== undefined) { campos.push('tipo_chave = ?'); valores.push(tipo_chave); }
  if (dados.chave_pix !== undefined) { campos.push('chave_pix = ?'); valores.push(dados.chave_pix); }
  if (dados.nome_titular !== undefined) { campos.push('nome_titular = ?'); valores.push(dados.nome_titular); }
  if (dados.banco !== undefined) { campos.push('banco = ?'); valores.push(dados.banco); }
  if (dados.agencia !== undefined) { campos.push('agencia = ?'); valores.push(dados.agencia); }
  if (dados.conta !== undefined) { campos.push('conta = ?'); valores.push(dados.conta); }
  if (dados.conta_dv !== undefined) { campos.push('conta_dv = ?'); valores.push(dados.conta_dv); }
  if (dados.padrao !== undefined) { campos.push('padrao = ?'); valores.push(dados.padrao ? 1 : 0); }
  if (dados.ativa !== undefined) { campos.push('ativa = ?'); valores.push(dados.ativa ? 1 : 0); }

  if (campos.length > 0) {
    campos.push('atualizado_em = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\')');
    valores.push(usuarioId, id);
    db.prepare(`UPDATE contas_bancarias SET ${campos.join(', ')} WHERE usuario_id = ? AND id = ?`).run(...valores);
  }

  return buscarPorId(usuarioId, id);
}

export function remover(usuarioId, id) {
  buscarPorId(usuarioId, id); // valida se existe
  banco().db.prepare('DELETE FROM contas_bancarias WHERE id = ? AND usuario_id = ?').run(id, usuarioId);
  return { removido: true, id };
}

export function definirPadrao(usuarioId, id) {
  const db = banco().db;
  db.prepare('UPDATE contas_bancarias SET padrao = 0 WHERE usuario_id = ?').run(usuarioId);
  db.prepare('UPDATE contas_bancarias SET padrao = 1 WHERE id = ? AND usuario_id = ?').run(id, usuarioId);
  return buscarPorId(usuarioId, id);
}