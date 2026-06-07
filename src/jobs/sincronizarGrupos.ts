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
  owner?: string;           // JID do criador do grupo
  participants?: Participante[];
}

/**
 * Gera todas as variantes de JID para um telefone.
 * Cobre números brasileiros com e sem o dígito 9.
 */
function jidVariants(telefone: string): string[] {
  const clean = telefone.replace(/@.*$/, '').replace(/\D/g, '');
  const set = new Set<string>();

  const add = (num: string) => {
    if (!num) return;
    set.add(`${num}@s.whatsapp.net`);
    // Brasil 55 + DDD(2) + 9 + 8 dígitos = 13 → gera versão sem o 9
    if (num.startsWith('55') && num.length === 13) {
      set.add(`${num.slice(0, 4)}${num.slice(5)}@s.whatsapp.net`);
    }
    // Brasil 55 + DDD(2) + 8 dígitos = 12 → gera versão com o 9
    if (num.startsWith('55') && num.length === 12) {
      set.add(`${num.slice(0, 4)}9${num.slice(4)}@s.whatsapp.net`);
    }
  };

  add(clean);

  // Se não tem DDI 55, tentar prefixar
  if (!clean.startsWith('55') && clean.length >= 10) {
    add('55' + clean);
  }

  return [...set];
}

/** Checa se um participante é admin (cobre múltiplos formatos da API) */
function eAdmin(p: Participante): boolean {
  return p.admin === 'admin' || p.admin === 'superadmin' || p.admin === true || p.isAdmin === true;
}

filaSync.process('sincronizar-grupos', async (job) => {
  const { jobId, usuarioId, instancia } = job.data as JobData;

  await pool.query(
    `UPDATE whatsapp_sync_jobs SET status = 'rodando', mensagem = 'Buscando grupos...' WHERE id = $1`,
    [jobId]
  );

  try {
    // Buscar telefone do DB — fonte confiável do número do bot
    const instResult = await pool.query(
      `SELECT telefone FROM whatsapp_instances WHERE usuario_id = $1 AND nome_instancia = $2 LIMIT 1`,
      [usuarioId, instancia]
    );
    const telefoneDb = instResult.rows[0]?.telefone as string | null;
    const botJids = telefoneDb ? jidVariants(telefoneDb) : [];

    logger.info({ instancia, telefoneDb, botJids }, 'JIDs do bot para verificação de admin');

    // Buscar grupos com participantes (para checar admin nos grupos)
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

      let isAdmin = false;

      if (botJids.length > 0) {
        // Caso 1: bot é dono/criador do grupo (owner bate com um JID do bot)
        if (grupo.owner && botJids.includes(grupo.owner)) {
          isAdmin = true;
        }

        // Caso 2: bot está na lista de participantes com cargo de admin
        if (!isAdmin && participantes.length > 0) {
          isAdmin = participantes.some(
            (p) => botJids.includes(p.id) && eAdmin(p)
          );
        }
      }

      if (isAdmin) adminCount++;

      await pool.query(
        `INSERT INTO whatsapp_group_cache
           (usuario_id, instancia_nome, group_jid, group_nome, participantes, is_admin)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (usuario_id, group_jid) DO UPDATE SET
           group_nome      = $4,
           participantes   = $5,
           is_admin        = $6,
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

    logger.info({ usuarioId, jobId, salvos, adminCount }, 'Sincronização concluída');
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
