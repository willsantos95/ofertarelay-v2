-- Migration 003: Criar tabelas WhatsApp

CREATE TABLE IF NOT EXISTS whatsapp_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telefone VARCHAR(20) NOT NULL,
  nome_instancia VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(50) DEFAULT 'aguardando_conexao',
  qrcode TEXT,
  codigo_pareamento VARCHAR(50),
  expira_em TIMESTAMPTZ,
  conectado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),
  deletado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_usuario_telefone
  ON whatsapp_instances(usuario_id, telefone) WHERE deletado_em IS NULL;

CREATE TABLE IF NOT EXISTS whatsapp_sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instancia_nome VARCHAR(255),
  status VARCHAR(50) DEFAULT 'rodando',
  mensagem TEXT,
  total_recebidos INTEGER,
  salvos INTEGER,
  ignorados INTEGER,
  mensagem_erro TEXT,
  iniciado_em TIMESTAMPTZ,
  finalizado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_group_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instancia_nome VARCHAR(255),
  group_jid VARCHAR(255) NOT NULL,
  group_nome VARCHAR(255),
  participantes INTEGER,
  sincronizado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_group_cache
  ON whatsapp_group_cache(usuario_id, group_jid);

CREATE TABLE IF NOT EXISTS usuario_whatsapp_grupos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_jid VARCHAR(255) NOT NULL,
  nome VARCHAR(255),
  papel VARCHAR(50) NOT NULL,
  nicho VARCHAR(100),
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),
  deletado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_usuario_whatsapp_papel
  ON usuario_whatsapp_grupos(usuario_id, papel) WHERE deletado_em IS NULL;
