import request from 'supertest';
import jwt from 'jsonwebtoken';
import { criarApp } from '../server';

jest.mock('../config/database', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../config/redis', () => ({ redisClient: { connect: jest.fn(), sendCommand: jest.fn() }, getRedisBullConfig: jest.fn(() => ({ host: 'localhost', port: 6379 })) }));
jest.mock('../middleware/rateLimiter', () => ({
  limitadorRegistro: (_: unknown, __: unknown, next: () => void) => next(),
  limitadorEntrada:  (_: unknown, __: unknown, next: () => void) => next(),
  limitadorWebhook:  (_: unknown, __: unknown, next: () => void) => next(),
  criarLimitadorN8n: () => (_: unknown, __: unknown, next: () => void) => next(),
}));
jest.mock('bull', () => jest.fn().mockImplementation(() => ({ add: jest.fn(), process: jest.fn(), on: jest.fn() })));

import { pool } from '../config/database';
const mockPool = pool as jest.Mocked<typeof pool>;

process.env.JWT_SECRET = 'segredo-teste-minimo-32-caracteres-ok';
const app = criarApp();

function token() {
  return jwt.sign({ id: 'user-id', email: 'test@test.com', nome: 'Test' }, process.env.JWT_SECRET!, { expiresIn: '1d' });
}

const PAYLOAD_AFILIADO = {
  amazon:       { tag: 'oferta-20', cookies: 'cookie_secreto' },
  mercadoLivre: { tag: '', cookies: '' },
  shopee:       { appId: 'app123', appSecret: 'secret_shopee' },
  magalu:       { magazineId: 'mag1' },
  aliexpress:   { apiKey: 'key', apiSecret: 'secret_ali', trackingId: 'track1' },
};

describe('Settings Module', () => {
  beforeEach(() => jest.clearAllMocks());

  // Teste 1: GET /affiliate sem configuração → payload vazio
  test('GET /affiliate sem configuração → payload vazio (não 404)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await request(app).get('/api/v1/settings/affiliate').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.sucesso).toBe(true);
    expect(res.body.setting.payload).toHaveProperty('amazon');
    expect(res.body.setting.payload).toHaveProperty('shopee');
  });

  // Teste 2: PUT /affiliate salva payload
  test('PUT /affiliate salva configurações', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const res = await request(app)
      .put('/api/v1/settings/affiliate')
      .set('Authorization', `Bearer ${token()}`)
      .send(PAYLOAD_AFILIADO);
    expect(res.status).toBe(200);
    expect(res.body.sucesso).toBe(true);
    expect(res.body.mensagem).toContain('salvas');
  });

  // Teste 3: GET /affiliate mascara campos sensíveis
  test('GET /affiliate mascara appSecret e cookies', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ payload: PAYLOAD_AFILIADO }], rowCount: 1 } as never);
    const res = await request(app).get('/api/v1/settings/affiliate').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.setting.payload.shopee.appSecret).not.toBe('secret_shopee');
    expect(res.body.setting.payload.shopee.appSecret).toContain('***');
    expect(res.body.setting.payload.amazon.cookies).toContain('***');
  });

  // Teste 4: GET /affiliate sem autenticação → 401
  test('GET /affiliate sem autenticação → 401', async () => {
    const res = await request(app).get('/api/v1/settings/affiliate');
    expect(res.status).toBe(401);
  });

  // Teste 5: GET /telegram sem configuração → payload vazio
  test('GET /telegram sem configuração → payload vazio', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await request(app).get('/api/v1/settings/telegram').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.setting.payload.chatIds).toEqual([]);
    expect(res.body.setting.payload.status).toBe('inactive');
  });

  // Teste 6: GET /telegram mascara botToken
  test('GET /telegram mascara botToken', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ payload: { botToken: '123456:ABCdefGhIJK', chatIds: ['@meucanal'], status: 'active' } }],
      rowCount: 1,
    } as never);
    const res = await request(app).get('/api/v1/settings/telegram').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.setting.payload.botToken).toContain('***');
    expect(res.body.setting.payload.botToken).not.toBe('123456:ABCdefGhIJK');
  });

  // Teste 7: PUT /telegram salva configuração
  test('PUT /telegram salva configuração', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const res = await request(app)
      .put('/api/v1/settings/telegram')
      .set('Authorization', `Bearer ${token()}`)
      .send({ botToken: '123456:ABCdef', chatIds: ['@meucanal'], status: 'active' });
    expect(res.status).toBe(200);
    expect(res.body.sucesso).toBe(true);
  });

  // Teste 8: PUT /telegram com status inválido → 400
  test('PUT /telegram com status inválido → 400', async () => {
    const res = await request(app)
      .put('/api/v1/settings/telegram')
      .set('Authorization', `Bearer ${token()}`)
      .send({ botToken: 'xxx', chatIds: [], status: 'invalido' });
    expect(res.status).toBe(400);
    expect(res.body.erro.codigo).toBe('ERRO_VALIDACAO');
  });

  // Teste 9: POST /telegram/test sem botToken → 400
  test('POST /telegram/test sem botToken → 400', async () => {
    const res = await request(app)
      .post('/api/v1/settings/telegram/test')
      .set('Authorization', `Bearer ${token()}`)
      .send({ chatIds: ['@meucanal'] });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // Teste 10: POST /telegram/test com token inválido (Telegram recusa) → 400
  test('POST /telegram/test com token inválido → 400', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ ok: false, description: 'Unauthorized' }),
    }) as jest.Mock;

    const res = await request(app)
      .post('/api/v1/settings/telegram/test')
      .set('Authorization', `Bearer ${token()}`)
      .send({ botToken: 'token-invalido', chatIds: ['@meucanal'] });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // Teste 11: POST /telegram/test com token válido → 200
  test('POST /telegram/test com token válido → 200', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    }) as jest.Mock;

    const res = await request(app)
      .post('/api/v1/settings/telegram/test')
      .set('Authorization', `Bearer ${token()}`)
      .send({ botToken: '123456:ABCdef', chatIds: ['@meucanal'] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // Teste 12: GET /auth/me retorna dados do usuário
  test('GET /auth/me retorna usuário logado', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'user-id', nome: 'João', email: 'joao@test.com',
        chave_api: 'rn8n_abc', status_plano: 'trial',
        trial_termina_em: new Date(),
      }],
      rowCount: 1,
    } as never);
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.usuario.id).toBe('user-id');
    expect(res.body.usuario).not.toHaveProperty('senha_hash');
  });

  // Teste 13: GET /auth/me sem autenticação → 401
  test('GET /auth/me sem autenticação → 401', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });
});
