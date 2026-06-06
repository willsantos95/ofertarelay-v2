import { Router, Response } from 'express';
import { query, validationResult } from 'express-validator';
import { pool } from '../config/database';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { logger } from '../utils/logger';

const router = Router();

const NICHOS_VALIDOS = ['geral', 'pet', 'baby', 'fitness', 'home', 'electronics', 'fashion'];

// GET /api/v1/relay/logs
router.get(
  '/logs',
  autenticacaoRequerida,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('niche').optional().isIn(NICHOS_VALIDOS),
  ],
  async (req: RequestComUsuario, res: Response): Promise<void> => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
      res.status(400).json({ sucesso: false, erro: { codigo: 'ERRO_VALIDACAO', mensagem: erros.array()[0].msg, codigoStatus: 400 } });
      return;
    }

    const usuarioId = req.usuario!.id;
    const page  = (req.query.page  as unknown as number) || 1;
    const limit = (req.query.limit as unknown as number) || 50;
    const niche = (req.query.niche as string) || null;
    const offset = (page - 1) * limit;

    try {
      const [logsResult, countResult] = await Promise.all([
        pool.query(
          `SELECT
             id,
             instancia_nome   AS instance_name,
             grupo_origem_nome  AS origin_group_name,
             grupo_destino_nome AS destination_group_name,
             loja             AS store,
             nicho            AS niche,
             url_afiliada     AS affiliate_url,
             status,
             relayado_em      AS relayed_at
           FROM relay_logs
           WHERE usuario_id = $1
             AND ($2::text IS NULL OR nicho = $2)
           ORDER BY relayado_em DESC
           LIMIT $3 OFFSET $4`,
          [usuarioId, niche, limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*) AS total
           FROM relay_logs
           WHERE usuario_id = $1
             AND ($2::text IS NULL OR nicho = $2)`,
          [usuarioId, niche]
        ),
      ]);

      const total = parseInt(countResult.rows[0].total as string, 10);

      res.json({
        sucesso: true,
        logs: logsResult.rows,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (erro) {
      logger.error({ erro }, 'Erro ao buscar relay logs');
      res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
    }
  }
);

// GET /api/v1/relay/stats
router.get('/stats', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const resultado = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE relayado_em >= CURRENT_DATE)                     AS today,
         COUNT(*) FILTER (WHERE relayado_em >= CURRENT_DATE - INTERVAL '7 days') AS week,
         COUNT(*) FILTER (WHERE relayado_em >= DATE_TRUNC('month', NOW()))        AS month,
         COUNT(*)                                                                 AS total
       FROM relay_logs
       WHERE usuario_id = $1`,
      [usuarioId]
    );

    const row = resultado.rows[0];
    res.json({
      sucesso: true,
      stats: {
        today: parseInt(row.today as string, 10),
        week:  parseInt(row.week  as string, 10),
        month: parseInt(row.month as string, 10),
        total: parseInt(row.total as string, 10),
      },
    });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao buscar relay stats');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

export default router;
