import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../config/database';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { limitadorWebhook } from '../middleware/rateLimiter';
import { logger } from '../utils/logger';

const router = Router();

// Lidos em tempo de execução para suportar variáveis dinâmicas
function getMpToken()       { return process.env.MERCADOPAGO_ACCESS_TOKEN || ''; }
function getMpSecret()      { return process.env.MERCADOPAGO_WEBHOOK_SECRET || ''; }
function getAppUrl()        { return process.env.APP_URL || ''; }
function getFrontendUrl()   { return process.env.FRONTEND_URL || ''; }
function getPlanName()      { return process.env.PLAN_NAME || 'OfertaRelay Pro'; }
function getPlanAmount()    { return Number(process.env.PLAN_AMOUNT || 199); }
function getPlanCurrency()  { return process.env.PLAN_CURRENCY || 'BRL'; }

function getCheckoutUrl(data: Record<string, unknown>): string | null {
  return (data?.init_point || data?.sandbox_init_point) as string | null;
}

function mapMpStatus(providerStatus: string): string {
  if (providerStatus === 'authorized') return 'ativo';
  if (providerStatus === 'paused')     return 'pausado';
  if (providerStatus === 'cancelled')  return 'cancelado';
  if (providerStatus === 'pending')    return 'pendente';
  return 'pendente';
}

function validarAssinaturaMP(req: Request): boolean {
  const secret = getMpSecret();
  if (!secret) return true; // sem secret, não bloquear

  const xSignature  = req.headers['x-signature'] as string;
  const xRequestId  = req.headers['x-request-id'] as string;
  const dataId      = (req.body as Record<string, unknown>)?.data
    ? ((req.body as Record<string, Record<string, string>>).data?.id || '')
    : '';

  if (!xSignature) return false;

  const tsPart = xSignature.split(',').find((p) => p.startsWith('ts='));
  const v1Part = xSignature.split(',').find((p) => p.startsWith('v1='));
  if (!tsPart || !v1Part) return false;

  const ts = tsPart.split('=')[1];
  const v1 = v1Part.split('=')[1];

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts}`;
  const expected  = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
  } catch {
    return false;
  }
}

// POST /api/v1/billing/checkout
router.post('/checkout', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuario = req.usuario!;

  if (!getMpToken()) {
    res.status(500).json({ sucesso: false, erro: { mensagem: 'Mercado Pago não configurado. Configure MERCADOPAGO_ACCESS_TOKEN.' } });
    return;
  }
  if (!getAppUrl() || !getFrontendUrl()) {
    res.status(500).json({ sucesso: false, erro: { mensagem: 'Configure APP_URL e FRONTEND_URL.' } });
    return;
  }

  try {
    // Buscar email do usuário
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [usuario.id]);
    const email = userResult.rows[0]?.email as string;

    const response = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getMpToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reason:             getPlanName(),
        external_reference: String(usuario.id),
        payer_email:        email,
        auto_recurring: {
          frequency:          1,
          frequency_type:     'months',
          transaction_amount: getPlanAmount(),
          currency_id:        getPlanCurrency(),
        },
        back_url:         `${getFrontendUrl()}/billing/success`,
        notification_url: `${getAppUrl()}/api/v1/faturamento/webhook/mercadopago`,
        status: 'pending',
      }),
    });

    const data = await response.json() as Record<string, unknown>;

    if (!response.ok) {
      logger.error({ data }, 'Erro MP ao criar assinatura');
      res.status(400).json({ sucesso: false, erro: { mensagem: (data.message as string) || 'Erro ao criar checkout no Mercado Pago.' } });
      return;
    }

    const checkoutUrl = getCheckoutUrl(data);

    await pool.query(
      `INSERT INTO subscriptions
         (usuario_id, provider, provider_subscription_id, provider_customer_id,
          nome_plano, valor, moeda, status_pagamento, checkout_url, criado_em, atualizado_em)
       VALUES ($1, 'mercadopago', $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT (provider_subscription_id)
       DO UPDATE SET checkout_url = EXCLUDED.checkout_url, status_pagamento = EXCLUDED.status_pagamento, atualizado_em = NOW()`,
      [usuario.id, data.id, (data as Record<string, string>).payer_id || null,
       getPlanName(), getPlanAmount(), getPlanCurrency(),
       (data as Record<string, string>).status || 'pending', checkoutUrl]
    );

    await pool.query(
      `UPDATE users SET status_plano = 'pendente', atualizado_em = NOW() WHERE id = $1`,
      [usuario.id]
    );

    res.json({ sucesso: true, checkoutUrl, subscriptionId: data.id, status: data.status });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao criar checkout');
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message || 'Erro ao criar checkout.' } });
  }
});

// GET /api/v1/billing/me
router.get('/me', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const [userResult, subResult] = await Promise.all([
      pool.query(
        `SELECT id, nome AS name, email, status_plano AS plan_status FROM users WHERE id = $1 AND deletado_em IS NULL`,
        [usuarioId]
      ),
      pool.query(
        `SELECT id, provider, provider_subscription_id, provider_customer_id,
                nome_plano AS plan_name, valor AS amount, moeda AS currency,
                status_pagamento AS status, checkout_url,
                started_at, next_payment_at, cancelled_at, criado_em AS created_at, atualizado_em AS updated_at
         FROM subscriptions WHERE usuario_id = $1
         ORDER BY criado_em DESC LIMIT 1`,
        [usuarioId]
      ),
    ]);

    res.json({
      sucesso: true,
      success: true,
      user: userResult.rows[0] || null,
      subscription: subResult.rows[0] || null,
    });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao buscar assinatura');
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// POST /api/v1/billing/sync
router.post('/sync', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;

  if (!getMpToken()) {
    res.status(500).json({ sucesso: false, erro: { mensagem: 'Mercado Pago não configurado.' } });
    return;
  }

  try {
    const subResult = await pool.query(
      `SELECT * FROM subscriptions WHERE usuario_id = $1 AND provider = 'mercadopago'
       AND provider_subscription_id IS NOT NULL ORDER BY criado_em DESC LIMIT 1`,
      [usuarioId]
    );

    if (subResult.rows.length === 0) {
      res.status(404).json({ sucesso: false, erro: { mensagem: 'Nenhuma assinatura encontrada.' } });
      return;
    }

    const localSub = subResult.rows[0];
    const response = await fetch(
      `https://api.mercadopago.com/preapproval/${localSub.provider_subscription_id}`,
      { headers: { Authorization: `Bearer ${getMpToken()}` } }
    );

    const subscription = await response.json() as Record<string, unknown>;

    if (!response.ok) {
      res.status(400).json({ sucesso: false, erro: { mensagem: (subscription.message as string) || 'Erro ao consultar Mercado Pago.' } });
      return;
    }

    const providerStatus = (subscription.status as string) || 'pending';
    const planStatus = mapMpStatus(providerStatus);

    await pool.query(
      `UPDATE subscriptions
       SET status_pagamento = $1, checkout_url = $2,
           next_payment_at = $3, cancelled_at = $4, atualizado_em = NOW()
       WHERE id = $5`,
      [
        providerStatus,
        getCheckoutUrl(subscription),
        (subscription.next_payment_date as string) || null,
        providerStatus === 'cancelled' ? new Date() : null,
        localSub.id,
      ]
    );

    await pool.query(
      `UPDATE users SET status_plano = $1, atualizado_em = NOW() WHERE id = $2`,
      [planStatus, usuarioId]
    );

    res.json({ sucesso: true, providerStatus, planStatus });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao sincronizar assinatura');
    res.status(500).json({ sucesso: false, erro: { mensagem: (erro as Error).message } });
  }
});

// POST /api/v1/faturamento/webhook/mercadopago
router.post('/webhook/mercadopago', limitadorWebhook, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!validarAssinaturaMP(req)) {
      logger.warn('Webhook MP rejeitado: assinatura inválida');
      res.status(401).json({ sucesso: false, mensagem: 'Assinatura inválida.' });
      return;
    }

    if (!getMpToken()) {
      res.status(200).json({ sucesso: false, mensagem: 'Mercado Pago não configurado.' });
      return;
    }

    const event = req.body as Record<string, unknown>;
    const subscriptionId =
      (event?.data as Record<string, string>)?.id ||
      (event?.id as string) ||
      ((event?.resource as string) || '').split('/').pop() ||
      null;

    if (!subscriptionId) {
      res.status(200).json({ sucesso: true, mensagem: 'Webhook recebido sem subscriptionId.' });
      return;
    }

    const response = await fetch(
      `https://api.mercadopago.com/preapproval/${subscriptionId}`,
      { headers: { Authorization: `Bearer ${getMpToken()}` } }
    );

    const subscription = await response.json() as Record<string, unknown>;

    if (!response.ok) {
      logger.error({ subscription }, 'Erro ao consultar MP');
      res.status(200).json({ sucesso: false, mensagem: 'Erro ao consultar assinatura.' });
      return;
    }

    const providerStatus = (subscription.status as string) || 'pending';
    const userId         = subscription.external_reference as string;
    const planStatus     = mapMpStatus(providerStatus);

    if (!userId) {
      logger.error({ subscription }, 'Assinatura sem external_reference');
      res.status(200).json({ sucesso: false, mensagem: 'Assinatura sem external_reference.' });
      return;
    }

    const autoRec = subscription.auto_recurring as Record<string, unknown> | undefined;

    await pool.query(
      `INSERT INTO subscriptions
         (usuario_id, provider, provider_subscription_id, provider_customer_id,
          nome_plano, valor, moeda, status_pagamento, checkout_url,
          started_at, next_payment_at, cancelled_at, criado_em, atualizado_em)
       VALUES ($1,'mercadopago',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
       ON CONFLICT (provider_subscription_id)
       DO UPDATE SET
         status_pagamento = EXCLUDED.status_pagamento,
         checkout_url     = EXCLUDED.checkout_url,
         started_at       = EXCLUDED.started_at,
         next_payment_at  = EXCLUDED.next_payment_at,
         cancelled_at     = EXCLUDED.cancelled_at,
         atualizado_em    = NOW()`,
      [
        userId,
        subscription.id,
        (subscription.payer_id as string) || null,
        (subscription.reason as string) || getPlanName(),
        autoRec?.transaction_amount || getPlanAmount(),
        getPlanCurrency(),
        providerStatus,
        getCheckoutUrl(subscription),
        null, // started_at
        (subscription.next_payment_date as string) || null,
        providerStatus === 'cancelled' ? new Date() : null,
      ]
    );

    await pool.query(
      `UPDATE users SET status_plano = $1, atualizado_em = NOW() WHERE id = $2`,
      [planStatus, userId]
    );

    logger.info({ userId, planStatus, providerStatus }, 'Webhook MP processado');
    res.status(200).json({ sucesso: true, providerStatus, planStatus });
  } catch (erro) {
    logger.error({ erro }, 'Erro webhook Mercado Pago');
    res.status(200).json({ sucesso: false, mensagem: (erro as Error).message });
  }
});

export default router;
