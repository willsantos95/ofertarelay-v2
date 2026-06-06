import request from 'supertest';
import jwt from 'jsonwebtoken';
import { criarApp } from '../server';

jest.mock('../config/database', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('../config/redis', () => ({
  redisClient: { connect: jest.fn(), sendCommand: jest.fn() },
}));

jest.mock('../middleware/rateLimiter', () => ({
  limitadorRegistro: (_req: unknown, _res: unknown, next: () => void) => next(),
  limitadorEntrada: (_req: unknown, _res: unknown, next: () => void) => next(),
  limitadorWebhook: (_req: unknown, _res: unknown, next: () => void) => next(),
  criarLimitadorN8n: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('bull', () => {
  return jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue(undefined),
    process: jest.fn(),
    on: jest.fn(),
  }));
});

import { pool } from '../config/database';

const mockPool = pool as jest.Mocked<typeof pool>;

process.env.JWT_SECRET = 'segredo-teste-minimo-32-caracteres-ok';
process.env.EVOLUTION_API_URL = 'https://evolution-api.com';
process.env.EVOLUTION_API_KEY = 'test-key';

const app = criarApp();

function gerarToken(id = '550e8400-e29b-41d4-a716-446655440000'): string {
  return jwt.sign({ id, email: 'test@test.com', nome: 'Test' }, process.env.JWT_SECRET as string, { expiresIn: '1d' });
}

describe('WhatsApp Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Teste 1: Conectar com telefone válido → 201 com QR
  test('POST /conectar com telefone válido → 201', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // não existe instancia
      .mockResolvedValueOnce({
        rows: [{
          id: 'inst-id', nome_instancia: 'minisaas_user_xxx_14999999999',
          telefone: '14999999999', status: 'aguardando_conexao',
          qrcode: 'data:image/png;base64,abc', codigo_pareamento: null,
          expira_em: new Date(),
        }],
        rowCount: 1,
      } as never);

    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ qrcode: 'data:image/png;base64,abc' }) });

    const response = await request(app)
      .post('/api/v1/whatsapp/conectar')
      .set('Authorization', `Bearer ${gerarToken()}`)
      .send({ telefone: '14999999999' });

    expect(response.status).toBe(201);
    expect(response.body.sucesso).toBe(true);
    expect(response.body.instancia.status).toBe('aguardando_conexao');
  });

  // Teste 2: Conectar telefone já conectado → 409
  test('POST /conectar telefone já conectado → 409', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ status: 'conectado', nome_instancia: 'inst_x' }],
      rowCount: 1,
    } as never);

    const response = await request(app)
      .post('/api/v1/whatsapp/conectar')
      .set('Authorization', `Bearer ${gerarToken()}`)
      .send({ telefone: '14999999999' });

    expect(response.status).toBe(409);
    expect(response.body.erro.codigo).toBe('WHATSAPP_JA_CONECTADO');
  });

  // Teste 3: Telefone inválido → 400
  test('POST /conectar com telefone inválido → 400', async () => {
    const response = await request(app)
      .post('/api/v1/whatsapp/conectar')
      .set('Authorization', `Bearer ${gerarToken()}`)
      .send({ telefone: 'abc' });

    expect(response.status).toBe(400);
    expect(response.body.erro.codigo).toBe('VALIDACAO_TELEFONE');
  });

  // Teste 4: Sem autenticação → 401
  test('POST /conectar sem autenticação → 401', async () => {
    const response = await request(app)
      .post('/api/v1/whatsapp/conectar')
      .send({ telefone: '14999999999' });

    expect(response.status).toBe(401);
  });

  // Teste 5: GET /status retorna status correto
  test('GET /status retorna status da instância', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'inst-id', nome_instancia: 'inst_x', telefone: '14999999999', status: 'aguardando_conexao', conectado_em: null }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // update

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ instance: { state: 'open' } }),
    });

    const response = await request(app)
      .get('/api/v1/whatsapp/status')
      .set('Authorization', `Bearer ${gerarToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.sucesso).toBe(true);
    expect(response.body).toHaveProperty('conectado');
  });

  // Teste 6: GET /status sem instância → nao_criado
  test('GET /status sem instância → nao_criado', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const response = await request(app)
      .get('/api/v1/whatsapp/status')
      .set('Authorization', `Bearer ${gerarToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('nao_criado');
    expect(response.body.conectado).toBe(false);
  });

  // Teste 7: Sincronizar grupos sem conexão → 400
  test('POST /grupos/sincronizar sem WhatsApp conectado → 400', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const response = await request(app)
      .post('/api/v1/whatsapp/grupos/sincronizar')
      .set('Authorization', `Bearer ${gerarToken()}`);

    expect(response.status).toBe(400);
    expect(response.body.erro.codigo).toBe('WHATSAPP_NAO_CONECTADO');
  });

  // Teste 8: Sincronizar grupos com conexão → 202
  test('POST /grupos/sincronizar com WhatsApp conectado → 202', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ nome_instancia: 'inst_x', status: 'conectado' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 'job-id', status: 'rodando', mensagem: 'Sincronizando grupos...', iniciado_em: new Date() }],
        rowCount: 1,
      } as never);

    const response = await request(app)
      .post('/api/v1/whatsapp/grupos/sincronizar')
      .set('Authorization', `Bearer ${gerarToken()}`);

    expect(response.status).toBe(202);
    expect(response.body.job.status).toBe('rodando');
  });

  // Teste 9: Salvar grupos com transaction
  test('POST /grupos/salvar salva com TRANSACTION', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    (mockPool.connect as jest.Mock).mockResolvedValue(mockClient);

    const gruposOrigem = [{ groupJid: '120362@g.us', nome: 'Grupo A', nicho: 'fitness', statusAtivo: true }];
    const gruposDestino = [{ groupJid: '120363@g.us', nome: 'Grupo B', nicho: 'geral', statusAtivo: true }];

    const response = await request(app)
      .post('/api/v1/whatsapp/grupos/salvar')
      .set('Authorization', `Bearer ${gerarToken()}`)
      .send({ gruposOrigem, gruposDestino });

    expect(response.status).toBe(200);
    expect(response.body.sucesso).toBe(true);
    const beginCalls = mockClient.query.mock.calls.filter((c: unknown[]) => c[0] === 'BEGIN');
    const commitCalls = mockClient.query.mock.calls.filter((c: unknown[]) => c[0] === 'COMMIT');
    expect(beginCalls.length).toBeGreaterThan(0);
    expect(commitCalls.length).toBeGreaterThan(0);
  });

  // Teste 10: Salvar grupos sem origem → 400
  test('POST /grupos/salvar sem grupos origem → 400', async () => {
    const response = await request(app)
      .post('/api/v1/whatsapp/grupos/salvar')
      .set('Authorization', `Bearer ${gerarToken()}`)
      .send({ gruposOrigem: [], gruposDestino: [{ groupJid: '120363@g.us', nome: 'B', nicho: 'geral' }] });

    expect(response.status).toBe(400);
  });

  // Teste 11: Salvar grupos — JID inválido → 400
  test('POST /grupos/salvar com JID inválido → 400', async () => {
    const response = await request(app)
      .post('/api/v1/whatsapp/grupos/salvar')
      .set('Authorization', `Bearer ${gerarToken()}`)
      .send({
        gruposOrigem: [{ groupJid: 'jid-invalido', nome: 'A', nicho: 'fitness' }],
        gruposDestino: [{ groupJid: '120363@g.us', nome: 'B', nicho: 'geral' }],
      });

    expect(response.status).toBe(400);
  });

  // Teste 12: ROLLBACK em erro ao salvar grupos
  test('POST /grupos/salvar → ROLLBACK em erro de banco', async () => {
    const mockClient = {
      query: jest.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('DB error')), // UPDATE falha
      release: jest.fn(),
    };
    (mockPool.connect as jest.Mock).mockResolvedValue(mockClient);

    const response = await request(app)
      .post('/api/v1/whatsapp/grupos/salvar')
      .set('Authorization', `Bearer ${gerarToken()}`)
      .send({
        gruposOrigem: [{ groupJid: '120362@g.us', nome: 'A', nicho: 'fitness' }],
        gruposDestino: [{ groupJid: '120363@g.us', nome: 'B', nicho: 'geral' }],
      });

    expect(response.status).toBe(500);
    const rollbackCalls = mockClient.query.mock.calls.filter((c: unknown[]) => c[0] === 'ROLLBACK');
    expect(rollbackCalls.length).toBeGreaterThan(0);
  });

  // Teste 13: GET /grupos/status-sync retorna status do job
  test('GET /grupos/status-sync retorna status', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'job-id', status: 'concluido', mensagem: null,
        total_recebidos: 5, salvos: 5, ignorados: 0, finalizado_em: new Date(),
      }],
      rowCount: 1,
    } as never);

    const response = await request(app)
      .get('/api/v1/whatsapp/grupos/status-sync?jobId=job-id')
      .set('Authorization', `Bearer ${gerarToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.job.status).toBe('concluido');
  });
});
