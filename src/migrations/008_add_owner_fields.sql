-- Migration 008: Adicionar campos owner para comparação de admin

-- JID do dono da instância WhatsApp (o próprio bot)
ALTER TABLE whatsapp_instances ADD COLUMN IF NOT EXISTS owner_jid VARCHAR(100);

-- JID do criador de cada grupo (campo "owner" retornado pela Evolution API)
ALTER TABLE whatsapp_group_cache ADD COLUMN IF NOT EXISTS group_owner VARCHAR(100);
