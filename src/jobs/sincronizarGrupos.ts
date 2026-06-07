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
  participants?: Participante[];
}

/**
 * Gera todas as variantes de JID de um telefone para comparação.
 * Cobre os casos de números brasileiros com/sem o dígito 9.
 */
function jidVariants(telefone: string): string[] {
  // Normalizar: remover tudo que não é dígito e qualquer sufixo @...
  const clean = telefone.replace(/@.*$/, '').replace(/\D/g, '');
  const set = new Set<string>();

  const adicionar = (num: string) => {
    set.add(`${num}@s.whatsapp.net`);
    // Brasil 55 + DDD(2) + 9 + número(8) = 13 dígitos → também sem o 9
    if (num.startsWith('55') && num.length === 13) {
      const semNove = num.slice(0, 4) + num.slice(5); // remove o 9 após o DDD
      set.add(`${semNove}@s.whatsapp.net`);
    }
    // Brasil 55 + DDD(2) + número(8) = 12 dígitos → também com o 9
    if (num.startsWith('55') && num.length === 12) {
      const comNove = num.slice(0, 4) + '9' + num.slice(4);
      set.add(`${comNove}@s.whatsapp.net`);
    }
  };

  adicionar(clean);

  // Se não tem o código do país 55, tentar prefixar
  if (!clean.startsWith('55')) {
    adicionar('55' + clean);
  }

  return [...set];
}

/** Verifica se o participante é admin (cobre múltiplos formatos da Evolution API) */
function participanteEAdmin(p: Participante): boolean {
  return p.admin === 'admin' || p.admin === 'superadmin' || p.admin === true || p.isAdmin === true;
}

/** Tenta obter o JID do bot via múltiplos endpoints da Evolution API */
async function getBotJidDaApi(instancia: string): Promise<string | null> {
  const url = getEvolutionUrl();
  const key = getEvolutionKey();
  const headers = { apikey: key };
  const signal = AbortSignal.timeout(10000);

  // Endpoint 1: connectionState (v1 e v2)
  try {
    const resp = await fetch(`${url}/instance/connectionState/${instancia}`, { headers, signal });
    if (resp.ok) {
      const data = await resp.json() as Record<string, unknown>;
      const inst = data?.instance as Record<string, unknown> | undefined;
      const owner = (
        inst?.owner ?? inst?.ownerJid ?? inst?.id ??
        data?.owner ?? data?.ownerJid
      ) as string | null;
      if (owner && owner.includes('@')) return owner;
      if (owner) return `${owner}@s.whatsapp.net`;
    }
  } catch { /* ignora */ }

  // Endpoint 2: fetchInstances (v2)
  try {
    const resp = await fetch(`${url}/instance/fetchInstances?instanceName=${instancia}`, { headers, signal });
    if (resp.ok) {
      const data = await resp.json() as unknown;
      const list = Array.isArray(data) ? data as Record<string, unknown>[] : [data as Record<string, unknown>];
      for (const item of list) {
        const inst = item?.instance as Record<string, unknown> | undefined;
        const owner = (inst?.owner ?? inst?.ownerJid ?? item?.owner) as string | null;
        if (owner && owner.includes('@')) return owner;
        if (owner) return `${owner}@s.whatsapp.net`;
      }
    }
  } catch { /* ignora */ }

  return null;
}

filaSync.process('sincronizar-grupos', async (job) => {
  const { jobId, usuarioId, instancia } = job.data as JobData;

  await pool.query(
    `UPDATE whatsapp_sync_jobs SET status = 'rodando', mensagem = 'Buscando grupos...' WHERE id = $1`,
    [jobId]
  );

  try {
    // Buscar telefone armazenado no banco (fallback para o JID)
    const instResult = await pool.query(
      `SELECT telefone FROM whatsapp_instances WHERE usuario_id = $1 AND nome_instancia = $2 LIMIT 1`,
      [usuarioId, instancia]
    );
    const telefoneDb = instResult.rows[0]?.telefone as string | null;

    // Tentar obter JID do bot pela API, com fallback para o telefone do DB
    const jidDaApi = await getBotJidDaApi(instancia);
    const jidBase = jidDaApi || (telefoneDb ? `${telefoneDb}@s.whatsapp.net` : null);
    const botJids = jidBase ? jidVariants(jidBase) : [];

    logger.info({ instancia, jidDaApi, jidBase, botJids, telefoneDb }, 'JIDs do bot para verificação de admin');

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
      const totalParticipantes = participantes.length;

      // Verificar admin: checa todas as variantes de JID do bot
      let isAdmin = false;
      if (botJids.length > 0 && participantes.length > 0) {
        isAdmin = participantes.some(
          (p) => botJids.includes(p.id) && participanteEAdmin(p)
        );
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

    logger.info({ usuarioId, jobId, salvos, adminCount, botJids }, 'Sincronização concluída');
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
