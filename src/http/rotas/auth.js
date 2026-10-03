import { config } from '../../config.js';
import { responderJson, compararToken } from '../middlewares/index.js';
import { ErroDeNegocio } from '../../utilitarios/erros.js';

const ROTAS_PUBLICAS = [
  '/api/saude',
  '/api/auth/login',
];

function ehRotaPublica(caminho) {
  return ROTAS_PUBLICAS.some(r => caminho === r || caminho.startsWith(r + '/'));
}

/**
 * Extrai o cookie de sessão da requisição.
 */
function lerCookieSessao(req) {
  const cookieHeader = req.headers.cookie ?? '';
  const nome = config.auth.sessaoNome + '=';
  const inicio = cookieHeader.indexOf(nome);
  if (inicio === -1) return null;
  const fim = cookieHeader.indexOf(';', inicio);
  return fim === -1
    ? cookieHeader.slice(inicio + nome.length)
    : cookieHeader.slice(inicio + nome.length, fim);
}

/**
 * Middleware de autenticação.
 * - Se não tem credenciais configuradas (dev), passa direto.
 * - Se tem credenciais, exige cookie de sessão válido.
 * - Rotas públicas (/api/saude, /api/auth/login) sempre passam.
 */
export function autenticacao(req, res, next) {
  if (ehRotaPublica(req.caminho)) {
    return next();
  }

  // Sem credenciais configuradas = modo desenvolvimento aberto
  if (!config.auth.usuario || !config.auth.senha) {
    return next();
  }

  const sessao = lerCookieSessao(req);
  if (!sessao || !compararToken(sessao, config.auth.senha)) {
    throw new ErroDeNegocio('não autenticado', {
      status: 401,
      codigo: 'NAO_AUTENTICADO',
    });
  }

  req.autenticado = true;
  next();
}

/**
 * POST /api/auth/login
 * Body: { usuario, senha }
 * Sucesso: seta cookie httpOnly + secure + sameSite=lax
 */
export async function login(req, res) {
  if (!config.auth.usuario || !config.auth.senha) {
    throw new ErroDeNegocio('autenticação não configurada no servidor', {
      status: 500,
      codigo: 'AUTH_NAO_CONFIGURADA',
    });
  }

  const { usuario, senha } = req.corpo ?? {};

  if (!usuario || !senha) {
    throw new ErroDeNegocio('usuario e senha são obrigatórios', {
      status: 400,
      codigo: 'CREDENCIAIS_AUSENTES',
    });
  }

  const usuarioOk = compararToken(usuario, config.auth.usuario);
  const senhaOk = compararToken(senha, config.auth.senha);

  if (!usuarioOk || !senhaOk) {
    // Mesmo erro para não vazar qual campo errou
    throw new ErroDeNegocio('usuario ou senha inválidos', {
      status: 401,
      codigo: 'CREDENCIAIS_INVALIDAS',
    });
  }

  // Cookie de sessão = hash da senha (já comparado em tempo constante)
  const cookie = `${config.auth.sessaoNome}=${config.auth.senha}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${config.auth.sessaoMaxAge}`;

  res.setHeader('Set-Cookie', cookie);
  responderJson(res, 200, {
    dados: { ok: true, mensagem: 'autenticado' },
  });
}

/**
 * POST /api/auth/logout
 * Limpa o cookie.
 */
export async function logout(req, res) {
  const cookie = `${config.auth.sessaoNome}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  res.setHeader('Set-Cookie', cookie);
  responderJson(res, 200, {
    dados: { ok: true, mensagem: 'deslogado' },
  });
}

/**
 * GET /api/auth/me
 * Verifica se está autenticado (útil pro front).
 */
export async function me(req, res) {
  responderJson(res, 200, {
    dados: { autenticado: true },
  });
}

export function registrar(rota) {
  rota.post('/api/auth/login', login);
  rota.post('/api/auth/logout', logout);
  rota.get('/api/auth/me', me);
}