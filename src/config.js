import { resolve } from 'node:path';
import { ErroDeValidacao } from './utilitarios/erros.js';
import { logger } from './logger.js';

/**
 * Configuracao central. Le do ambiente (arquivo .env carregado pelo
 * proprio Node via --env-file-if-exists) e valida na hora de subir.
 *
 * Falhar no boot e melhor do que falhar no meio de uma cobranca: se o
 * token do webhook nao esta configurado, o servidor nem inicia.
 */

function texto(chave, padrao) {
  const v = process.env[chave];
  return v === undefined || v === '' ? padrao : v;
}

function inteiro(chave, padrao) {
  const bruto = texto(chave, null);
  if (bruto === null) return padrao;
  const n = Number(bruto);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ErroDeValidacao(`${chave} tem que ser um inteiro positivo (recebido: "${bruto}")`);
  }
  return n;
}

const raiz = resolve(import.meta.dirname, '..');

export const config = {
  raiz,
  ambiente: texto('NODE_ENV', 'desenvolvimento'),
  porta: inteiro('PORT', 3000),
  host: texto('HOST', '127.0.0.1'),
  caminhoBanco: texto('CREDIGEST_DB', 'dados/credigest.db'),

  gateway: {
    nome: texto('GATEWAY', 'simulado'),
    timeoutMs: inteiro('GATEWAY_TIMEOUT_MS', 8000),
    asaas: {
      baseUrl: texto('ASAAS_BASE_URL', 'https://api-sandbox.asaas.com/v3'),
      token: texto('ASAAS_ACCESS_TOKEN', null),
      ambiente: texto('ASAAS_AMBIENTE', 'sandbox'),
    },
    pix: {
      recebedor: texto('PIX_RECEBEDOR', 'credigest'),
      cidade: texto('PIX_CIDADE', 'Salvador'),
    },
  },

  webhook: {
    token: texto('ASAAS_WEBHOOK_TOKEN', null),
  },

  auth: {
    usuario: texto('AUTH_USUARIO', null),
    senha: texto('AUTH_SENHA', null),
    sessaoNome: texto('AUTH_SESSAO_NOME', 'credigest_sessao'),
    sessaoMaxAge: inteiro('AUTH_SESSAO_MAX_AGE', 60 * 60 * 24 * 30), // 30 dias
  },
};

/**
 * Conferencias de boot. Roda uma vez na subida do servidor.
 * @throws {ErroDeNegocio} com mensagem que diz exatamente o que faltou.
 */
export function validarConfig() {
  const problemas = [];

  if (!['simulado', 'asaas'].includes(config.gateway.nome)) {
    problemas.push(`GATEWAY invalido: "${config.gateway.nome}". Use "simulado" ou "asaas".`);
  }

  if (config.gateway.nome === 'asaas' && !config.gateway.asaas.token) {
    problemas.push(
      'GATEWAY=asaas exige ASAAS_ACCESS_TOKEN. ' +
      'Copie o .env.example para .env e preencha, ou use GATEWAY=simulado para testar sem conta.'
    );
  }

  // O token do webhook e' o que impede alguem de forjar "esta pago" na
  // sua API. Sem ele, o endpoint fica aberto e qualquer um baixa divida
  // de graca.
  //
  // Exigido nos DOIS gateways, e nao so no asaas: o endpoint
  // /api/webhooks/pix existe e responde em qualquer modo. Se o token
  // fosse obrigatorio so no asaas, rodar em modo simulado treinaria
  // justamente o comportamento perigoso (rota aberta) e o deploy em
  //asaas comecaria so no primeiro boot.
  const t = config.webhook.token;
  if (!t) {
    problemas.push(
      'ASAAS_WEBHOOK_TOKEN ausente. Sem ele o endpoint /api/webhooks/pix fica aberto e ' +
      'qualquer um que descubra a URL manda "pago" numa cobranca que nao foi paga. ' +
      'Gere um: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"'
    );
  } else {
    if (t.length < 32 || t.length > 255) {
      problemas.push(`ASAAS_WEBHOOK_TOKEN precisa ter entre 32 e 255 caracteres (tem ${t.length}).`);
    }
    if (/\s/.test(t)) {
      problemas.push('ASAAS_WEBHOOK_TOKEN nao pode conter espacos.');
    }
    if (/^(.)\1+$/.test(t)) {
      problemas.push('ASAAS_WEBHOOK_TOKEN nao pode ser uma sequencia de caracteres repetidos.');
    }
  }

  if (problemas.length > 0) {
    const erro = new ErroDeValidacao('configuracao invalida:\n  - ' + problemas.join('\n  - '));
    erro.status = 500;
    erro.codigo = 'CONFIG_INVALIDA';
    throw erro;
  }

  // Auth: se não configurar, avisa mas não bloqueia (permite testar local sem auth)
  if (!config.auth.usuario || !config.auth.senha) {
    logger.warn('AUTH_USUARIO e/ou AUTH_SENHA não definidos — painel e API abertos sem autenticação');
  }
}

/** Resolve o caminho do banco para absoluto, sem criar nada. */
export function caminhoBancoAbsoluto() {
  if (config.caminhoBanco === ':memory:') return ':memory:';
  return resolve(raiz, config.caminhoBanco);
}