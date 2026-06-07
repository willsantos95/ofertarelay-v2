// Serviço de credenciais e geração de links de afiliado (Shopee + Mercado Livre).
// Compartilhado entre as rotas (sincronização/envio manual) e o worker da fila.

import crypto from 'crypto';
import { pool } from '../config/database';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// Credenciais (página Afiliado)
// ─────────────────────────────────────────────

export async function getShopeeCredenciais(usuarioId: string): Promise<{ appId: string; appSecret: string } | null> {
  const r = await pool.query(
    `SELECT payload FROM user_settings WHERE usuario_id = $1 AND tipo = 'affiliate'`,
    [usuarioId]
  );
  const shopee = r.rows.length
    ? (r.rows[0].payload as Record<string, Record<string, string>>)?.shopee
    : null;

  const appId     = shopee?.appId     || process.env.SHOPEE_APP_ID || '';
  const appSecret = shopee?.appSecret || process.env.SHOPEE_SECRET || '';

  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

export async function getMLCredenciais(usuarioId: string): Promise<{ tag: string; cookies: string; urls: string[] } | null> {
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

export function shopeeSign(appId: string, ts: string, payload: object, secret: string): string {
  return crypto.createHash('sha256')
    .update(`${appId}${ts}${JSON.stringify(payload)}${secret}`)
    .digest('hex');
}

/** Gera um short link de afiliado da Shopee para a URL do produto (origin). */
export async function gerarShortLinkShopee(appId: string, secret: string, originUrl: string): Promise<string | null> {
  const ts      = Math.floor(Date.now() / 1000).toString();
  const query   = `mutation{generateShortLink(input:{originUrl:${JSON.stringify(originUrl)},subIds:[]}){shortLink}}`;
  const payload = { query };
  const sig     = shopeeSign(appId, ts, payload, secret);

  const resp = await fetch('https://open-api.affiliate.shopee.com.br/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${sig}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) throw new Error(`Shopee shortLink ${resp.status}: ${(await resp.text()).slice(0, 200)}`);

  const data = await resp.json() as {
    data?: { generateShortLink?: { shortLink?: string } };
    errors?: { message?: string }[];
  };
  if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join('; ').slice(0, 200));
  return data.data?.generateShortLink?.shortLink || null;
}

// ─────────────────────────────────────────────
// MERCADO LIVRE
// ─────────────────────────────────────────────

const ML_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0';

/** Mescla cookies antigos com os novos set-cookie da resposta. */
export function mergeCookies(oldCookies: string, setCookieHeaders: string[]): string {
  const map: Record<string, string> = {};

  oldCookies.split(';').forEach((c) => {
    const idx = c.trim().indexOf('=');
    if (idx > 0) map[c.trim().slice(0, idx).trim()] = c.trim().slice(idx + 1).trim();
  });

  setCookieHeaders.forEach((header) => {
    const part = header.split(';')[0].trim();
    const idx  = part.indexOf('=');
    if (idx > 0) map[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });

  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Gera link de afiliado ML com refresh de cookies:
 * 1. GET /afiliados/linkbuilder → renova cookies
 * 2. Mescla cookies antigos + novos
 * 3. POST createLink → short_url (https://meli.la/...)
 */
export async function gerarLinkAfiliadoML(
  produtoUrl: string, tag: string, cookies: string,
): Promise<{ shortUrl: string | null; cookiesAtualizados: string }> {
  if (!cookies || !tag) return { shortUrl: null, cookiesAtualizados: cookies };

  let cookiesAtualizados = cookies;

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

    const raw = (refreshResp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? [refreshResp.headers.get('set-cookie') ?? ''].filter(Boolean);

    if (raw.length > 0) {
      cookiesAtualizados = mergeCookies(cookies, raw);
      logger.info({ tag }, 'ML cookies renovados com sucesso');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'ML: falha ao renovar cookies, usando os originais');
  }

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

/** Persiste cookies ML renovados no user_settings. */
export async function persistirCookiesML(usuarioId: string, cookies: string): Promise<void> {
  const r = await pool.query(
    `SELECT payload FROM user_settings WHERE usuario_id = $1 AND tipo = 'affiliate'`,
    [usuarioId]
  );
  if (!r.rows.length) return;
  const payload = r.rows[0].payload as Record<string, unknown>;
  const ml = (payload.mercadoLivre || {}) as Record<string, string>;
  await pool.query(
    `UPDATE user_settings SET payload = $1, atualizado_em = NOW() WHERE usuario_id = $2 AND tipo = 'affiliate'`,
    [JSON.stringify({ ...payload, mercadoLivre: { ...ml, cookies } }), usuarioId]
  );
}

// ─────────────────────────────────────────────
// Resolução do link de afiliado do usuário logado
// ─────────────────────────────────────────────

export interface OfertaLink {
  plataforma: string;
  link_produto: string | null;
  link_afiliado: string | null;
}

/**
 * Gera o link de afiliado para o usuário logado no momento do envio.
 * Shopee: generateShortLink · ML: createLink (com refresh de cookies).
 * Faz fallback para o link existente/produto se não conseguir gerar.
 */
export async function resolverLinkAfiliado(usuarioId: string, oferta: OfertaLink): Promise<string> {
  const origem   = oferta.link_produto || oferta.link_afiliado || '';
  const fallback = oferta.link_afiliado || oferta.link_produto || '';
  if (!origem) return fallback;

  if (oferta.plataforma === 'shopee') {
    const creds = await getShopeeCredenciais(usuarioId);
    if (!creds) return fallback;
    try {
      const short = await gerarShortLinkShopee(creds.appId, creds.appSecret, origem);
      return short || fallback;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Falha ao gerar shortLink Shopee no envio');
      return fallback;
    }
  }

  if (oferta.plataforma === 'mercadolivre') {
    const creds = await getMLCredenciais(usuarioId);
    if (!creds) return fallback;
    try {
      const { shortUrl, cookiesAtualizados } = await gerarLinkAfiliadoML(origem, creds.tag, creds.cookies);
      if (cookiesAtualizados && cookiesAtualizados !== creds.cookies) {
        await persistirCookiesML(usuarioId, cookiesAtualizados);
      }
      return shortUrl || fallback;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Falha ao gerar link ML no envio');
      return fallback;
    }
  }

  return fallback;
}
