import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { pool } from '../config/database';
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

function mascararCamposSensiveis(payload: Record<string, unknown>): Record<string, unknown> {
  const mascarar = (val: string) => val ? '***' + val.slice(-4) : '';
  const p = { ...payload } as Record<string, Record<string, string>>;

  if (p.amazon?.cookies)        p.amazon       = { ...p.amazon,       cookies:     mascarar(p.amazon.cookies) };
  if (p.mercadoLivre?.cookies)  p.mercadoLivre = { ...p.mercadoLivre, cookies:     mascarar(p.mercadoLivre.cookies) };
  if (p.shopee?.appSecret)      p.shopee       = { ...p.shopee,       appSecret:   mascarar(p.shopee.appSecret) };
  if (p.aliexpress?.apiSecret)  p.aliexpress   = { ...p.aliexpress,   apiSecret:   mascarar(p.aliexpress.apiSecret) };

  return p;
}

// GET /api/v1/settings/affiliate
router.get('/affiliate', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const resultado = await pool.query(
      `SELECT payload FROM user_settings WHERE usuario_id = $1 AND tipo = 'affiliate'`,
      [usuarioId]
    );
    const payload = resultado.rows.length > 0
      ? resultado.rows[0].payload as Record<string, unknown>
      : PAYLOAD_AFILIADO_VAZIO;

    res.json({
      sucesso: true,
      setting: { tipo: 'affiliate', payload: mascararCamposSensiveis(payload) },
    });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao buscar settings afiliado');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

// PUT /api/v1/settings/affiliate
router.put('/affiliate', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  const payload = req.body as Record<string, unknown>;

  try {
    await pool.query(
      `INSERT INTO user_settings (usuario_id, tipo, payload)
       VALUES ($1, 'affiliate', $2)
       ON CONFLICT (usuario_id, tipo)
       DO UPDATE SET payload = $2, atualizado_em = NOW()`,
      [usuarioId, JSON.stringify(payload)]
    );
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
    const resultado = await pool.query(
      `SELECT payload FROM user_settings WHERE usuario_id = $1 AND tipo = 'telegram'`,
      [usuarioId]
    );
    const payload = resultado.rows.length > 0
      ? resultado.rows[0].payload as Record<string, unknown>
      : PAYLOAD_TELEGRAM_VAZIO;

    // Mascarar botToken na resposta GET
    const payloadMascarado = {
      ...payload,
      botToken: (payload.botToken as string) ? '***' + (payload.botToken as string).slice(-4) : '',
    };

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
      const payload = { botToken: botToken?.trim() || '', chatIds: chatIds || [], status };
      await pool.query(
        `INSERT INTO user_settings (usuario_id, tipo, payload)
         VALUES ($1, 'telegram', $2)
         ON CONFLICT (usuario_id, tipo)
         DO UPDATE SET payload = $2, atualizado_em = NOW()`,
        [usuarioId, JSON.stringify(payload)]
      );
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

    const { botToken, chatIds } = req.body as { botToken: string; chatIds: string[] };

    try {
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

export default router;
