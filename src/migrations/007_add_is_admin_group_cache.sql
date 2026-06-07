-- Migration 007: Adicionar is_admin na tabela de cache de grupos

ALTER TABLE whatsapp_group_cache ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
