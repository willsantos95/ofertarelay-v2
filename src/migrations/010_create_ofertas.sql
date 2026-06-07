-- Migration 010: Tabela de ofertas compartilhada (global, sem separação por usuário)

CREATE TABLE IF NOT EXISTS ofertas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         VARCHAR(255) NOT NULL UNIQUE,
  nome            VARCHAR(500) NOT NULL,
  preco           NUMERIC(10,2) NOT NULL,
  imagem_url      TEXT,
  link_produto    TEXT,
  link_afiliado   TEXT,
  comissao        NUMERIC(10,2),
  taxa_comissao   NUMERIC(6,4),  -- ex: 0.1000 = 10%
  categoria_id    INTEGER,
  categoria_nome  VARCHAR(100),
  status          VARCHAR(50) NOT NULL DEFAULT 'pendente',
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ofertas_status       ON ofertas(status);
CREATE INDEX IF NOT EXISTS idx_ofertas_categoria    ON ofertas(categoria_id);
CREATE INDEX IF NOT EXISTS idx_ofertas_criado_em    ON ofertas(criado_em DESC);
