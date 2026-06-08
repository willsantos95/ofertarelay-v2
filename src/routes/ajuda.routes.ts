// Rota de chat de suporte com IA para o OfertaRelay.
// Endpoint público — não requer autenticação (suporte pré e pós login).

import { Router, Request, Response } from 'express';
import { chatConfigurado, responderChat, MensagemHistorico } from '../services/ajuda.service';

const router = Router();

/**
 * GET /api/v1/ajuda/status
 * Verifica se o chat de IA está disponível.
 */
router.get('/status', (_req: Request, res: Response) => {
  res.json({ disponivel: chatConfigurado() });
});

/**
 * POST /api/v1/ajuda/chat
 * Envia uma mensagem para o assistente de suporte.
 *
 * Body:
 *   mensagem  string   — Mensagem do usuário (obrigatório)
 *   historico Array    — Histórico de mensagens anteriores [{role, content}] (opcional)
 *
 * Response:
 *   { resposta: string }
 */
router.post('/chat', async (req: Request, res: Response) => {
  const { mensagem, historico } = req.body as {
    mensagem?: string;
    historico?: MensagemHistorico[];
  };

  if (!mensagem || !mensagem.trim()) {
    res.status(400).json({
      sucesso: false,
      erro: { mensagem: 'Campo "mensagem" é obrigatório.' },
    });
    return;
  }

  if (mensagem.trim().length > 1000) {
    res.status(400).json({
      sucesso: false,
      erro: { mensagem: 'Mensagem muito longa (máximo 1000 caracteres).' },
    });
    return;
  }

  if (!chatConfigurado()) {
    res.status(503).json({
      sucesso: false,
      erro: { mensagem: 'Chat de suporte temporariamente indisponível.' },
    });
    return;
  }

  // Valida historico (opcional, mas deve ter formato correto se enviado)
  const historicoValido: MensagemHistorico[] = [];
  if (Array.isArray(historico)) {
    for (const item of historico) {
      if (
        item && typeof item === 'object' &&
        (item.role === 'user' || item.role === 'assistant') &&
        typeof item.content === 'string' && item.content.trim()
      ) {
        historicoValido.push({ role: item.role, content: item.content.trim() });
      }
    }
  }

  try {
    const resposta = await responderChat(mensagem.trim(), historicoValido);
    res.json({ sucesso: true, resposta });
  } catch (err) {
    const msg = (err as Error).message || 'Erro desconhecido';
    res.status(500).json({
      sucesso: false,
      erro: { mensagem: `Falha ao processar mensagem: ${msg}` },
    });
  }
});

export default router;
