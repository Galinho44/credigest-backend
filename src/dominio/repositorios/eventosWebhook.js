import { banco } from '../../banco/conexao.js';

/**
 * Registro de eventos de webhook recebidos.
 *
 * A PRIMARY KEY em id_evento e' o mecanismo de idempotencia do Asaas:
 * o gateway entrega "at least once", entao o mesmo evento chega mais de
 * uma vez. INSERT OR IGNORE devolve changes=0 na segunda vez e a gente
 * sabe que e' repetido.
 */

export function registrarRecebimento({ idEvento, gateway, tipo, idTransacaoGateway = null }) {
  const info = banco().db
    .prepare(
      `INSERT OR IGNORE INTO eventos_webhook (id_evento, gateway, tipo, id_transacao_gateway)
       VALUES (?, ?, ?, ?)`
    )
    .run(idEvento, gateway, tipo, idTransacaoGateway ?? null);

  return { novo: info.changes > 0 };
}

export function jaRecebido(idEvento) {
  return !!buscar(idEvento);
}

export function buscar(idEvento) {
  return banco().db.prepare('SELECT * FROM eventos_webhook WHERE id_evento = ?').get(idEvento) ?? null;
}

export function marcarProcessado(idEvento, { resultado = null, erro = null }) {
  banco().db
    .prepare(
      `UPDATE eventos_webhook
          SET processado    = 1,
              resultado     = ?,
              erro          = ?,
              processado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id_evento = ?`
    )
    .run(resultado, erro, idEvento);
}

/**
 * Libera o evento para ser reprocessado.
 *
 * Existe para quando o processamento foi feito FORA de transacao e
 * falhou no meio (o caminho feliz usa transacao, que ja faz rollback).
 * Sem isto, um webhook que deu timeout ficaria preso para sempre como
 * "ja recebido" e a baixa nunca mais aconteceria.
 */
export function liberarParaReprocessamento(idEvento) {
  banco().db.prepare('DELETE FROM eventos_webhook WHERE id_evento = ?').run(idEvento);
}

export function listar(limite = 100) {
  return banco().db
    .prepare('SELECT * FROM eventos_webhook ORDER BY recebido_em DESC LIMIT ?')
    .all(limite);
}