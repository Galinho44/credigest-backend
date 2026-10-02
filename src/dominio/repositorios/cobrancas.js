import { banco } from '../../banco/conexao.js';
import { ErroNaoEncontrado, ErroDeValidacao } from '../../utilitarios/erros.js';

/**
 * Repositorio de cobrancas Pix.
 *
 * Ponto mais delicado do arquivo: `registrarBaixa` e' IDEMPOTENTE.
 *
 * Por que: o gateway entrega webhook "at least once". O mesmo evento
 * chega 2, 3, 10 vezes. Se cada chegada reescrevesse `pago_em`, a
 * baixa ficaria instavel e a data do pagamento mudaria. O `WHERE pago_em
 * IS NULL` faz o UPDATE nao afetar nada na segunda vez, e o
 * `changes === 0` diz que ja estava baixada.
 *
 * Obs.: valem mais o `UPDATE ... WHERE pago_em IS NULL` e a PRIMARY KEY
 * de eventos_webhook do que checar antes e depois. Um check-then-act tem
 * corrida; o UPDATE condicional nao.
 */

/**
 * @param {object} dados
 * @param {number} dados.valor_centavos  INTEIRO EM CENTAVOS. Nao reais.
 */
export function criar(dados) {
  // ATENCAO: aqui nao se converte nada. `valor_centavos` ja vem em
  // centavos de quem chamou. Uma versao anterior aplicava paraCentavos()
  // neste ponto e multiplicava o valor por 100 (R$ 100 -> 10.000,00).
  // A conversao de reais para centavos acontece SO na borda HTTP e no
  // gateway; dentro do dominio o dinheiro ja e inteiro.
  if (!Number.isInteger(dados.valor_centavos) || dados.valor_centavos <= 0) {
    throw new ErroDeValidacao(
      `valor_centavos precisa ser inteiro positivo, em centavos (recebido: ${JSON.stringify(dados.valor_centavos)})`,
      { codigo: 'VALOR_CENTAVOS_INVALIDO' }
    );
  }

  const info = banco().db
    .prepare(
      `INSERT INTO cobrancas
         (divida_id, cliente_id, gateway, id_transacao_gateway, valor_centavos,
          pix_copia_e_cola, qr_code_url, status_gateway)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      dados.divida_id ?? null,
      dados.cliente_id,
      dados.gateway,
      dados.id_transacao_gateway ?? null,
      dados.valor_centavos,
      dados.pix_copia_e_cola ?? null,
      dados.qr_code_url ?? null,
      dados.status_gateway ?? 'PENDENTE'
    );

  return buscarPorId(Number(info.lastInsertRowid));
}

export function buscarPorId(id) {
  const linha = banco().db.prepare('SELECT * FROM vw_cobrancas WHERE id = ?').get(id);
  if (!linha) throw new ErroNaoEncontrado('cobranca', id);
  return linha;
}

/**
 * Procura pelo id que o GATEWAY devolveu, nao pelo nosso id.
 * E' assim que o webhook encontra a cobranca certa.
 */
export function buscarPorTransacaoDoGateway(gateway, idTransacaoGateway) {
  if (!idTransacaoGateway) return null;
  return (
    banco().db
      .prepare('SELECT * FROM vw_cobrancas WHERE gateway = ? AND id_transacao_gateway = ?')
      .get(gateway, idTransacaoGateway) ?? null
  );
}

/**
 * Pix ainda em aberto desta divida, para reaproveitar.
 *
 * Filtra por `status_gateway = 'PENDENTE'` e NAO pelo status derivado da
 * view. Sao coisas diferentes:
 *
 *   - status (derivado) = 'PENDENTE'  -> ninguem pagou. Vale tambem para
 *     uma cobranca cujo gateway FALHOU (status_gateway = 'ERRO'), que
 *     nunca teve codigo Pix nenhum.
 *   - status_gateway = 'PENDENTE'     -> o gateway RECEBEU o pedido e
 *     mandou o Pix copia-e-cola. Esse e o unico que da para reenviar.
 *
 * Sem essa distincao, uma falha de rede no gateway deixava a divida
 * travada para sempre: o servico "reaproveitava" um registro sem Pix e
 * devolvia 200 para o usuario com um codigo vazio.
 */
export function buscarPixPendenteDaDivida(dividaId) {
  return (
    banco().db
      .prepare(
        `SELECT * FROM vw_cobrancas
          WHERE divida_id = ?
            AND pago_em IS NULL
            AND status_gateway = 'PENDENTE'
            AND pix_copia_e_cola IS NOT NULL
          ORDER BY criado_em DESC`
      )
      .get(dividaId) ?? null
  );
}

export function listar({ cliente_id = null, status = null, limite = 50, offset = 0 } = {}) {
  const onde = [];
  const valores = [];

  if (cliente_id !== null) {
    onde.push('cliente_id = ?');
    valores.push(cliente_id);
  }
  if (status) {
    onde.push('status = ?');
    valores.push(String(status).toUpperCase());
  }

  const filtro = onde.length ? `WHERE ${onde.join(' AND ')}` : '';
  return banco().db
    .prepare(`SELECT * FROM vw_cobrancas ${filtro} ORDER BY criado_em DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...valores, limite, offset);
}

/**
 * Baixa a cobranca. Idempotente.
 *
 * @returns {{alterada: boolean, cobranca: object}}
 *   alterada=false significa: ja estava paga, nao mexi em nada.
 */
export function registrarBaixa({ gateway, idTransacaoGateway, idPagamentoGateway = null, pagoEm = null, valorPagoCentavos = null, statusGateway = 'RECEBIDO' }) {
  const db = banco().db;

  const info = db
    .prepare(
      `UPDATE cobrancas
          SET pago_em              = COALESCE(?, pago_em),
              id_pagamento_gateway = COALESCE(?, id_pagamento_gateway),
              valor_pago_centavos  = COALESCE(?, valor_pago_centavos),
              status_gateway       = ?,
              atualizado_em        = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE gateway = ?
          AND id_transacao_gateway = ?
          AND pago_em IS NULL`
    )
    .run(
      pagoEm ?? new Date().toISOString(),
      idPagamentoGateway,
      valorPagoCentavos,
      statusGateway,
      gateway,
      idTransacaoGateway
    );

  const cobranca = buscarPorTransacaoDoGateway(gateway, idTransacaoGateway);
  if (!cobranca) throw new ErroNaoEncontrado('cobranca do gateway', idTransacaoGateway);

  return { alterada: info.changes > 0, cobranca };
}

/**
 * Sincroniza o espelho do status do gateway (consulta, sem baixa).
 * Nunca mexe em pago_em.
 */
export function sincronizarStatusGateway({ gateway, idTransacaoGateway, statusGateway }) {
  const db = banco().db;
  db.prepare(
    `UPDATE cobrancas
        SET status_gateway = ?,
            atualizado_em  = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE gateway = ? AND id_transacao_gateway = ?`
  ).run(statusGateway, gateway, idTransacaoGateway);
}

/** Preenche o QR Code / copia-e-cola depois que o gateway responde. */
export function anexarPix(id, { pix_copia_e_cola, qr_code_url }) {
  banco().db
    .prepare(
      `UPDATE cobrancas
          SET pix_copia_e_cola = ?,
              qr_code_url      = ?,
              atualizado_em    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?`
    )
    .run(pix_copia_e_cola ?? null, qr_code_url ?? null, id);

  return buscarPorId(id);
}