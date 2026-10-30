-- Migration 018: gestão de usuários pelo admin (cortesia premium, bloqueio, histórico)

-- Acesso premium concedido pelo admin, independente da assinatura paga.
-- O webhook do Mercado Pago altera status_plano, mas não mexe aqui.
ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_ate TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bloqueado_em TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS motivo_bloqueio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS observacao_admin TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ultimo_acesso_em TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_criado_em ON users(criado_em DESC);

CREATE TABLE IF NOT EXISTS admin_acoes (
  id BIGSERIAL PRIMARY KEY,
  admin_email VARCHAR(255) NOT NULL,
  usuario_id UUID REFERENCES users(id) ON DELETE CASCADE,
  acao VARCHAR(50) NOT NULL,
  detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_acoes_usuario ON admin_acoes(usuario_id, criado_em DESC);
