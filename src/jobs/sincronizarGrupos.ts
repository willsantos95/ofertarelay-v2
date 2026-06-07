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
  owner?: string; // @lid format — salvo para auditoria mas NÃO usado para comparação
  participants?: Participante[];
}

/** Verifica se um participante tem cargo de admin (cobre múltiplos formatos da API) */
function eAdmin(p: Participante): boolean {
  return (
    p.admin === 'admin' ||
    p.admin === 'superadmin' ||
    p.admin === true ||
    p.isAdmin === true
  );
}

/**
 * Busca o ownerJid da instância via fetchInstances.
 * Retorna o JID no formato @s.whatsapp.net (ex: "5514988099530@s.whatsapp.net").
 */
async function fetchOwnerJid(instancia: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `${getEvolutionUrl()}/instance/fetchInstances?instanceName=${instancia}`,
      {
        headers: { 'Content-Type': 'application/json', apikey: getEvolutionKey() },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!resp.ok) return null;

    const data = await resp.json() as unknown;
    const list = Array.isArray(data)
      ? (data as Record<string, unknown>[])
      : [data as Record<string, unknown>];

    for (const item of list) {
      const inst = item?.instance as Record<string, unknown> | undefined;
      // A documentação da Evolution v2 retorna ownerJid em @s.whatsapp.net
      const jid = (inst?.ownerJid ?? inst?.owner ?? item?.ownerJid ?? item?.owner) as string | null;
      if (jid && jid.includes('@s.whatsapp.net')) return jid;
    }
  } catch (err) {
    logger.warn({ instancia, err: (err as Error).message }, 'Falha ao buscar ownerJid via fetchInstances');
  }
  return null;
}

filaSync.process('sincronizar-grupos', async (job) => {
  const { jobId, usuarioId, instancia } = job.data as JobData;

  await pool.query(
    `UPDATE whatsapp_sync_jobs SET status = 'rodando', mensagem = 'Buscando grupos...' WHERE id = $1`,
    [jobId]
  );

  try {
    // 1. Obter ownerJid: primeiro tenta o DB, depois a API
    const instResult = await pool.query(
      `SELECT owner_jid FROM whatsapp_instances WHERE usuario_id = $1 AND nome_instancia = $2 LIMIT 1`,
      [usuarioId, instancia]
    );
    let ownerJid: string | null = instResult.rows[0]?.owner_jid as string | null;

    if (!ownerJid || !ownerJid.includes('@s.whatsapp.net')) {
      ownerJid = await fetchOwnerJid(instancia);
      if (ownerJid) {
        // Persistir para uso futuro
        await pool.query(
          `UPDATE whatsapp_instances SET owner_jid = $1 WHERE usuario_id = $2 AND nome_instancia = $3`,
          [ownerJid, usuarioId, instancia]
        );
        logger.info({ instancia, ownerJid }, 'ownerJid obtido da API e salvo no DB');
      }
    }

    if (!ownerJid) {
      logger.warn({ instancia }, 'ownerJid não encontrado — is_admin será false para todos os grupos');
    } else {
      logger.info({ instancia, ownerJid }, 'ownerJid pronto para verificação de admin');
    }

    // 2. Buscar todos os grupos com participantes
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
      const totalParticipantes = participantes.length;
      // group.owner vem em @lid — salvamos para auditoria mas NÃO usamos para comparação
      const groupOwner = grupo.owner || null;

      let isAdmin = false;

      if (ownerJid) {
        // Comparação pela lista de participantes: ownerJid em @s.whatsapp.net vs participant.id
        isAdmin = participantes.some(
          (p) => p.id === ownerJid && eAdmin(p)
        );
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
        [usuarioId, instancia, grupo.id, grupo.subject, totalParticipantes, groupOwner, isAdmin]
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
