-- Rastreia quais usuários já enviaram cada oferta.
-- A tabela ofertas.status global não é mais usada para controle de "enviado por mim".
CREATE TABLE IF NOT EXISTS ofertas_enviadas (
  oferta_id  UUID NOT NULL REFERENCES ofertas(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  enviado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (oferta_id, usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_ofertas_enviadas_usuario
  ON ofertas_enviadas (usuario_id);
