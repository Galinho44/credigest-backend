import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

import { config } from './config.js';
import { logger } from './logger.js';
import { criarRoteador } from './http/roteador.js';
import { lerJson, centralDeErros, responderJson } from './http/middlewares/index.js';
import { ErroNaoEncontrado } from './utilitarios/erros.js';

import * as rotasClientes from './http/rotas/clientes.js';
import * as rotasDividas from './http/rotas/dividas.js';
import * as rotasCobrancas from './http/rotas/cobrancas.js';
import * as rotasWebhooks from './http/rotas/webhooks.js';

/**
 * Monta o servidor HTTP (sem subir). Devolve o objeto do server para que
 * os testes possam subir em porta aleatoria e derrubar no final.
 */

const TIPOS_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const PASTA_PUBLICO = join(config.raiz, 'publico');

/**
 * Anexa atalhos de resposta que as rotas usam (`res.json`, `res.status`).
 *
 * `node:http` so oferece writeHead/end. Sem este passo, toda rota
 * precisaria repetir `responderJson(res, 200, ...)` e o status codes
 * viraria um argumento solto que ninguem revisa. Aqui o status fica
 * encadeado com o corpo: `res.status(201).json(...)`.
 *
 * Guarda contra envio duplicado: uma rota que chamou json() e depois
 * caiu no central de erros nao tenta escrever header duas vezes.
 */
function anexarHelpersDeResposta(res) {
  let status = 200;
  let enviado = false;

  res.status = (codigo) => {
    if (!enviado) status = codigo;
    return res;
  };

  res.json = (dados) => {
    if (enviado) return res;
    enviado = true;
    responderJson(res, status, dados);
    return res;
  };

  res.finalizado = () => enviado;
  return res;
}

export function criarAplicacao() {
  const rota = criarRoteador();

  rotasClientes.registrar(rota);
  rotasDividas.registrar(rota);
  rotasCobrancas.registrar(rota);
  rotasWebhooks.registrar(rota);

  const lerCorpoJson = lerJson();

  return createServer(async (req, res) => {
    const inicio = Date.now();
    req.metodo = req.method;
    req.caminho = (req.url ?? '/').split('?')[0];
    anexarHelpersDeResposta(res);

    const indiceInterrogacao = (req.url ?? '').indexOf('?');
    req.query = indiceInterrogacao >= 0
      ? Object.fromEntries(new URL(req.url, 'http://localhost').searchParams)
      : {};

    res.on('finish', () => {
      logger.debug('requisicao atendida', {
        metodo: req.metodo,
        caminho: req.caminho,
        status: res.statusCode,
        ms: Date.now() - inicio,
      });
    });

    try {
      // ---- health check (antes do /api/: senao cairia no 404 do roteador) ----
      if (req.caminho === '/api/saude') {
        // Fora do roteador, entao o 405 de "metodo nao permitido" nao
        // acontece sozinho. Checar aqui para o comportamento nao mudar
        // so porque a rota esta antes do /api/: POST /api/saude
        // responderia 200 e o painel nenhum precisa saber disso.
        if (req.metodo !== 'GET' && req.metodo !== 'HEAD') {
          responderJson(res, 405, {
            erro: {
              codigo: 'METODO_NAO_PERMITIDO',
              mensagem: `${req.metodo} nao e permitido em ${req.caminho}`,
              detalhes: { permitidos: ['GET'] },
            },
          });
          return;
        }

        // Mesmo envelope `{ dados }` de todas as outras rotas: o painel
        // lê `saude.dados.gateway` e não precisa saber a diferença.
        responderJson(res, 200, {
          dados: {
            ok: true,
            gateway: config.gateway.nome,
            ambiente: config.ambiente,
            banco: config.caminhoBanco,
          },
        });
        return;
      }

      // ---- API ----
      if (req.caminho.startsWith('/api/')) {
        await lerCorpoJson(req);

        const achada = rota.casar(req.metodo, req.caminho);
        if (!achada) {
          throw new ErroNaoEncontrado(`rota ${req.metodo} ${req.caminho}`);
        }

        req.params = achada.params;
        await achada.handler(req, res);
        return;
      }

      // ---- painel estatico ----
      await servirEstatico(req, res);
    } catch (erro) {
      centralDeErros(erro, req, res);
    }
  });
}

/**
 * Serve os arquivos do painel.
 *
 * O `normalize` + verificacao de prefixo nao e paranoia: sem isso,
 * `GET /../../.env` sai da pasta publica e entrega o arquivo de token.
 */
async function servirEstatico(req, res) {
  if (req.metodo !== 'GET' && req.metodo !== 'HEAD') {
    throw new ErroNaoEncontrado(`rota ${req.metodo} ${req.caminho}`);
  }

  const relativo = req.caminho === '/' ? 'index.html' : req.caminho.replace(/^\/+/, '');
  const alvo = normalize(join(PASTA_PUBLICO, relativo));

  if (!alvo.startsWith(PASTA_PUBLICO)) {
    throw new ErroNaoEncontrado('recurso');
  }

  let conteudo;
  try {
    conteudo = await readFile(alvo);
  } catch {
    throw new ErroNaoEncontrado(`arquivo ${req.caminho}`);
  }

  const tipo = TIPOS_MIME[extname(alvo).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': tipo,
    'content-length': conteudo.length,
    // O painel nao tem dado sensivel, mas o padrao e' nao deixar nada
    // cacheado sem motivo.
    'cache-control': 'no-cache',
  });
  res.end(conteudo);
}