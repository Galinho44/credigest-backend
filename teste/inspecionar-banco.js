import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('dados/credigest.db');

const objetos = db
  .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name`)
  .all();
console.log(objetos.map((o) => `${o.type.padEnd(5)} ${o.name}`).join('\n'));

console.log('\n--- colunas de vw_dividas ---');
console.log(
  db
    .prepare('PRAGMA table_info(vw_dividas)')
    .all()
    .map((c) => c.name)
    .join(', ')
);

console.log('\n--- colunas de vw_cobrancas ---');
console.log(
  db
    .prepare('PRAGMA table_info(vw_cobrancas)')
    .all()
    .map((c) => c.name)
    .join(', ')
);

db.close();