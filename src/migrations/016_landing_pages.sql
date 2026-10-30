-- Migration 016: landing page pública do usuário (link na bio), ex.: ofertarelay.com.br/capivaraofertas

CREATE TABLE IF NOT EXISTS landing_pages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id           UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  slug                 VARCHAR(40)  NOT NULL,
  titulo               VARCHAR(80)  NOT NULL DEFAULT '',
  descricao            VARCHAR(300) NOT NULL DEFAULT '',
  cor                  VARCHAR(7)   NOT NULL DEFAULT '#16a34a',
  publicada            BOOLEAN      NOT NULL DEFAULT TRUE,
  imagem               BYTEA,
  imagem_mime          VARCHAR(40),
  imagem_atualizada_em TIMESTAMPTZ,
  visitas              INTEGER      NOT NULL DEFAULT 0,
  criado_em            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  atualizado_em        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_landing_slug ON landing_pages (LOWER(slug));

CREATE TABLE IF NOT EXISTS landing_botoes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  landing_id  UUID NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  rotulo      VARCHAR(60) NOT NULL,
  url         TEXT        NOT NULL,
  tipo        VARCHAR(20) NOT NULL DEFAULT 'link', -- whatsapp_grupo | whatsapp_canal | telegram | instagram | link
  ordem       INTEGER     NOT NULL DEFAULT 0,
  ativo       BOOLEAN     NOT NULL DEFAULT TRUE,
  cliques     INTEGER     NOT NULL DEFAULT 0,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_landing_botoes_landing ON landing_botoes (landing_id, ordem);
