-- =====================================================================
-- Credigest - migration 001: estrutura inicial
--
-- CONVENCAO DE DATA/HORA
-- Todo timestamps e gravado em ISO 8601 UTC (ex.: 2026-10-02T15:04:05.123Z)
-- via strftime. Isso e o mesmo formato que o JavaScript Date#toISOString()
-- devolve, entao nao existe conversao manual em nenhum lugar do codigo.
--
-- REGRA DE OURO DO STATUS
-- O status de uma cobranca NAO e um campo guardado: ele e DERIVADO de
-- cobrancas.pago_em. Se pagamento != null -> "PAGO", senao -> "PENDENTE".
-- Isso impede o classico bug de status dessincronizado do banco (pago no
-- gateway, mas "PENDENTE" na tela), porque existe so uma fonte da verdade.
-- =====================================================================

-- ---------------------------------------------------------------------
-- clientes
-- ---------------------------------------------------------------------
CREATE TABLE clientes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT    NOT NULL CHECK (length(trim(nome)) >= 2),
    email       TEXT,
    -- DDD guardado separado do numero. A Credigest formata 55+DDD+numero na
    -- hora de montar o link do WhatsApp, entao os dois precisam ser validados
    -- por conta propria.
    ddd         TEXT    NOT NULL CHECK (ddd GLOB '[0-9][0-9]'),
    telefone    TEXT    NOT NULL CHECK (telefone GLOB '[0-9][0-9]*'),
    documento   TEXT,
    criado_em   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------
-- dividas
-- A obrigacao financeira do cliente. NAO tem coluna de status: o status e
-- derivado das cobrancas desta divida (ver view vw_dividas).
-- ---------------------------------------------------------------------
CREATE TABLE dividas (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id     INTEGER NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
    descricao      TEXT    NOT NULL CHECK (length(trim(descricao)) >= 3),
    -- Dinheiro SEMPRE em centavos, como inteiro. Float nao serve para
    -- dinheiro: 0.1 + 0.2 !== 0.3 e o erro se acumula a cada soma.
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
    vencimento     TEXT,
    criado_em      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------
-- cobrancas
-- Uma tentativa de cobranca via Pix junto ao gateway.
-- ---------------------------------------------------------------------
CREATE TABLE cobrancas (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    divida_id             INTEGER REFERENCES dividas(id) ON DELETE SET NULL,
    cliente_id            INTEGER NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,

    gateway               TEXT    NOT NULL,

    -- Id que o gateway devolveu. NULL significa: criamos no gateway mas
    -- ele nao respondeu / deu timeout, entao nao sabemos o id.
    id_transacao_gateway  TEXT,

    -- Guardamos o valor que ENVIAMOS ao gateway, para conseguir conferir
    -- depois se o gateway cobrou o mesmo valor. Nao confiamos no valor que
    -- volta no webhook: o valor de referencia e o nosso.
    valor_centavos        INTEGER NOT NULL CHECK (valor_centavos > 0),

    pix_copia_e_cola      TEXT,
    qr_code_url           TEXT,

    -- Espelho do que o gateway disse. Consulta, nao verdade.
    status_gateway        TEXT    NOT NULL DEFAULT 'PENDENTE',

    -- ---- FONTE DA VERDADE DO STATUS ----
    -- Preenchido uma unica vez, pelo webhook, quando o pagamento e
    -- confirmado. Nunca e zerado: um pagamento confirmado nao volta a ser
    -- pendente.
    pago_em               TEXT,
    id_pagamento_gateway  TEXT,
    valor_pago_centavos   INTEGER,

    criado_em             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    atualizado_em         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------
-- eventos_webhook
-- Controle de idempotencia.
--
-- O Asaas entrega webhooks "at least once": o MESMO evento pode chegar
-- varias vezes (timeout da nossa resposta, retentativa do gateway, etc).
-- A chave primaria em id_evento faz o segundo recebimento ser ignorado.
-- ---------------------------------------------------------------------
CREATE TABLE eventos_webhook (
    id_evento            TEXT    PRIMARY KEY,
    gateway              TEXT    NOT NULL,
    tipo                 TEXT    NOT NULL,
    id_transacao_gateway TEXT,
    processado           INTEGER NOT NULL DEFAULT 0,
    resultado            TEXT,
    erro                 TEXT,
    recebido_em          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    processado_em        TEXT
);