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

const LISTAS_SHOPEE = [
  { query: 'productOfferV2(listType: 0, productCatId: 0, limit: 50)', nome: 'Top Comissão' },
  { query: 'productOfferV2(listType: 2, limit: 50)',                   nome: 'Flash Sale'   },
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

async function buscarListaShopee(queryPart: string, appId: string, secret: string): Promise<ProdutoShopee[]> {
  const ts      = Math.floor(Date.now() / 1000).toString();
  const payload = { query: `{ ${queryPart} { nodes { itemId commissionRate commission imageUrl price productLink offerLink productName } } }` };
  const sig     = shopeeSign(appId, ts, payload, secret);

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
  const data  = await resp.json() as Record<string, unknown>;
  const nodes = ((data?.data as Record<string, unknown>)?.productOfferV2 as Record<string, unknown>);
  return (nodes?.nodes as ProdutoShopee[]) || [];
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

/** Gera link de afiliado do ML via API do programa de afiliados */
async function gerarLinkAfiliadoML(
  url: string,
  tag: string,
  cookies: string,
): Promise<string | null> {
  if (!cookies || !tag) return null;

  try {
    const resp = await fetch(
      'https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink',
      {
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'accept':          'application/json, text/plain, */*',
          'accept-language': 'pt-BR,pt;q=0.9',
          'origin':          'https://www.mercadolivre.com.br',
          'referer':         'https://www.mercadolivre.com.br/afiliados/linkbuilder',
          'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'cookie':          cookies,
          'sec-fetch-dest':  'empty',
          'sec-fetch-mode':  'cors',
          'sec-fetch-site':  'same-origin',
        },
        body: JSON.stringify({ urls: [url], tag }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!resp.ok) {
      logger.warn({ status: resp.status, url }, 'ML affiliate link falhou');
      return null;
    }
    const data = await resp.json() as { urls?: { short_url?: string }[] };
    return data?.urls?.[0]?.short_url || null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Erro ao gerar link afiliado ML');
    return null;
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
    let totalNovos = 0, totalIgnorados = 0;
    const erros: string[] = [];

    for (const lista of LISTAS_SHOPEE) {
      try {
        const produtos = await buscarListaShopee(lista.query, creds.appId, creds.appSecret);
        for (const p of produtos) {
          const preco = parseFloat(String(p.price));
          const taxa  = parseFloat(String(p.commissionRate));
          const com   = parseFloat(String(p.commission));
          if (preco < MIN_PRECO || taxa < MIN_COMISSAO) { totalIgnorados++; continue; }

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
             p.offerLink, isNaN(com) ? null : com, taxa, lista.nome]
          );
          if (r.rows[0]?.inserido) totalNovos++; else totalIgnorados++;
        }
      } catch (err) {
        erros.push(`${lista.nome}: ${(err as Error).message}`);
      }
    }

    res.json({ sucesso: true, plataforma: 'shopee', totalNovos, totalIgnorados, erros });
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
          let linkAfiliado = await gerarLinkAfiliadoML(p.linkCompra, creds.tag, creds.cookies);
          if (!linkAfiliado) linkAfiliado = p.linkCompra;

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

  if (categoria)  { filtros.push(`categoria_id = $${idx++}`);   params.push(parseInt(categoria)); }
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
