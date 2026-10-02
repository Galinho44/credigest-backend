import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { caminhoBancoAbsoluto } from '../config.js';
import { logger } from '../logger.js';

/**
 * Conexao com o banco.
 *
 * Usa o modulo `node:sqlite`, que vem pronto no Node 22.5+. Isso evita
 * dependencia nativa (type `better-sqlite3` precisaria compilar no
 * Windows e ja falhou varias vezes em maquina do Gabriel).
 */

let instancia = null;

/**
 * Abre (ou reaproveita) a conexao singleton.
 * @param {string} [caminho] padrao: vem do .env. ':memory:' nos testes.
 */
export function conectar(caminho = caminhoBancoAbsoluto()) {
  if (instancia && instancia.caminho === caminho) return instancia;

  // Ja existe conexao aberta para OUTRO caminho (troca de banco em teste,
  // ou `.env` recarregado). Sem fechar antes, o handle antigo fica
  // aberto: no Windows o arquivo do SQLite continua travado e o
  // processo sobe consumindo um descriptor por troca.
  if (instancia?.db) {
    try {
      instancia.db.close();
    } catch (erro) {
      logger.warn('nao consegui fechar a conexao anterior', { erro: erro.message });
    }
    instancia = null;
  }

  if (caminho !== ':memory:') {
    mkdirSync(dirname(caminho), { recursive: true });
  }

  const db = new DatabaseSync(caminho);

  // WAL: leituras nao travam escrita. Importante porque o painel fica
  // consultando enquanto o webhook escreve.
  if (caminho !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');

  // Sem isto o SQLite ACEITA criar cobranca apontando para um cliente
  // inexistente. Chave estrangeira sem enforce e' decoracao.
  db.exec('PRAGMA foreign_keys = ON;');

  // Espera ate 5s por lock em vez de falhar na hora.
  db.exec('PRAGMA busy_timeout = 5000;');

  instancia = {
    caminho,
    db,
    prepare(sql) {
      return db.prepare(sql);
    },
    /** Executa uma funcao dentro de transacao. Faz rollback se ela lancar. */
    emTransacao(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn(db);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch (erroRollback) {
          logger.error('falha no rollback', { erro: erroRollback.message });
        }
        throw e;
      }
    },
    fechar() {
      if (instancia && instancia.db) {
        instancia.db.close();
        instancia = null;
      }
    },
  };

  logger.debug('banco conectado', { caminho });
  return instancia;
}

/** Atalho: conexao ja aberta. */
export function banco() {
  if (!instancia) return conectar();
  return instancia;
}