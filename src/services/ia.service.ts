// Serviço de reescrita de legendas com IA (OpenAI GPT-4o-mini por padrão)

export interface ContextoLegenda {
  nome: string;
  preco: string | number;
  plataforma: string;
  link: string;
  descontoPct?: number | null;
}

export function iaConfigurada(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Reescreve a legenda mantendo link e preço, deixando-a mais persuasiva.
 * Lança Error em caso de falha (caller decide como tratar).
 */
export async function melhorarLegendaIA(legendaAtual: string, ctx: ContextoLegenda): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('IA não configurada. Defina OPENAI_API_KEY no servidor.');

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const sistema = [
    'Você é um copywriter especialista em ofertas para grupos de WhatsApp e Telegram no Brasil.',
    'Reescreva a legenda do produto para ser mais persuasiva e gerar urgência, em português do Brasil.',
    'REGRAS OBRIGATÓRIAS:',
    '- Mantenha o link EXATAMENTE como está, sem alterar, encurtar ou remover.',
    '- Mantenha o preço exatamente igual ao informado.',
    '- Use no máximo 3 a 4 emojis relevantes.',
    '- Use *texto* para negrito e _texto_ para itálico (formato WhatsApp/Telegram).',
    '- Não invente características, garantias, cupons ou frete que não estejam na legenda original.',
    '- Seja curto (até ~4 linhas). Responda APENAS com a legenda final, sem comentários ou aspas.',
  ].join('\n');

  const usuario = [
    `Produto: ${ctx.nome}`,
    `Preço: ${ctx.preco}`,
    `Plataforma: ${ctx.plataforma}`,
    ctx.descontoPct ? `Desconto: ${ctx.descontoPct}% OFF` : '',
    `Link (manter idêntico): ${ctx.link}`,
    '',
    'Legenda atual:',
    legendaAtual,
  ].filter(Boolean).join('\n');

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sistema },
        { role: 'user', content: usuario },
      ],
      temperature: 0.8,
      max_tokens: 400,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
  let texto = data.choices?.[0]?.message?.content?.trim();
  if (!texto) throw new Error('IA não retornou conteúdo.');

  // Remove aspas de cerca caso a IA devolva entre aspas
  texto = texto.replace(/^["'`]+|["'`]+$/g, '').trim();

  // Garante que o link continue presente
  if (ctx.link && !texto.includes(ctx.link)) {
    texto = `${texto}\n🛒 ${ctx.link}`;
  }
  return texto;
}
