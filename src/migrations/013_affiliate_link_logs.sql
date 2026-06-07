-- Migration 013: Logs de criação de links de afiliado (Shopee + ML)

CREATE TABLE IF NOT EXISTS affiliate_link_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  plataforma    VARCHAR(20) NOT NULL,       -- 'shopee' | 'mercadolivre'
  contexto      VARCHAR(50) NOT NULL DEFAULT 'envio', -- 'envio' | 'sincronizacao' | 'manual'
  url_origem    TEXT NOT NULL,
  url_gerada    TEXT,
  sucesso       BOOLEAN NOT NULL DEFAULT FALSE,
  erro          TEXT,
  duracao_ms    INTEGER,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aff_logs_usuario  ON affiliate_link_logs(usuario_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_aff_logs_plat     ON affiliate_link_logs(plataforma, sucesso);
CREATE INDEX IF NOT EXISTS idx_aff_logs_criado   ON affiliate_link_logs(criado_em DESC);
