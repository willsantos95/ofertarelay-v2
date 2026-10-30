// HTML da landing page pública, renderizado no servidor (carrega rápido e gera prévia
// com imagem e título quando o link é compartilhado no WhatsApp/Instagram).

import { Landing, TipoBotao } from './landing.service';

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** Texto legível (preto ou branco) sobre a cor escolhida. */
function corTexto(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#111111' : '#ffffff';
}

const ICONES: Record<TipoBotao, string> = {
  whatsapp_grupo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.8-1.2.2-.6.2-1.1.1-1.2l-.4-.3Z"/></svg>',
  whatsapp_canal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 10v4a1 1 0 0 0 1 1h2l5 4V5L6 9H4a1 1 0 0 0-1 1Zm13.5 2A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>',
  telegram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.9 4.3 18.7 19c-.2 1-.9 1.3-1.8.8l-4.8-3.6-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.4 12.8 1.7 11.3c-1-.3-1-1 .2-1.5L20.5 2.7c.9-.3 1.6.2 1.4 1.6Z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4ZM17.3 5.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4ZM21.9 7.1a5.8 5.8 0 0 0-1.6-4.1A5.8 5.8 0 0 0 16.2 1.4C14.6 1.3 9.4 1.3 7.8 1.4A5.8 5.8 0 0 0 3.7 3 5.8 5.8 0 0 0 2.1 7.1c-.1 1.6-.1 6.8 0 8.4a5.8 5.8 0 0 0 1.6 4.1 5.8 5.8 0 0 0 4.1 1.6c1.6.1 6.8.1 8.4 0a5.8 5.8 0 0 0 4.1-1.6 5.8 5.8 0 0 0 1.6-4.1c.1-1.6.1-6.8 0-8.4Zm-2.1 10.2a3.3 3.3 0 0 1-1.9 1.9c-1.3.5-4.4.4-5.9.4s-4.6.1-5.9-.4a3.3 3.3 0 0 1-1.9-1.9c-.5-1.3-.4-4.4-.4-5.9s-.1-4.6.4-5.9a3.3 3.3 0 0 1 1.9-1.9c1.3-.5 4.4-.4 5.9-.4s4.6-.1 5.9.4a3.3 3.3 0 0 1 1.9 1.9c.5 1.3.4 4.4.4 5.9s.1 4.6-.4 5.9Z"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10.6 13.4a1 1 0 0 0 1.4 0l4-4a3 3 0 0 0-4.2-4.2l-1.5 1.5 1.4 1.4 1.5-1.5a1 1 0 0 1 1.4 1.4l-4 4a1 1 0 0 0 0 1.4Zm2.8-2.8a1 1 0 0 0-1.4 0l-4 4a3 3 0 0 0 4.2 4.2l1.5-1.5-1.4-1.4-1.5 1.5a1 1 0 0 1-1.4-1.4l4-4a1 1 0 0 0 0-1.4Z"/></svg>',
};

export function renderizarLanding(l: Landing, opts: { baseApi: string; urlPagina: string }): string {
  const cor = l.cor;
  const fg = corTexto(cor);
  const versao = l.imagem_atualizada_em ? new Date(l.imagem_atualizada_em).getTime() : 0;
  const imagem = l.tem_imagem ? `${opts.baseApi}/public/landing/${encodeURIComponent(l.slug)}/imagem?v=${versao}` : '';
  const titulo = l.titulo || l.slug;
  const descricao = l.descricao || 'Entre no grupo e receba as melhores ofertas.';

  const botoes = l.botoes.map((b) => `
      <a class="btn" href="${esc(`${opts.baseApi}/public/l/${encodeURIComponent(l.slug)}/${b.id}`)}" rel="noopener">
        <span class="ico">${ICONES[b.tipo] || ICONES.link}</span>
        <span class="txt">${esc(b.rotulo)}</span>
      </a>`).join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(descricao)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(descricao)}">
<meta property="og:url" content="${esc(opts.urlPagina)}">
${imagem ? `<meta property="og:image" content="${esc(imagem)}">` : ''}
<meta name="theme-color" content="${esc(cor)}">
${imagem ? `<link rel="icon" href="${esc(imagem)}">` : ''}
<style>
  :root { --cor: ${cor}; --fg: ${fg}; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         color: #1f2937; background: #f5f5f4;
         background-image: linear-gradient(180deg, color-mix(in srgb, var(--cor) 22%, #fff) 0, #f5f5f4 320px); }
  main { max-width: 480px; margin: 0 auto; padding: 48px 20px 32px; text-align: center; }
  .foto { width: 112px; height: 112px; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 16px;
          border: 4px solid #fff; box-shadow: 0 4px 18px rgba(0,0,0,.12); background: #fff; }
  .foto.vazia { display: grid; place-items: center; font-size: 44px; font-weight: 700; color: var(--fg); background: var(--cor); }
  h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: -.01em; color: #111827; }
  p.desc { margin: 0 auto 28px; color: #4b5563; max-width: 36ch; }
  .btns { display: grid; gap: 12px; }
  .btn { display: flex; align-items: center; gap: 12px; padding: 16px 18px; border-radius: 14px; text-decoration: none;
         background: var(--cor); color: var(--fg); font-weight: 650; box-shadow: 0 2px 0 rgba(0,0,0,.08);
         transition: transform .08s ease, filter .15s ease; }
  .btn:hover { filter: brightness(1.05); } .btn:active { transform: translateY(1px); }
  .btn .ico { width: 24px; height: 24px; flex: none; } .btn .ico svg { width: 24px; height: 24px; display: block; }
  .btn .txt { flex: 1; text-align: center; padding-right: 24px; }
  .vazio { color: #6b7280; padding: 16px; }
  .gratis { margin-top: 14px; font-size: 13px; color: #6b7280; }
  footer { margin-top: 40px; font-size: 12px; color: #9ca3af; }
  footer a { color: inherit; }
</style>
</head>
<body>
<main>
  ${imagem
    ? `<img class="foto" src="${esc(imagem)}" alt="${esc(titulo)}" width="112" height="112">`
    : `<div class="foto vazia" aria-hidden="true">${esc(titulo.slice(0, 1).toUpperCase())}</div>`}
  <h1>${esc(titulo)}</h1>
  <p class="desc">${esc(descricao)}</p>
  <nav class="btns">${botoes || '<div class="vazio">Nenhum link disponível no momento.</div>'}
  </nav>
  <p class="gratis">É grátis, e você pode sair quando quiser.</p>
  <footer>Feito com <a href="/" rel="noopener">OfertaRelay</a></footer>
</main>
</body>
</html>`;
}

export function renderizarNaoEncontrada(): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Página não encontrada</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;color:#374151;background:#f5f5f4}a{color:#16a34a}</style></head>
<body><div style="text-align:center;padding:24px"><h1 style="font-size:22px">Página não encontrada</h1><p>Esse link não existe ou foi desativado.</p><p><a href="/">Ir para o OfertaRelay</a></p></div></body></html>`;
}
