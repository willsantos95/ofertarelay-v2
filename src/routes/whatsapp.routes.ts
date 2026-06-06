import { Router, Response as ExpressResponse } from 'express';
type Response = ExpressResponse;
import { body, query, validationResult } from 'express-validator';
import Bull from 'bull';
import { pool } from '../config/database';
import { getRedisBullConfig } from '../config/redis';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { logger } from '../utils/logger';

const router = Router();

export const filaSync = new Bull('whatsapp-sync', {
  redis: getRedisBullConfig(),
});

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api.com';
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || '';

async function fetchEvolution(path: string, options: RequestInit = {}): Promise<globalThis.Response> {
  return fetch(`${EVOLUTION_URL}${path}`, {
    ...options,
    headers: {
      apikey: EVOLUTION_KEY,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    },
  });
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
      res.status(400).json({
        sucesso: false,
        erro: {
          codigo: 'VALIDACAO_TELEFONE',
          mensagem: erros.array()[0].msg,
          codigoStatus: 400,
        },
      });
      return;
    }

    const { telefone } = req.body as { telefone: string };
    const usuarioId = req.usuario!.id;

    try {
      const existente = await pool.query(
        `SELECT * FROM whatsapp_instances
         WHERE usuario_id = $1 AND telefone = $2 AND deletado_em IS NULL`,
        [usuarioId, telefone]
      );

      if (existente.rows.length > 0 && existente.rows[0].status === 'conectado') {
        res.status(409).json({
          sucesso: false,
          erro: {
            codigo: 'WHATSAPP_JA_CONECTADO',
            mensagem: 'Este telefone já está conectado',
            codigoStatus: 409,
            instancia: {
              nome: existente.rows[0].nome_instancia,
              status: existente.rows[0].status,
            },
          },
        });
        return;
      }

      const nomeInstancia = `minisaas_user_${usuarioId}_${telefone}`;
      let qrcode: string | null = null;
      let codigoPareamento: string | null = null;

      try {
        const respostaCreate = await fetchEvolution('/instance/create', {
          method: 'POST',
          body: JSON.stringify({ instanceName: nomeInstancia, qrcode: true, integration: 'WHATSAPP-BAILEYS' }),
          signal: AbortSignal.timeout(10000),
        });

        if (!respostaCreate.ok) {
          throw new Error(`Evolution retornou ${respostaCreate.status}`);
        }

        const respostaQR = await fetchEvolution(`/instance/connect/${nomeInstancia}`, {
          signal: AbortSignal.timeout(5000),
        });

        if (respostaQR.ok) {
          const dadosQR = await respostaQR.json() as {
            qrcode?: string;
            pairingCode?: string;
          };
          qrcode = dadosQR.qrcode || null;
          codigoPareamento = dadosQR.pairingCode || null;
        }
      } catch (err) {
        logger.warn({ err, telefone }, 'Erro Evolution na 1ª tentativa, retrying...');
        await new Promise((r) => setTimeout(r, 1000));

        // Segunda tentativa
        try {
          const respostaQR2 = await fetchEvolution(`/instance/connect/${nomeInstancia}`, {
            signal: AbortSignal.timeout(5000),
          });
          if (respostaQR2.ok) {
            const dadosQR2 = await respostaQR2.json() as {
              qrcode?: string;
              pairingCode?: string;
            };
            qrcode = dadosQR2.qrcode || null;
            codigoPareamento = dadosQR2.pairingCode || null;
          }
        } catch (err2) {
          logger.error({ err2 }, 'Falha no retry Evolution');
        }
      }

      const resultado = await pool.query(
        `INSERT INTO whatsapp_instances
         (usuario_id, telefone, nome_instancia, status, qrcode, codigo_pareamento, expira_em)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '1 minute')
         ON CONFLICT (usuario_id, telefone) DO UPDATE SET
           status = $4, qrcode = $5, codigo_pareamento = $6, atualizado_em = NOW()
         RETURNING *`,
        [usuarioId, telefone, nomeInstancia, 'aguardando_conexao', qrcode, codigoPareamento]
      );

      const instancia = resultado.rows[0];

      res.status(201).json({
        sucesso: true,
        instancia: {
          nome: instancia.nome_instancia,
          telefone: instancia.telefone,
          status: instancia.status,
          qrcode: instancia.qrcode,
          codigoPareamento: instancia.codigo_pareamento,
          expiracao: instancia.expira_em,
        },
      });
    } catch (erro: unknown) {
      logger.error({ erro, usuarioId, telefone }, 'Erro ao conectar WhatsApp');
      res.status(500).json({
        sucesso: false,
        erro: {
          codigo: 'ERRO_CONEXAO_EVOLUTION',
          mensagem: 'Erro ao conectar com Evolution API',
          codigoStatus: 500,
        },
      });
    }
  }
);

// GET /api/v1/whatsapp/status
router.get('/status', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;

  try {
    const resultadoDb = await pool.query(
      `SELECT * FROM whatsapp_instances
       WHERE usuario_id = $1 AND deletado_em IS NULL
       ORDER BY criado_em DESC LIMIT 1`,
      [usuarioId]
    );

    if (resultadoDb.rows.length === 0) {
      res.json({ sucesso: true, conectado: false, status: 'nao_criado' });
      return;
    }

    const instancia = resultadoDb.rows[0];
    let statusAtual: string = instancia.status;

    try {
      const respostaEvolution = await fetchEvolution(
        `/instance/connectionState/${instancia.nome_instancia}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (respostaEvolution.ok) {
        const dados = await respostaEvolution.json() as {
          instance?: { state?: string };
        };
        const state = dados.instance?.state || 'desconhecido';
        statusAtual = state === 'open' || state === 'connected' ? 'conectado' : state;
      }
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
      instancia: {
        nome: instancia.nome_instancia,
        telefone: instancia.telefone,
        conectadoEm: instancia.conectado_em,
      },
    });
  } catch (erro: unknown) {
    logger.error({ erro }, 'Erro ao verificar status');
    res.status(500).json({
      sucesso: false,
      erro: {
        codigo: 'ERRO_VERIFICACAO',
        mensagem: 'Erro ao verificar status',
        codigoStatus: 500,
      },
    });
  }
});

// POST /api/v1/whatsapp/grupos/sincronizar
router.post('/grupos/sincronizar', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;

  try {
    const instancia = await pool.query(
      `SELECT * FROM whatsapp_instances
       WHERE usuario_id = $1 AND status = 'conectado' AND deletado_em IS NULL
       LIMIT 1`,
      [usuarioId]
    );

    if (instancia.rows.length === 0) {
      res.status(400).json({
        sucesso: false,
        erro: {
          codigo: 'WHATSAPP_NAO_CONECTADO',
          mensagem: 'WhatsApp não está conectado',
          codigoStatus: 400,
        },
      });
      return;
    }

    const jobResult = await pool.query(
      `INSERT INTO whatsapp_sync_jobs
       (usuario_id, instancia_nome, status, mensagem, iniciado_em)
       VALUES ($1, $2, 'rodando', 'Sincronizando grupos...', NOW())
       RETURNING *`,
      [usuarioId, instancia.rows[0].nome_instancia]
    );

    const job = jobResult.rows[0];

    await filaSync.add(
      'sincronizar-grupos',
      { jobId: job.id, usuarioId, instancia: instancia.rows[0].nome_instancia },
      { priority: 10, attempts: 3, backoff: { type: 'exponential', delay: 2000 } }
    );

    res.status(202).json({
      sucesso: true,
      job: {
        id: job.id,
        status: job.status,
        mensagem: job.mensagem,
        iniciado_em: job.iniciado_em,
      },
    });
  } catch (erro: unknown) {
    logger.error({ erro, usuarioId }, 'Erro ao sincronizar grupos');
    res.status(500).json({
      sucesso: false,
      erro: {
        codigo: 'ERRO_SYNC',
        mensagem: 'Erro ao iniciar sincronização',
        codigoStatus: 500,
      },
    });
  }
});

// GET /api/v1/whatsapp/grupos/status-sync
router.get(
  '/grupos/status-sync',
  autenticacaoRequerida,
  [query('jobId').notEmpty().withMessage('jobId é obrigatório')],
  async (req: RequestComUsuario, res: Response): Promise<void> => {
    const usuarioId = req.usuario!.id;
    const { jobId } = req.query as { jobId: string };

    try {
      const resultado = await pool.query(
        `SELECT * FROM whatsapp_sync_jobs
         WHERE id = $1 AND usuario_id = $2`,
        [jobId, usuarioId]
      );

      if (resultado.rows.length === 0) {
        res.status(404).json({ sucesso: false, erro: { codigo: 'JOB_NAO_ENCONTRADO', mensagem: 'Job não encontrado', codigoStatus: 404 } });
        return;
      }

      const job = resultado.rows[0];

      res.json({
        sucesso: true,
        job: {
          id: job.id,
          status: job.status,
          mensagem: job.mensagem,
          totalRecebidos: job.total_recebidos,
          salvos: job.salvos,
          ignorados: job.ignorados,
          finalizadoEm: job.finalizado_em,
        },
      });
    } catch (erro: unknown) {
      logger.error({ erro }, 'Erro ao obter status do job');
      res.status(500).json({
        sucesso: false,
        erro: { codigo: 'ERRO_STATUS_JOB', mensagem: 'Erro ao obter status', codigoStatus: 500 },
      });
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
      res.status(400).json({
        sucesso: false,
        erro: { codigo: 'ERRO_VALIDACAO', mensagem: erros.array()[0].msg, codigoStatus: 400 },
      });
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

      await client.query(
        `UPDATE usuario_whatsapp_grupos SET deletado_em = NOW()
         WHERE usuario_id = $1 AND deletado_em IS NULL`,
        [usuarioId]
      );

      for (const grupo of gruposOrigem) {
        await client.query(
          `INSERT INTO usuario_whatsapp_grupos (usuario_id, group_jid, nome, papel, nicho)
           VALUES ($1, $2, $3, 'origem', $4)`,
          [usuarioId, grupo.groupJid, grupo.nome, grupo.nicho]
        );
      }

      for (const grupo of gruposDestino) {
        await client.query(
          `INSERT INTO usuario_whatsapp_grupos (usuario_id, group_jid, nome, papel, nicho)
           VALUES ($1, $2, $3, 'destino', $4)`,
          [usuarioId, grupo.groupJid, grupo.nome, grupo.nicho]
        );
      }

      await client.query('COMMIT');

      res.json({
        sucesso: true,
        mensagem: 'Configuração salva com sucesso',
        resumo: {
          gruposOrigemAtivos: gruposOrigem.filter((g) => g.statusAtivo !== false).length,
          gruposDestinoAtivos: gruposDestino.filter((g) => g.statusAtivo !== false).length,
          automatizacaoPronta: true,
        },
      });
    } catch (erro: unknown) {
      await client.query('ROLLBACK');
      logger.error({ erro, usuarioId }, 'Erro ao salvar grupos');
      res.status(500).json({
        sucesso: false,
        erro: { codigo: 'ERRO_SALVAR_GRUPOS', mensagem: 'Erro ao salvar configuração', codigoStatus: 500 },
      });
    } finally {
      client.release();
    }
  }
);

// GET /api/v1/whatsapp/dashboard
router.get('/dashboard', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const [instanciaResult, gruposResult] = await Promise.all([
      pool.query(
        `SELECT nome_instancia AS instance_name, telefone AS phone, status
         FROM whatsapp_instances
         WHERE usuario_id = $1 AND deletado_em IS NULL
         ORDER BY criado_em DESC LIMIT 1`,
        [usuarioId]
      ),
      pool.query(
        `SELECT id, nome AS group_name, group_jid, nicho AS niche, papel AS role
         FROM usuario_whatsapp_grupos
         WHERE usuario_id = $1 AND deletado_em IS NULL
         ORDER BY papel, nome`,
        [usuarioId]
      ),
    ]);

    const instance = instanciaResult.rows.length > 0 ? instanciaResult.rows[0] : null;
    const todosGrupos = gruposResult.rows as { id: string; group_name: string; group_jid: string; niche: string; role: string }[];
    const originGroups = todosGrupos.filter((g) => g.role === 'origem').map((g) => ({ ...g, status: 'active' }));
    const destinationGroups = todosGrupos.filter((g) => g.role === 'destino').map((g) => ({ ...g, status: 'active' }));

    res.json({
      sucesso: true,
      instance,
      summary: {
        total_groups: todosGrupos.length,
        origin_groups: originGroups.length,
        destination_groups: destinationGroups.length,
      },
      originGroups,
      destinationGroups,
    });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao buscar dashboard WhatsApp');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

// GET /api/v1/whatsapp/grupos
router.get('/grupos', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const resultado = await pool.query(
      `SELECT id, group_jid, nome, papel, nicho
       FROM usuario_whatsapp_grupos
       WHERE usuario_id = $1 AND deletado_em IS NULL
       ORDER BY papel, nome`,
      [usuarioId]
    );
    res.json({ sucesso: true, grupos: resultado.rows });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao buscar grupos WhatsApp');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

export default router;
