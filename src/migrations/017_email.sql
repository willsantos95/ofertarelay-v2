-- Migration 017: servidor de e-mail configurável pelo admin + confirmação de cadastro

CREATE TABLE IF NOT EXISTS configuracoes_sistema (
  chave VARCHAR(50) PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por VARCHAR(255)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmado_em TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS tokens_confirmacao_email (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash_token VARCHAR(255) NOT NULL UNIQUE,
  expira_em TIMESTAMPTZ NOT NULL,
  usado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tce_usuario_id ON tokens_confirmacao_email(usuario_id);

-- Registro dos e-mails enviados (diagnóstico pelo admin)
CREATE TABLE IF NOT EXISTS email_logs (
  id BIGSERIAL PRIMARY KEY,
  para VARCHAR(255) NOT NULL,
  tipo VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_logs_criado_em ON email_logs(criado_em DESC);
