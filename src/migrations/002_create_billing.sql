-- Migration 002: Criar tabelas de faturamento

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL DEFAULT 'mercadopago',
  provider_subscription_id VARCHAR(255),
  status_pagamento VARCHAR(50) NOT NULL DEFAULT 'pendente',
  nome_plano VARCHAR(100),
  valor NUMERIC(10,2),
  moeda VARCHAR(10) DEFAULT 'BRL',
  proxima_cobranca TIMESTAMPTZ,
  chave_idempotencia VARCHAR(255) UNIQUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_usuario_id
  ON subscriptions(usuario_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_subscription_id
  ON subscriptions(provider_subscription_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_atualizado_em
  ON subscriptions(atualizado_em DESC);

CREATE TABLE IF NOT EXISTS webhook_idempotency (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chave_idempotencia VARCHAR(255) NOT NULL UNIQUE,
  provider VARCHAR(50) NOT NULL,
  webhook_data JSONB NOT NULL,
  processado_em TIMESTAMPTZ NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_idempotency_provider
  ON webhook_idempotency(provider, processado_em DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_idempotency_chave
  ON webhook_idempotency(chave_idempotencia);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id VARCHAR(255) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  usuario_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status_http INTEGER,
  payload JSONB,
  resposta JSONB,
  tempo_processamento_ms INTEGER,
  erro_codigo VARCHAR(50),
  erro_mensagem TEXT,
  recebido_em TIMESTAMPTZ NOT NULL,
  processado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_provider
  ON webhook_logs(provider, recebido_em DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_usuario_id
  ON webhook_logs(usuario_id);
