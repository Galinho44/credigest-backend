-- Migration 006: contas_bancarias
-- Armazena as chaves Pix do recebedor (dados bancarios do usuario logado)

CREATE TABLE IF NOT EXISTS contas_bancarias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id TEXT NOT NULL, -- id do usuario no Supabase/auth
  tipo_chave TEXT NOT NULL CHECK (tipo_chave IN ('cpf', 'cnpj', 'email', 'telefone', 'aleatoria')),
  chave_pix TEXT NOT NULL,
  nome_titular TEXT NOT NULL,
  banco TEXT NOT NULL,
  agencia TEXT,
  conta TEXT,
  conta_dv TEXT,
  padrao BOOLEAN DEFAULT 0,
  ativa BOOLEAN DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  atualizado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(usuario_id, tipo_chave, chave_pix)
);

-- Trigger para atualizar atualizado_em
CREATE TRIGGER IF NOT EXISTS trg_contas_bancarias_atualizado
AFTER UPDATE ON contas_bancarias
FOR EACH ROW
BEGIN
  UPDATE contas_bancarias SET atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- Index para busca rapida
CREATE INDEX IF NOT EXISTS idx_contas_bancarias_usuario ON contas_bancarias(usuario_id);
CREATE INDEX IF NOT EXISTS idx_contas_bancarias_padrao ON contas_bancarias(usuario_id, padrao) WHERE padrao = 1;