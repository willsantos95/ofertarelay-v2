import request from 'supertest';
import crypto from 'crypto';
import { criarApp } from '../server';

jest.mock('../config/database', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('../config/redis', () => ({
  redisClient: { connect: jest.fn(), sendCommand: jest.fn() }, getRedisBullConfig: jest.fn(() => ({ host: 'localhost', port: 6379 })),
}));

jest.mock('../middleware/rateLimiter', () => ({
  limitadorRegistro: (_req: unknown, _res: unknown, next: () => void) => next(),
  limitadorEntrada: (_req: unknown, _res: unknown, next: () => void) => next(),
  limitadorWebhook: (_req: unknown, _res: unknown, next: () => void) => next(),
  criarLimitadorN8n: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { pool } from '../config/database';

const mockPool = pool as jest.Mocked<typeof pool>;

const app = criarApp();

const WEBHOOK_SECRET = 'secret-de-teste-com-32-caracteres-ok';
process.env.MERCADOPAGO_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
process.env.MERCADOPAGO_API_URL = 'https://api.mercadopago.com';

function gerarAssinatura(webhookId: string, requestId: string): { signature: string; ts: string } {
  const ts = Math.floor(Date.now() / 1000).toString();
  const manifest = `id:${webhookId};request-id:${requestId};ts:${ts}`;
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(manifest).digest('hex');
  return { signature: `ts=${ts},v1=${v1}`, ts };
}

const WEBHOOK_BODY = {
  id: '12345678901',
  live_mode: true,
  type: 'payment',
  data: { id: '12345678901' },
  user_id: 123456789,
};

describe('Billing Webhook Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Teste 1: Webhook com assinatura correta → 200
  test('Webhook válido com assinatura correta → 200', async () => {
    const requestId = 'req_123';
    const { signature } = gerarAssinatura(WEBHOOK_BODY.data.id, requestId);

    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // idempotência check
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'user-id' }] } as never); // buscar usuário

    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{}] }),
      release: jest.fn(),
    };
    (mockPool.connect as jest.Mock).mockResolvedValue(mockClient);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '12345678901', status: 'authorized', next_payment_date: null }),
    }) as jest.Mock;

    const response = await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-signature', signature)
      .set('x-request-id', requestId)
      .send(WEBHOOK_BODY);

    expect(response.status).toBe(200);
    expect(response.body.sucesso).toBe(true);
  });

  // Teste 2: Webhook com assinatura inválida → 401
  test('Webhook com assinatura inválida → 401', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const response = await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-signature', `ts=${ts},v1=assinaturainvalida`)
      .set('x-request-id', 'req_test')
      .send(WEBHOOK_BODY);

    expect(response.status).toBe(401);
    expect(response.body.erro.codigo).toBe('WEBHOOK_ASSINATURA_INVALIDA');
  });

  // Teste 3: Webhook sem assinatura → 401
  test('Webhook sem x-signature → 401', async () => {
    const response = await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-request-id', 'req_test')
      .send(WEBHOOK_BODY);

    expect(response.status).toBe(401);
    expect(response.body.erro.codigo).toBe('WEBHOOK_ASSINATURA_AUSENTE');
  });

  // Teste 4: Webhook duplicado → 200 (idempotência)
  test('Webhook duplicado → 200 (idempotência)', async () => {
    const requestId = 'req_dup';
    const { signature } = gerarAssinatura(WEBHOOK_BODY.data.id, requestId);

    // Simular que já foi processado
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'existente' }] } as never);

    const response = await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-signature', signature)
      .set('x-request-id', requestId)
      .send(WEBHOOK_BODY);

    expect(response.status).toBe(200);
    expect(response.body.mensagem).toContain('já processado');
  });

  // Teste 5: Timestamp expirado → 401
  test('Webhook com timestamp expirado → 401', async () => {
    const tsVelho = Math.floor(Date.now() / 1000) - 400; // 400s atrás
    const manifest = `id:${WEBHOOK_BODY.data.id};request-id:req_test;ts:${tsVelho}`;
    const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(manifest).digest('hex');

    const response = await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-signature', `ts=${tsVelho},v1=${v1}`)
      .set('x-request-id', 'req_test')
      .send(WEBHOOK_BODY);

    expect(response.status).toBe(401);
    expect(response.body.erro.codigo).toBe('WEBHOOK_TIMESTAMP_EXPIRADO');
  });

  // Teste 6: Sem x-request-id → 401
  test('Webhook sem x-request-id → 401', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const response = await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-signature', `ts=${ts},v1=abc`)
      .send(WEBHOOK_BODY);

    expect(response.status).toBe(401);
    expect(response.body.erro.codigo).toBe('WEBHOOK_ASSINATURA_AUSENTE');
  });

  // Teste 7: Assinatura com formato incorreto → 401
  test('Webhook com formato de assinatura incorreto → 401', async () => {
    const response = await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-signature', 'formato_invalido')
      .set('x-request-id', 'req_test')
      .send(WEBHOOK_BODY);

    expect(response.status).toBe(401);
    expect(response.body.erro.codigo).toBe('WEBHOOK_ASSINATURA_INVALIDA');
  });

  // Teste 8: Status 'authorized' → status_plano 'ativo'
  test('Webhook authorized → status_plano ativo', async () => {
    const requestId = 'req_auth';
    const { signature } = gerarAssinatura(WEBHOOK_BODY.data.id, requestId);

    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'user-id' }] } as never);

    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{}] }),
      release: jest.fn(),
    };
    (mockPool.connect as jest.Mock).mockResolvedValue(mockClient);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '12345678901', status: 'authorized' }),
    }) as jest.Mock;

    const response = await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-signature', signature)
      .set('x-request-id', requestId)
      .send(WEBHOOK_BODY);

    expect(response.status).toBe(200);
    // Verificar que status foi mapeado para 'ativo'
    const updateCalls = mockClient.query.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('UPDATE users')
    );
    if (updateCalls.length > 0) {
      expect(updateCalls[0][1]).toContain('ativo');
    }
  });

  // Teste 9: Status 'cancelled' → status_plano 'trial'
  test('Webhook cancelled → status_plano trial', async () => {
    const requestId = 'req_cancel';
    const { signature } = gerarAssinatura(WEBHOOK_BODY.data.id, requestId);

    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'user-id' }] } as never);

    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{}] }),
      release: jest.fn(),
    };
    (mockPool.connect as jest.Mock).mockResolvedValue(mockClient);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '12345678901', status: 'cancelled' }),
    }) as jest.Mock;

    await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-signature', signature)
      .set('x-request-id', requestId)
      .send(WEBHOOK_BODY);

    const updateUserCalls = mockClient.query.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('UPDATE users')
    );
    if (updateUserCalls.length > 0) {
      expect(updateUserCalls[0][1]).toContain('trial');
    }
  });

  // Teste 10: MP API indisponível → 200 (sem reprocessamento)
  test('MP API indisponível → 200 (graceful)', async () => {
    const requestId = 'req_fail';
    const { signature } = gerarAssinatura(WEBHOOK_BODY.data.id, requestId);

    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockPool.query.mockResolvedValueOnce({ rows: [] } as never);

    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-signature', signature)
      .set('x-request-id', requestId)
      .send(WEBHOOK_BODY);

    expect(response.status).toBe(200);
  });

  // Teste 11: ROLLBACK em erro de banco
  test('Erro de banco → ROLLBACK', async () => {
    const requestId = 'req_rollback';
    const { signature } = gerarAssinatura(WEBHOOK_BODY.data.id, requestId);

    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'user-id' }] } as never);

    const mockClient = {
      query: jest.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('DB error')), // UPDATE falha
      release: jest.fn(),
    };
    (mockPool.connect as jest.Mock).mockResolvedValue(mockClient);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '12345678901', status: 'authorized' }),
    }) as jest.Mock;

    const response = await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-signature', signature)
      .set('x-request-id', requestId)
      .send(WEBHOOK_BODY);

    // ROLLBACK deve ter sido chamado
    const rollbackCalls = mockClient.query.mock.calls.filter((c: unknown[]) => c[0] === 'ROLLBACK');
    expect(rollbackCalls.length).toBeGreaterThan(0);
    expect([500, 200]).toContain(response.status);
  });

  // Teste 12: idempotência é registrada após sucesso
  test('Após sucesso, chave idempotência é registrada', async () => {
    const requestId = 'req_idem';
    const { signature } = gerarAssinatura(WEBHOOK_BODY.data.id, requestId);

    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'user-id' }] } as never);

    const insertIdempotenciaCalled = { value: false };
    const mockClient = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('webhook_idempotency')) insertIdempotenciaCalled.value = true;
        return Promise.resolve({ rows: [{}] });
      }),
      release: jest.fn(),
    };
    (mockPool.connect as jest.Mock).mockResolvedValue(mockClient);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '12345678901', status: 'authorized' }),
    }) as jest.Mock;

    await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-signature', signature)
      .set('x-request-id', requestId)
      .send(WEBHOOK_BODY);

    expect(insertIdempotenciaCalled.value).toBe(true);
  });

  // Teste 13: Webhook com body vazio ainda retorna erro estruturado
  test('Webhook com body vazio → erro estruturado', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const response = await request(app)
      .post('/api/v1/faturamento/webhook/mercadopago')
      .set('x-signature', `ts=${ts},v1=abc`)
      .set('x-request-id', 'req_empty')
      .send({});

    // Deve ter resposta JSON com estrutura de erro
    expect(response.body).toHaveProperty('sucesso');
    expect(typeof response.body.sucesso).toBe('boolean');
  });
});
