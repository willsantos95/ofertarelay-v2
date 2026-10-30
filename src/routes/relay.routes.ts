import { Router, Response } from 'express';
import { query, validationResult } from 'express-validator';
import { pool } from '../config/database';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { logger } from '../utils/logger';
import { STATUS_SUCESSO, STATUS_FALHA } from '../services/relayLog.service';

const router = Router();

const FUSO = 'America/Sao_Paulo';
const ORIGENS = ['relay', 'manual', 'agendado'];
const NICHOS_VALIDOS = ['geral', 'pet', 'baby', 'fitness', 'home', 'electronics', 'fashion'];

function erroValidacao(res: Response, msg: string): void {
  res.status(400).json({ sucesso: false, erro: { codigo: 'ERRO_VALIDACAO', mensagem: msg, codigoStatus: 400 } });
}

// GET /api/v1/relay/logs?page&limit&niche&status&origem&loja&dias&busca
router.get(
  '/logs',
  autenticacaoRequerida,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('niche').optional().isIn(NICHOS_VALIDOS),
    query('status').optional().isString().isLength({ max: 50 }),
    query('origem').optional().isIn(ORIGENS),
    query('loja').optional().isString().isLength({ max: 50 }),
    query('dias').optional().isInt({ min: 1, max: 365 }).toInt(),
    query('busca').optional().isString().isLength({ max: 100 }),
  ],
  async (req: RequestComUsuario, res: Response): Promise<void> => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) { erroValidacao(res, erros.array()[0].msg); return; }

    const usuarioId = req.usuario!.id;
    const page  = (req.query.page  as unknown as number) || 1;
    const limit = (req.query.limit as unknown as number) || 50;
    const offset = (page - 1) * limit;

    const filtros = ['usuario_id = $1'];
    const params: unknown[] = [usuarioId];
    const add = (sql: string, v: unknown) => { params.push(v); filtros.push(sql.replace('?', `$${params.length}`)); };

    if (req.query.niche)  add('nicho = ?', req.query.niche);
    if (req.query.status) {
      const st = String(req.query.status);
      if (st === 'sucesso') add('status = ANY(?)', STATUS_SUCESSO);
      else if (st === 'falha') add('status = ANY(?)', STATUS_FALHA);
      else add('status = ?', st);
    }
    if (req.query.origem) add('origem = ?', req.query.origem);
    if (req.query.loja)   add('loja = ?', req.query.loja);
    if (req.query.dias)   add(`relayado_em >= NOW() - (? || ' days')::interval`, String(req.query.dias));
    if (req.query.busca)  add('titulo_oferta ILIKE ?', `%${String(req.query.busca)}%`);

    const where = filtros.join(' AND ');

    try {
      const [logsResult, countResult] = await Promise.all([
        pool.query(
          `SELECT
             id,
             instancia_nome     AS instance_name,
             origem,
             grupo_origem_nome  AS origin_group_name,
             grupo_destino_nome AS destination_group_name,
             loja               AS store,
             nicho              AS niche,
             titulo_oferta      AS title,
             preco              AS price,
             url_original       AS original_url,
             url_afiliada       AS affiliate_url,
             status,
             motivo             AS reason,
             destinos_total     AS destinations_total,
             destinos_ok        AS destinations_ok,
             duracao_ms         AS duration_ms,
             relayado_em        AS relayed_at
           FROM relay_logs
           WHERE ${where}
           ORDER BY relayado_em DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*) AS total FROM relay_logs WHERE ${where}`, params),
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

// GET /api/v1/relay/stats — ofertas entregues (dia no fuso de São Paulo)
router.get('/stats', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const resultado = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE (relayado_em AT TIME ZONE '${FUSO}')::date = (NOW() AT TIME ZONE '${FUSO}')::date) AS today,
         COUNT(*) FILTER (WHERE relayado_em >= NOW() - INTERVAL '7 days')                                         AS week,
         COUNT(*) FILTER (WHERE relayado_em >= DATE_TRUNC('month', NOW() AT TIME ZONE '${FUSO}') AT TIME ZONE '${FUSO}') AS month,
         COUNT(*)                                                                                               AS total
       FROM relay_logs
       WHERE usuario_id = $1 AND status = ANY($2)`,
      [usuarioId, STATUS_SUCESSO]
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

// GET /api/v1/relay/resumo?dias=7 — indicadores do painel de acompanhamento
router.get(
  '/resumo',
  autenticacaoRequerida,
  [query('dias').optional().isInt({ min: 1, max: 90 }).toInt()],
  async (req: RequestComUsuario, res: Response): Promise<void> => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) { erroValidacao(res, erros.array()[0].msg); return; }

    const usuarioId = req.usuario!.id;
    const dias = (req.query.dias as unknown as number) || 7;
    const base = `FROM relay_logs WHERE usuario_id = $1 AND relayado_em >= NOW() - ($2 || ' days')::interval`;
    const p = [usuarioId, String(dias), STATUS_SUCESSO, STATUS_FALHA];

    try {
      const [kpi, porDia, porLoja, porOrigem, porMotivo] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = ANY($3))                        AS entregues,
             COUNT(*) FILTER (WHERE status = ANY($4))                        AS falhas,
             COUNT(*) FILTER (WHERE NOT (status = ANY($3) OR status = ANY($4))) AS descartadas,
             COALESCE(SUM(destinos_ok) FILTER (WHERE status = ANY($3)), 0)   AS envios_grupos,
             ROUND(AVG(duracao_ms) FILTER (WHERE status = ANY($3) AND duracao_ms IS NOT NULL)) AS duracao_media_ms
           ${base}`, p),
        pool.query(
          `SELECT TO_CHAR((relayado_em AT TIME ZONE '${FUSO}')::date, 'YYYY-MM-DD') AS dia,
                  COUNT(*) FILTER (WHERE status = ANY($3)) AS entregues,
                  COUNT(*) FILTER (WHERE status = ANY($4)) AS falhas
           ${base} GROUP BY 1 ORDER BY 1`, p),
        pool.query(
          `SELECT COALESCE(loja, '—') AS chave, COUNT(*) AS total
           ${base} AND status = ANY($3) GROUP BY 1 ORDER BY 2 DESC`, p.slice(0, 3)),
        pool.query(
          `SELECT origem AS chave, COUNT(*) AS total
           ${base} AND status = ANY($3) GROUP BY 1 ORDER BY 2 DESC`, p.slice(0, 3)),
        pool.query(
          `SELECT status AS chave, COUNT(*) AS total
           ${base} AND NOT (status = ANY($3)) GROUP BY 1 ORDER BY 2 DESC`, p.slice(0, 3)),
      ]);

      const k = kpi.rows[0] || {};
      const entregues = Number(k.entregues || 0);
      const falhas = Number(k.falhas || 0);
      const num = (rows: Record<string, unknown>[]) => rows.map((r) => ({ chave: r.chave, total: Number(r.total) }));

      res.json({
        sucesso: true,
        dias,
        kpis: {
          entregues,
          falhas,
          descartadas: Number(k.descartadas || 0),
          enviosGrupos: Number(k.envios_grupos || 0),
          taxaSucesso: entregues + falhas ? Math.round((entregues / (entregues + falhas)) * 100) : null,
          duracaoMediaMs: k.duracao_media_ms === null || k.duracao_media_ms === undefined ? null : Number(k.duracao_media_ms),
        },
        porDia: porDia.rows.map((r) => ({ dia: r.dia, entregues: Number(r.entregues), falhas: Number(r.falhas) })),
        porLoja: num(porLoja.rows),
        porOrigem: num(porOrigem.rows),
        porMotivo: num(porMotivo.rows),
      });
    } catch (erro) {
      logger.error({ erro }, 'Erro ao montar resumo do relay');
      res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
    }
  }
);

export default router;
