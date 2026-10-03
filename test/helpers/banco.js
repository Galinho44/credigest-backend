import { conectar } from '../../src/banco/conexao.js';
import { migrar } from '../../src/banco/migrar.js';
import { config } from '../../src/config.js';

/**
 * Banco de teste: SQLite em memoria.
 *
 * Por que ":memory:" e nao um arquivo temporario:
 *   - some sozinho quando o processo acaba, nao deixa lixo em disco;
 *   - cada teste comeca com o schema do zero, entao a ordem dos testes
 *     nao muda o resultado;
 *   - e' mais rapido, porque WAL nao tem o que sincronizar.
 *
 * `config.caminhoBanco` e' reescrito em memoria e devolvido ao valor
 * original no fim. Sem isso, um teste que esquece de restaurar vazaria
 * o banco de teste para o resto da suite.
 */

export function usarBancoDeTeste() {
  const original = config.caminhoBanco;
  config.caminhoBanco = ':memory:';

  const conexao = conectar(':memory:');
  migrar(':memory:');

  return {
    banco: conexao.db,
    restaurar() {
      conexao.fechar();
      config.caminhoBanco = original;
    },
  };
}

/**
 * Cala o logger.
 *
 * O logger le `LOG_SILENCIOSO` a cada chamada (nao no import), entao
 * ligar aqui funciona mesmo com os modulos ja carregados. tests
 * themselves nao devem poluir a saida do `node:test`, que usa essa
 * saida para mostrar o TAP.
 */
export function silenciarLogs() {
  process.env.LOG_SILENCIOSO = '1';
}