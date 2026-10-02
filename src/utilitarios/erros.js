/**
 * Erro de negocio: erro esperado, com significado para quem consome a API.
 *
 * A DIFFERENCA para um Error comum e o `status` e o `codigo`. O
 * middleware central de erros usa isso para responder HTTP com a causa
 * exata em vez de engolir tudo num 500 generico.
 *
 * @example
 * throw new ErroDeNegocio('cliente nao encontrado', {
 *   status: 404,
 *   codigo: 'CLIENTE_NAO_ENCONTRADO',
 * });
 */
export class ErroDeNegocio extends Error {
  constructor(mensagem, { status = 400, codigo = 'ERRO_DE_NEGOCIO', detalhes = null, causa = null } = {}) {
    super(mensagem, causa ? { cause: causa } : undefined);
    this.name = 'ErroDeNegocio';
    this.status = status;
    this.codigo = codigo;
    this.detalhes = detalhes;
    // Marca como esperado: o middleware de erros loga em nivel 'warn',
    // nao em 'error'. Nao polui o log com-stack de erro para
    // "cliente nao existe".
    this.esperado = true;
  }
}

/** Erro de validacao de entrada (dados que o cliente enviou). */
export class ErroDeValidacao extends ErroDeNegocio {
  constructor(mensagem, { codigo = 'VALIDACAO_INVALIDA', detalhes = null } = {}) {
    super(mensagem, { status: 422, codigo, detalhes });
    this.name = 'ErroDeValidacao';
  }
}

/** Recurso nao encontrado (404). */
export class ErroNaoEncontrado extends ErroDeNegocio {
  constructor(recurso, id = null) {
    super(
      id ? `${recurso} ${id} nao encontrado` : `${recurso} nao encontrado`,
      { status: 404, codigo: 'NAO_ENCONTRADO' }
    );
    this.name = 'ErroNaoEncontrado';
  }
}

/** Conflito de estado: nao e erro do cliente, e' do sistema (409). */
export class ErroDeConflito extends ErroDeNegocio {
  constructor(mensagem, { codigo = 'CONFLITO_DE_ESTADO', detalhes = null } = {}) {
    super(mensagem, { status: 409, codigo, detalhes });
    this.name = 'ErroDeConflito';
  }
}

/**
 * Falha de comunicacao com o gateway de pagamento.
 *
 * Sempre 502: o problema NAO e da Credigest nem do cliente que chamou a
 * API. O 502 e o status que diz isso ao consumidor, e o detalhe fica no
 * log do servidor.
 */
export class ErroDoGateway extends ErroDeNegocio {
  constructor(mensagem, { codigo = 'GATEWAY_INDISPONIVEL', status = 502, gateway = null, resposta = null, causa = null } = {}) {
    super(mensagem, { status, codigo, causa });
    this.name = 'ErroDoGateway';
    this.gateway = gateway;
    this.resposta = resposta;
  }
}

/** Falha de autenticacao no webhook (401). */
export class ErroDeAutenticacao extends ErroDeNegocio {
  constructor(mensagem = 'token invalido') {
    super(mensagem, { status: 401, codigo: 'TOKEN_INVALIDO' });
    this.name = 'ErroDeAutenticacao';
  }
}