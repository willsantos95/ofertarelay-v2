import { Router, Request, Response } from 'express';
import { parse as parseHtml } from 'node-html-parser';
import { pool } from '../config/database';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { logger } from '../utils/logger';
import { enviarOfertaWhatsApp, enviarOfertaTelegram } from '../services/envio.service';
import { melhorarLegendaIA, iaConfigurada } from '../services/ia.service';
import {
  getShopeeCredenciais, getMLCredenciais, shopeeSign,
  gerarShortLinkShopee, gerarLinkAfiliadoML, persistirCookiesML,
} from '../services/afiliado.service';

const router = Router();

// ─────────────────────────────────────────────
// SHOPEE
// ─────────────────────────────────────────────

// Fontes de busca da Shopee Affiliate API:
//  - listType: listas curadas da Shopee (2 = Flash Sale costuma ser a única ativa)
//  - keyword:  busca por palavra-chave — traz MUITO mais produtos, por categoria
interface ShopeeArgs {
  listType?: number;
  productCatId?: number;
  keyword?: string;
  sortType?: number;   // 2 = mais vendidos · 5 = maior comissão
  page?: number;
  limit?: number;
}

interface ShopeeFonte {
  args: ShopeeArgs;
  nome: string;
  paginas: number;
}

// Cada palavra-chave vira uma "categoria" de ofertas
const SHOPEE_KEYWORDS = [
  'eletrônicos', 'casa e cozinha', 'beleza', 'moda feminina', 'moda masculina',
  'esporte e lazer', 'bebês', 'pet shop', 'ferramentas', 'celular',
  'fone de ouvido', 'gamer',
];

const LISTAS_SHOPEE: ShopeeFonte[] = [
  // Listas curadas por tipo (a Shopee pode retornar vazio em algumas)
  { args: { listType: 2 }, nome: 'Flash Sale',    paginas: 2 },
  { args: { listType: 1 }, nome: 'Mais Vendidos', paginas: 2 },
  // Busca por palavra-chave (fonte principal de variedade)
  ...SHOPEE_KEYWORDS.map((k): ShopeeFonte => ({
    args: { keyword: k, sortType: 2 },
    nome: k.charAt(0).toUpperCase() + k.slice(1),
    paginas: 1,
  })),
];

const MIN_PRECO    = 20;
const MIN_COMISSAO = 0.05;

interface ProdutoShopee {
  itemId: string; commissionRate: string | number;
  commission: string | number; imageUrl: string;
  price: string | number; productLink: string;
  offerLink: string; productName: string;
}

/** Monta os argumentos do productOfferV2 a partir de um objeto. */
function buildShopeeArgs(a: ShopeeArgs): string {
  const parts: string[] = [];
  if (a.listType     !== undefined) parts.push(`listType: ${a.listType}`);
  if (a.productCatId !== undefined) parts.push(`productCatId: ${a.productCatId}`);
  if (a.keyword)                    parts.push(`keyword: ${JSON.stringify(a.keyword)}`);
  if (a.sortType     !== undefined) parts.push(`sortType: ${a.sortType}`);
  if (a.page         !== undefined) parts.push(`page: ${a.page}`);
  parts.push(`limit: ${a.limit ?? 50}`);
  return parts.join(', ');
}

async function buscarListaShopee(
  args: ShopeeArgs, appId: string, secret: string,
): Promise<{ nodes: ProdutoShopee[]; hasNextPage: boolean }> {
  const ts        = Math.floor(Date.now() / 1000).toString();
  const queryPart = `productOfferV2(${buildShopeeArgs(args)})`;
  const payload   = { query: `{ ${queryPart} { nodes { itemId commissionRate commission imageUrl price productLink offerLink productName } pageInfo { page limit hasNextPage } } }` };
  const sig       = shopeeSign(appId, ts, payload, secret);

  const resp = await fetch('https://open-api.affiliate.shopee.com.br/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${sig}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });

  if (!resp.ok) throw new Error(`Shopee API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);

  const data = await resp.json() as Record<string, unknown>;

  // A API pode responder 200 com erros no corpo (ex.: listType/sortType inválido)
  const gqlErros = data?.errors as Array<{ message?: string }> | undefined;
  if (gqlErros?.length) throw new Error(gqlErros.map(e => e.message).join('; ').slice(0, 200));

  const block    = (data?.data as Record<string, unknown>)?.productOfferV2 as Record<string, unknown> | undefined;
  const nodes    = (block?.nodes as ProdutoShopee[]) || [];
  const pageInfo = block?.pageInfo as { hasNextPage?: boolean } | undefined;
  return { nodes, hasNextPage: pageInfo?.hasNextPage ?? false };
}

/** Busca várias páginas de uma mesma fonte, parando quando não há mais resultados. */
async function buscarPaginado(
  base: ShopeeArgs, maxPaginas: number, appId: string, secret: string,
): Promise<ProdutoShopee[]> {
  const todos: ProdutoShopee[] = [];
  for (let page = 1; page <= maxPaginas; page++) {
    const { nodes, hasNextPage } = await buscarListaShopee({ ...base, page }, appId, secret);
    todos.push(...nodes);
    if (!hasNextPage || nodes.length === 0) break;
  }
  return todos;
}

// ─────────────────────────────────────────────
// MERCADO LIVRE
// ─────────────────────────────────────────────

interface MLProduto {
  nome: string; imagem: string; precoRaw: string;
  linkCompra: string; idProduto: string;
}

interface MLPrecos {
  precoFinal: number; precoOriginal: number | null; descontoPct: number | null;
}

/** Extrai preço, preço original e % desconto do texto bruto retornado pelo ML */
function parsePrecosML(raw: string): MLPrecos {
  const linhas = raw.replace(/\\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  if (!linhas.length) return { precoFinal: 0, precoOriginal: null, descontoPct: null };

  const toNum = (s: string) => parseFloat(s.replace(/\./g, '').replace(',', '.'));

  // Primeira linha = preço principal ou preço "de"
  const matchP = linhas[0].match(/R\$\s?([\d.,]+)/);
  if (!matchP) return { precoFinal: 0, precoOriginal: null, descontoPct: null };
  const precoPrincipal = toNum(matchP[1]);

  // Segunda linha pode ser: "R$34,9330% OFF" (bloco com desconto colado)
  if (linhas.length > 1) {
    const bloco = linhas[1];

    // Formato: "R$XX.XX YY% OFF"  (separados)
    const matchSep = bloco.match(/R\$\s?([\d.,]+)\s+(\d+)%\s*OFF/i);
    if (matchSep) {
      return {
        precoOriginal: precoPrincipal,
        precoFinal:    toNum(matchSep[1]),
        descontoPct:   parseInt(matchSep[2], 10),
      };
    }

    // Formato legado: "R$34,9330% OFF" (preço e desconto colados)
    const matchCola = bloco.match(/R\$\s?([\d,.]+)/);
    const matchPct  = bloco.match(/(\d+)%\s*OFF/i);
    if (matchCola && matchPct) {
      const blocoNum  = matchCola[1];
      const desconto  = parseInt(matchPct[1], 10);
      // O desconto pode estar no final dos dígitos colado: "34,9330" → pct=30, preço=34,93
      const precoStr  = blocoNum.length > 4 ? blocoNum.slice(0, -2) : blocoNum;
      return {
        precoOriginal: precoPrincipal,
        precoFinal:    toNum(precoStr),
        descontoPct:   desconto,
      };
    }

    // Só tem % OFF sem preço (preço único já na linha 1)
    if (matchPct) {
      return { precoFinal: precoPrincipal, precoOriginal: null, descontoPct: parseInt(matchPct[1], 10) };
    }
  }

  return { precoFinal: precoPrincipal, precoOriginal: null, descontoPct: null };
}

/** Extrai ID do produto MLB do link */
function extrairIdML(url: string): string {
  const m = url.match(/MLB-?(\d+)/i);
  return m ? `MLB${m[1]}` : `ML_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Faz scraping de uma página do ML e retorna lista de produtos */
async function scrapeMLPage(url: string, cookies = ''): Promise<MLProduto[]> {
  const headers: Record<string, string> = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  if (cookies) headers['Cookie'] = cookies;

  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`ML HTTP ${resp.status} em ${url}`);

  const html = await resp.text();
  const root = parseHtml(html);

  const produtos: MLProduto[] = [];

  // Busca o .poly-card PAI (que contém tanto .poly-card__portada com a imagem
  // quanto .poly-card__content com título, preço e link)
  const cards = root.querySelectorAll('.poly-card');

  for (const card of cards) {
    const content  = card.querySelector('.poly-card__content');
    if (!content) continue;

    const aEl     = content.querySelector('h3 > a');
    const precoEl = content.querySelector('div.poly-component__price');

    // Imagem está na div irmã (.poly-card__portada), não dentro do content
    const imgEl = card.querySelector('img.poly-component__picture');

    const nome       = aEl?.text?.trim()  || '';
    const linkCompra = aEl?.getAttribute('href') || '';
    // src pode ser placeholder em lazy load; data-src tem a URL real
    const imagem = imgEl?.getAttribute('data-src') || imgEl?.getAttribute('src') || '';
    const precoRaw   = precoEl?.text?.trim() || '';

    // Filtrar links patrocinados (click1.mercadolivre) e sem nome
    if (!nome || !linkCompra || linkCompra.includes('click1.mercadolivre')) continue;
    if (!linkCompra.includes('mercadolivre.com.br')) continue;

    produtos.push({ nome, imagem, precoRaw, linkCompra, idProduto: extrairIdML(linkCompra) });
  }

  return produtos;
}

// ─────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────

// POST /api/v1/ofertas/sincronizar  (Shopee)
router.post('/sincronizar', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const creds = await getShopeeCredenciais(req.usuario!.id);
  if (!creds) {
    res.status(400).json({ sucesso: false, erro: { mensagem: 'Configure App ID e App Secret da Shopee na página Afiliado.' } });
    return;
  }

  try {
    const porItem  = new Map<string, { p: ProdutoShopee; categoria: string }>();
    const detalhes: { fonte: string; encontrados: number }[] = [];
    const erros: string[] = [];

    // 1. Coleta de todas as fontes (com paginação) + dedupe por itemId
    for (const fonte of LISTAS_SHOPEE) {
      try {
        const produtos = await buscarPaginado(fonte.args, fonte.paginas, creds.appId, creds.appSecret);
        for (const p of produtos) {
          if (!p?.itemId) continue;
          const key = String(p.itemId);
          if (!porItem.has(key)) porItem.set(key, { p, categoria: fonte.nome });
        }
        detalhes.push({ fonte: fonte.nome, encontrados: produtos.length });
      } catch (err) {
        erros.push(`${fonte.nome}: ${(err as Error).message}`);
      }
    }

    // 2. Persistência das ofertas únicas
    let totalNovos = 0, totalIgnorados = 0;
    for (const { p, categoria } of porItem.values()) {
      const preco = parseFloat(String(p.price));
      const taxa  = parseFloat(String(p.commissionRate));
      const com   = parseFloat(String(p.commission));
      if (isNaN(preco) || preco < MIN_PRECO || isNaN(taxa) || taxa < MIN_COMISSAO) { totalIgnorados++; continue; }

      const r = await pool.query(
        `INSERT INTO ofertas
           (item_id, nome, preco, imagem_url, link_produto, link_afiliado,
            comissao, taxa_comissao, categoria_nome, plataforma, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'shopee','pendente')
         ON CONFLICT (item_id) DO UPDATE SET
           preco=EXCLUDED.preco, link_afiliado=EXCLUDED.link_afiliado,
           taxa_comissao=EXCLUDED.taxa_comissao, atualizado_em=NOW()
         RETURNING (xmax=0) AS inserido`,
        [p.itemId, p.productName, preco, p.imageUrl, p.productLink,
         p.offerLink, isNaN(com) ? null : com, taxa, categoria]
      );
      if (r.rows[0]?.inserido) totalNovos++; else totalIgnorados++;
    }

    res.json({
      sucesso: true, plataforma: 'shopee',
      totalNovos, totalIgnorados, totalUnicos: porItem.size,
      detalhes, erros,
    });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// POST /api/v1/ofertas/sincronizar/mercadolivre
router.post('/sincronizar/mercadolivre', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const creds = await getMLCredenciais(req.usuario!.id);
  if (!creds) {
    res.status(400).json({
      sucesso: false,
      erro: { mensagem: 'Configure Tag e Cookies do Mercado Livre na página Afiliado.' },
    });
    return;
  }

  if (!creds.urls.length) {
    res.status(400).json({
      sucesso: false,
      erro: { mensagem: 'Adicione ao menos uma URL do Mercado Livre nas configurações de Afiliado (campo "URLs para buscar").' },
    });
    return;
  }

  try {
    let totalNovos = 0, totalIgnorados = 0;
    const erros: string[] = [];

    for (const url of creds.urls) {
      try {
        const produtos = await scrapeMLPage(url, creds.cookies);

        for (const p of produtos) {
          const { precoFinal, precoOriginal, descontoPct } = parsePrecosML(p.precoRaw);
          if (!precoFinal || precoFinal < MIN_PRECO) { totalIgnorados++; continue; }

          // Gerar link de afiliado (fallback para link original se cookies expiraram)
          const { shortUrl } = await gerarLinkAfiliadoML(p.linkCompra, creds.tag, creds.cookies);
          const linkAfiliado = shortUrl || p.linkCompra;

          const r = await pool.query(
            `INSERT INTO ofertas
               (item_id, nome, preco, preco_original, desconto_pct,
                imagem_url, link_produto, link_afiliado,
                categoria_nome, plataforma, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Mercado Livre','mercadolivre','pendente')
             ON CONFLICT (item_id) DO UPDATE SET
               preco=EXCLUDED.preco, preco_original=EXCLUDED.preco_original,
               desconto_pct=EXCLUDED.desconto_pct,
               link_afiliado=EXCLUDED.link_afiliado, atualizado_em=NOW()
             RETURNING (xmax=0) AS inserido`,
            [p.idProduto, p.nome, precoFinal, precoOriginal, descontoPct,
             p.imagem, p.linkCompra, linkAfiliado]
          );
          if (r.rows[0]?.inserido) totalNovos++; else totalIgnorados++;
        }
      } catch (err) {
        logger.warn({ url, err: (err as Error).message }, 'Erro ao scrape ML');
        erros.push(`${url}: ${(err as Error).message}`);
      }
    }

    res.json({ sucesso: true, plataforma: 'mercadolivre', totalNovos, totalIgnorados, erros });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// GET /api/v1/ofertas
router.get('/', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  const { categoria, status, plataforma, pagina = '1', limite = '24' } = req.query as Record<string, string>;
  const pg  = Math.max(1, parseInt(pagina));
  const lim = Math.min(100, Math.max(1, parseInt(limite)));
  const offset = (pg - 1) * lim;

  // $1 é sempre o usuarioId (para o LEFT JOIN de enviado_por_mim)
  const params: unknown[] = [usuarioId];
  const filtros: string[] = [];
  let idx = 2;

  if (categoria)  { filtros.push(`o.categoria_nome = $${idx++}`); params.push(categoria); }
  if (plataforma) { filtros.push(`o.plataforma = $${idx++}`);     params.push(plataforma); }

  // Filtro de status é agora por usuário: "enviado" = tem registro em ofertas_enviadas
  if (status === 'enviado')  filtros.push('oe.oferta_id IS NOT NULL');
  if (status === 'pendente') filtros.push('oe.oferta_id IS NULL');

  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

  try {
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT o.id, o.item_id, o.nome, o.preco, o.preco_original, o.desconto_pct,
                o.imagem_url, o.link_produto, o.link_afiliado,
                o.comissao, o.taxa_comissao, o.categoria_id, o.categoria_nome,
                o.plataforma, o.criado_em,
                (oe.oferta_id IS NOT NULL) AS enviado_por_mim
         FROM ofertas o
         LEFT JOIN ofertas_enviadas oe
           ON oe.oferta_id = o.id AND oe.usuario_id = $1
         ${where}
         ORDER BY o.criado_em DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, lim, offset]
      ),
      pool.query(
        `SELECT COUNT(*)
         FROM ofertas o
         LEFT JOIN ofertas_enviadas oe
           ON oe.oferta_id = o.id AND oe.usuario_id = $1
         ${where}`,
        params
      ),
    ]);

    res.json({
      sucesso: true,
      ofertas: rows.rows,
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

// GET /api/v1/ofertas/categorias
router.get('/categorias', autenticacaoRequerida, async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT categoria_nome AS nome, plataforma, COUNT(*) AS total
       FROM ofertas
       GROUP BY categoria_nome, plataforma
       ORDER BY total DESC`
    );
    res.json({ sucesso: true, categorias: result.rows });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// DELETE /api/v1/ofertas  — limpa ofertas (todas ou filtradas por plataforma/status)
router.delete('/', autenticacaoRequerida, async (req: Request, res: Response): Promise<void> => {
  const { plataforma, status } = req.query as Record<string, string>;
  const filtros: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (plataforma) { filtros.push(`plataforma = $${idx++}`); params.push(plataforma); }
  if (status)     { filtros.push(`status = $${idx++}`);     params.push(status); }

  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

  try {
    const r = await pool.query(`DELETE FROM ofertas ${where}`, params);
    res.json({ sucesso: true, removidas: r.rowCount ?? 0 });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// POST /api/v1/ofertas/:id/gerar-link-afiliado
// Gera o link de afiliado do usuário logado no momento (Shopee ou ML)
router.post('/:id/gerar-link-afiliado', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const { id }    = req.params;
  const usuarioId = req.usuario!.id;

  try {
    const ofertaResult = await pool.query(
      `SELECT id, plataforma, link_produto, link_afiliado FROM ofertas WHERE id = $1`,
      [id]
    );
    if (!ofertaResult.rows.length) {
      res.status(404).json({ sucesso: false, erro: { mensagem: 'Oferta não encontrada.' } });
      return;
    }
    const oferta = ofertaResult.rows[0] as {
      id: string; plataforma: string;
      link_produto: string | null; link_afiliado: string | null;
    };

    const urlOrigem = oferta.link_produto || oferta.link_afiliado || '';
    if (!urlOrigem) {
      res.status(400).json({ sucesso: false, erro: { mensagem: 'Oferta sem URL de produto.' } });
      return;
    }

    // ── SHOPEE ──────────────────────────────────────────────────────
    if (oferta.plataforma === 'shopee') {
      const creds = await getShopeeCredenciais(usuarioId);
      if (!creds) {
        res.status(400).json({ sucesso: false, erro: { mensagem: 'Configure App ID e App Secret da Shopee na página Afiliado.' } });
        return;
      }
      const shortLink = await gerarShortLinkShopee(creds.appId, creds.appSecret, urlOrigem, { usuarioId, contexto: 'manual' });
      if (shortLink) {
        res.json({ sucesso: true, linkAfiliado: shortLink });
      } else {
        res.json({ sucesso: false, linkAfiliado: oferta.link_afiliado, erro: { mensagem: 'Não foi possível gerar o short link da Shopee. Verifique suas credenciais.' } });
      }
      return;
    }

    // ── MERCADO LIVRE ────────────────────────────────────────────────
    if (oferta.plataforma === 'mercadolivre') {
      const creds = await getMLCredenciais(usuarioId);
      if (!creds) {
        res.status(400).json({ sucesso: false, erro: { mensagem: 'Configure Tag e Cookies do ML na página Afiliado.' } });
        return;
      }
      const { shortUrl, cookiesAtualizados } = await gerarLinkAfiliadoML(urlOrigem, creds.tag, creds.cookies, { usuarioId, contexto: 'manual' });
      if (cookiesAtualizados !== creds.cookies) {
        await persistirCookiesML(usuarioId, cookiesAtualizados);
      }
      if (shortUrl) {
        res.json({ sucesso: true, linkAfiliado: shortUrl });
      } else {
        res.json({ sucesso: false, linkAfiliado: oferta.link_afiliado, erro: { mensagem: 'Não foi possível gerar o link. Verifique os cookies do ML.' } });
      }
      return;
    }

    // Plataforma desconhecida — devolve o que tiver
    res.json({ sucesso: true, linkAfiliado: oferta.link_afiliado });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao gerar link afiliado');
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// POST /api/v1/ofertas/:id/enviar-whatsapp
router.post('/:id/enviar-whatsapp', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const { id } = req.params;
  const { legenda, grupos } = req.body as { legenda: string; grupos?: string[] };
  try {
    const r = await enviarOfertaWhatsApp(req.usuario!.id, id, legenda, grupos);
    res.json({ sucesso: true, enviados: r.enviados, erros: r.erros });
  } catch (erro) {
    res.status(400).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// POST /api/v1/ofertas/:id/enviar-telegram
router.post('/:id/enviar-telegram', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const { id } = req.params;
  const { legenda, chatIds } = req.body as { legenda: string; chatIds?: string[] };
  try {
    const r = await enviarOfertaTelegram(req.usuario!.id, id, legenda, chatIds);
    res.json({ sucesso: true, enviados: r.enviados, erros: r.erros });
  } catch (erro) {
    res.status(400).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// POST /api/v1/ofertas/:id/legenda-ia  — reescreve a legenda com IA
router.post('/:id/legenda-ia', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const { id } = req.params;
  const { legenda } = req.body as { legenda?: string };

  if (!iaConfigurada()) {
    res.status(400).json({ sucesso: false, erro: { mensagem: 'IA não configurada no servidor (defina OPENAI_API_KEY).' } });
    return;
  }

  if (!legenda || !legenda.trim()) {
    res.status(400).json({ sucesso: false, erro: { mensagem: 'Legenda obrigatória para melhoria com IA.' } });
    return;
  }

  try {
    const r = await pool.query(
      `SELECT nome, preco, desconto_pct, link_produto, link_afiliado, plataforma FROM ofertas WHERE id = $1`,
      [id]
    );
    if (!r.rows.length) {
      res.status(404).json({ sucesso: false, erro: { mensagem: 'Oferta não encontrada.' } });
      return;
    }
    const o = r.rows[0] as {
      nome: string; preco: string; desconto_pct: number | null;
      link_produto: string | null; link_afiliado: string | null; plataforma: string;
    };
    const link = o.link_afiliado || o.link_produto || '';
    const nova = await melhorarLegendaIA(legenda || '', {
      nome: o.nome,
      preco: o.preco,
      plataforma: o.plataforma === 'shopee' ? 'Shopee' : 'Mercado Livre',
      link,
      descontoPct: o.desconto_pct,
    });
    res.json({ sucesso: true, legenda: nova });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao gerar legenda com IA');
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// PATCH /api/v1/ofertas/:id/status  — controle de enviado POR USUÁRIO
router.patch('/:id/status', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const { id }      = req.params;
  const usuarioId   = req.usuario!.id;
  const { status }  = req.body as { status: string };
  if (!['pendente', 'enviado'].includes(status)) {
    res.status(400).json({ sucesso: false, erro: { mensagem: 'Status inválido.' } });
    return;
  }
  try {
    if (status === 'enviado') {
      await pool.query(
        `INSERT INTO ofertas_enviadas (oferta_id, usuario_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, usuarioId]
      );
    } else {
      await pool.query(
        `DELETE FROM ofertas_enviadas WHERE oferta_id = $1 AND usuario_id = $2`,
        [id, usuarioId]
      );
    }
    res.json({ sucesso: true });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

export default router;
