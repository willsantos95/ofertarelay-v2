import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import {
  lerSetting, salvarSetting, mascararPayload, eValorMascarado,
  lerConfigRelay, normalizarConfigRelay,
} from '../services/settings.service';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { logger } from '../utils/logger';

const router = Router();

const PAYLOAD_AFILIADO_VAZIO = {
  amazon:       { tag: '', cookies: '' },
  mercadoLivre: { tag: '', cookies: '' },
  shopee:       { appId: '', appSecret: '' },
  magalu:       { magazineId: '' },
  aliexpress:   { apiKey: '', apiSecret: '', trackingId: '' },
};

const PAYLOAD_TELEGRAM_VAZIO = {
  botToken: '',
  chatIds:  [] as string[],
  status:   'inactive',
};

// GET /api/v1/settings/affiliate
router.get('/affiliate', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const payload = (await lerSetting(usuarioId, 'affiliate')) || PAYLOAD_AFILIADO_VAZIO;
    res.json({
      sucesso: true,
      setting: { tipo: 'affiliate', payload: mascararPayload('affiliate', payload) },
    });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao buscar settings afiliado');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

// PUT /api/v1/settings/affiliate
// Campos sensíveis enviados mascarados (***abcd) mantêm o valor já salvo.
router.put('/affiliate', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  const payload = req.body as Record<string, unknown>;

  try {
    await salvarSetting(usuarioId, 'affiliate', payload);
    res.json({ sucesso: true, mensagem: 'Configurações de afiliado salvas com sucesso.' });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao salvar settings afiliado');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

// GET /api/v1/settings/telegram
router.get('/telegram', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const payload = (await lerSetting(usuarioId, 'telegram')) || PAYLOAD_TELEGRAM_VAZIO;
    const payloadMascarado = mascararPayload('telegram', payload);

    res.json({ sucesso: true, setting: { tipo: 'telegram', payload: payloadMascarado } });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao buscar settings telegram');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

// PUT /api/v1/settings/telegram
router.put(
  '/telegram',
  autenticacaoRequerida,
  [
    body('chatIds').isArray().withMessage('chatIds deve ser um array'),
    body('status').isIn(['active', 'inactive']).withMessage('status deve ser active ou inactive'),
  ],
  async (req: RequestComUsuario, res: Response): Promise<void> => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
      res.status(400).json({ sucesso: false, erro: { codigo: 'ERRO_VALIDACAO', mensagem: erros.array()[0].msg, codigoStatus: 400 } });
      return;
    }

    const usuarioId = req.usuario!.id;
    const { botToken, chatIds, status } = req.body as { botToken: string; chatIds: string[]; status: string };

    try {
      // botToken mascarado (***abcd) ou ausente mantém o token salvo
      const payload = { botToken: typeof botToken === 'string' ? botToken.trim() : undefined, chatIds: chatIds || [], status };
      await salvarSetting(usuarioId, 'telegram', payload);
      res.json({ sucesso: true, mensagem: 'Configuração do Telegram salva com sucesso.' });
    } catch (erro) {
      logger.error({ erro }, 'Erro ao salvar settings telegram');
      res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
    }
  }
);

// POST /api/v1/settings/telegram/test
router.post(
  '/telegram/test',
  autenticacaoRequerida,
  [
    body('botToken').notEmpty().withMessage('botToken é obrigatório'),
    body('chatIds').isArray({ min: 1 }).withMessage('Informe ao menos um Chat ID'),
  ],
  async (req: RequestComUsuario, res: Response): Promise<void> => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
      res.status(400).json({ sucesso: false, success: false, mensagem: erros.array()[0].msg });
      return;
    }

    const { chatIds } = req.body as { botToken: string; chatIds: string[] };
    let { botToken } = req.body as { botToken: string };

    try {
      if (eValorMascarado(botToken)) {
        const salvo = await lerSetting(req.usuario!.id, 'telegram');
        botToken = String(salvo?.botToken || '');
      }
      const resultados: { chatId: string; ok: boolean }[] = [];

      for (const chatId of chatIds) {
        try {
          const resp = await fetch(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text: '✅ OfertaRelay conectado com sucesso! Suas ofertas serão enviadas aqui.',
              }),
              signal: AbortSignal.timeout(10000),
            }
          );
          const data = await resp.json() as { ok: boolean };
          resultados.push({ chatId, ok: data.ok });
        } catch {
          resultados.push({ chatId, ok: false });
        }
      }

      const todosOk = resultados.every((r) => r.ok);
      const alguemOk = resultados.some((r) => r.ok);

      if (todosOk) {
        res.json({ sucesso: true, success: true, mensagem: `Mensagem enviada com sucesso para ${chatIds.length} destino(s).` });
      } else if (alguemOk) {
        const falhos = resultados.filter((r) => !r.ok).map((r) => r.chatId);
        res.json({ sucesso: true, success: true, mensagem: `Enviado com sucesso, mas falhou em: ${falhos.join(', ')}` });
      } else {
        res.status(400).json({ sucesso: false, success: false, mensagem: 'Erro ao conectar com o Telegram. Verifique o Bot Token e os Chat IDs.' });
      }
    } catch (erro) {
      logger.error({ erro }, 'Erro ao testar conexão Telegram');
      res.status(400).json({ sucesso: false, success: false, mensagem: 'Erro ao conectar com o Telegram. Verifique o Bot Token e os Chat IDs.' });
    }
  }
);

// GET /api/v1/settings/relay — cabeçalho, rodapé e ritmo do relay
router.get('/relay', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const config = await lerConfigRelay(req.usuario!.id);
    res.json({ sucesso: true, setting: { tipo: 'relay', payload: config } });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao buscar settings relay');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

// PUT /api/v1/settings/relay
router.put('/relay', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const config = normalizarConfigRelay(req.body as Record<string, unknown>);
    await salvarSetting(req.usuario!.id, 'relay', { ...config });
    res.json({ sucesso: true, mensagem: 'Configurações do relay salvas com sucesso.', setting: { tipo: 'relay', payload: config } });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao salvar settings relay');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

export default router;
