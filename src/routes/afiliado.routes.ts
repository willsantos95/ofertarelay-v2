import { Router, Request, Response } from 'express';
import { pool } from '../config/database';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';

const router = Router();

// GET /api/v1/afiliado/logs
// Parâmetros: plataforma, sucesso, contexto, pagina, limite
router.get('/logs', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  const {
    plataforma, sucesso, contexto,
    pagina = '1', limite = '50',
  } = req.query as Record<string, string>;

  const pg  = Math.max(1, parseInt(pagina));
  const lim = Math.min(200, Math.max(1, parseInt(limite)));
  const offset = (pg - 1) * lim;

  const filtros = ['usuario_id = $1'];
  const params: unknown[] = [usuarioId];
  let idx = 2;

  if (plataforma) { filtros.push(`plataforma = $${idx++}`); params.push(plataforma); }
  if (sucesso !== undefined && sucesso !== '') {
    filtros.push(`sucesso = $${idx++}`);
    params.push(sucesso === 'true');
  }
  if (contexto) { filtros.push(`contexto = $${idx++}`); params.push(contexto); }

  const where = `WHERE ${filtros.join(' AND ')}`;

  try {
    const [rows, total, resumo] = await Promise.all([
      pool.query(
        `SELECT id, plataforma, contexto, url_origem, url_gerada,
                sucesso, erro, duracao_ms, criado_em
         FROM affiliate_link_logs
         ${where}
         ORDER BY criado_em DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, lim, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM affiliate_link_logs ${where}`, params),
      pool.query(
        `SELECT
           plataforma,
           COUNT(*) FILTER (WHERE sucesso = true)  AS sucessos,
           COUNT(*) FILTER (WHERE sucesso = false) AS erros,
           ROUND(AVG(duracao_ms))                  AS avg_ms
         FROM affiliate_link_logs
         WHERE usuario_id = $1
         GROUP BY plataforma`,
        [usuarioId]
      ),
    ]);

    res.json({
      sucesso: true,
      logs: rows.rows,
      resumo: resumo.rows,
      paginacao: {
        total: parseInt(total.rows[0].count),
        pagina: pg, limite: lim,
        totalPaginas: Math.ceil(parseInt(total.rows[0].count) / lim),
      },
    });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// DELETE /api/v1/afiliado/logs  — limpa logs antigos (padrão: > 30 dias)
router.delete('/logs', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const { dias = '30' } = req.query as Record<string, string>;
  const d = Math.max(1, parseInt(dias));
  try {
    const r = await pool.query(
      `DELETE FROM affiliate_link_logs
       WHERE usuario_id = $1 AND criado_em < NOW() - ($2 || ' days')::interval`,
      [req.usuario!.id, String(d)]
    );
    res.json({ sucesso: true, removidos: r.rowCount ?? 0 });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

export default router;
