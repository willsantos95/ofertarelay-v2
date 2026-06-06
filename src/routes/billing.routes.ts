import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../config/database';
import { limitadorWebhook } from '../middleware/rateLimiter';
import { logger } from '../utils/logger';

const router = Router();

// Middleware: validar assinatura HMAC do Mercado Pago
function validacaoAssinaturaMercadopago(req: Request, res: Response, next: () => void): void {
  const signature = req.headers['x-signature'] as string | undefined;
  const requestId = req.headers['x-request-id'] as string | undefined;

  if (!signature || !requestId) {
    res.status(401).json({
      sucesso: false,
      erro: {
        codigo: 'WEBHOOK_ASSINATURA_AUSENTE',
        mensagem: 'Headers x-signature ou x-request-id ausentes',
        codigoStatus: 401,
      },
    });
    return;
  }

  const match = signature.match(/ts=(\d+),v1=([a-f0-9]+)/);
  if (!match) {
    res.status(401).json({
      sucesso: false,
      erro: {
        codigo: 'WEBHOOK_ASSINATURA_INVALIDA',
        mensagem: 'Formato de x-signature inválido',
        codigoStatus: 401,
      },
    });
    return;
  }

  const [, ts, v1Fornecido] = match;
  const body = req.body as { data?: { id?: string } };
  const webhookId = body.data?.id || 'unknown';

  // Verificar timestamp (não mais de 5 minutos atrás)
  const agora = Math.floor(Date.now() / 1000);
  if (agora - parseInt(ts) > 300) {
    res.status(401).json({
      sucesso: false,
      erro: {
        codigo: 'WEBHOOK_TIMESTAMP_EXPIRADO',
        mensagem: 'Webhook expirado (timestamp muito antigo)',
        codigoStatus: 401,
      },
    });
    return;
  }

  const manifest = `id:${webhookId};request-id:${requestId};ts:${ts}`;
  const v1Calculado = crypto
    .createHmac('sha256', process.env.MERCADOPAGO_WEBHOOK_SECRET as string)
    .update(manifest)
    .digest('hex');

  let assinaturaValida = false;
  try {
    assinaturaValida = crypto.timingSafeEqual(
      Buffer.from(v1Fornecido),
      Buffer.from(v1Calculado)
    );
  } catch {
    assinaturaValida = false;
  }

  if (!assinaturaValida) {
    logger.warn({ v1Fornecido, webhookId }, 'Assinatura MP inválida');
    res.status(401).json({
      sucesso: false,
      erro: {
        codigo: 'WEBHOOK_ASSINATURA_INVALIDA',
        mensagem: 'Assinatura HMAC inválida',
        codigoStatus: 401,
      },
    });
    return;
  }

  (req as Request & { webhookId?: string; webhookTimestamp?: number }).webhookId = webhookId;
  (req as Request & { webhookId?: string; webhookTimestamp?: number }).webhookTimestamp = parseInt(ts);
  next();
}

function mapearStatusMercadopago(statusMp: string): string {
  const mapa: Record<string, string> = {
    pending: 'pendente',
    authorized: 'ativo',
    paused: 'pausado',
    cancelled: 'cancelado',
    suspended: 'suspenso',
  };
  return mapa[statusMp] || 'desconhecido';
}

async function buscarAssinaturaMercadopago(subscriptionId: string): Promise<Record<string, unknown>> {
  const resposta = await fetch(
    `${process.env.MERCADOPAGO_API_URL}/v1/preapproval/${subscriptionId}`,
    {
      headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(parseInt(process.env.WEBHOOK_TIMEOUT_MS || '30000')),
    }
  );

  if (!resposta.ok) {
    throw new Error(`Erro ao buscar assinatura MP: ${resposta.status}`);
  }

  return resposta.json() as Promise<Record<string, unknown>>;
}

// POST /api/v1/faturamento/webhook/mercadopago
router.post(
  '/webhook/mercadopago',
  limitadorWebhook,
  validacaoAssinaturaMercadopago as unknown as (req: Request, res: Response, next: () => void) => void,
  async (req: Request, res: Response): Promise<void> => {
    const inicioMs = Date.now();
    const body = req.body as { data?: { id?: string }; user_id?: number };
    const webhookId = (req as Request & { webhookId?: string }).webhookId || 'unknown';
    const chaveIdempotencia = `mercadopago_${body.data?.id}`;

    try {
      // Verificar idempotência
      const jaProcessado = await pool.query(
        'SELECT id FROM webhook_idempotency WHERE chave_idempotencia = $1',
        [chaveIdempotencia]
      );

      if (jaProcessado.rows.length > 0) {
        res.json({
          sucesso: true,
          mensagem: 'Webhook já processado anteriormente',
          webhookId: body.data?.id,
        });
        return;
      }

      // Buscar dados atualizados no MP
      let assinatura: Record<string, unknown>;
      try {
        assinatura = await buscarAssinaturaMercadopago(body.data?.id || '');
      } catch (err) {
        logger.error({ err, webhookId }, 'Erro ao buscar assinatura no MP');
        res.json({ sucesso: true, mensagem: 'Webhook recebido, assinatura não encontrada no MP', webhookId });
        return;
      }

      const novoStatus = mapearStatusMercadopago(assinatura.status as string);
      const usuarioMpId = body.user_id;

      // Encontrar usuário pelo MP user_id (simplificado — na prática seria via external reference)
      const usuarioResult = await pool.query(
        `SELECT u.id FROM users u
         JOIN subscriptions s ON s.usuario_id = u.id
         WHERE s.provider = 'mercadopago' AND s.provider_subscription_id = $1
         LIMIT 1`,
        [assinatura.id]
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (usuarioResult.rows.length > 0) {
          const usuarioId = usuarioResult.rows[0].id as string;

          const subResult = await client.query(
            `UPDATE subscriptions
             SET provider_subscription_id = $1,
                 status_pagamento = $2,
                 proxima_cobranca = $3,
                 atualizado_em = NOW()
             WHERE usuario_id = $4 AND provider = 'mercadopago'
             RETURNING *`,
            [assinatura.id, novoStatus, assinatura.next_payment_date, usuarioId]
          );

          if (subResult.rows.length === 0) {
            await client.query(
              `INSERT INTO subscriptions
               (usuario_id, provider, provider_subscription_id, status_pagamento, nome_plano, valor, moeda)
               VALUES ($1, 'mercadopago', $2, $3, 'OfertaRelay Pro', 19900, 'BRL')`,
              [usuarioId, assinatura.id, novoStatus]
            );
          }

          await client.query(
            `UPDATE users SET status_plano = $1, atualizado_em = NOW() WHERE id = $2`,
            [novoStatus === 'ativo' ? 'ativo' : 'trial', usuarioId]
          );
        }

        await client.query(
          `INSERT INTO webhook_idempotency
           (chave_idempotencia, provider, webhook_data, processado_em)
           VALUES ($1, 'mercadopago', $2, NOW())`,
          [chaveIdempotencia, JSON.stringify(body)]
        );

        await client.query('COMMIT');

        logger.info({ webhookId, novoStatus, mpUserId: usuarioMpId }, 'Webhook MP processado com sucesso');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Registrar log
      await pool.query(
        `INSERT INTO webhook_logs
         (webhook_id, provider, status_http, payload, resposta, tempo_processamento_ms, recebido_em, processado_em)
         VALUES ($1, 'mercadopago', 200, $2, $3, $4, NOW(), NOW())`,
        [webhookId, JSON.stringify(body), JSON.stringify({ sucesso: true }), Date.now() - inicioMs]
      );

      res.json({
        sucesso: true,
        mensagem: 'Webhook recebido e processado',
        webhookId,
      });
    } catch (erro: unknown) {
      logger.error({ erro, webhookId }, 'Erro ao processar webhook MP');

      await pool.query(
        `INSERT INTO webhook_logs
         (webhook_id, provider, status_http, payload, tempo_processamento_ms, erro_mensagem, recebido_em)
         VALUES ($1, 'mercadopago', 500, $2, $3, $4, NOW())`,
        [webhookId, JSON.stringify(body), Date.now() - inicioMs, (erro as Error).message]
      ).catch(() => {});

      res.status(500).json({
        sucesso: false,
        erro: {
          codigo: 'ERRO_PROCESSAMENTO_WEBHOOK',
          mensagem: 'Erro interno ao processar webhook',
          codigoStatus: 500,
        },
      });
    }
  }
);

export default router;
