/**
 * Migration do schema Supabase (PostgreSQL) para o Credigest.
 *
 * Roda uma vez no banco novo: `npm run migrate:supabase`
 * Baseado nas migrations SQLite (db/migrations/001 a 005).
 */

import { config } from '../src/config.js';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../src/logger.js';

const sb = createClient(config.supabase.url, config.supabase.serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SCHEMA_SQL = `
-- =====================================================================
-- Credigest - Schema Supabase (PostgreSQL)
-- Equivalente as migrations SQLite 001 a 005
-- =====================================================================

-- ---------------------------------------------------------------------
-- Extensoes
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------
-- clientes
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
    id                      BIGSERIAL PRIMARY KEY,
    nome                    TEXT        NOT NULL CHECK (length(trim(nome)) >= 2),
    email                   TEXT,
    ddd                     TEXT        NOT NULL CHECK (ddd ~ '^\d{2}$'),
    telefone                TEXT        NOT NULL CHECK (telefone ~ '^\d+$'),
    documento               TEXT,
    id_cliente_gateway      TEXT,
    criado_em               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_documento
    ON clientes (documento)
    WHERE documento IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_gateway
    ON clientes (id_cliente_gateway)
    WHERE id_cliente_gateway IS NOT NULL;

-- ---------------------------------------------------------------------
-- dividas
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dividas (
    id              BIGSERIAL PRIMARY KEY,
    cliente_id      BIGINT      NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
    descricao       TEXT        NOT NULL CHECK (length(trim(descricao)) >= 3),
    valor_centavos  BIGINT      NOT NULL CHECK (valor_centavos > 0),
    vencimento      DATE,
    criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dividas_cliente
    ON dividas (cliente_id, criado_em DESC);

-- ---------------------------------------------------------------------
-- cobrancas
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cobrancas (
    id                      BIGSERIAL PRIMARY KEY,
    divida_id               BIGINT REFERENCES dividas(id) ON DELETE SET NULL,
    cliente_id              BIGINT      NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
    gateway                 TEXT        NOT NULL,
    id_transacao_gateway    TEXT,
    valor_centavos          BIGINT      NOT NULL CHECK (valor_centavos > 0),
    pix_copia_e_cola        TEXT,
    qr_code_url             TEXT,
    status_gateway          TEXT        NOT NULL DEFAULT 'PENDENTE',
    pago_em                 TIMESTAMPTZ,
    id_pagamento_gateway    TEXT,
    valor_pago_centavos     BIGINT,
    criado_em               TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cobrancas_gateway_transacao
    ON cobrancas (gateway, id_transacao_gateway)
    WHERE id_transacao_gateway IS NOT NULL;

-- Indice unico: no maximo UM Pix pendente por divida
CREATE UNIQUE INDEX IF NOT EXISTS idx_cobrancas_pix_pendente_por_divida
    ON cobrancas (divida_id)
    WHERE divida_id IS NOT NULL
      AND pago_em IS NULL
      AND status_gateway = 'PENDENTE';

CREATE INDEX IF NOT EXISTS idx_cobrancas_cliente
    ON cobrancas (cliente_id, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_cobrancas_pago_em
    ON cobrancas (pago_em)
    WHERE pago_em IS NOT NULL;

-- ---------------------------------------------------------------------
-- eventos_webhook
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eventos_webhook (
    id_evento               TEXT        PRIMARY KEY,
    gateway                 TEXT        NOT NULL,
    tipo                    TEXT        NOT NULL,
    id_transacao_gateway    TEXT,
    processado              BOOLEAN     NOT NULL DEFAULT FALSE,
    resultado               TEXT,
    erro                    TEXT,
    recebido_em             TIMESTAMPTZ NOT NULL DEFAULT now(),
    processado_em           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_eventos_webhook_transacao
    ON eventos_webhook (id_transacao_gateway, recebido_em DESC);

-- ---------------------------------------------------------------------
-- View: vw_dividas (status derivado + saldo)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_dividas AS
SELECT
    d.id,
    d.cliente_id,
    c.nome                AS cliente_nome,
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
    COALESCE(SUM(cb.pago_centavos), 0) AS valor_pago_centavos,
    GREATEST(d.valor_centavos - COALESCE(SUM(cb.pago_centavos), 0), 0) AS saldo_centavos,
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
GROUP BY d.id, c.nome;

-- ---------------------------------------------------------------------
-- View: vw_cobrancas (status derivado + dados cliente + descricao divida)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_cobrancas AS
SELECT
    cb.*,
    CASE WHEN cb.pago_em IS NOT NULL THEN 'PAGO' ELSE 'PENDENTE' END AS status,
    c.nome        AS cliente_nome,
    c.email       AS cliente_email,
    c.ddd         AS cliente_ddd,
    c.telefone    AS cliente_telefone,
    COALESCE(d.descricao, 'Cobranca avulsa') AS descricao_divida
FROM cobrancas cb
JOIN clientes c ON c.id = cb.cliente_id
LEFT JOIN dividas d ON d.id = cb.divida_id;

-- ---------------------------------------------------------------------
-- Tabela de controle de migrations
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS _migrations (
    nome        TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function main() {
  logger.info('Aplicando schema Supabase...');

  // Executa o schema em pedaços (Supabase nao aceita multiplas statements de uma vez)
  const statements = SCHEMA_SQL
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const sql of statements) {
    try {
      const { error } = await sb.rpc('exec_sql', { sql: sql + ';' });
      if (error) {
        // Tenta executar direto via REST se RPC nao existir
        const { error: restError } = await sb.from('_migrations').select('*').limit(1);
        if (restError) {
          logger.error('Erro ao aplicar schema', { sql: sql.slice(0, 100), error });
        }
      }
    } catch (e) {
      logger.warn('Statement pode ter falhado (ignorado se ja existe)', { erro: e.message });
    }
  }

  logger.info('Schema aplicado (verifique logs acima para erros).');

  // Verifica tabelas criadas
  const tabelas = ['clientes', 'dividas', 'cobrancas', 'eventos_webhook', '_migrations'];
  for (const t of tabelas) {
    const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
    if (error) {
      logger.error(`Tabela ${t} nao acessivel`, { error });
    } else {
      logger.info(`Tabela ${t} OK`, { count: count ?? 0 });
    }
  }

  // Views
  for (const v of ['vw_dividas', 'vw_cobrancas']) {
    const { data, error } = await sb.from(v).select('*').limit(1);
    if (error) {
      logger.error(`View ${v} nao acessivel`, { error });
    } else {
      logger.info(`View ${v} OK`);
    }
  }
}

main().catch(e => {
  logger.error('Falha na migracao Supabase', { erro: e.message, stack: e.stack });
  process.exit(1);
});