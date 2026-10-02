-- =====================================================================
-- Credigest - migration 003: id do cliente no gateway
--
-- Sem esta coluna, cada geracao de Pix criaria um cliente NOVO no Asaas
-- (POST /v3/customers), e o painel do Asaas encheria de "Joao Silva"
-- repetido. Guardar o id devolvido pelo gateway faz a integracao
-- idempotente do lado do gateway tambem.
--
-- UNIQUE: um id do gateway so pode pertencer a um cliente nosso.
-- =====================================================================

ALTER TABLE clientes ADD COLUMN id_cliente_gateway TEXT;

CREATE UNIQUE INDEX idx_clientes_gateway
    ON clientes (id_cliente_gateway)
    WHERE id_cliente_gateway IS NOT NULL;