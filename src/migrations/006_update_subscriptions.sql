-- Migration 006: Atualizar tabela subscriptions para suporte completo ao MP

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_customer_id VARCHAR(255);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS checkout_url TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS next_payment_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- Converter valor para suportar casas decimais (ex: 49.90)
ALTER TABLE subscriptions ALTER COLUMN valor TYPE NUMERIC(10,2);
