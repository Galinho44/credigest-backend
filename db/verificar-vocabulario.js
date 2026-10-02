/**
 * Confere que o vocabulario de status do banco bate com o codigo.
 *
 * POR QUE ISTO EXISTE
 *
 * `db/migrations/005_normalizar_status_gateway.sql` espelha, em SQL, o
 * vocabulario de `src/utilitarios/statusGateway.js`. SQL nao importa JS,
 * entao a lista fica duplicada em dois lugares — e duplicacao sem
 * verificacao e' como os dois comecam a divergir em silencio.
 *
 * O ja aconteceu: a primeira versao da 005 tinha `REEMBOLSADO`, que nao
 * existe no codigo, e a lista defensiva final nao cobria `EXCLUIDO`,
 * `APROVADO` nem `PROCESSANDO`. O efeito do UPDATE final seria transformar
 * uma cobranca ESTORNADA em PENDENTE — abrindo um Pix novo para uma divida
 * que o cliente ja quitou. So apareceu porque o .js foi lido antes de a
 * migration rodar, nao porque um teste pegou.
 *
 * Este script e' a rede contra isso. Ele le a lista do UPDATE defensivo da
 * 005 e compara com `VOCABULARIO_INTERNO` do codigo — a MESMA constante que
 * o runtime usa, entao nao existe uma terceira copia da lista aqui.
 *
 * Como rodar:
 *   node db/verificar-vocabulario.js
 *
 * Sai com codigo 1 se divergir, 0 se bater.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { VOCABULARIO_INTERNO } from '../src/utilitarios/statusGateway.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const CAMINHO_SQL = join(AQUI, 'migrations', '005_normalizar_status_gateway.sql');

/**
 * Extrai o vocabulario interno declarado na migration.
 *
 * Procura o NOT IN do UPDATE defensivo — o unico bloco com a lista
 * completa — e le os valores de dentro dos parenteses. Os outros UPDATEs
 * do arquivo tem `IN ('X')` com um ou dois status, e nao servem.
 *
 * @param {string} sql  conteudo do arquivo .sql
 * @returns {string[]}   status declarados, na ordem do arquivo
 */
export function extrairVocabularioDaMigration(sql) {
  const bloco = sql.match(/NOT\s+IN\s*\(([\s\S]*?)\)/i);
  if (!bloco) {
    throw new Error('nao achei o UPDATE defensivo (NOT IN) na migration 005');
  }
  return [...bloco[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

/**
 * Compara os dois vocabularios e devolve as diferencas.
 *
 * Compara como conjunto, nao como lista: a ordem dos UPDATEs na migration
 * nao tem significado nenhum, e comparar posicao a posicao daria falso
 * negativo quando so a ordem mudar.
 *
 * @param {string[]} doSql
 * @param {string[]} doJs
 * @returns {{soNoSql: string[], soNoJs: string[]}}
 */
export function compararVocabulario(doSql, doJs) {
  const sql = new Set(doSql);
  const js = new Set(doJs);
  return {
    soNoSql: doSql.filter((s) => !js.has(s)),
    soNoJs: doJs.filter((s) => !sql.has(s)),
  };
}

// ---- executa ------------------------------------------------------------

const doSql = extrairVocabularioDaMigration(readFileSync(CAMINHO_SQL, 'utf8'));
const { soNoSql, soNoJs } = compararVocabulario(doSql, VOCABULARIO_INTERNO);

console.log('migration 005 :', doSql.length, '->', doSql.join(', '));
console.log('statusGateway :', VOCABULARIO_INTERNO.length, '->', VOCABULARIO_INTERNO.join(', '));
console.log('');

if (soNoSql.length === 0 && soNoJs.length === 0) {
  console.log('OK — os dois vocabularios batem.');
  process.exit(0);
}

if (soNoSql.length > 0) {
  console.error('NAO VERIFICADO NO CODIGO    :', soNoSql.join(', '));
}
if (soNoJs.length > 0) {
  console.error('AUSENTE NA MIGRATION 005    :', soNoJs.join(', '));
}
console.error('');
console.error('Se voce adicionou um status em src/utilitarios/statusGateway.js,');
console.error('adicione tambem em db/migrations/005_normalizar_status_gateway.sql.');
console.error('O UPDATE defensivo da 005 cairia em DESCONHECIDO sem cobrir o status novo.');
process.exit(1);