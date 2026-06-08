// Serviço de envio de ofertas para WhatsApp e Telegram.
// Reutilizado pelos endpoints (envio manual) e pelo worker (fila agendada).

import { pool } from '../config/database';
import { logger } from '../utils/logger';
import { resolverLinkAfiliado } from './afiliado.service';

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
): Promise<{ imagemUrl: string | null; legenda: string }> {
  const r = await pool.query(
    'SELECT imagem_url, link_produto, link_afiliado, plataforma FROM ofertas WHERE id = $1',
    [ofertaId]
  );
  if (!r.rows.length) throw new Error('Oferta não encontrada.');
  const o = r.rows[0] as {
    imagem_url: string | null; link_produto: string | null;
    link_afiliado: string | null; plataforma: string;
  };

  const linkAntigo = o.link_afiliado || o.link_produto || '';
  let legendaFinal = legenda;

  try {
    const linkNovo = await resolverLinkAfiliado(usuarioId, o);
    if (linkNovo && linkAntigo && linkNovo !== linkAntigo && legendaFinal.includes(linkAntigo)) {
      legendaFinal = legendaFinal.split(linkAntigo).join(linkNovo);
    }
  } catch (e) {
    logger.warn({ ofertaId, err: (e as Error).message }, 'Falha ao regenerar link no envio; usando legenda original');
  }

  return { imagemUrl: o.imagem_url, legenda: legendaFinal };
}

/**
 * Envia uma oferta para grupos de WhatsApp via Evolution API.
 * Se `grupos` não vier, usa os grupos de destino configurados do usuário.
 * Lança Error em problemas de configuração (sem instância/sem grupos).
 */
export async function enviarOfertaWhatsApp(
  usuarioId: string, ofertaId: string, legenda: string, grupos?: string[],
): Promise<ResultadoEnvio> {
  const { imagemUrl, legenda: legendaFinal } = await prepararEnvio(usuarioId, ofertaId, legenda);

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

  for (const groupJid of gruposDestino) {
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
  logger.info({ ofertaId, enviados: enviados.length, erros }, 'Oferta enviada ao WhatsApp');
  return { enviados: enviados.length, erros };
}

/**
 * Envia uma oferta para o Telegram. Se `chatIds` não vier, usa os configurados.
 * Lança Error em problemas de configuração (não configurado/inativo).
 */
export async function enviarOfertaTelegram(
  usuarioId: string, ofertaId: string, legenda: string, chatIds?: string[],
): Promise<ResultadoEnvio> {
  const tgResult = await pool.query(
    `SELECT payload FROM user_settings WHERE usuario_id = $1 AND tipo = 'telegram'`,
    [usuarioId]
  );
  if (!tgResult.rows.length) throw new Error('Telegram não configurado.');

  const tg = tgResult.rows[0].payload as { botToken: string; chatIds: string[]; status: string };
  if (tg.status !== 'active') throw new Error('Telegram não está ativo.');
  if (!tg.botToken) throw new Error('Bot Token do Telegram não configurado.');

  const destinos: string[] = chatIds?.length ? chatIds : (tg.chatIds || []);
  if (!destinos.length) throw new Error('Nenhum Chat ID configurado no Telegram.');

  const { imagemUrl, legenda: legendaFinal } = await prepararEnvio(usuarioId, ofertaId, legenda);

  const enviados: string[] = [];
  const erros: string[] = [];

  for (const chatId of destinos) {
    try {
      let endpoint: string;
      let body: Record<string, unknown>;

      if (imagemUrl) {
        endpoint = `https://api.telegram.org/bot${tg.botToken}/sendPhoto`;
        body = { chat_id: chatId, photo: imagemUrl, caption: legendaFinal, parse_mode: 'Markdown' };
      } else {
        endpoint = `https://api.telegram.org/bot${tg.botToken}/sendMessage`;
        body = { chat_id: chatId, text: legendaFinal, parse_mode: 'Markdown' };
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
  logger.info({ ofertaId, enviados: enviados.length, erros }, 'Oferta enviada ao Telegram');
  return { enviados: enviados.length, erros };
}
