// Rotas públicas (sem login) da landing page do usuário.
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../config/database';
import { logger } from '../utils/logger';
import { buscarLandingPublica, normalizarSlug } from '../services/landing.service';
import { renderizarLanding, renderizarNaoEncontrada } from '../services/landingHtml';

const router = Router();

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.PUBLIC_RATE_LIMIT || '120'),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
}));

/** Endereço público (para og:image/og:url): PUBLIC_URL ou o host que chegou pelo proxy. */
function origemPublica(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0];
  return `${proto}://${host}`;
}

// GET /api/v1/public/p/:slug — página HTML pronta (o nginx do frontend aponta /:slug para cá)
router.get('/p/:slug', async (req: Request, res: Response): Promise<void> => {
  const slug = normalizarSlug(req.params.slug);
  try {
    const landing = slug ? await buscarLandingPublica(slug) : null;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    if (!landing) { res.status(404).send(renderizarNaoEncontrada()); return; }

    pool.query(`UPDATE landing_pages SET visitas = visitas + 1 WHERE id = $1`, [landing.id]).catch(() => undefined);

    const origem = origemPublica(req);
    res.send(renderizarLanding(landing, {
      baseApi: `${origem}/api/v1`,
      urlPagina: `${origem}/${landing.slug}`,
    }));
  } catch (e) {
    logger.error({ e, slug }, 'Erro ao renderizar landing');
    res.status(500).send(renderizarNaoEncontrada());
  }
});

// GET /api/v1/public/landing/:slug — dados em JSON (para prévia no editor ou outro front)
router.get('/landing/:slug', async (req: Request, res: Response): Promise<void> => {
  try {
    const landing = await buscarLandingPublica(normalizarSlug(req.params.slug));
    if (!landing) { res.status(404).json({ sucesso: false, erro: { mensagem: 'Página não encontrada.' } }); return; }
    res.json({
      sucesso: true,
      landing: {
        slug: landing.slug, titulo: landing.titulo, descricao: landing.descricao, cor: landing.cor,
        imagem: landing.tem_imagem ? `/public/landing/${landing.slug}/imagem` : null,
        botoes: landing.botoes.map((b) => ({ id: b.id, rotulo: b.rotulo, tipo: b.tipo, href: `/public/l/${landing.slug}/${b.id}` })),
      },
    });
  } catch {
    res.status(500).json({ sucesso: false, erro: { mensagem: 'Erro interno' } });
  }
});

// GET /api/v1/public/landing/:slug/imagem
router.get('/landing/:slug/imagem', async (req: Request, res: Response): Promise<void> => {
  try {
    const r = await pool.query(
      `SELECT imagem, imagem_mime FROM landing_pages
       WHERE LOWER(slug) = LOWER($1) AND publicada = TRUE AND imagem IS NOT NULL`,
      [normalizarSlug(req.params.slug)]
    );
    if (!r.rows.length) { res.status(404).end(); return; }
    res.setHeader('Content-Type', r.rows[0].imagem_mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(r.rows[0].imagem as Buffer);
  } catch {
    res.status(500).end();
  }
});

// GET /api/v1/public/l/:slug/:botaoId — conta o clique e redireciona para o grupo
router.get('/l/:slug/:botaoId', async (req: Request, res: Response): Promise<void> => {
  const slug = normalizarSlug(req.params.slug);
  try {
    const r = await pool.query(
      `UPDATE landing_botoes b SET cliques = b.cliques + 1
       FROM landing_pages l
       WHERE b.landing_id = l.id AND b.id::text = $2 AND LOWER(l.slug) = LOWER($1)
         AND l.publicada = TRUE AND b.ativo = TRUE
       RETURNING b.url`,
      [slug, req.params.botaoId]
    );
    res.setHeader('Cache-Control', 'no-store');
    if (!r.rows.length) { res.redirect(302, `/${slug}`); return; }
    res.redirect(302, r.rows[0].url as string);
  } catch {
    res.redirect(302, `/${slug}`);
  }
});

export default router;
