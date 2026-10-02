import { config } from '../config.js';
import { ErroDeNegocio } from '../utilitarios/erros.js';

import * as simulado from './simulado.js';
import * as asaas from './asaas.js';

/**
 * Fabrica de gateways.
 *
 * O resto do sistema nunca importa 'asaas.js' ou 'simulado.js'
 * diretamente: pede o gateway pelo nome em GATEWAY. Isso permite trocar
 * de provedor mexendo em uma linha do .env, e permite rodar os testes
 * sem depender de rede nem de conta em nenhum lugar.
 */

const DISPONIVEIS = { simulado, asaas };

let cache = null;

export function gateway() {
  if (cache) return cache;

  const nome = config.gateway.nome;
  const modulo = DISPONIVEIS[nome];

  if (!modulo) {
    throw new ErroDeNegocio(
      `gateway "${nome}" nao existe. Disponiveis: ${Object.keys(DISPONIVEIS).join(', ')}`,
      { status: 500, codigo: 'GATEWAY_DESCONHECIDO' }
    );
  }

  cache = { nome, ...modulo };
  return cache;
}

/** Usado pelos testes para trocar de gateway no meio da execucao. */
export function trocarGateway(nome) {
  config.gateway.nome = nome;
  cache = null;
  return gateway();
}

export { simulado, asaas };