// Serviço de envio de ofertas para WhatsApp e Telegram.
// Reutilizado pelos endpoints (envio manual) e pelo worker (fila agendada).

import { pool } from '../config/database';
import { logger } from '../utils/logger';
import { resolverLinkAfiliado } from './afiliado.service';
import { lerSetting, lerConfigRelay } from './settings.service';
import { registrarRelayLogSeguro } from './relayLog.service';

export type OrigemEnvio = 'manual' | 'agendado';

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pausa entre grupos (config do relay do usuário; em testes, zero). */
async function intervaloEntreGruposMs(usuarioId: string): Promise<number> {
  if (process.env.NODE_ENV === 'test') return 0;
  try {
    return (await lerConfigRelay(usuarioId)).intervaloEnvioSeg * 1000;
  } catch {
    return 5000;
  }
}

export interface ResultadoEnvio { enviados: number; erros: string[]; }

export interface OfertaLegenda {
  nome: string;
  preco: string | number;
  desconto_pct: number | null;
  link_produto: string | null;
  link_afiliado: string | null;
  plataforma: string;
}

function formatPreco(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Gera a legenda padrão de uma oferta (mesmo formato do frontend). */
export function gerarLegendaPadrao(o: OfertaLegenda): string {
  const plat = o.plataforma === 'shopee' ? 'Shopee' : 'Mercado Livre';
  const prep = o.plataforma === 'shopee' ? 'na' : 'no';
  const link = o.link_afiliado || o.link_produto || '';
  const preco = parseFloat(String(o.preco));
  const precoStr = preco % 1 === 0 ? `R$ ${preco.toFixed(0)}` : formatPreco(preco);

  if (o.desconto_pct) {
    return `🔥 *${o.nome}*\n\n_Vendido ${prep} ${plat}_ · *-${o.desconto_pct}% OFF*\n\n💰 Por *${precoStr}*\n🛒 ${link}`;
  }
  return `🛍️ *${o.nome}*\n\n_Vendido ${prep} ${plat}_\n\n💰 Por *${precoStr}*\n🛒 ${link}`;
}

interface InfoOferta {
  nome: string | null; preco: string | number | null; plataforma: string;
  linkProduto: string | null; linkAfiliado: string | null;
}

async function marcarOfertaEnviada(ofertaId: string, usuarioId: string): Promise<void> {
  await pool.query(
    `INSERT INTO ofertas_enviadas (oferta_id, usuario_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [ofertaId, usuarioId]
  );
}

/**
 * Busca a oferta e REGERA o link de afiliado para o usuário logado no momento
 * do envio, substituindo o link antigo na legenda. Garante que cada envio use
 * o link de afiliado de quem está enviando (a tabela ofertas é global).
 */
async function prepararEnvio(
  usuarioId: string, ofertaId: string, legenda: string,
): Promise<{ imagemUrl: string | null; legenda: string; info: InfoOferta }> {
  const r = await pool.query(
    'SELECT imagem_url, link_produto, link_afiliado, plataforma, nome, preco FROM ofertas WHERE id = $1',
    [ofertaId]
  );
  if (!r.rows.length) throw new Error('Oferta não encontrada.');
  const o = r.rows[0] as {
    imagem_url: string | null; link_produto: string | null;
    link_afiliado: string | null; plataforma: string; nome?: string; preco?: string | number;
  };

  const linkAntigo = o.link_afiliado || o.link_produto || '';
  let legendaFinal = legenda;

  let linkUsado = linkAntigo;
  try {
    const linkNovo = await resolverLinkAfiliado(usuarioId, o);
    if (linkNovo && linkAntigo && linkNovo !== linkAntigo && legendaFinal.includes(linkAntigo)) {
      legendaFinal = legendaFinal.split(linkAntigo).join(linkNovo);
    }
    if (linkNovo) linkUsado = linkNovo;
  } catch (e) {
    logger.warn({ ofertaId, err: (e as Error).message }, 'Falha ao regenerar link no envio; usando legenda original');
  }

  return {
    imagemUrl: o.imagem_url,
    legenda: legendaFinal,
    info: {
      nome: o.nome || null, preco: o.preco ?? null, plataforma: o.plataforma,
      linkProduto: o.link_produto, linkAfiliado: linkUsado || null,
    },
  };
}

/**
 * Envia uma oferta para grupos de WhatsApp via Evolution API.
 * Se `grupos` não vier, usa os grupos de destino configurados do usuário.
 * Lança Error em problemas de configuração (sem instância/sem grupos).
 */
export async function enviarOfertaWhatsApp(
  usuarioId: string, ofertaId: string, legenda: string, grupos?: string[], origem: OrigemEnvio = 'manual',
): Promise<ResultadoEnvio> {
  const t0 = Date.now();
  const { imagemUrl, legenda: legendaFinal, info } = await prepararEnvio(usuarioId, ofertaId, legenda);

  const instResult = await pool.query(
    `SELECT nome_instancia FROM whatsapp_instances
     WHERE usuario_id = $1 AND status = 'conectado'
     ORDER BY criado_em DESC LIMIT 1`,
    [usuarioId]
  );
  if (!instResult.rows.length) throw new Error('WhatsApp não está conectado.');
  const nomeInstancia = instResult.rows[0].nome_instancia as string;

  let gruposDestino: string[] = grupos || [];
  if (!gruposDestino.length) {
    const gr = await pool.query(
      `SELECT group_jid FROM usuario_whatsapp_grupos
       WHERE usuario_id = $1 AND papel = 'destino' AND deletado_em IS NULL`,
      [usuarioId]
    );
    gruposDestino = gr.rows.map((r: { group_jid: string }) => r.group_jid);
  }
  if (!gruposDestino.length) throw new Error('Nenhum grupo de destino configurado.');

  const evoUrl = process.env.EVOLUTION_API_URL || '';
  const evoKey = process.env.EVOLUTION_API_KEY || '';
  const enviados: string[] = [];
  const erros: string[] = [];

  const pausaMs = await intervaloEntreGruposMs(usuarioId);

  for (const [i, groupJid] of gruposDestino.entries()) {
    if (i > 0 && pausaMs > 0) await esperar(pausaMs);
    try {
      let endpoint: string;
      let body: Record<string, unknown>;

      if (imagemUrl) {
        endpoint = `/message/sendMedia/${nomeInstancia}`;
        body = { number: groupJid, mediatype: 'image', media: imagemUrl, mimetype: 'image/jpeg', caption: legendaFinal };
      } else {
        endpoint = `/message/sendText/${nomeInstancia}`;
        body = { number: groupJid, text: legendaFinal };
      }

      const resp = await fetch(`${evoUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: evoKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      if (resp.ok) enviados.push(groupJid);
      else erros.push(`${groupJid}: ${(await resp.text()).slice(0, 120)}`);
    } catch (err) {
      erros.push(`${groupJid}: ${(err as Error).message}`);
    }
  }

  if (enviados.length > 0) await marcarOfertaEnviada(ofertaId, usuarioId);
  await registrarRelayLogSeguro({
    usuarioId, instancia: nomeInstancia, origem,
    status: enviados.length === gruposDestino.length ? 'publicada' : enviados.length > 0 ? 'parcial' : 'falha_envio',
    motivo: erros.length ? erros.join(' | ').slice(0, 1000) : null,
    grupoDestinoNome: 'WhatsApp',
    loja: info.plataforma, urlOriginal: info.linkProduto, urlAfiliada: info.linkAfiliado,
    titulo: info.nome, preco: info.preco,
    destinosTotal: gruposDestino.length, destinosOk: enviados.length,
    duracaoMs: Date.now() - t0, temImagem: !!imagemUrl,
  });
  logger.info({ ofertaId, enviados: enviados.length, erros }, 'Oferta enviada ao WhatsApp');
  return { enviados: enviados.length, erros };
}

/**
 * Envia uma oferta para o Telegram. Se `chatIds` não vier, usa os configurados.
 * Lança Error em problemas de configuração (não configurado/inativo).
 */
export async function enviarOfertaTelegram(
  usuarioId: string, ofertaId: string, legenda: string, chatIds?: string[], origem: OrigemEnvio = 'manual',
): Promise<ResultadoEnvio> {
  const t0 = Date.now();
  const tgPayload = await lerSetting(usuarioId, 'telegram');
  if (!tgPayload) throw new Error('Telegram não configurado.');

  const tg = tgPayload as unknown as { botToken: string; chatIds: string[]; status: string };
  if (tg.status !== 'active') throw new Error('Telegram não está ativo.');
  if (!tg.botToken) throw new Error('Bot Token do Telegram não configurado.');

  const destinos: string[] = chatIds?.length ? chatIds : (tg.chatIds || []);
  if (!destinos.length) throw new Error('Nenhum Chat ID configurado no Telegram.');

  const { imagemUrl, legenda: legendaFinal, info } = await prepararEnvio(usuarioId, ofertaId, legenda);

  const enviados: string[] = [];
  const erros: string[] = [];

  // Sem parse_mode: nomes de produto com _ ou * quebravam o Markdown e a mensagem não saía
  for (const chatId of destinos) {
    try {
      let endpoint: string;
      let body: Record<string, unknown>;

      if (imagemUrl) {
        endpoint = `https://api.telegram.org/bot${tg.botToken}/sendPhoto`;
        body = { chat_id: chatId, photo: imagemUrl, caption: legendaFinal.slice(0, 1024) };
      } else {
        endpoint = `https://api.telegram.org/bot${tg.botToken}/sendMessage`;
        body = { chat_id: chatId, text: legendaFinal.slice(0, 4096) };
      }

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      const data = await resp.json() as { ok: boolean; description?: string };
      if (data.ok) enviados.push(chatId);
      else erros.push(`${chatId}: ${data.description || 'Erro desconhecido'}`);
    } catch (err) {
      erros.push(`${chatId}: ${(err as Error).message}`);
    }
  }

  if (enviados.length > 0) await marcarOfertaEnviada(ofertaId, usuarioId);
  await registrarRelayLogSeguro({
    usuarioId, instancia: 'telegram', origem,
    status: enviados.length === destinos.length ? 'publicada' : enviados.length > 0 ? 'parcial' : 'falha_envio',
    motivo: erros.length ? erros.join(' | ').slice(0, 1000) : null,
    grupoDestinoNome: 'Telegram',
    loja: info.plataforma, urlOriginal: info.linkProduto, urlAfiliada: info.linkAfiliado,
    titulo: info.nome, preco: info.preco,
    destinosTotal: destinos.length, destinosOk: enviados.length,
    duracaoMs: Date.now() - t0, temImagem: !!imagemUrl,
  });
  logger.info({ ofertaId, enviados: enviados.length, erros }, 'Oferta enviada ao Telegram');
  return { enviados: enviados.length, erros };
}
