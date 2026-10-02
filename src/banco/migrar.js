import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { caminhoBancoAbsoluto, config } from '../config.js';
import { ehPontoDeEntrada } from '../utilitarios/pontoDeEntrada.js';
import { conectar } from './conexao.js';
import { logger } from '../logger.js';

/**
 * Runner de migration.
 *
 * Cada arquivo .sql em db/migrations roda UMA vez, em ordem alfabetica.
 * O que ja rodou fica registrado na tabela _migrations com o checksum do
 * arquivo: se alguem editar uma migration que ja foi aplicada, o sistema
 * avisa em vez de fingir que nada aconteceu.
 */

const PASTA_MIGRATIONS = join(config.raiz, 'db', 'migrations');

function garantirTabelaDeControle(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      nome       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      aplicada_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

/** Checksum simples (djb2). Nao e criptografia: e' so para detectar edicao. */
function checksum(texto) {
  let h = 5381;
  for (let i = 0; i < texto.length; i++) h = ((h << 5) + h + texto.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * Aplica todas as migrations pendentes.
 * @returns {{aplicadas: string[], jaAplicadas: string[], alteradas: string[]}}
 */
export function migrar(caminhoBanco = caminhoBancoAbsoluto()) {
  const conexao = conectar(caminhoBanco);
  const db = conexao.db;

  garantirTabelaDeControle(db);

  const arquivos = readdirSync(PASTA_MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const aplicadas = [];
  const jaAplicadas = [];
  const alteradas = [];

  for (const nome of arquivos) {
    const sql = readFileSync(join(PASTA_MIGRATIONS, nome), 'utf8');
    const soma = checksum(sql);

    const anterior = db.prepare('SELECT checksum FROM _migrations WHERE nome = ?').get(nome);

    if (anterior) {
      if (anterior.checksum !== soma) {
        // Migration ja aplicada e depois editada. Rodar de novo pode
        // falhar no meio e deixar o banco inconsistente. Melhor avisar
        // e obrigar a criar uma migration nova.
        alteradas.push(nome);
        logger.error('migration aplicada foi alterada depois', { migration: nome });
      } else {
        jaAplicadas.push(nome);
      }
      continue;
    }

    conexao.emTransacao(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (nome, checksum) VALUES (?, ?)').run(nome, soma);
    });

    aplicadas.push(nome);
    logger.info('migration aplicada', { migration: nome });
  }

  return { aplicadas, jaAplicadas, alteradas };
}

// Permite rodar direto: `npm run migrate`
if (ehPontoDeEntrada(import.meta.url)) {
  const r = migrar();
  console.log(`aplicadas: ${r.aplicadas.length} | ja aplicadas: ${r.jaAplicadas.length}`);
  for (const n of r.aplicadas) console.log(`  + ${n}`);
  if (r.alteradas.length) {
    console.error(`\nATENCAO: migrations alteradas depois de aplicadas: ${r.alteradas.join(', ')}`);
    process.exitCode = 1;
  }
}