import { Router, Response } from 'express';
import { pool } from '../config/database';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { gerarLegendaPadrao, OfertaLegenda } from '../services/envio.service';

const router = Router();

interface ConfigRow {
  usuario_id: string;
  intervalo_min: number;
  ativo: boolean;
  grupos: string[];
  enviar_telegram: boolean;
  proximo_envio_em: string | null;
}

async function obterOuCriarConfig(usuarioId: string): Promise<ConfigRow> {
  await pool.query(
    `INSERT INTO agendamento_config (usuario_id) VALUES ($1) ON CONFLICT (usuario_id) DO NOTHING`,
    [usuarioId]
  );
  const r = await pool.query(
    `SELECT usuario_id, intervalo_min, ativo, grupos, enviar_telegram, proximo_envio_em
     FROM agendamento_config WHERE usuario_id = $1`,
    [usuarioId]
  );
  return r.rows[0] as ConfigRow;
}

// GET /api/v1/agendamento/config
router.get('/config', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const config = await obterOuCriarConfig(req.usuario!.id);
    res.json({ sucesso: true, config });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// PUT /api/v1/agendamento/config
router.put('/config', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  const { intervalo_min, ativo, grupos, enviar_telegram } = req.body as {
    intervalo_min?: number; ativo?: boolean; grupos?: string[]; enviar_telegram?: boolean;
  };

  const intervalo = Math.max(1, Math.min(1440, parseInt(String(intervalo_min ?? 7)) || 7));

  try {
    await obterOuCriarConfig(usuarioId);
    // Ao ativar, zera o próximo envio para começar imediatamente
    const config = await pool.query(
      `UPDATE agendamento_config SET
         intervalo_min   = $2,
         ativo           = $3,
         grupos          = $4::jsonb,
         enviar_telegram = $5,
         proximo_envio_em = CASE WHEN $3 = true AND ativo = false THEN NOW() ELSE proximo_envio_em END,
         atualizado_em   = NOW()
       WHERE usuario_id = $1
       RETURNING usuario_id, intervalo_min, ativo, grupos, enviar_telegram, proximo_envio_em`,
      [usuarioId, intervalo, ativo ?? false, JSON.stringify(grupos ?? []), enviar_telegram ?? false]
    );
    res.json({ sucesso: true, config: config.rows[0] });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// GET /api/v1/agendamento/itens
router.get('/itens', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const r = await pool.query(
      `SELECT i.id, i.oferta_id, i.legenda, i.status, i.enviado_em, i.erro, i.criado_em,
              o.nome, o.preco, o.imagem_url, o.plataforma, o.desconto_pct
       FROM agendamento_itens i
       JOIN ofertas o ON o.id = i.oferta_id
       WHERE i.usuario_id = $1
       ORDER BY
         CASE i.status WHEN 'pendente' THEN 0 WHEN 'erro' THEN 1 ELSE 2 END,
         i.criado_em ASC`,
      [req.usuario!.id]
    );
    const contagem = await pool.query(
      `SELECT status, COUNT(*) AS total FROM agendamento_itens WHERE usuario_id = $1 GROUP BY status`,
      [req.usuario!.id]
    );
    res.json({ sucesso: true, itens: r.rows, contagem: contagem.rows });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// POST /api/v1/agendamento/itens  — adiciona ofertas à fila
// body: { itens: [{ ofertaId, legenda? }] }  ou  { ofertaIds: string[] }
router.post('/itens', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  const body = req.body as { itens?: { ofertaId: string; legenda?: string }[]; ofertaIds?: string[] };

  let lista: { ofertaId: string; legenda?: string }[] = [];
  if (Array.isArray(body.itens)) lista = body.itens;
  else if (Array.isArray(body.ofertaIds)) lista = body.ofertaIds.map((id) => ({ ofertaId: id }));

  if (!lista.length) {
    res.status(400).json({ sucesso: false, erro: { mensagem: 'Nenhuma oferta informada.' } });
    return;
  }

  try {
    let adicionados = 0;
    for (const it of lista) {
      let legenda = it.legenda;
      if (!legenda) {
        const r = await pool.query(
          `SELECT nome, preco, desconto_pct, link_produto, link_afiliado, plataforma
           FROM ofertas WHERE id = $1`,
          [it.ofertaId]
        );
        if (!r.rows.length) continue;
        legenda = gerarLegendaPadrao(r.rows[0] as OfertaLegenda);
      }
      await pool.query(
        `INSERT INTO agendamento_itens (usuario_id, oferta_id, legenda) VALUES ($1, $2, $3)`,
        [usuarioId, it.ofertaId, legenda]
      );
      adicionados++;
    }
    res.json({ sucesso: true, adicionados });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// PATCH /api/v1/agendamento/itens/:id  — atualiza a legenda de um item pendente
router.patch('/itens/:id', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const { legenda } = req.body as { legenda?: string };
  if (!legenda || !legenda.trim()) {
    res.status(400).json({ sucesso: false, erro: { mensagem: 'Legenda vazia.' } });
    return;
  }
  try {
    const r = await pool.query(
      `UPDATE agendamento_itens SET legenda = $1
       WHERE id = $2 AND usuario_id = $3 AND status = 'pendente'`,
      [legenda, req.params.id, req.usuario!.id]
    );
    res.json({ sucesso: true, atualizado: (r.rowCount ?? 0) > 0 });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// DELETE /api/v1/agendamento/itens/:id  — remove um item
router.delete('/itens/:id', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const r = await pool.query(
      `DELETE FROM agendamento_itens WHERE id = $1 AND usuario_id = $2`,
      [req.params.id, req.usuario!.id]
    );
    res.json({ sucesso: true, removidas: r.rowCount ?? 0 });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// DELETE /api/v1/agendamento/itens  — limpa a fila (todas ou por status)
router.delete('/itens', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const { status } = req.query as Record<string, string>;
  const params: unknown[] = [req.usuario!.id];
  let where = 'usuario_id = $1';
  if (status) { where += ' AND status = $2'; params.push(status); }
  try {
    const r = await pool.query(`DELETE FROM agendamento_itens WHERE ${where}`, params);
    res.json({ sucesso: true, removidas: r.rowCount ?? 0 });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

export default router;
