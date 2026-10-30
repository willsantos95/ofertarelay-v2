-- Migration 015: detalhes por oferta em relay_logs (usado pelo relay v3 e pelos envios manuais/agendados)
-- Todas as colunas são opcionais: registros antigos continuam válidos.

ALTER TABLE relay_logs ADD COLUMN IF NOT EXISTS origem         VARCHAR(20) NOT NULL DEFAULT 'relay'; -- relay | manual | agendado
ALTER TABLE relay_logs ADD COLUMN IF NOT EXISTS motivo         TEXT;
ALTER TABLE relay_logs ADD COLUMN IF NOT EXISTS destinos_total INTEGER;
ALTER TABLE relay_logs ADD COLUMN IF NOT EXISTS destinos_ok    INTEGER;
ALTER TABLE relay_logs ADD COLUMN IF NOT EXISTS duracao_ms     INTEGER;
ALTER TABLE relay_logs ADD COLUMN IF NOT EXISTS tem_imagem     BOOLEAN;
ALTER TABLE relay_logs ADD COLUMN IF NOT EXISTS message_id     VARCHAR(100);
ALTER TABLE relay_logs ADD COLUMN IF NOT EXISTS execucao_id    VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_relay_logs_usuario_data   ON relay_logs(usuario_id, relayado_em DESC);
CREATE INDEX IF NOT EXISTS idx_relay_logs_usuario_status ON relay_logs(usuario_id, status);
