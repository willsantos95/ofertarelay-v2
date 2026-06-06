-- Migration 004: Criar tabelas n8n

CREATE TABLE IF NOT EXISTS n8n_access_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint VARCHAR(255) NOT NULL,
  metodo VARCHAR(10) NOT NULL,
  status_http INTEGER NOT NULL,
  tempo_resposta_ms INTEGER,
  instancia_nome VARCHAR(255),
  ip_origem VARCHAR(45),
  user_agent TEXT,
  erro_codigo VARCHAR(50),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nal_usuario_id ON n8n_access_logs(usuario_id);
CREATE INDEX IF NOT EXISTS idx_nal_endpoint ON n8n_access_logs(endpoint);
CREATE INDEX IF NOT EXISTS idx_nal_criado_em ON n8n_access_logs(criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_nal_usuario_endpoint
  ON n8n_access_logs(usuario_id, endpoint, criado_em DESC);

CREATE TABLE IF NOT EXISTS relay_logs (
  id BIGSERIAL PRIMARY KEY,
  usuario_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instancia_nome VARCHAR(255) NOT NULL,
  grupo_origem_jid VARCHAR(255),
  grupo_origem_nome VARCHAR(255),
  grupo_destino_jid VARCHAR(255),
  grupo_destino_nome VARCHAR(255),
  loja VARCHAR(50),
  nicho VARCHAR(100) DEFAULT 'geral',
  url_original TEXT,
  url_afiliada TEXT,
  titulo_oferta VARCHAR(500),
  preco VARCHAR(50),
  status VARCHAR(50),
  relayado_em TIMESTAMPTZ NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_relay_logs_usuario_id ON relay_logs(usuario_id);
CREATE INDEX IF NOT EXISTS idx_relay_logs_relayado_em ON relay_logs(relayado_em DESC);
CREATE INDEX IF NOT EXISTS idx_relay_logs_usuario_nicho ON relay_logs(usuario_id, nicho);
