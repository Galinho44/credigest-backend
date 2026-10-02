import { timingSafeEqual } from 'node:crypto';

import { ErroDeNegocio } from '../../utilitarios/erros.js';
import { logger } from '../../logger.js';

/**
 * Middlewares transversais.
 */

// ---------------------------------------------------------------------
// Corpo JSON com limite de tamanho
// ---------------------------------------------------------------------

/** 1 MB. Nenhuma cobranca legitima passa disso. */
const TAMANHO_MAXIMO_CORPO = 1024 * 1024;

/**
 * Le o corpo da requisicao como JSON.
 *
 * Erros de JSON sao ErroDeNegocio (4xx) e nao erro generico: JSON
 * quebrado e' erro de quem mandou, nao bug do servidor.
 *
 * BUG CORRIGIDO AQUI (achado pelos testes HTTP): a versao anterior usava
 * o mesmo flag `encerrado` como guarda dentro de `encerrar()` e tambem o
 * ligava no topo de `aoEncerrar()`. Resultado: quando `aoEncerrar()`
 * precisava recusar o corpo invalido, `encerrar()` via, achava o flag
 * ligado e retornava sem fazer nada — a Promise ficava pendurada para
 * sempre e a requisicao ficava pendurada junto. O cliente só descobria
 * com timeout, sem nenhuma mensagem do servidor.
 *
 * A correção e' um ponto único de decisão (`liquidar`), que garante que
 * a Promise resolve OU rejeita exatamente uma vez.
 */
export function lerJson(limite = TAMANHO_MAXIMO_CORPO) {
  return (req) =>
    new Promise((resolve, reject) => {
      // GET/HEAD não têm corpo: não fica esperando bytes que nunca vão chegar.
      if (req.metodo === 'GET' || req.metodo === 'HEAD') {
        req.corpo = {};
        resolve();
        return;
      }

      const tipo = String(req.headers['content-type'] ?? '');
      const pedacos = [];
      let tamanho = 0;
      let liquidado = false;

      /** Ponto único de decisão: resolve OU rejeita, nunca as duas, nunca duas vezes. */
      const liquidar = (erro, valor) => {
        if (liquidado) return;
        liquidado = true;
        req.off('data', aoReceberDados);
        req.off('end', aoEncerrar);
        req.off('error', aoDarErro);
        if (erro) reject(erro);
        else resolve(valor);
      };

      function aoReceberDados(pedaco) {
        tamanho += pedaco.length;
        if (tamanho > limite) {
          req.destroy();
          liquidar(
            new ErroDeNegocio(`corpo da requisicao maior que o limite de ${limite} bytes`, {
              status: 413,
              codigo: 'CORPO_DEMASIADO_GRANDE',
            })
          );
          return;
        }
        pedacos.push(pedaco);
      }

      function aoEncerrar() {
        const bruto = Buffer.concat(pedacos).toString('utf8').trim();

        if (bruto === '') {
          req.corpo = {};
          liquidar(null);
          return;
        }

        if (tipo && !tipo.toLowerCase().includes('application/json')) {
          liquidar(
            new ErroDeNegocio(`Content-Type invalido: "${tipo}". Use application/json`, {
              status: 415,
              codigo: 'CONTENT_TYPE_INVALIDO',
            })
          );
          return;
        }

        try {
          req.corpo = JSON.parse(bruto);
          liquidar(null);
        } catch (erro) {
          liquidar(
            new ErroDeNegocio(`JSON invalido: ${erro.message}`, {
              status: 400,
              codigo: 'JSON_INVALIDO',
            })
          );
        }
      }

      function aoDarErro(erro) {
        liquidar(new ErroDeNegocio(`erro de leitura do corpo: ${erro.message}`));
      }

      req.on('data', aoReceberDados);
      req.on('end', aoEncerrar);
      req.on('error', aoDarErro);
    });
}

// ---------------------------------------------------------------------
// Comparacao de token em tempo constante
// ---------------------------------------------------------------------

/**
 * Compara dois segredos sem vazar quanto do token o atacante ja acertou.
 *
 * `===` para no primeiro caractere diferente e devolve false. Isso vaza
 * informacao: medindo o tempo da resposta, da para descobrir o token
 * byte a byte. `timingSafeEqual` sempre compara tudo.
 */
export function compararToken(recebido, esperado) {
  if (!recebido || !esperado) return false;
  const a = Buffer.from(String(recebido), 'utf8');
  const b = Buffer.from(String(esperado), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------

export function responderJson(res, status, dados) {
  const corpo = JSON.stringify(dados, (_chave, valor) =>
    typeof valor === 'bigint' ? Number(valor) : valor
  );
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(corpo),
    'cache-control': 'no-store',
  });
  res.end(corpo);
}

/**
 * Middleware de erro (ultimo da cadeia).
 *
 * Regra: erro ESPERADO responde com a causa e o codigo. Erro
 * INESPERADO responde generico (500) e loga o stack inteiro, sem vazar
 * detalhe interno para quem chamou.
 */
export function centralDeErros(erro, req, res) {
  const esperado = erro instanceof ErroDeNegocio;

  if (esperado) {
    logger.warn('erro de negocio', {
      metodo: req.metodo,
      caminho: req.caminho,
      codigo: erro.codigo,
      status: erro.status,
      mensagem: erro.message,
    });
  } else {
    logger.error('erro inesperado', {
      metodo: req.metodo,
      caminho: req.caminho,
      erro: erro.message,
      stack: erro.stack,
    });
  }

  if (res.headersSent) return;

  responderJson(res, erro.status ?? 500, {
    erro: {
      codigo: erro.codigo ?? 'ERRO_INTERNO',
      mensagem: esperado ? erro.message : 'erro interno do servidor',
      ...(erro.detalhes ? { detalhes: erro.detalhes } : {}),
    },
  });
}