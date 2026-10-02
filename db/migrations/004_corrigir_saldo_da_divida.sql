-- =====================================================================
-- Credigest - migration 004: corrige o saldo da divida
--
-- POR QUE ESTA MIGRATION EXISTE
-- A 002 criou a vw_dividas com este trecho:
--
--     COALESCE(valor_pago_centavos, valor_centavos) AS pago_centavos
--
-- dentro de um subselect sobre TODAS as cobrancas, sem filtrar `pago_em`.
-- Ou seja: uma cobranca que foi emitida mas ainda NAO foi paga
-- (pago_em = NULL, valor_pago_centavos = NULL) caia no COALESCE e entrava
-- na soma como se estivesse paga.
--
-- O resultado na tela: divida com Pix pendente aparecia como
--   status  = PENDENTE   (isto esta certo, vem do EXISTS)
--   saldo   = R$ 0,00    (isto esta ERRADO)
-- Um painel que mostra "deve R$ 0,00" e "pendente" ao mesmo tempo faz o
-- usuario desconfiar do sistema inteiro. Pior: `resumo()` soma
-- `saldo_centavos` das pendentes para calcular `a_receber_centavos`, entao
-- o total a receber do painel saia zerado.
--
-- O QUE MUDOU
-- 1. O subselect da vw_dividas passa a trazer 0 (nao o valor cheio) para
--    cobranca sem `pago_em`. Soma so de dinheiro que entrou de verdade.
-- 2. A vw_cobrancas passou a expor `descricao_divida`, que a mensagem de
--    WhatsApp usa para dizer ao cliente o que ele esta pagando. Sem isso a
--    mensagem saia generica, ou o codigo tinha que fazer um JOIN a parte.
--
-- Nao editei a 002 de proposito: ela ja foi aplicada e o runner guarda
-- checksum. Alterar arquivo aplicado faz o sistema avisar e nao reaplicar.
-- Correcao de dado sempre entra como migration nova.
-- =====================================================================

DROP VIEW IF EXISTS vw_dividas;
DROP VIEW IF EXISTS vw_cobrancas;

-- ---------------------------------------------------------------------
-- View: divida com status derivado e saldo CORRETO
-- ---------------------------------------------------------------------
CREATE VIEW vw_dividas AS
SELECT
    d.id,
    d.cliente_id,
    c.nome                  AS cliente_nome,
    d.descricao,
    d.valor_centavos,
    d.vencimento,
    d.criado_em,

    CASE
        WHEN EXISTS (
            SELECT 1 FROM cobrancas cb
            WHERE cb.divida_id = d.id AND cb.pago_em IS NOT NULL
        ) THEN 'PAGO'
        ELSE 'PENDENTE'
    END                    AS status,

    -- Soma SO de cobranca com pagamento confirmado. A correcao esta no
    -- CASE: sem `pago_em IS NOT NULL` o COALESCE transformava cobranca
    -- pendente em dinheiro recebido.
    COALESCE(SUM(cb.pago_centavos), 0) AS valor_pago_centavos,

    -- Saldo nunca fica negativo: se o cliente pagou mais do que devia
    -- (gorjeta, parcelamento), o saldo e 0 e a diferenca fica visivel em
    -- `valor_pago_centavos`. Numero negativo na tela vira "a Credigest
    -- deve dinheiro ao cliente", que nao e o que o saldo significa.
    MAX(d.valor_centavos - COALESCE(SUM(cb.pago_centavos), 0), 0) AS saldo_centavos,

    MAX(cb.pago_em)       AS pago_em

FROM dividas d
JOIN clientes c ON c.id = d.cliente_id
LEFT JOIN (
    SELECT
        id,
        divida_id,
        pago_em,
        CASE
            WHEN pago_em IS NOT NULL
            THEN COALESCE(valor_pago_centavos, valor_centavos)
            ELSE 0
        END AS pago_centavos
    FROM cobrancas
) cb ON cb.divida_id = d.id
GROUP BY d.id;

-- ---------------------------------------------------------------------
-- View: cobranca com status derivado + dados do cliente e da divida
-- ---------------------------------------------------------------------
CREATE VIEW vw_cobrancas AS
SELECT
    cb.*,
    CASE WHEN cb.pago_em IS NOT NULL THEN 'PAGO' ELSE 'PENDENTE' END AS status,
    c.nome        AS cliente_nome,
    c.email       AS cliente_email,
    c.ddd         AS cliente_ddd,
    c.telefone    AS cliente_telefone,

    -- Texto que o cliente vai ler na mensagem de WhatsApp. Cobranca
    -- avulsa (divida_id NULL) cai no COALESCE para 'Cobranca avulsa'.
    COALESCE(d.descricao, 'Cobranca avulsa') AS descricao_divida
FROM cobrancas cb
JOIN clientes c ON c.id = cb.cliente_id
LEFT JOIN dividas d ON d.id = cb.divida_id;