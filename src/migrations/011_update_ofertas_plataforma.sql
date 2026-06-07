-- Migration 011: Adicionar campos de plataforma e desconto na tabela ofertas

ALTER TABLE ofertas ADD COLUMN IF NOT EXISTS plataforma VARCHAR(50) NOT NULL DEFAULT 'shopee';
ALTER TABLE ofertas ADD COLUMN IF NOT EXISTS preco_original NUMERIC(10,2);
ALTER TABLE ofertas ADD COLUMN IF NOT EXISTS desconto_pct INTEGER;

CREATE INDEX IF NOT EXISTS idx_ofertas_plataforma ON ofertas(plataforma);
