/**
 * Log simples em JSON, uma linha por evento.
 *
 * JSON porque da para filtrar por campo depois (grep, Loki, arquivo).
 * Nao usa biblioteca: um logger de 30 linhas e' melhor que uma
 * dependencia de 30.000 linhas para o que o projeto precisa.
 *
 * `level` e `msg` sao os campos que plataformas de log esperam (Railway,
 * Grafana Loki, Datadog, CloudWatch). Sem eles o painel mostra
 * "[inf]" com a mensagem VAZIA, porque nao reconhece "nivel" e
 * "mensagem" em portugues. Os dois idiomas sao emitidos: um para a
 * plataforma, outro para quem le o arquivo.
 */

const NIVEIS = { debug: 10, info: 20, warn: 30, error: 40, silencioso: 99 };

const nivelAtual = NIVEIS[process.env.LOG_NIVEL ?? 'info'] ?? NIVEIS.info;

function escrever(nivel, mensagem, extra = {}) {
  if (NIVEIS[nivel] < nivelAtual) return;

  const registro = {
    em: new Date().toISOString(),
    // campos que a plataforma reconhece
    level: nivel,
    msg: mensagem,
    // campos em portugues, para quem le o arquivo
    nivel,
    mensagem,
    ...extra,
  };

  // Em teste nao polui a saida do node:test.
  if (nivel === 'silencioso' || process.env.LOG_SILENCIOSO === '1') return;

  const linha = JSON.stringify(registro);
  if (nivel === 'error' || nivel === 'warn') process.stderr.write(linha + '\n');
  else process.stdout.write(linha + '\n');
}

export const logger = {
  debug: (mensagem, extra) => escrever('debug', mensagem, extra),
  info: (mensagem, extra) => escrever('info', mensagem, extra),
  warn: (mensagem, extra) => escrever('warn', mensagem, extra),
  error: (mensagem, extra) => escrever('error', mensagem, extra),
};