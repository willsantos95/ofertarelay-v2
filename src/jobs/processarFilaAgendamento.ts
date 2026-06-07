// Worker da fila de agendamento: envia uma oferta por vez, respeitando o
// intervalo configurado por usuário (drip). Roda a cada 60s.

import { pool } from '../config/database';
import { logger } from '../utils/logger';
import { enviarOfertaWhatsApp, enviarOfertaTelegram, ResultadoEnvio } from '../services/envio.service';

const INTERVALO_CHECK_MS = 60_000;
let processando = false;

async function avancarProximoEnvio(usuarioId: string, intervaloMin: number): Promise<void> {
  await pool.query(
    `UPDATE agendamento_config
     SET proximo_envio_em = NOW() + ($2 || ' minutes')::interval, atualizado_em = NOW()
     WHERE usuario_id = $1`,
    [usuarioId, String(intervaloMin)]
  );
}

async function processarFila(): Promise<void> {
  if (processando) return;
  processando = true;
  try {
    const configs = await pool.query(
      `SELECT usuario_id, intervalo_min, grupos, enviar_telegram
       FROM agendamento_config
       WHERE ativo = true AND (proximo_envio_em IS NULL OR proximo_envio_em <= NOW())`
    );

    for (const cfg of configs.rows as Array<{
      usuario_id: string; intervalo_min: number; grupos: string[]; enviar_telegram: boolean;
    }>) {
      // Próximo item pendente da fila
      const itemRes = await pool.query(
        `SELECT id, oferta_id, legenda FROM agendamento_itens
         WHERE usuario_id = $1 AND status = 'pendente'
         ORDER BY criado_em ASC LIMIT 1`,
        [cfg.usuario_id]
      );
      if (!itemRes.rows.length) continue; // nada para enviar — mantém o agendamento

      const item = itemRes.rows[0] as { id: string; oferta_id: string; legenda: string };
      const grupos = Array.isArray(cfg.grupos) ? cfg.grupos : [];

      let waResult: ResultadoEnvio | null = null;
      let tgResult: ResultadoEnvio | null = null;
      let waErroConfig: string | null = null;
      let tgErroConfig: string | null = null;

      try {
        waResult = await enviarOfertaWhatsApp(
          cfg.usuario_id, item.oferta_id, item.legenda, grupos.length ? grupos : undefined
        );
      } catch (e) { waErroConfig = (e as Error).message; }

      if (cfg.enviar_telegram) {
        try {
          tgResult = await enviarOfertaTelegram(cfg.usuario_id, item.oferta_id, item.legenda);
        } catch (e) { tgErroConfig = (e as Error).message; }
      }

      const enviados  = (waResult?.enviados ?? 0) + (tgResult?.enviados ?? 0);
      const tentou    = !!waResult || !!tgResult; // algum canal rodou sem lançar erro de config
      const erros = [
        ...((waResult?.erros ?? []).map((e) => `WA: ${e}`)),
        ...((tgResult?.erros ?? []).map((e) => `TG: ${e}`)),
        ...(waErroConfig ? [`WA: ${waErroConfig}`] : []),
        ...(tgErroConfig ? [`TG: ${tgErroConfig}`] : []),
      ];

      if (enviados > 0) {
        await pool.query(
          `UPDATE agendamento_itens SET status = 'enviado', enviado_em = NOW(), erro = $2 WHERE id = $1`,
          [item.id, erros.length ? erros.join(' | ').slice(0, 500) : null]
        );
      } else if (tentou) {
        // Tentou enviar mas falhou em todos os destinos — marca como erro e segue
        await pool.query(
          `UPDATE agendamento_itens SET status = 'erro', enviado_em = NOW(), erro = $2 WHERE id = $1`,
          [item.id, erros.join(' | ').slice(0, 500) || 'Falha no envio']
        );
      } else {
        // Erro de configuração (ex.: WhatsApp desconectado) — mantém pendente p/ retry
        logger.warn({ usuarioId: cfg.usuario_id, itemId: item.id, erros }, 'Envio agendado adiado (config indisponível)');
      }

      await avancarProximoEnvio(cfg.usuario_id, cfg.intervalo_min);
      logger.info(
        { usuarioId: cfg.usuario_id, itemId: item.id, enviados, tentou },
        'Fila de agendamento: item processado'
      );
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Erro no worker de agendamento');
  } finally {
    processando = false;
  }
}

export function iniciarWorkerAgendamento(): void {
  setInterval(() => { void processarFila(); }, INTERVALO_CHECK_MS);
  logger.info('Worker de agendamento de ofertas iniciado');
}
