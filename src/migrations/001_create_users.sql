-- Migration 001: Criar tabela users
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  senha_hash VARCHAR(255) NOT NULL,
  chave_api VARCHAR(255) NOT NULL UNIQUE,
  status_plano VARCHAR(50) NOT NULL DEFAULT 'trial',
  trial_termina_em TIMESTAMPTZ NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deletado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ativo
  ON users(LOWER(email)) WHERE deletado_em IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_chave_api
  ON users(chave_api) WHERE deletado_em IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_deletado_em ON users(deletado_em);

CREATE TABLE IF NOT EXISTS tokens_reset_senha (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash_token VARCHAR(255) NOT NULL UNIQUE,
  expira_em TIMESTAMPTZ NOT NULL,
  usado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trs_usuario_id ON tokens_reset_senha(usuario_id);
CREATE INDEX IF NOT EXISTS idx_trs_expira_em ON tokens_reset_senha(expira_em);
