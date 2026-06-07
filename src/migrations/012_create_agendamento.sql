-- Migration 012: Fila de agendamento de envio de ofertas (drip)

-- Configuração por usuário (intervalo, destinos, ativo)
CREATE TABLE IF NOT EXISTS agendamento_config (
  usuario_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  intervalo_min    INTEGER NOT NULL DEFAULT 7,
  ativo            BOOLEAN NOT NULL DEFAULT FALSE,
  grupos           JSONB   NOT NULL DEFAULT '[]'::jsonb,
  enviar_telegram  BOOLEAN NOT NULL DEFAULT FALSE,
  proximo_envio_em TIMESTAMPTZ,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Itens da fila (cada oferta a ser enviada)
CREATE TABLE IF NOT EXISTS agendamento_itens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  oferta_id   UUID NOT NULL REFERENCES ofertas(id) ON DELETE CASCADE,
  legenda     TEXT NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pendente', -- pendente | enviado | erro
  enviado_em  TIMESTAMPTZ,
  erro        TEXT,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agend_itens_fila
  ON agendamento_itens(usuario_id, status, criado_em);
