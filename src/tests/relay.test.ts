import request from 'supertest';
import jwt from 'jsonwebtoken';
import { criarApp } from '../server';

jest.mock('../config/database', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../config/redis', () => ({ redisClient: { connect: jest.fn(), sendCommand: jest.fn() } }));
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

function token(id = 'user-a') {
  return jwt.sign({ id, email: 'test@test.com', nome: 'Test' }, process.env.JWT_SECRET!, { expiresIn: '1d' });
}

const LOG_EXEMPLO = {
  id: 1,
  instance_name: 'minisaas_user_xxx_14999',
  origin_group_name: 'Ofertas Fitness',
  destination_group_name: 'Meu Grupo',
  store: 'shopee',
  niche: 'fitness',
  affiliate_url: 'https://shopee.com.br/x',
  status: 'success',
  relayed_at: new Date().toISOString(),
};

const STATS_EXEMPLO = { today: '47', week: '312', month: '1204', total: '8901' };

describe('Relay Module', () => {
  beforeEach(() => jest.clearAllMocks());

  // Teste 1: GET /relay/logs retorna lista paginada
  test('GET /relay/logs retorna logs', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [LOG_EXEMPLO], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ total: '1' }], rowCount: 1 } as never);

    const res = await request(app).get('/api/v1/relay/logs').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].store).toBe('shopee');
    expect(res.body.total).toBe(1);
  });

  // Teste 2: GET /relay/logs filtra por nicho
  test('GET /relay/logs?niche=fitness filtra corretamente', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [LOG_EXEMPLO], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ total: '1' }], rowCount: 1 } as never);

    const res = await request(app)
      .get('/api/v1/relay/logs?niche=fitness')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);

    // verificar que a query foi chamada com o nicho correto
    const calls = mockPool.query.mock.calls;
    expect(JSON.stringify(calls)).toContain('fitness');
  });

  // Teste 3: GET /relay/logs paginação
  test('GET /relay/logs calcula totalPages corretamente', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: Array(50).fill(LOG_EXEMPLO), rowCount: 50 } as never)
      .mockResolvedValueOnce({ rows: [{ total: '120' }], rowCount: 1 } as never);

    const res = await request(app).get('/api/v1/relay/logs?page=1&limit=50').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.totalPages).toBe(3);
    expect(res.body.page).toBe(1);
  });

  // Teste 4: GET /relay/logs sem autenticação → 401
  test('GET /relay/logs sem autenticação → 401', async () => {
    const res = await request(app).get('/api/v1/relay/logs');
    expect(res.status).toBe(401);
  });

  // Teste 5: GET /relay/logs isolamento — sempre filtra por usuario_id
  test('GET /relay/logs sempre filtra por usuario_id', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 } as never);

    await request(app).get('/api/v1/relay/logs').set('Authorization', `Bearer ${token('user-b')}`);

    const queries = mockPool.query.mock.calls.map((c) => c[1] as unknown[]);
    expect(queries[0][0]).toBe('user-b');
  });

  // Teste 6: GET /relay/stats retorna 4 contadores
  test('GET /relay/stats retorna today/week/month/total', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [STATS_EXEMPLO], rowCount: 1 } as never);

    const res = await request(app).get('/api/v1/relay/stats').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.stats.today).toBe(47);
    expect(res.body.stats.week).toBe(312);
    expect(res.body.stats.month).toBe(1204);
    expect(res.body.stats.total).toBe(8901);
  });

  // Teste 7: GET /relay/stats sem autenticação → 401
  test('GET /relay/stats sem autenticação → 401', async () => {
    const res = await request(app).get('/api/v1/relay/stats');
    expect(res.status).toBe(401);
  });

  // Teste 8: GET /relay/stats isolamento — filtra por usuario_id
  test('GET /relay/stats filtra por usuario_id', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [STATS_EXEMPLO], rowCount: 1 } as never);

    await request(app).get('/api/v1/relay/stats').set('Authorization', `Bearer ${token('user-c')}`);

    const queries = mockPool.query.mock.calls.map((c) => c[1] as unknown[]);
    expect(queries[0][0]).toBe('user-c');
  });

  // Teste 9: GET /whatsapp/dashboard retorna instância + grupos
  test('GET /whatsapp/dashboard retorna dados completos', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ instance_name: 'inst_x', phone: '14999', status: 'connected' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [
          { id: '1', group_name: 'Fitness', group_jid: '120362@g.us', niche: 'fitness', role: 'origem' },
          { id: '2', group_name: 'Meu Grupo', group_jid: '120363@g.us', niche: 'geral', role: 'destino' },
        ],
        rowCount: 2,
      } as never);

    const res = await request(app).get('/api/v1/whatsapp/dashboard').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.instance.instance_name).toBe('inst_x');
    expect(res.body.originGroups).toHaveLength(1);
    expect(res.body.destinationGroups).toHaveLength(1);
    expect(res.body.summary.total_groups).toBe(2);
  });

  // Teste 10: GET /whatsapp/dashboard sem instância → instance null
  test('GET /whatsapp/dashboard sem instância → instance null', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const res = await request(app).get('/api/v1/whatsapp/dashboard').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.instance).toBeNull();
    expect(res.body.summary.total_groups).toBe(0);
  });

  // Teste 11: GET /whatsapp/grupos retorna grupos salvos
  test('GET /whatsapp/grupos retorna lista de grupos', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: '1', group_jid: '120362@g.us', nome: 'Fitness', papel: 'origem', nicho: 'fitness' },
        { id: '2', group_jid: '120363@g.us', nome: 'Destino', papel: 'destino', nicho: 'geral' },
      ],
      rowCount: 2,
    } as never);

    const res = await request(app).get('/api/v1/whatsapp/grupos').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.grupos).toHaveLength(2);
    expect(res.body.grupos[0].papel).toBe('origem');
  });

  // Teste 12: GET /whatsapp/grupos sem autenticação → 401
  test('GET /whatsapp/grupos sem autenticação → 401', async () => {
    const res = await request(app).get('/api/v1/whatsapp/grupos');
    expect(res.status).toBe(401);
  });

  // Teste 13: GET /relay/logs com nicho inválido → 400
  test('GET /relay/logs com nicho inválido → 400', async () => {
    const res = await request(app)
      .get('/api/v1/relay/logs?niche=invalido')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(400);
  });
});
