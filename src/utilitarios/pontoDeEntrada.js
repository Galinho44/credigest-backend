import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Descobre se o modulo atual e o arquivo que o Node executou.
 *
 * Serve para o padrao:
 *   if (ehPontoDeEntrada(import.meta)) { ...roda pelo CLI... }
 *
 * Sem isso, todo arquivo utilitario que tambem pode ser executado direto
 * (migrate, seed) transformaria-se em servidor quando importado.
 *
 * Comparar as strings nao funciona de forma confiavel: no Windows o
 * process.argv[1] vem com barra invertida e o import.meta.url com barra
 * normal. Por isso resolve os dois com realpath antes de comparar.
 */
export function ehPontoDeEntrada(metaUrl) {
  const executado = process.argv[1];
  if (!executado) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(executado);
  } catch {
    return false;
  }
}