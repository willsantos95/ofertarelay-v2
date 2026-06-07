-- Migration 009: Adicionar owner_lid para comparação com participantes em formato @lid

ALTER TABLE whatsapp_instances ADD COLUMN IF NOT EXISTS owner_lid VARCHAR(100);
