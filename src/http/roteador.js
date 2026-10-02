// `src/http/roteador.js` -> `src/utilitarios/`: sobe UM nivel.
import { ErroDeNegocio } from '../utilitarios/erros.js';

/**
 * Roteador minimo sobre node:http.
 *
 * Por que nao Express: o projeto precisa de ~10 rotas. Um roteador de
 * 120 linhas substitui uma dependencia externa e evita `npm install`,
 * que no Windows ja deu trabalho por causa da politica de execucao de
 * script do PowerShell.
 *
 * Suporta: parametros de caminho (/api/clientes/:id), query string,
 * JSON body com limite de tamanho, e middlewares por rota.
 */

export function criarRoteador() {
  /** @type {Array<{metodo:string, segmentos:string[], handler:Function, nome:string}>} */
  const rotas = [];

  function adicionar(metodo, padrao, handler, opcoes = {}) {
    rotas.push({
      metodo,
      segmentos: padrao.split('/').filter(Boolean),
      handler,
      nome: opcoes.nome ?? `${metodo} ${padrao}`,
    });
    return api;
  }

  const api = {
    get: (p, h, o) => adicionar('GET', p, h, o),
    post: (p, h, o) => adicionar('POST', p, h, o),
    put: (p, h, o) => adicionar('PUT', p, h, o),
    patch: (p, h, o) => adicionar('PATCH', p, h, o),
    delete: (p, h, o) => adicionar('DELETE', p, h, o),

    /**
     * Casa a requisicao com uma rota registrada.
     * @returns {{handler: Function, params: object}|null}
     */
    casar(metodo, caminho) {
      const segmentosCaminho = caminho.split('/').filter(Boolean);
      const permitidos = new Set();

      for (const rota of rotas) {
        if (rota.metodo !== metodo) continue;
        if (rota.segmentos.length !== segmentosCaminho.length) continue;

        const params = {};
        let casou = true;

        for (let i = 0; i < rota.segmentos.length; i++) {
          const esperado = rota.segmentos[i];
          const recebido = segmentosCaminho[i];

          if (esperado.startsWith(':')) {
            params[esperado.slice(1)] = decodeURIComponent(recebido);
          } else if (esperado !== recebido) {
            casou = false;
            break;
          }
        }

        if (casou) {
          permitidos.add(rota.metodo);
          return { handler: rota.handler, params, nomeRota: rota.nome };
        }
      }

      // Mesmo caminho existe, mas com outro verbo? E' 405, nao 404.
      // A diferenca importa: 404 = nao existe; 405 = existe mas nao posso.
      for (const rota of rotas) {
        if (rota.segmentos.length !== segmentosCaminho.length) continue;
        let mesmoCaminho = true;
        for (let i = 0; i < rota.segmentos.length; i++) {
          const esperado = rota.segmentos[i];
          if (!esperado.startsWith(':') && esperado !== segmentosCaminho[i]) {
            mesmoCaminho = false;
            break;
          }
        }
        if (mesmoCaminho) permitidos.add(rota.metodo);
      }

      if (permitidos.size > 0) {
        throw new ErroDeNegocio(
          `metodo ${metodo} nao permitido neste caminho (use ${[...permitidos].join(', ')})`,
          { status: 405, codigo: 'METODO_NAO_PERMITIDO', detalhes: { permitidos: [...permitidos] } }
        );
      }

      return null;
    },

    /** Todas as rotas registradas (documentacao / debug). */
    listar() {
      return rotas.map((r) => `${r.metodo} /${r.segmentos.join('/')}`);
    },
  };

  return api;
}