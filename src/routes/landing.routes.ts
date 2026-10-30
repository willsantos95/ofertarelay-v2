// Editor da landing page do usuário (autenticado).
import express, { Router, Response } from 'express';
import { pool } from '../config/database';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { logger } from '../utils/logger';
import {
  TIPOS_BOTAO, TipoBotao, Botao,
  normalizarSlug, validarSlug, urlSegura, corValida, slugDisponivel, buscarLandingDoUsuario,
} from '../services/landing.service';

const router = Router();

const MAX_BOTOES = 8;
const MAX_IMAGEM_BYTES = 2 * 1024 * 1024;
const MIMES_IMAGEM = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function erro(res: Response, status: number, mensagem: string, codigo = 'ERRO_VALIDACAO'): void {
  res.status(status).json({ sucesso: false, erro: { codigo, mensagem, codigoStatus: status } });
}

function resposta(landing: Awaited<ReturnType<typeof buscarLandingDoUsuario>>) {
  if (!landing) return null;
  const { usuario_id: _omit, ...resto } = landing;
  return { ...resto, caminho: `/${landing.slug}` };
}

// GET /api/v1/landing — a landing do usuário (ou null)
router.get('/', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    res.json({ sucesso: true, landing: resposta(await buscarLandingDoUsuario(req.usuario!.id)) });
  } catch (e) {
    logger.error({ e }, 'Erro ao buscar landing');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

// GET /api/v1/landing/slug-disponivel?slug=
router.get('/slug-disponivel', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const slug = normalizarSlug(req.query.slug);
  const invalido = validarSlug(slug);
  if (invalido) { res.json({ sucesso: true, slug, disponivel: false, motivo: invalido }); return; }
  try {
    const livre = await slugDisponivel(slug, req.usuario!.id);
    res.json({ sucesso: true, slug, disponivel: livre, motivo: livre ? null : 'Esse endereço já está em uso.' });
  } catch {
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

// PUT /api/v1/landing — cria ou atualiza { slug, titulo, descricao, cor, publicada, botoes[] }
router.put('/', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  const b = (req.body || {}) as Record<string, unknown>;

  const slug = normalizarSlug(b.slug);
  const invalido = validarSlug(slug);
  if (invalido) { erro(res, 400, invalido); return; }

  const titulo = String(b.titulo ?? '').trim().slice(0, 80);
  if (!titulo) { erro(res, 400, 'Informe o nome do grupo.'); return; }
  const descricao = String(b.descricao ?? '').trim().slice(0, 300);
  const cor = corValida(b.cor);
  const publicada = b.publicada !== false;

  const entrada = Array.isArray(b.botoes) ? (b.botoes as Record<string, unknown>[]) : [];
  if (entrada.length > MAX_BOTOES) { erro(res, 400, `Use no máximo ${MAX_BOTOES} botões.`); return; }

  const botoes: Botao[] = [];
  for (const [i, x] of entrada.entries()) {
    const rotulo = String(x.rotulo ?? '').trim().slice(0, 60);
    const url = urlSegura(x.url);
    if (!rotulo) { erro(res, 400, `Botão ${i + 1}: informe o texto.`); return; }
    if (!url) { erro(res, 400, `Botão ${i + 1}: informe um link começando com https://`); return; }
    const tipo = (TIPOS_BOTAO as readonly string[]).includes(String(x.tipo)) ? (x.tipo as TipoBotao) : 'link';
    botoes.push({ id: typeof x.id === 'string' ? x.id : undefined, rotulo, url, tipo, ativo: x.ativo !== false });
  }

  const client = await pool.connect();
  try {
    if (!(await slugDisponivel(slug, usuarioId))) { erro(res, 409, 'Esse endereço já está em uso. Escolha outro.', 'SLUG_EM_USO'); return; }

    await client.query('BEGIN');
    const up = await client.query(
      `INSERT INTO landing_pages (usuario_id, slug, titulo, descricao, cor, publicada)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (usuario_id) DO UPDATE SET
         slug = $2, titulo = $3, descricao = $4, cor = $5, publicada = $6, atualizado_em = NOW()
       RETURNING id`,
      [usuarioId, slug, titulo, descricao, cor, publicada]
    );
    const landingId = up.rows[0].id as string;

    // Mantém os botões que voltaram com id (preserva a contagem de cliques), cria os novos, remove o resto
    const manter = botoes.map((x) => x.id).filter(Boolean) as string[];
    await client.query(
      `DELETE FROM landing_botoes WHERE landing_id = $1 AND NOT (id::text = ANY($2::text[]))`,
      [landingId, manter]
    );
    for (const [ordem, x] of botoes.entries()) {
      const atualizado = x.id
        ? await client.query(
          `UPDATE landing_botoes SET rotulo = $3, url = $4, tipo = $5, ativo = $6, ordem = $7
           WHERE id::text = $1 AND landing_id = $2`,
          [x.id, landingId, x.rotulo, x.url, x.tipo, x.ativo, ordem]
        )
        : { rowCount: 0 };
      if (!atualizado.rowCount) {
        await client.query(
          `INSERT INTO landing_botoes (landing_id, rotulo, url, tipo, ativo, ordem) VALUES ($1, $2, $3, $4, $5, $6)`,
          [landingId, x.rotulo, x.url, x.tipo, x.ativo, ordem]
        );
      }
    }
    await client.query('COMMIT');

    res.json({ sucesso: true, mensagem: 'Página salva.', landing: resposta(await buscarLandingDoUsuario(usuarioId)) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((e as { code?: string }).code === '23505') { erro(res, 409, 'Esse endereço já está em uso. Escolha outro.', 'SLUG_EM_USO'); return; }
    logger.error({ e }, 'Erro ao salvar landing');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  } finally {
    client.release();
  }
});

// PUT /api/v1/landing/imagem { dataUrl: "data:image/png;base64,..." }
router.put(
  '/imagem',
  express.json({ limit: '4mb' }),
  autenticacaoRequerida,
  async (req: RequestComUsuario, res: Response): Promise<void> => {
    const dataUrl = String((req.body as Record<string, unknown>)?.dataUrl || '');
    const m = dataUrl.match(/^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (!m) { erro(res, 400, 'Imagem inválida.'); return; }
    const mime = m[1].toLowerCase();
    if (!MIMES_IMAGEM.includes(mime)) { erro(res, 400, 'Use PNG, JPG, WEBP ou GIF.'); return; }
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > MAX_IMAGEM_BYTES) { erro(res, 400, 'A imagem deve ter no máximo 2 MB.'); return; }

    try {
      const r = await pool.query(
        `UPDATE landing_pages SET imagem = $2, imagem_mime = $3, imagem_atualizada_em = NOW(), atualizado_em = NOW()
         WHERE usuario_id = $1`,
        [req.usuario!.id, bytes, mime]
      );
      if (!r.rowCount) { erro(res, 400, 'Salve a página antes de enviar a imagem.'); return; }
      res.json({ sucesso: true, landing: resposta(await buscarLandingDoUsuario(req.usuario!.id)) });
    } catch (e) {
      logger.error({ e }, 'Erro ao salvar imagem da landing');
      erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
    }
  }
);

// GET /api/v1/landing/imagem — imagem atual (inclusive com a página despublicada), para o editor
router.get('/imagem', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const r = await pool.query(
      `SELECT imagem, imagem_mime FROM landing_pages WHERE usuario_id = $1 AND imagem IS NOT NULL`,
      [req.usuario!.id]
    );
    if (!r.rows.length) { res.status(404).end(); return; }
    res.setHeader('Content-Type', r.rows[0].imagem_mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(r.rows[0].imagem as Buffer);
  } catch {
    res.status(500).end();
  }
});

// DELETE /api/v1/landing/imagem
router.delete('/imagem', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    await pool.query(
      `UPDATE landing_pages SET imagem = NULL, imagem_mime = NULL, imagem_atualizada_em = NOW() WHERE usuario_id = $1`,
      [req.usuario!.id]
    );
    res.json({ sucesso: true, landing: resposta(await buscarLandingDoUsuario(req.usuario!.id)) });
  } catch {
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

// GET /api/v1/landing/convites — links de convite dos grupos de destino (para virar botão)
router.get('/convites', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const inst = await pool.query(
      `SELECT nome_instancia FROM whatsapp_instances WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [usuarioId]
    );
    if (!inst.rows.length) { res.json({ sucesso: true, grupos: [] }); return; }
    const instancia = inst.rows[0].nome_instancia as string;

    const grupos = await pool.query(
      `SELECT DISTINCT ON (group_jid) group_jid, nome FROM usuario_whatsapp_grupos
       WHERE usuario_id = $1 AND papel = 'destino' AND deletado_em IS NULL
       ORDER BY group_jid, nome LIMIT 10`,
      [usuarioId]
    );

    const url = process.env.EVOLUTION_API_URL || '';
    const key = process.env.EVOLUTION_API_KEY || '';
    const saida = await Promise.all((grupos.rows as { group_jid: string; nome: string }[]).map(async (g) => {
      try {
        const resp = await fetch(
          `${url}/group/inviteCode/${encodeURIComponent(instancia)}?groupJid=${encodeURIComponent(g.group_jid)}`,
          { headers: { apikey: key }, signal: AbortSignal.timeout(10000) }
        );
        const data = await resp.json().catch(() => ({})) as { inviteUrl?: string; inviteCode?: string };
        const link = data.inviteUrl || (data.inviteCode ? `https://chat.whatsapp.com/${data.inviteCode}` : null);
        return { groupJid: g.group_jid, nome: g.nome, link, erro: link ? null : 'O número precisa ser admin do grupo' };
      } catch {
        return { groupJid: g.group_jid, nome: g.nome, link: null, erro: 'Não foi possível consultar o WhatsApp' };
      }
    }));

    res.json({ sucesso: true, grupos: saida });
  } catch (e) {
    logger.error({ e }, 'Erro ao buscar convites');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

export default router;
