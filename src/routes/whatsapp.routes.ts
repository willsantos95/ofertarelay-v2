import { Router, Response as ExpressResponse } from 'express';
type Response = ExpressResponse;
import { body, query as queryValidator, validationResult } from 'express-validator';
import Bull from 'bull';
import { pool } from '../config/database';
import { getRedisBullConfig } from '../config/redis';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { logger } from '../utils/logger';

const router = Router();

export const filaSync = new Bull('whatsapp-sync', {
  redis: getRedisBullConfig(),
});

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || '';
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || '';

// Busca o QR em múltiplos campos possíveis (compatível com v1 e v2)
function normalizeQrCode(data: Record<string, unknown>): string | null {
  return (
    (data?.qrcode as Record<string, unknown>)?.base64 as string ||
    data?.qrcode as string ||
    data?.base64 as string ||
    data?.qr as string ||
    data?.code as string ||
    null
  );
}

function normalizePairingCode(data: Record<string, unknown>): string | null {
  return (
    data?.pairingCode as string ||
    data?.pairing_code as string ||
    (data?.qrcode as Record<string, unknown>)?.pairingCode as string ||
    null
  );
}

async function evolutionFetch(path: string, options: RequestInit = {}, timeoutMs = 25000): Promise<Record<string, unknown>> {
  if (!EVOLUTION_URL || !EVOLUTION_KEY) throw new Error('Evolution API não configurada');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${EVOLUTION_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        apikey: EVOLUTION_KEY,
        ...(options.headers as Record<string, string> || {}),
      },
    });

    const text = await response.text();
    let data: Record<string, unknown>;
    try { data = text ? JSON.parse(text) as Record<string, unknown> : {}; }
    catch { data = { raw: text }; }

    if (!response.ok) {
      throw new Error((data?.message || data?.error || `Erro Evolution: ${response.status}`) as string);
    }

    return data;
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') throw new Error('Evolution API demorou demais. Tente novamente.');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// POST /api/v1/whatsapp/conectar
router.post(
  '/conectar',
  autenticacaoRequerida,
  [
    body('telefone')
      .notEmpty().withMessage('Telefone é obrigatório')
      .matches(/^\d{10,15}$/).withMessage('Telefone deve ter 10-15 dígitos'),
  ],
  async (req: RequestComUsuario, res: Response): Promise<void> => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
      res.status(400).json({ sucesso: false, erro: { codigo: 'VALIDACAO_TELEFONE', mensagem: erros.array()[0].msg, codigoStatus: 400 } });
      return;
    }

    const usuarioId = req.usuario!.id;
    const telefone = (req.body as { telefone: string }).telefone.replace(/\D/g, '');
    const nomeInstancia = `minisaas_user_${usuarioId}_${telefone}`;

    try {
      // 1. Verificar se já existe instância no banco
      const existente = await pool.query(
        `SELECT * FROM whatsapp_instances WHERE usuario_id = $1 AND telefone = $2 LIMIT 1`,
        [usuarioId, telefone]
      );

      let instanciaId: string;

      if (existente.rows.length === 0) {
        // 2a. Criar instância na Evolution (ignorar erro se já existe)
        try {
          await evolutionFetch('/instance/create', {
            method: 'POST',
            body: JSON.stringify({ instanceName: nomeInstancia, qrcode: true, integration: 'WHATSAPP-BAILEYS' }),
          });
        } catch (err) {
          // Se deu erro mas não é "já existe", logar mas continuar
          logger.warn({ err: (err as Error).message }, 'Aviso ao criar instância Evolution (pode já existir)');
        }

        // 2b. Inserir no banco
        const inserido = await pool.query(
          `INSERT INTO whatsapp_instances (usuario_id, telefone, nome_instancia, status)
           VALUES ($1, $2, $3, 'aguardando_conexao') RETURNING id`,
          [usuarioId, telefone, nomeInstancia]
        );
        instanciaId = inserido.rows[0].id as string;
      } else {
        instanciaId = existente.rows[0].id as string;
      }

      // 3. Buscar QR code via /instance/connect
      const connectData = await evolutionFetch(`/instance/connect/${nomeInstancia}`, { method: 'GET' });

      const qrcode = normalizeQrCode(connectData);
      const pairingCode = normalizePairingCode(connectData);

      // 4. Atualizar banco com QR
      await pool.query(
        `UPDATE whatsapp_instances
         SET qrcode = $1, codigo_pareamento = $2, status = 'aguardando_conexao',
             expira_em = NOW() + INTERVAL '1 minute', atualizado_em = NOW()
         WHERE id = $3`,
        [qrcode, pairingCode, instanciaId]
      );

      res.status(201).json({
        sucesso: true,
        instancia: {
          nome: nomeInstancia,
          telefone,
          status: 'aguardando_conexao',
          qrcode,
          codigoPareamento: pairingCode,
        },
      });
    } catch (erro: unknown) {
      logger.error({ erro, usuarioId, telefone }, 'Erro ao conectar WhatsApp');
      res.status(500).json({
        sucesso: false,
        erro: { codigo: 'ERRO_CONEXAO_EVOLUTION', mensagem: (erro as Error).message || 'Erro ao conectar', codigoStatus: 500 },
      });
    }
  }
);

// GET /api/v1/whatsapp/status
router.get('/status', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const resultado = await pool.query(
      `SELECT * FROM whatsapp_instances WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [usuarioId]
    );

    if (resultado.rows.length === 0) {
      res.json({ sucesso: true, conectado: false, status: 'nao_criado' });
      return;
    }

    const instancia = resultado.rows[0];
    let statusAtual = instancia.status as string;

    try {
      const stateData = await evolutionFetch(`/instance/connectionState/${instancia.nome_instancia}`, { method: 'GET' }, 12000);
      const state = (stateData?.instance as Record<string, unknown>)?.state as string || stateData?.state as string || stateData?.connectionStatus as string || statusAtual;
      statusAtual = (state === 'open' || state === 'connected') ? 'conectado' : state;
    } catch {
      logger.warn({ instancia: instancia.nome_instancia }, 'Erro ao checar status Evolution, usando DB');
    }

    await pool.query(
      `UPDATE whatsapp_instances SET status = $1, atualizado_em = NOW() WHERE id = $2`,
      [statusAtual, instancia.id]
    );

    res.json({
      sucesso: true,
      conectado: statusAtual === 'conectado',
      status: statusAtual,
      instancia: { nome: instancia.nome_instancia, telefone: instancia.telefone, conectadoEm: instancia.conectado_em },
    });
  } catch (erro: unknown) {
    logger.error({ erro }, 'Erro ao verificar status');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_VERIFICACAO', mensagem: 'Erro ao verificar status', codigoStatus: 500 } });
  }
});

// POST /api/v1/whatsapp/grupos/sincronizar
router.post('/grupos/sincronizar', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const instancia = await pool.query(
      `SELECT * FROM whatsapp_instances WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [usuarioId]
    );

    if (instancia.rows.length === 0) {
      res.status(400).json({ sucesso: false, erro: { codigo: 'WHATSAPP_NAO_CONECTADO', mensagem: 'WhatsApp não está conectado', codigoStatus: 400 } });
      return;
    }

    const jobResult = await pool.query(
      `INSERT INTO whatsapp_sync_jobs (usuario_id, instancia_nome, status, mensagem, iniciado_em)
       VALUES ($1, $2, 'rodando', 'Sincronizando grupos...', NOW()) RETURNING *`,
      [usuarioId, instancia.rows[0].nome_instancia]
    );
    const job = jobResult.rows[0];

    await filaSync.add('sincronizar-grupos', { jobId: job.id, usuarioId, instancia: instancia.rows[0].nome_instancia }, {
      priority: 10, attempts: 3, backoff: { type: 'exponential', delay: 2000 },
    });

    res.status(202).json({ sucesso: true, job: { id: job.id, status: job.status, mensagem: job.mensagem, iniciado_em: job.iniciado_em } });
  } catch (erro: unknown) {
    logger.error({ erro, usuarioId }, 'Erro ao sincronizar grupos');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_SYNC', mensagem: 'Erro ao iniciar sincronização', codigoStatus: 500 } });
  }
});

// GET /api/v1/whatsapp/grupos/status-sync
router.get(
  '/grupos/status-sync',
  autenticacaoRequerida,
  [queryValidator('jobId').notEmpty().withMessage('jobId é obrigatório')],
  async (req: RequestComUsuario, res: Response): Promise<void> => {
    const usuarioId = req.usuario!.id;
    const { jobId } = req.query as { jobId: string };
    try {
      const resultado = await pool.query(
        `SELECT * FROM whatsapp_sync_jobs WHERE id = $1 AND usuario_id = $2`,
        [jobId, usuarioId]
      );
      if (resultado.rows.length === 0) {
        res.status(404).json({ sucesso: false, erro: { codigo: 'JOB_NAO_ENCONTRADO', mensagem: 'Job não encontrado', codigoStatus: 404 } });
        return;
      }
      const job = resultado.rows[0];
      res.json({ sucesso: true, job: { id: job.id, status: job.status, mensagem: job.mensagem, totalRecebidos: job.total_recebidos, salvos: job.salvos, ignorados: job.ignorados, finalizadoEm: job.finalizado_em } });
    } catch (erro: unknown) {
      res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_STATUS_JOB', mensagem: 'Erro ao obter status', codigoStatus: 500 } });
    }
  }
);

// POST /api/v1/whatsapp/grupos/salvar
router.post(
  '/grupos/salvar',
  autenticacaoRequerida,
  [
    body('gruposOrigem').isArray({ min: 1 }).withMessage('Mínimo 1 grupo origem'),
    body('gruposDestino').isArray({ min: 1 }).withMessage('Mínimo 1 grupo destino'),
    body('gruposOrigem.*.groupJid').matches(/.*@g\.us$/).withMessage('JID de origem inválido'),
    body('gruposDestino.*.groupJid').matches(/.*@g\.us$/).withMessage('JID de destino inválido'),
    body('gruposOrigem.*.nicho').trim().notEmpty().withMessage('Nicho é obrigatório'),
  ],
  async (req: RequestComUsuario, res: Response): Promise<void> => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
      res.status(400).json({ sucesso: false, erro: { codigo: 'ERRO_VALIDACAO', mensagem: erros.array()[0].msg, codigoStatus: 400 } });
      return;
    }

    const usuarioId = req.usuario!.id;
    const { gruposOrigem, gruposDestino } = req.body as {
      gruposOrigem: { groupJid: string; nome: string; nicho: string; statusAtivo?: boolean }[];
      gruposDestino: { groupJid: string; nome: string; nicho: string; statusAtivo?: boolean }[];
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE usuario_whatsapp_grupos SET deletado_em = NOW() WHERE usuario_id = $1 AND deletado_em IS NULL`, [usuarioId]);
      for (const grupo of gruposOrigem) {
        await client.query(`INSERT INTO usuario_whatsapp_grupos (usuario_id, group_jid, nome, papel, nicho) VALUES ($1, $2, $3, 'origem', $4)`, [usuarioId, grupo.groupJid, grupo.nome, grupo.nicho]);
      }
      for (const grupo of gruposDestino) {
        await client.query(`INSERT INTO usuario_whatsapp_grupos (usuario_id, group_jid, nome, papel, nicho) VALUES ($1, $2, $3, 'destino', $4)`, [usuarioId, grupo.groupJid, grupo.nome, grupo.nicho]);
      }
      await client.query('COMMIT');
      res.json({ sucesso: true, mensagem: 'Configuração salva com sucesso', resumo: { gruposOrigemAtivos: gruposOrigem.length, gruposDestinoAtivos: gruposDestino.length, automatizacaoPronta: true } });
    } catch (erro: unknown) {
      await client.query('ROLLBACK');
      logger.error({ erro, usuarioId }, 'Erro ao salvar grupos');
      res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_SALVAR_GRUPOS', mensagem: 'Erro ao salvar configuração', codigoStatus: 500 } });
    } finally {
      client.release();
    }
  }
);

// POST /api/v1/whatsapp/desconectar
router.post('/desconectar', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const instancia = await pool.query(
      `SELECT * FROM whatsapp_instances WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [usuarioId]
    );

    if (instancia.rows.length === 0) {
      res.status(404).json({ sucesso: false, erro: { codigo: 'INSTANCIA_NAO_ENCONTRADA', mensagem: 'Nenhuma instância encontrada', codigoStatus: 404 } });
      return;
    }

    const nomeInstancia = instancia.rows[0].nome_instancia as string;

    // Chamar Evolution para fazer logout
    try {
      await evolutionFetch(`/instance/logout/${nomeInstancia}`, { method: 'DELETE' });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Aviso ao desconectar Evolution (pode já estar desconectado)');
    }

    await pool.query(
      `UPDATE whatsapp_instances SET status = 'desconectado', qrcode = NULL, atualizado_em = NOW() WHERE usuario_id = $1`,
      [usuarioId]
    );

    res.json({ sucesso: true, mensagem: 'WhatsApp desconectado com sucesso.' });
  } catch (erro: unknown) {
    logger.error({ erro }, 'Erro ao desconectar WhatsApp');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_DESCONECTAR', mensagem: 'Erro ao desconectar', codigoStatus: 500 } });
  }
});

// POST /api/v1/whatsapp/excluir
router.post('/excluir', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const instancia = await pool.query(
      `SELECT * FROM whatsapp_instances WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [usuarioId]
    );

    if (instancia.rows.length > 0) {
      const nomeInstancia = instancia.rows[0].nome_instancia as string;

      // Excluir instância na Evolution
      try {
        await evolutionFetch(`/instance/delete/${nomeInstancia}`, { method: 'DELETE' });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Aviso ao excluir instância Evolution');
      }
    }

    // Limpar todos os dados do WhatsApp do usuário
    await pool.query(`DELETE FROM whatsapp_instances WHERE usuario_id = $1`, [usuarioId]);
    await pool.query(`DELETE FROM whatsapp_group_cache WHERE usuario_id = $1`, [usuarioId]);
    await pool.query(`DELETE FROM usuario_whatsapp_grupos WHERE usuario_id = $1`, [usuarioId]);
    await pool.query(`DELETE FROM whatsapp_sync_jobs WHERE usuario_id = $1`, [usuarioId]);

    res.json({ sucesso: true, mensagem: 'Dados do WhatsApp removidos com sucesso.' });
  } catch (erro: unknown) {
    logger.error({ erro }, 'Erro ao excluir dados WhatsApp');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_EXCLUIR', mensagem: 'Erro ao excluir dados', codigoStatus: 500 } });
  }
});

// GET /api/v1/whatsapp/dashboard
router.get('/dashboard', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const [instanciaResult, gruposResult] = await Promise.all([
      pool.query(`SELECT nome_instancia AS instance_name, telefone AS phone, status FROM whatsapp_instances WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`, [usuarioId]),
      pool.query(`SELECT id, nome AS group_name, group_jid, nicho AS niche, papel AS role FROM usuario_whatsapp_grupos WHERE usuario_id = $1 AND deletado_em IS NULL ORDER BY papel, nome`, [usuarioId]),
    ]);
    const instance = instanciaResult.rows.length > 0 ? instanciaResult.rows[0] : null;
    const todosGrupos = gruposResult.rows as { id: string; group_name: string; group_jid: string; niche: string; role: string }[];
    const originGroups = todosGrupos.filter((g) => g.role === 'origem').map((g) => ({ ...g, status: 'active' }));
    const destinationGroups = todosGrupos.filter((g) => g.role === 'destino').map((g) => ({ ...g, status: 'active' }));
    res.json({ sucesso: true, instance, summary: { total_groups: todosGrupos.length, origin_groups: originGroups.length, destination_groups: destinationGroups.length }, originGroups, destinationGroups });
  } catch (erro: unknown) {
    logger.error({ erro }, 'Erro ao buscar dashboard WhatsApp');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

// GET /api/v1/whatsapp/grupos — grupos salvos (origem/destino configurados)
router.get('/grupos', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const resultado = await pool.query(
      `SELECT id, group_jid, nome, papel, nicho FROM usuario_whatsapp_grupos WHERE usuario_id = $1 AND deletado_em IS NULL ORDER BY papel, nome`,
      [usuarioId]
    );
    res.json({ sucesso: true, grupos: resultado.rows });
  } catch (erro: unknown) {
    logger.error({ erro }, 'Erro ao buscar grupos WhatsApp');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

// GET /api/v1/whatsapp/grupos/cache — todos os grupos sincronizados da Evolution
router.get('/grupos/cache', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const instanciaResult = await pool.query(
      `SELECT nome_instancia FROM whatsapp_instances WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [usuarioId]
    );

    if (instanciaResult.rows.length === 0) {
      res.json({ sucesso: true, grupos: [] });
      return;
    }

    const nomeInstancia = instanciaResult.rows[0].nome_instancia as string;

    // Busca do cache com info de seleção já configurada
    const resultado = await pool.query(
      `SELECT
         c.group_jid,
         c.group_nome AS group_name,
         c.participantes AS participants_count,
         c.sincronizado_em AS synced_at,
         COALESCE(BOOL_OR(uwg.papel = 'origem' AND uwg.deletado_em IS NULL), false) AS is_origin,
         COALESCE(BOOL_OR(uwg.papel = 'destino' AND uwg.deletado_em IS NULL), false) AS is_destination,
         COALESCE(MAX(uwg.nicho), 'geral') AS nicho
       FROM whatsapp_group_cache c
       LEFT JOIN usuario_whatsapp_grupos uwg
         ON uwg.usuario_id = c.usuario_id AND uwg.group_jid = c.group_jid
       WHERE c.usuario_id = $1 AND c.instancia_nome = $2
       GROUP BY c.group_jid, c.group_nome, c.participantes, c.sincronizado_em
       ORDER BY c.group_nome ASC`,
      [usuarioId, nomeInstancia]
    );

    res.json({ sucesso: true, grupos: resultado.rows });
  } catch (erro: unknown) {
    logger.error({ erro }, 'Erro ao buscar cache de grupos');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

export default router;
