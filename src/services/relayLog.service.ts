// Registro único em relay_logs para relay (n8n), envio manual e fila agendada.

import { pool } from '../config/database';
import { logger } from '../utils/logger';

/** Status que contam como oferta entregue (inclui o formato antigo por destino). */
export const STATUS_SUCESSO = ['success', 'publicada', 'parcial'];
/** Status de falha (algo deveria ter saído e não saiu). */
export const STATUS_FALHA = ['failed', 'falha_link', 'falha_envio', 'sem_destino'];

export interface DadosRelayLog {
  usuarioId: string;
  instancia: string;
  origem?: 'relay' | 'manual' | 'agendado';
  status: string;
  motivo?: string | null;
  grupoOrigemJid?: string | null;
  grupoOrigemNome?: string | null;
  grupoDestinoJid?: string | null;
  grupoDestinoNome?: string | null;
  loja?: string | null;
  nicho?: string | null;
  urlOriginal?: string | null;
  urlAfiliada?: string | null;
  titulo?: string | null;
  preco?: string | number | null;
  destinosTotal?: number | null;
  destinosOk?: number | null;
  duracaoMs?: number | null;
  temImagem?: boolean | null;
  messageId?: string | null;
  execucaoId?: string | null;
  quando?: string | Date | null;
}

function curto(v: unknown, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  return String(v).slice(0, max);
}

function inteiro(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
}

export async function registrarRelayLog(d: DadosRelayLog): Promise<void> {
  await pool.query(
    `INSERT INTO relay_logs
       (usuario_id, instancia_nome, origem, status, motivo,
        grupo_origem_jid, grupo_origem_nome, grupo_destino_jid, grupo_destino_nome,
        loja, nicho, url_original, url_afiliada, titulo_oferta, preco,
        destinos_total, destinos_ok, duracao_ms, tem_imagem, message_id, execucao_id, relayado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, COALESCE($22::timestamptz, NOW()))`,
    [
      d.usuarioId,
      curto(d.instancia, 255) || '-',
      d.origem || 'relay',
      curto(d.status, 50) || 'success',
      curto(d.motivo, 1000),
      curto(d.grupoOrigemJid, 255),
      curto(d.grupoOrigemNome, 255),
      curto(d.grupoDestinoJid, 255),
      curto(d.grupoDestinoNome, 255),
      curto(d.loja, 50),
      curto(d.nicho, 100) || 'geral',
      d.urlOriginal || null,
      d.urlAfiliada || null,
      curto(d.titulo, 500),
      d.preco === undefined || d.preco === null || d.preco === '' ? null : String(d.preco).slice(0, 50),
      inteiro(d.destinosTotal),
      inteiro(d.destinosOk),
      inteiro(d.duracaoMs),
      typeof d.temImagem === 'boolean' ? d.temImagem : null,
      curto(d.messageId, 100),
      curto(d.execucaoId, 50),
      d.quando ? new Date(d.quando).toISOString() : null,
    ]
  );
}

/** Versão que nunca lança — para não quebrar um envio por causa do log. */
export async function registrarRelayLogSeguro(d: DadosRelayLog): Promise<void> {
  try {
    await registrarRelayLog(d);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Falha ao gravar relay_log');
  }
}
