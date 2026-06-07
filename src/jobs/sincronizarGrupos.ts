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

interface Participante {
  id: string;
  admin: 'admin' | 'superadmin' | null;
}

interface GrupoEvolution {
  id: string;
  subject: string;
  participants?: Participante[];
}

/** Busca o JID do próprio bot via connectionState da instância */
async function getBotJid(instancia: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `${EVOLUTION_URL}/instance/connectionState/${instancia}`,
      { headers: { apikey: EVOLUTION_KEY }, signal: AbortSignal.timeout(15000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json() as Record<string, unknown>;
    // Evolution v2 retorna instance.owner, v1 pode retornar owner diretamente
    const instance = data?.instance as Record<string, unknown> | undefined;
    return (instance?.owner ?? data?.owner ?? null) as string | null;
  } catch {
    return null;
  }
}

filaSync.process('sincronizar-grupos', async (job) => {
  const { jobId, usuarioId, instancia } = job.data as JobData;

  await pool.query(
    `UPDATE whatsapp_sync_jobs SET status = 'rodando', mensagem = 'Buscando grupos...' WHERE id = $1`,
    [jobId]
  );

  try {
    // Buscar JID do bot para detectar adminship
    const botJid = await getBotJid(instancia);
    logger.info({ instancia, botJid }, 'JID do bot para verificação de admin');

    // Buscar todos os grupos com participantes (para checar admin)
    const resposta = await fetch(
      `${EVOLUTION_URL}/group/fetchAllGroups/${instancia}?getParticipants=true`,
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
      const participantes = grupo.participants || [];
      const totalParticipantes = participantes.length;

      // Verifica se o bot é admin neste grupo
      let isAdmin = false;
      if (botJid && participantes.length > 0) {
        isAdmin = participantes.some(
          (p) => p.id === botJid && (p.admin === 'admin' || p.admin === 'superadmin')
        );
      }

      await pool.query(
        `INSERT INTO whatsapp_group_cache
         (usuario_id, instancia_nome, group_jid, group_nome, participantes, is_admin)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (usuario_id, group_jid) DO UPDATE SET
           group_nome    = $4,
           participantes = $5,
           is_admin      = $6,
           sincronizado_em = NOW()`,
        [usuarioId, instancia, grupo.id, grupo.subject, totalParticipantes, isAdmin]
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
