import { filaSync } from '../routes/whatsapp.routes';
import { pool } from '../config/database';
import { logger } from '../utils/logger';

function getEvolutionUrl() { return process.env.EVOLUTION_API_URL || ''; }
function getEvolutionKey() { return process.env.EVOLUTION_API_KEY || ''; }

interface JobData {
  jobId: string;
  usuarioId: string;
  instancia: string;
}

interface Participante {
  id: string;
  admin: 'admin' | 'superadmin' | null | boolean;
  isAdmin?: boolean;
}

interface GrupoEvolution {
  id: string;
  subject: string;
  owner?: string;           // JID do criador do grupo (ex: "553198296801@s.whatsapp.net")
  participants?: Participante[];
}

/** Checa se um participante tem cargo de admin (cobre múltiplos formatos da API) */
function eAdmin(p: Participante): boolean {
  return (
    p.admin === 'admin' ||
    p.admin === 'superadmin' ||
    p.admin === true ||
    p.isAdmin === true
  );
}

filaSync.process('sincronizar-grupos', async (job) => {
  const { jobId, usuarioId, instancia } = job.data as JobData;

  await pool.query(
    `UPDATE whatsapp_sync_jobs SET status = 'rodando', mensagem = 'Buscando grupos...' WHERE id = $1`,
    [jobId]
  );

  try {
    // Buscar owner_jid da instância no DB (salvo pelo endpoint /status)
    const instResult = await pool.query(
      `SELECT owner_jid, telefone FROM whatsapp_instances
       WHERE usuario_id = $1 AND nome_instancia = $2 LIMIT 1`,
      [usuarioId, instancia]
    );

    let ownerJid: string | null = instResult.rows[0]?.owner_jid as string | null;

    // Se ainda não temos o owner_jid, buscar direto na Evolution API
    if (!ownerJid) {
      try {
        const resp = await fetch(
          `${getEvolutionUrl()}/instance/connectionState/${instancia}`,
          { headers: { apikey: getEvolutionKey() }, signal: AbortSignal.timeout(10000) }
        );
        if (resp.ok) {
          const data = await resp.json() as Record<string, unknown>;
          const inst = data?.instance as Record<string, unknown> | undefined;
          ownerJid = (inst?.owner ?? null) as string | null;
          // Persistir para uso futuro
          if (ownerJid) {
            await pool.query(
              `UPDATE whatsapp_instances SET owner_jid = $1 WHERE usuario_id = $2 AND nome_instancia = $3`,
              [ownerJid, usuarioId, instancia]
            );
          }
        }
      } catch {
        logger.warn({ instancia }, 'Não foi possível obter owner_jid da Evolution API');
      }
    }

    logger.info({ instancia, ownerJid }, 'Owner JID da instância para verificação de admin');

    // Buscar todos os grupos com participantes
    const resposta = await fetch(
      `${getEvolutionUrl()}/group/fetchAllGroups/${instancia}?getParticipants=true`,
      {
        headers: { apikey: getEvolutionKey() },
        signal: AbortSignal.timeout(120000),
      }
    );

    if (!resposta.ok) {
      throw new Error(`Evolution retornou ${resposta.status}`);
    }

    const grupos = (await resposta.json()) as GrupoEvolution[];
    let salvos = 0;
    let adminCount = 0;

    for (const grupo of grupos) {
      const participantes = grupo.participants || [];
      const groupOwner = grupo.owner || null;

      let isAdmin = false;

      if (ownerJid) {
        // Caso 1: o bot é o criador/dono do grupo (owner bate exatamente)
        if (groupOwner === ownerJid) {
          isAdmin = true;
        }

        // Caso 2: o bot está na lista de participantes com cargo de admin
        if (!isAdmin) {
          isAdmin = participantes.some(
            (p) => p.id === ownerJid && eAdmin(p)
          );
        }
      }

      if (isAdmin) adminCount++;

      await pool.query(
        `INSERT INTO whatsapp_group_cache
           (usuario_id, instancia_nome, group_jid, group_nome, participantes, group_owner, is_admin)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (usuario_id, group_jid) DO UPDATE SET
           group_nome      = $4,
           participantes   = $5,
           group_owner     = $6,
           is_admin        = $7,
           sincronizado_em = NOW()`,
        [usuarioId, instancia, grupo.id, grupo.subject, participantes.length, groupOwner, isAdmin]
      );
      salvos++;
    }

    await pool.query(
      `UPDATE whatsapp_sync_jobs
       SET status = 'concluido', total_recebidos = $1, salvos = $2, finalizado_em = NOW()
       WHERE id = $3`,
      [grupos.length, salvos, jobId]
    );

    logger.info({ usuarioId, jobId, salvos, adminCount, ownerJid }, 'Sincronização concluída');
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
