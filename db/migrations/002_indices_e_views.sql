-- =====================================================================
-- Credigest - migration 002: indices e views de leitura
--
-- Views: e aqui que mora o STATUS DERIVADO. Nenhuma tabela guarda
-- "PAGO"/"PENDENTE" em coluna; o status e calculado na leitura a partir
-- de pago_em. Assim nao existe coluna para dessincronizar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Indices
-- ---------------------------------------------------------------------

-- Documento (CPF/CNPJ) e a identificacao natural do cliente: dois cadastro
-- com o mesmo documento e' o mesmo cliente. Unique parcial porque o
-- documento e' opcional (quem nao tem, tem varios NULLs e NULLs nao
-- conflitam entre si).
CREATE UNIQUE INDEX idx_clientes_documento
    ON clientes (documento)
    WHERE documento IS NOT NULL;

CREATE INDEX idx_dividas_cliente
    ON dividas (cliente_id, criado_em DESC);

CREATE INDEX idx_cobrancas_cliente
    ON cobrancas (cliente_id, criado_em DESC);

-- Um id do gateway so pode pertencer a UMA cobranca nossa. Garante que o
-- webhook nao atualize a linha errada.
CREATE UNIQUE INDEX idx_cobrancas_gateway_transacao
    ON cobrancas (gateway, id_transacao_gateway)
    WHERE id_transacao_gateway IS NOT NULL;

-- REGRA DE NEGOCIO IMPOSTA PELO BANCO:
-- no maximo UM Pix pendente por divida. Se o cliente pedir um Pix novo para
-- uma divida que ja tem um pendente, o servico devolve o existente em vez
-- de criar outro (idempotencia). Se o gateway marcar o antigo como
-- CANCELADO/DELETED, a linha sai deste indice e um novo Pix pode ser gerado.
CREATE UNIQUE INDEX idx_cobrancas_pix_pendente_por_divida
    ON cobrancas (divida_id)
    WHERE divida_id IS NOT NULL
      AND pago_em IS NULL
      AND status_gateway = 'PENDENTE';

CREATE INDEX idx_cobrancas_pago_em
    ON cobrancas (pago_em)
    WHERE pago_em IS NOT NULL;

CREATE INDEX idx_eventos_webhook_transacao
    ON eventos_webhook (id_transacao_gateway, recebido_em DESC);

-- ---------------------------------------------------------------------
-- View: divida com status derivado
-- ---------------------------------------------------------------------
CREATE VIEW vw_dividas AS
SELECT
    d.id,
    d.cliente_id,
    c.nome                AS cliente_nome,
    d.descricao,
    d.valor_centavos,
    d.vencimento,
    d.criado_em,

    -- Uma divida so esta PAGA quando existe alguma cobranca dela com
    -- pagamento confirmado. Uma divida sem nenhuma cobranca ainda esta
    -- PENDENTE.
    CASE
        WHEN EXISTS (
            SELECT 1 FROM cobrancas cb
            WHERE cb.divida_id = d.id AND cb.pago_em IS NOT NULL
        ) THEN 'PAGO'
        ELSE 'PENDENTE'
    END                    AS status,

    COALESCE(SUM(cb.pago_centavos), 0) AS valor_pago_centavos,
    d.valor_centavos - COALESCE(SUM(cb.pago_centavos), 0) AS saldo_centavos,

    MAX(cb.pago_em)       AS pago_em

FROM dividas d
JOIN clientes c ON c.id = d.cliente_id
LEFT JOIN (
    SELECT
        id,
        divida_id,
        pago_em,
        COALESCE(valor_pago_centavos, valor_centavos) AS pago_centavos
    FROM cobrancas
) cb ON cb.divida_id = d.id
GROUP BY d.id;

-- ---------------------------------------------------------------------
-- View: cobranca com status derivado + dados do cliente prontos pro WhatsApp
-- ---------------------------------------------------------------------
CREATE VIEW vw_cobrancas AS
SELECT
    cb.*,
    CASE WHEN cb.pago_em IS NOT NULL THEN 'PAGO' ELSE 'PENDENTE' END AS status,
    c.nome    AS cliente_nome,
    c.email   AS cliente_email,
    c.ddd     AS cliente_ddd,
    c.telefone AS cliente_telefone
FROM cobrancas cb
JOIN clientes c ON c.id = cb.cliente_id;