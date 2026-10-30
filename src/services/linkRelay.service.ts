// Geração de link de afiliado a partir de QUALQUER URL de produto (usado pelo relay do n8n).
// Concentra aqui a lógica que antes ficava duplicada dentro do fluxo n8n:
// resolve link curto → detecta a loja → gera o link com as credenciais do usuário → registra em affiliate_link_logs.

import crypto from 'crypto';
import { logger } from '../utils/logger';
import { lerSetting } from './settings.service';
import {
  ContextoLink, logLink,
  getShopeeCredenciais, gerarShortLinkShopee,
  getMLCredenciais, gerarLinkAfiliadoML, persistirCookiesML,
} from './afiliado.service';

export type Loja = 'shopee' | 'mercado_livre' | 'amazon' | 'aliexpress' | 'magalu' | 'desconhecida';

export interface ResultadoLink {
  sucesso: boolean;
  loja: Loja;
  urlOriginal: string;
  urlFinal: string;
  linkAfiliado: string | null;
  erro: string | null;
  codigo: 'ok' | 'loja_desconhecida' | 'loja_nao_conectada' | 'falha_link';
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

export function detectarLoja(url: string): Loja {
  const l = String(url || '').toLowerCase();
  if (/shopee\.|shp\.ee/.test(l)) return 'shopee';
  if (/mercadoli(v|b)re\.|meli\.la/.test(l)) return 'mercado_livre';
  if (/amazon\.|amzn\.to|a\.co\//.test(l)) return 'amazon';
  if (/aliexpress\.|s\.click\.aliexpress/.test(l)) return 'aliexpress';
  if (/magazinevoce|magazineluiza|magalu\./.test(l)) return 'magalu';
  return 'desconhecida';
}

/** Segue até 3 redirecionamentos para obter a URL real do produto. */
export async function resolverUrl(url: string, saltos = 3): Promise<string> {
  let atual = url;
  for (let i = 0; i < saltos; i++) {
    try {
      const resp = await fetch(atual, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(8000),
      });
      const loc = resp.headers.get('location');
      if (!loc || resp.status < 300 || resp.status >= 400) break;
      if (/^https?:\/\//i.test(loc)) atual = loc;
      else if (loc.startsWith('//')) atual = 'https:' + loc;
      else if (loc.startsWith('/')) atual = (atual.match(/^https?:\/\/[^/]+/i) || [''])[0] + loc;
      else break;
    } catch {
      break;
    }
  }
  return atual;
}

// ─────────────────────────────────────────────
// Amazon
// ─────────────────────────────────────────────

export async function gerarLinkAmazon(url: string, tag: string, cookies: string): Promise<{ link: string; encurtado: boolean }> {
  const m = url.match(/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  const host = (url.match(/https?:\/\/([^/]+)/) || [])[1] || 'www.amazon.com.br';
  const limpo = m ? `https://${host}/dp/${m[1].toUpperCase()}` : url.split('?')[0];
  const longo = `${limpo}?tag=${encodeURIComponent(tag)}`;

  if (!cookies) return { link: longo, encurtado: false };
  try {
    const q = new URLSearchParams({ longUrl: longo, marketplaceId: '526970' });
    const resp = await fetch(`https://www.amazon.com.br/associates/sitestripe/getShortUrl?${q}`, {
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        referer: 'https://www.amazon.com.br/',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': UA,
        cookie: cookies,
      },
      signal: AbortSignal.timeout(12000),
    });
    const data = await resp.json().catch(() => ({})) as { shortUrl?: string };
    if (typeof data.shortUrl === 'string' && data.shortUrl.startsWith('http')) return { link: data.shortUrl, encurtado: true };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Amazon: encurtador falhou, usando link longo com tag');
  }
  return { link: longo, encurtado: false };
}

// ─────────────────────────────────────────────
// Magalu
// ─────────────────────────────────────────────

export function gerarLinkMagalu(url: string, magazineId: string): string | null {
  if (/magazinevoce\.com\.br\/[^/]+/i.test(url)) {
    return url.replace(/(magazinevoce\.com\.br\/)[^/?#]+/i, `$1${magazineId}`);
  }
  const m = url.match(/magazineluiza\.com\.br(\/[^?#]+)/i);
  return m ? `https://www.magazinevoce.com.br/${magazineId}${m[1]}` : null;
}

// ─────────────────────────────────────────────
// AliExpress (Open Platform, assinatura HMAC-SHA256)
// ─────────────────────────────────────────────

export function assinarAliExpress(params: Record<string, string>, secret: string): string {
  const base = Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha256', secret).update(base).digest('hex').toUpperCase();
}

export async function gerarLinkAliExpress(url: string, apiKey: string, apiSecret: string, trackingId: string): Promise<string | null> {
  const params: Record<string, string> = {
    app_key: apiKey,
    method: 'aliexpress.affiliate.link.generate',
    sign_method: 'sha256',
    timestamp: String(Date.now()),
    promotion_link_type: '0',
    source_values: url,
    tracking_id: trackingId || 'default',
  };
  params.sign = assinarAliExpress(params, apiSecret);

  const resp = await fetch('https://api-sg.aliexpress.com/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json().catch(() => ({})) as Record<string, any>;
  const r = data?.aliexpress_affiliate_link_generate_response?.resp_result;
  const link = r?.result?.promotion_links?.promotion_link?.[0]?.promotion_link;
  if (link) return String(link);
  const msg = r?.resp_msg || data?.error_response?.msg || `AliExpress ${resp.status}`;
  throw new Error(String(msg).slice(0, 200));
}

// ─────────────────────────────────────────────
// Mercado Livre: página social / link curto → URL do produto
// ─────────────────────────────────────────────

export async function extrairProdutoML(url: string): Promise<string> {
  if (/MLB-?\d+|produto\.mercadolivre|\/p\/MLB/i.test(url)) return url;
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    const html = await resp.text();
    const m = html.match(/<a[^>]+href="([^"]+)"[^>]*>\s*Ir para produto\s*<\/a>/i);
    let achado = m?.[1];
    if (!achado) {
      const links = [...html.matchAll(/href="([^"]+)"/gi)].map((x) => x[1]);
      achado = links.find((l) => /mercadolivre\.com\.br/i.test(l) && (/MLB-?\d+/i.test(l) || /\/p\//i.test(l)));
    }
    if (achado?.startsWith('/')) achado = `https://www.mercadolivre.com.br${achado}`;
    return achado || url;
  } catch {
    return url;
  }
}

// ─────────────────────────────────────────────
// Entrada única
// ─────────────────────────────────────────────

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

/**
 * Gera o link de afiliado do usuário para uma URL qualquer de produto.
 * Nunca lança: falhas voltam com `sucesso: false`, `codigo` e `erro`.
 */
export async function gerarLinkParaUrl(usuarioId: string, urlOriginal: string, contexto: ContextoLink = 'relay'): Promise<ResultadoLink> {
  const base = { urlOriginal, urlFinal: urlOriginal, linkAfiliado: null as string | null };
  let urlFinal = urlOriginal;
  let loja = detectarLoja(urlOriginal);

  // Link curto ou de rastreio: resolve antes (também ajuda a identificar a loja)
  if (loja === 'desconhecida' || /s\.shopee|shp\.ee|meli\.la|amzn\.to|a\.co\/|s\.click\.aliexpress/i.test(urlOriginal)) {
    urlFinal = await resolverUrl(urlOriginal);
    const lojaFinal = detectarLoja(urlFinal);
    if (lojaFinal !== 'desconhecida') loja = lojaFinal;
  }

  if (loja === 'desconhecida') {
    return { ...base, urlFinal, sucesso: false, loja, codigo: 'loja_desconhecida', erro: 'Link não pertence a uma loja suportada' };
  }

  const aff = (await lerSetting(usuarioId, 'affiliate')) || {};
  const t0 = Date.now();
  const falha = async (codigo: ResultadoLink['codigo'], erro: string): Promise<ResultadoLink> => {
    if (codigo === 'falha_link') {
      await logLink({ usuarioId, plataforma: loja, contexto, urlOrigem: urlFinal, sucesso: false, erro, duracaoMs: Date.now() - t0 });
    }
    return { ...base, urlFinal, sucesso: false, loja, codigo, erro };
  };
  const ok = async (link: string): Promise<ResultadoLink> => {
    await logLink({ usuarioId, plataforma: loja, contexto, urlOrigem: urlFinal, urlGerada: link, sucesso: true, duracaoMs: Date.now() - t0 });
    return { ...base, urlFinal, sucesso: true, loja, codigo: 'ok', erro: null, linkAfiliado: link };
  };

  try {
    switch (loja) {
      case 'shopee': {
        const creds = await getShopeeCredenciais(usuarioId);
        if (!creds) return falha('loja_nao_conectada', 'Credenciais da Shopee não configuradas');
        // gerarShortLinkShopee já registra o log
        const link = await gerarShortLinkShopee(creds.appId, creds.appSecret, urlFinal, { usuarioId, contexto });
        return link
          ? { ...base, urlFinal, sucesso: true, loja, codigo: 'ok', erro: null, linkAfiliado: link }
          : { ...base, urlFinal, sucesso: false, loja, codigo: 'falha_link', erro: 'Shopee não retornou shortLink' };
      }
      case 'mercado_livre': {
        const creds = await getMLCredenciais(usuarioId);
        if (!creds) return falha('loja_nao_conectada', 'Tag e cookies do Mercado Livre não configurados');
        const produto = await extrairProdutoML(urlFinal);
        urlFinal = produto;
        // gerarLinkAfiliadoML já registra o log
        const { shortUrl, cookiesAtualizados } = await gerarLinkAfiliadoML(produto, creds.tag, creds.cookies, { usuarioId, contexto });
        if (cookiesAtualizados && cookiesAtualizados !== creds.cookies) await persistirCookiesML(usuarioId, cookiesAtualizados);
        return shortUrl
          ? { ...base, urlFinal, sucesso: true, loja, codigo: 'ok', erro: null, linkAfiliado: shortUrl }
          : { ...base, urlFinal, sucesso: false, loja, codigo: 'falha_link', erro: 'Mercado Livre não gerou o link (cookies expirados?)' };
      }
      case 'amazon': {
        const amz = (aff.amazon || {}) as Record<string, unknown>;
        const tag = str(amz.tag);
        if (!tag) return falha('loja_nao_conectada', 'Tag de associado da Amazon não configurada');
        const { link } = await gerarLinkAmazon(urlFinal, tag, str(amz.cookies));
        return ok(link);
      }
      case 'magalu': {
        const id = str(((aff.magalu || {}) as Record<string, unknown>).magazineId);
        if (!id) return falha('loja_nao_conectada', 'ID do Magazine Você não configurado');
        const link = gerarLinkMagalu(urlFinal, id);
        return link ? ok(link) : falha('falha_link', 'Formato de link da Magalu não reconhecido');
      }
      case 'aliexpress': {
        const ali = (aff.aliexpress || {}) as Record<string, unknown>;
        const apiKey = str(ali.apiKey), apiSecret = str(ali.apiSecret), trackingId = str(ali.trackingId);
        if (!apiKey || !apiSecret) return falha('loja_nao_conectada', 'App Key e App Secret do AliExpress não configurados');
        const link = await gerarLinkAliExpress(urlFinal, apiKey, apiSecret, trackingId);
        return link ? ok(link) : falha('falha_link', 'AliExpress não retornou link');
      }
    }
  } catch (err) {
    const msg = (err as Error).message.slice(0, 300);
    if (loja === 'shopee' || loja === 'mercado_livre') {
      // já registrado pelo serviço da loja
      return { ...base, urlFinal, sucesso: false, loja, codigo: 'falha_link', erro: msg };
    }
    return falha('falha_link', msg);
  }
  return falha('falha_link', 'Loja não tratada');
}
