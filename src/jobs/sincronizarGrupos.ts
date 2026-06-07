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
  phoneNumber?: string;     // @s.whatsapp.net — campo correto para comparar com ownerJid
  admin: 'admin' | 'superadmin' | null | boolean;
  isAdmin?: boolean;
}

interface GrupoEvolution {
  id: string;
  subject: string;
  owner?: string;
  participants?: Participante[];
}

/** Verifica se um participante tem cargo de admin (cobre múltiplos formatos) */
function eAdmin(p: Participante): boolean {
  return (
    p.admin === 'admin' ||
    p.admin === 'superadmin' ||
    p.admin === true ||
    p.isAdmin === true
  );
}

interface OwnerInfo {
  ownerJid: string | null; // @s.whatsapp.net — retornado pelo campo "ownerJid"
  ownerLid: string | null; // @lid          — retornado pelo campo "owner" quando é @lid
}

/**
 * Busca os identificadores do bot via fetchInstances.
 * A Evolution API v2 retorna:
 *   "ownerJid": "5514988099530@s.whatsapp.net"  → para comparar com participantes @s.whatsapp.net
 *   "owner":    "208487023956011@lid"            → para comparar com participantes @lid
 */
async function fetchOwnerInfo(instancia: string): Promise<OwnerInfo> {
  try {
    const resp = await fetch(
      `${getEvolutionUrl()}/instance/fetchInstances?instanceName=${instancia}`,
      {
        headers: { 'Content-Type': 'application/json', apikey: getEvolutionKey() },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!resp.ok) return { ownerJid: null, ownerLid: null };

    const data = await resp.json() as unknown;
    const list = Array.isArray(data)
      ? (data as Record<string, unknown>[])
      : [data as Record<string, unknown>];

    for (const item of list) {
      const inst = item?.instance as Record<string, unknown> | undefined;

      // ownerJid = campo explícito com @s.whatsapp.net
      const ownerJid = (inst?.ownerJid ?? item?.ownerJid) as string | null;

      // owner = pode ser @s.whatsapp.net (v1) ou @lid (v2)
      const ownerRaw = (inst?.owner ?? item?.owner) as string | null;

      const result: OwnerInfo = { ownerJid: null, ownerLid: null };

      if (ownerJid?.includes('@s.whatsapp.net')) result.ownerJid = ownerJid;
      if (ownerRaw?.includes('@s.whatsapp.net') && !result.ownerJid) result.ownerJid = ownerRaw;
      if (ownerRaw?.includes('@lid')) result.ownerLid = ownerRaw;

      if (result.ownerJid || result.ownerLid) return result;
    }
  } catch (err) {
    logger.warn({ instancia, err: (err as Error).message }, 'Falha ao buscar ownerInfo via fetchInstances');
  }
  return { ownerJid: null, ownerLid: null };
}

filaSync.process('sincronizar-grupos', async (job) => {
  const { jobId, usuarioId, instancia } = job.data as JobData;

  await pool.query(
    `UPDATE whatsapp_sync_jobs SET status = 'rodando', mensagem = 'Buscando grupos...' WHERE id = $1`,
    [jobId]
  );

  try {
    // 1. Obter identifiers do bot: primeiro do DB, depois da API
    const instResult = await pool.query(
      `SELECT owner_jid, owner_lid FROM whatsapp_instances
       WHERE usuario_id = $1 AND nome_instancia = $2 LIMIT 1`,
      [usuarioId, instancia]
    );

    let ownerJid: string | null = instResult.rows[0]?.owner_jid as string | null;
    let ownerLid: string | null = instResult.rows[0]?.owner_lid as string | null;

    // Buscar da API se algum campo estiver faltando
    if (!ownerJid || !ownerLid) {
      const info = await fetchOwnerInfo(instancia);
      if (info.ownerJid) ownerJid = info.ownerJid;
      if (info.ownerLid) ownerLid = info.ownerLid;

      // Persistir para uso futuro
      await pool.query(
        `UPDATE whatsapp_instances
         SET owner_jid = COALESCE($1, owner_jid),
             owner_lid = COALESCE($2, owner_lid)
         WHERE usuario_id = $3 AND nome_instancia = $4`,
        [ownerJid, ownerLid, usuarioId, instancia]
      );
    }

    logger.info({ instancia, ownerJid, ownerLid }, 'Identifiers do bot prontos para verificação de admin');

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
      const groupOwner = grupo.owner || null;

      // Log diagnóstico: primeiros 3 grupos com participantes para verificar formato
      if (salvos < 3) {
        logger.info({
          groupJid: grupo.id,
          groupSubject: grupo.subject,
          groupOwner,
          participantesTotal: participantes.length,
          amostraParticipantes: participantes.slice(0, 3).map(p => ({ id: p.id, phoneNumber: p.phoneNumber, admin: p.admin })),
          ownerJid,
          ownerLid,
        }, '[SYNC] Amostra de participantes');
      }

      let isAdmin = false;

      if (participantes.length > 0 && ownerJid) {
        isAdmin = participantes.some((p) => {
          // Comparar pelo phoneNumber (@s.whatsapp.net), que é o campo correto
          // O campo id retorna @lid (identificador interno do WhatsApp)
          const phone = p.phoneNumber || '';
          return phone === ownerJid && eAdmin(p);
        });
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

    logger.info({ usuarioId, jobId, salvos, adminCount, ownerJid, ownerLid }, 'Sincronização concluída');
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
