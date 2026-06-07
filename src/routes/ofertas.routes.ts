import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../config/database';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { logger } from '../utils/logger';

const router = Router();

/** Busca as credenciais Shopee do usuário na tabela user_settings (sem mascaramento) */
async function getShopeeCredenciais(usuarioId: string): Promise<{ appId: string; appSecret: string } | null> {
  const result = await pool.query(
    `SELECT payload FROM user_settings WHERE usuario_id = $1 AND tipo = 'affiliate'`,
    [usuarioId]
  );
  if (result.rows.length === 0) return null;

  const payload = result.rows[0].payload as Record<string, unknown>;
  const shopee  = payload?.shopee as Record<string, string> | undefined;

  if (!shopee?.appId || !shopee?.appSecret) return null;
  return { appId: shopee.appId, appSecret: shopee.appSecret };
}

// Categorias a sincronizar (mesmas do workflow n8n de referência)
const CATEGORIAS = [
  { id: 100013, nome: 'Eletrônicos'        },
  { id: 100011, nome: 'Eletrodomésticos'   },
  { id: 100003, nome: 'Utensílios Casa'    },
  { id: 100062, nome: 'Perfumes'           },
  { id: 100017, nome: 'Roupas'             },
  { id: 100018, nome: 'Calçados'           },
  { id: 10053,  nome: 'Suplementos'        },
  { id: 100055, nome: 'Produtos Higiene'   },
];

// Filtros mínimos (semelhantes ao n8n: preço > R$20 e comissão > 5%)
const MIN_PRECO      = 20;
const MIN_COMISSAO   = 0.05;

interface ProdutoShopee {
  itemId:         string;
  commissionRate: string | number;
  commission:     string | number;
  imageUrl:       string;
  price:          string | number;
  productLink:    string;
  offerLink:      string;
  productName:    string;
}

/**
 * Gera a assinatura SHA256 para a API da Shopee Affiliate.
 * Formato: SHA256(appID + timestamp + JSON.stringify(payload) + secret)
 */
function shopeeSign(appId: string, timestamp: string, payload: object, secret: string): string {
  const msg = `${appId}${timestamp}${JSON.stringify(payload)}${secret}`;
  return crypto.createHash('sha256').update(msg).digest('hex');
}

/**
 * Busca ofertas de uma categoria na API Shopee Affiliate.
 */
async function buscarCategoria(categoriaId: number, appId: string, secret: string): Promise<ProdutoShopee[]> {
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const payload = {
    query: `{ productOfferV2(listType: 0, productCatId: ${categoriaId}, limit: 20) { nodes { itemId commissionRate commission imageUrl price productLink offerLink productName } } }`,
  };

  const signature = shopeeSign(appId, timestamp, payload, secret);

  const resp = await fetch('https://open-api.affiliate.shopee.com.br/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Shopee API ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json() as Record<string, unknown>;
  const nodes = (data?.data as Record<string, unknown>)
    ?.productOfferV2 as Record<string, unknown>;

  return (nodes?.nodes as ProdutoShopee[]) || [];
}

// POST /api/v1/ofertas/sincronizar
// Busca ofertas em todas as categorias usando as credenciais Shopee do usuário logado
router.post('/sincronizar', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;

  const creds = await getShopeeCredenciais(usuarioId);
  if (!creds) {
    res.status(400).json({
      sucesso: false,
      erro: { mensagem: 'Configure seu App ID e App Secret da Shopee na página Afiliado antes de sincronizar.' },
    });
    return;
  }

  try {
    let totalNovos     = 0;
    let totalIgnorados = 0;
    const errosCat: string[] = [];

    for (const cat of CATEGORIAS) {
      try {
        const produtos = await buscarCategoria(cat.id, creds.appId, creds.appSecret);

        for (const p of produtos) {
          const preco         = parseFloat(String(p.price));
          const taxaComissao  = parseFloat(String(p.commissionRate));
          const comissao      = parseFloat(String(p.commission));

          // Aplicar filtros mínimos
          if (preco < MIN_PRECO || taxaComissao < MIN_COMISSAO) {
            totalIgnorados++;
            continue;
          }

          const result = await pool.query(
            `INSERT INTO ofertas
               (item_id, nome, preco, imagem_url, link_produto, link_afiliado,
                comissao, taxa_comissao, categoria_id, categoria_nome, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pendente')
             ON CONFLICT (item_id) DO UPDATE SET
               preco         = EXCLUDED.preco,
               link_afiliado = EXCLUDED.link_afiliado,
               taxa_comissao = EXCLUDED.taxa_comissao,
               atualizado_em = NOW()
             RETURNING (xmax = 0) AS inserido`,
            [
              p.itemId,
              p.productName,
              preco,
              p.imageUrl,
              p.productLink,
              p.offerLink,
              isNaN(comissao) ? null : comissao,
              taxaComissao,
              cat.id,
              cat.nome,
            ]
          );

          if (result.rows[0]?.inserido) totalNovos++;
          else totalIgnorados++;
        }
      } catch (err) {
        logger.warn({ categoria: cat.nome, err: (err as Error).message }, 'Erro ao buscar categoria Shopee');
        errosCat.push(`${cat.nome}: ${(err as Error).message}`);
      }
    }

    logger.info({ totalNovos, totalIgnorados, errosCat }, 'Sincronização Shopee concluída');
    res.json({ sucesso: true, totalNovos, totalIgnorados, errosCat });
  } catch (erro) {
    logger.error({ erro }, 'Erro na sincronização Shopee');
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// GET /api/v1/ofertas
// Lista ofertas paginadas, com filtro por categoria e status
router.get('/', autenticacaoRequerida, async (req: Request, res: Response): Promise<void> => {
  const { categoria, status, pagina = '1', limite = '20' } = req.query as Record<string, string>;
  const pg  = Math.max(1, parseInt(pagina));
  const lim = Math.min(100, Math.max(1, parseInt(limite)));
  const offset = (pg - 1) * lim;

  const filtros: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (categoria) { filtros.push(`categoria_id = $${idx++}`); params.push(parseInt(categoria)); }
  if (status)    { filtros.push(`status = $${idx++}`);       params.push(status); }

  const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : '';

  try {
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT id, item_id, nome, preco, imagem_url, link_produto, link_afiliado,
                comissao, taxa_comissao, categoria_id, categoria_nome, status,
                criado_em, atualizado_em
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
        pagina: pg,
        limite: lim,
        totalPaginas: Math.ceil(parseInt(total.rows[0].count) / lim),
      },
    });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao listar ofertas');
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// GET /api/v1/ofertas/categorias
// Lista as categorias disponíveis para o filtro
router.get('/categorias', autenticacaoRequerida, async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT categoria_id AS id, categoria_nome AS nome, COUNT(*) AS total
       FROM ofertas
       GROUP BY categoria_id, categoria_nome
       ORDER BY total DESC`
    );
    res.json({ sucesso: true, categorias: result.rows });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// PATCH /api/v1/ofertas/:id/status
// Atualiza o status de uma oferta (pendente → enviado)
router.patch('/:id/status', autenticacaoRequerida, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { status } = req.body as { status: string };

  if (!['pendente', 'enviado'].includes(status)) {
    res.status(400).json({ sucesso: false, erro: { mensagem: 'Status inválido.' } });
    return;
  }

  try {
    await pool.query(
      `UPDATE ofertas SET status = $1, atualizado_em = NOW() WHERE id = $2`,
      [status, id]
    );
    res.json({ sucesso: true });
  } catch (erro) {
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

export default router;
