import { filaSync } from '../routes/whatsapp.routes';
import { pool } from '../config/database';
import { logger } from '../utils/logger';

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api.com';
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || '';

interface JobData {
  jobId: string;
  usuarioId: string;
  instancia: string;
}

interface GrupoEvolution {
  id: string;
  subject: string;
  participants?: unknown[];
}

filaSync.process('sincronizar-grupos', async (job) => {
  const { jobId, usuarioId, instancia } = job.data as JobData;

  await pool.query(
    `UPDATE whatsapp_sync_jobs SET status = 'rodando', mensagem = 'Buscando grupos...' WHERE id = $1`,
    [jobId]
  );

  try {
    const resposta = await fetch(
      `${EVOLUTION_URL}/group/fetchAllGroups/${instancia}?getParticipants=false`,
      {
        headers: { apikey: EVOLUTION_KEY },
        signal: AbortSignal.timeout(120000),
      }
    );

    if (!resposta.ok) {
      throw new Error(`Evolution retornou ${resposta.status}`);
    }

    const grupos = (await resposta.json()) as GrupoEvolution[];
    let salvos = 0;

    for (const grupo of grupos) {
      await pool.query(
        `INSERT INTO whatsapp_group_cache
         (usuario_id, instancia_nome, group_jid, group_nome, participantes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (usuario_id, group_jid) DO UPDATE SET
           group_nome = $4, participantes = $5, sincronizado_em = NOW()`,
        [usuarioId, instancia, grupo.id, grupo.subject, grupo.participants?.length || 0]
      );
      salvos++;
    }

    await pool.query(
      `UPDATE whatsapp_sync_jobs
       SET status = 'concluido', total_recebidos = $1, salvos = $2, finalizado_em = NOW()
       WHERE id = $3`,
      [grupos.length, salvos, jobId]
    );

    logger.info({ usuarioId, jobId, salvos }, 'Sincronização de grupos concluída');
  } catch (erro: unknown) {
    logger.error({ erro, jobId }, 'Erro no job de sincronização');

    await pool.query(
      `UPDATE whatsapp_sync_jobs
       SET status = 'erro', mensagem_erro = $1, finalizado_em = NOW()
       WHERE id = $2`,
      [(erro as Error).message, jobId]
    );

    throw erro;
  }
});
