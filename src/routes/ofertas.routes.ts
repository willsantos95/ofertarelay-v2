import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { parse as parseHtml } from 'node-html-parser';
import { pool } from '../config/database';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { logger } from '../utils/logger';

const router = Router();

// ─────────────────────────────────────────────
// Helpers de credenciais
// ─────────────────────────────────────────────

async function getShopeeCredenciais(usuarioId: string) {
  // 1. Tenta credenciais do usuário (página Afiliado)
  const r = await pool.query(
    `SELECT payload FROM user_settings WHERE usuario_id = $1 AND tipo = 'affiliate'`,
    [usuarioId]
  );
  const shopee = r.rows.length
    ? (r.rows[0].payload as Record<string, Record<string, string>>)?.shopee
    : null;

  const appId     = shopee?.appId     || process.env.SHOPEE_APP_ID  || '';
  const appSecret = shopee?.appSecret || process.env.SHOPEE_SECRET  || '';

  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

async function getMLCredenciais(usuarioId: string) {
  const r = await pool.query(
    `SELECT payload FROM user_settings WHERE usuario_id = $1 AND tipo = 'affiliate'`,
    [usuarioId]
  );
  if (!r.rows.length) return null;
  const ml = (r.rows[0].payload as Record<string, Record<string, string>>)?.mercadoLivre;
  if (!ml?.tag || !ml?.cookies) return null;
  const urls = (ml.urls || '')
    .split('\n')
    .map((u: string) => u.trim())
    .filter((u: string) => u.startsWith('http'));
  return { tag: ml.tag, cookies: ml.cookies, urls };
}

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

function shopeeSign(appId: string, ts: string, payload: object, secret: string) {
  return crypto.createHash('sha256')
    .update(`${appId}${ts}${JSON.stringify(payload)}${secret}`)
    .digest('hex');
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

const ML_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0';

/**
 * Mescla cookies antigos com os novos set-cookie da resposta.
 * Igual ao "merge cookies" do workflow n8n de referência.
 */
function mergeCookies(oldCookies: string, setCookieHeaders: string[]): string {
  const map: Record<string, string> = {};

  // Parsear cookies existentes
  oldCookies.split(';').forEach((c) => {
    const idx = c.trim().indexOf('=');
    if (idx > 0) {
      map[c.trim().slice(0, idx).trim()] = c.trim().slice(idx + 1).trim();
    }
  });

  // Sobrescrever com os novos set-cookie (apenas a parte nome=valor, ignorar path/expires/etc.)
  setCookieHeaders.forEach((header) => {
    const part = header.split(';')[0].trim();
    const idx  = part.indexOf('=');
    if (idx > 0) {
      map[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  });

  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Gera link de afiliado ML com refresh de cookies:
 * 1. GET /afiliados/linkbuilder → renova cookies via set-cookie headers
 * 2. Mescla cookies antigos + novos
 * 3. POST /affiliate-program/api/v2/affiliates/createLink
 * Retorna o short_url (ex: https://meli.la/1C8Lv8i) ou null se falhar.
 */
async function gerarLinkAfiliadoML(
  produtoUrl: string,
  tag: string,
  cookies: string,
): Promise<{ shortUrl: string | null; cookiesAtualizados: string }> {
  if (!cookies || !tag) return { shortUrl: null, cookiesAtualizados: cookies };

  let cookiesAtualizados = cookies;

  // Passo 1: Renovar cookies acessando a página do linkbuilder (igual ao n8n)
  try {
    const refreshResp = await fetch('https://www.mercadolivre.com.br/afiliados/linkbuilder', {
      headers: {
        'User-Agent': ML_UA,
        'accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'cookie':     cookies,
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });

    // Extrair set-cookie da resposta
    // Node 18.14+ tem getSetCookie(); fallback para get('set-cookie')
    const raw = (refreshResp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? [refreshResp.headers.get('set-cookie') ?? ''].filter(Boolean);

    if (raw.length > 0) {
      cookiesAtualizados = mergeCookies(cookies, raw);
      logger.info({ tag }, 'ML cookies renovados com sucesso');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'ML: falha ao renovar cookies, usando os originais');
  }

  // Passo 2: Gerar link de afiliado com os cookies atualizados
  try {
    const resp = await fetch(
      'https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink',
      {
        method: 'POST',
        headers: {
          'Content-Type':       'application/json',
          'accept':             'application/json, text/plain, */*',
          'accept-language':    'en-US,en;q=0.9',
          'origin':             'https://www.mercadolivre.com.br',
          'referer':            'https://www.mercadolivre.com.br/afiliados/linkbuilder',
          'user-agent':         ML_UA,
          'sec-ch-ua':          '"Not(A:Brand";v="8", "Chromium";v="144"',
          'sec-ch-ua-mobile':   '?0',
          'sec-ch-ua-platform': '"macOS"',
          'sec-fetch-dest':     'empty',
          'sec-fetch-mode':     'cors',
          'sec-fetch-site':     'same-origin',
          'cookie':             cookiesAtualizados,
        },
        body: JSON.stringify({ urls: [produtoUrl], tag }),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!resp.ok) {
      logger.warn({ status: resp.status, produtoUrl }, 'ML createLink falhou');
      return { shortUrl: null, cookiesAtualizados };
    }

    const data = await resp.json() as { urls?: { short_url?: string }[] };
    const shortUrl = data?.urls?.[0]?.short_url || null;
    logger.info({ shortUrl, produtoUrl }, 'ML link de afiliado gerado');
    return { shortUrl, cookiesAtualizados };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Erro ao gerar link afiliado ML');
    return { shortUrl: null, cookiesAtualizados };
  }
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
router.get('/', autenticacaoRequerida, async (req: Request, res: Response): Promise<void> => {
  const { categoria, status, plataforma, pagina = '1', limite = '24' } = req.query as Record<string, string>;
  const pg  = Math.max(1, parseInt(pagina));
  const lim = Math.min(100, Math.max(1, parseInt(limite)));
  const offset = (pg - 1) * lim;

  const filtros: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (categoria)  { filtros.push(`categoria_nome = $${idx++}`); params.push(categoria); }
  if (status)     { filtros.push(`status = $${idx++}`);         params.push(status); }
  if (plataforma) { filtros.push(`plataforma = $${idx++}`);     params.push(plataforma); }

  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

  try {
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT id, item_id, nome, preco, preco_original, desconto_pct,
                imagem_url, link_produto, link_afiliado,
                comissao, taxa_comissao, categoria_id, categoria_nome,
                plataforma, status, criado_em
         FROM ofertas ${where}
         ORDER BY criado_em DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, lim, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM ofertas ${where}`, params),
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

// POST /api/v1/ofertas/:id/gerar-link-afiliado
// Gera (ou renova) o link de afiliado ML com refresh de cookies
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

    // Shopee já tem link de afiliado direto — retorna como está
    if (oferta.plataforma !== 'mercadolivre') {
      res.json({ sucesso: true, linkAfiliado: oferta.link_afiliado });
      return;
    }

    const creds = await getMLCredenciais(usuarioId);
    if (!creds) {
      res.status(400).json({ sucesso: false, erro: { mensagem: 'Configure Tag e Cookies do ML na página Afiliado.' } });
      return;
    }

    const urlProduto = oferta.link_produto || oferta.link_afiliado || '';
    if (!urlProduto) {
      res.status(400).json({ sucesso: false, erro: { mensagem: 'Oferta sem URL de produto.' } });
      return;
    }

    const { shortUrl, cookiesAtualizados } = await gerarLinkAfiliadoML(urlProduto, creds.tag, creds.cookies);

    if (shortUrl) {
      // Persistir o link de afiliado gerado
      await pool.query(
        `UPDATE ofertas SET link_afiliado = $1, atualizado_em = NOW() WHERE id = $2`,
        [shortUrl, id]
      );

      // Persistir os cookies renovados para a próxima chamada
      if (cookiesAtualizados !== creds.cookies) {
        const settingsResult = await pool.query(
          `SELECT payload FROM user_settings WHERE usuario_id = $1 AND tipo = 'affiliate'`,
          [usuarioId]
        );
        if (settingsResult.rows.length) {
          const payload = settingsResult.rows[0].payload as Record<string, unknown>;
          const ml = (payload.mercadoLivre || {}) as Record<string, string>;
          await pool.query(
            `UPDATE user_settings SET payload = $1, atualizado_em = NOW()
             WHERE usuario_id = $2 AND tipo = 'affiliate'`,
            [JSON.stringify({ ...payload, mercadoLivre: { ...ml, cookies: cookiesAtualizados } }), usuarioId]
          );
        }
      }

      res.json({ sucesso: true, linkAfiliado: shortUrl });
    } else {
      res.json({ sucesso: false, linkAfiliado: oferta.link_afiliado, erro: { mensagem: 'Não foi possível gerar o link. Verifique os cookies do ML.' } });
    }
  } catch (erro) {
    logger.error({ erro }, 'Erro ao gerar link afiliado ML');
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// POST /api/v1/ofertas/:id/enviar-whatsapp
router.post('/:id/enviar-whatsapp', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const { id }    = req.params;
  const { legenda, grupos } = req.body as { legenda: string; grupos?: string[] };
  const usuarioId = req.usuario!.id;

  try {
    // Buscar oferta
    const ofertaResult = await pool.query('SELECT * FROM ofertas WHERE id = $1', [id]);
    if (!ofertaResult.rows.length) {
      res.status(404).json({ sucesso: false, erro: { mensagem: 'Oferta não encontrada.' } });
      return;
    }
    const oferta = ofertaResult.rows[0] as { imagem_url: string | null };

    // Buscar instância WhatsApp conectada
    const instResult = await pool.query(
      `SELECT nome_instancia FROM whatsapp_instances
       WHERE usuario_id = $1 AND status = 'conectado'
       ORDER BY criado_em DESC LIMIT 1`,
      [usuarioId]
    );
    if (!instResult.rows.length) {
      res.status(400).json({ sucesso: false, erro: { mensagem: 'WhatsApp não está conectado.' } });
      return;
    }
    const nomeInstancia = instResult.rows[0].nome_instancia as string;

    // Grupos de destino: usa os fornecidos ou busca os configurados
    let gruposDestino: string[] = grupos || [];
    if (!gruposDestino.length) {
      const gr = await pool.query(
        `SELECT group_jid FROM usuario_whatsapp_grupos
         WHERE usuario_id = $1 AND papel = 'destino' AND deletado_em IS NULL`,
        [usuarioId]
      );
      gruposDestino = gr.rows.map((r: { group_jid: string }) => r.group_jid);
    }

    if (!gruposDestino.length) {
      res.status(400).json({ sucesso: false, erro: { mensagem: 'Nenhum grupo de destino configurado. Configure na página Grupos.' } });
      return;
    }

    const evoUrl = process.env.EVOLUTION_API_URL || '';
    const evoKey = process.env.EVOLUTION_API_KEY || '';
    const enviados: string[] = [];
    const erros:    string[] = [];

    for (const groupJid of gruposDestino) {
      try {
        let endpoint: string;
        let body: Record<string, unknown>;

        if (oferta.imagem_url) {
          // Enviar imagem com legenda
          endpoint = `/message/sendMedia/${nomeInstancia}`;
          body = {
            number:    groupJid,
            mediatype: 'image',
            media:     oferta.imagem_url,
            mimetype:  'image/jpeg',
            caption:   legenda,
          };
        } else {
          // Sem imagem — enviar só texto
          endpoint = `/message/sendText/${nomeInstancia}`;
          body = { number: groupJid, text: legenda };
        }

        const resp = await fetch(`${evoUrl}${endpoint}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', apikey: evoKey },
          body:    JSON.stringify(body),
          signal:  AbortSignal.timeout(15000),
        });

        if (resp.ok) {
          enviados.push(groupJid);
        } else {
          const txt = await resp.text();
          erros.push(`${groupJid}: ${txt.slice(0, 120)}`);
        }
      } catch (err) {
        erros.push(`${groupJid}: ${(err as Error).message}`);
      }
    }

    // Marcar como enviado se pelo menos um grupo recebeu
    if (enviados.length > 0) {
      await pool.query(
        `UPDATE ofertas SET status = 'enviado', atualizado_em = NOW() WHERE id = $1`,
        [id]
      );
    }

    logger.info({ id, enviados: enviados.length, erros }, 'Oferta enviada ao WhatsApp');
    res.json({ sucesso: true, enviados: enviados.length, erros });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao enviar oferta para WhatsApp');
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// POST /api/v1/ofertas/:id/enviar-telegram
router.post('/:id/enviar-telegram', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const { id }    = req.params;
  const { legenda, chatIds } = req.body as { legenda: string; chatIds?: string[] };
  const usuarioId = req.usuario!.id;

  try {
    // Buscar configurações reais do Telegram (sem mascaramento)
    const tgResult = await pool.query(
      `SELECT payload FROM user_settings WHERE usuario_id = $1 AND tipo = 'telegram'`,
      [usuarioId]
    );
    if (!tgResult.rows.length) {
      res.status(400).json({ sucesso: false, erro: { mensagem: 'Telegram não configurado.' } });
      return;
    }

    const tg = tgResult.rows[0].payload as { botToken: string; chatIds: string[]; status: string };
    if (tg.status !== 'active') {
      res.status(400).json({ sucesso: false, erro: { mensagem: 'Telegram não está ativo.' } });
      return;
    }
    if (!tg.botToken) {
      res.status(400).json({ sucesso: false, erro: { mensagem: 'Bot Token do Telegram não configurado.' } });
      return;
    }

    const destinos: string[] = chatIds?.length ? chatIds : (tg.chatIds || []);
    if (!destinos.length) {
      res.status(400).json({ sucesso: false, erro: { mensagem: 'Nenhum Chat ID configurado no Telegram.' } });
      return;
    }

    // Buscar oferta
    const ofertaResult = await pool.query('SELECT imagem_url FROM ofertas WHERE id = $1', [id]);
    if (!ofertaResult.rows.length) {
      res.status(404).json({ sucesso: false, erro: { mensagem: 'Oferta não encontrada.' } });
      return;
    }
    const oferta = ofertaResult.rows[0] as { imagem_url: string | null };

    const enviados: string[] = [];
    const erros:    string[] = [];

    for (const chatId of destinos) {
      try {
        let endpoint: string;
        let body: Record<string, unknown>;

        if (oferta.imagem_url) {
          endpoint = `https://api.telegram.org/bot${tg.botToken}/sendPhoto`;
          body = {
            chat_id:    chatId,
            photo:      oferta.imagem_url,
            caption:    legenda,
            parse_mode: 'Markdown',
          };
        } else {
          endpoint = `https://api.telegram.org/bot${tg.botToken}/sendMessage`;
          body = {
            chat_id:    chatId,
            text:       legenda,
            parse_mode: 'Markdown',
          };
        }

        const resp = await fetch(endpoint, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
          signal:  AbortSignal.timeout(15000),
        });

        const data = await resp.json() as { ok: boolean; description?: string };
        if (data.ok) {
          enviados.push(chatId);
        } else {
          erros.push(`${chatId}: ${data.description || 'Erro desconhecido'}`);
        }
      } catch (err) {
        erros.push(`${chatId}: ${(err as Error).message}`);
      }
    }

    if (enviados.length > 0) {
      await pool.query(
        `UPDATE ofertas SET status = 'enviado', atualizado_em = NOW() WHERE id = $1`,
        [id]
      );
    }

    logger.info({ id, enviados: enviados.length, erros }, 'Oferta enviada ao Telegram');
    res.json({ sucesso: true, enviados: enviados.length, erros });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao enviar oferta para Telegram');
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// PATCH /api/v1/ofertas/:id/status
router.patch('/:id/status', autenticacaoRequerida, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { status } = req.body as { status: string };
  if (!['pendente', 'enviado'].includes(status)) {
    res.status(400).json({ sucesso: false, erro: { mensagem: 'Status inválido.' } });
    return;
  }
  try {
    await pool.query(`UPDATE ofertas SET status=$1, atualizado_em=NOW() WHERE id=$2`, [status, id]);
    res.json({ sucesso: true });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

export default router;
