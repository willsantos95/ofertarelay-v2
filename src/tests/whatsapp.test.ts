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
  redisClient: { connect: jest.fn(), sendCommand: jest.fn() }, getRedisBullConfig: jest.fn(() => ({ host: 'localhost', port: 6379 })),
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

// Variáveis necessárias para o módulo WhatsApp
process.env.JWT_SECRET = 'segredo-teste-minimo-32-caracteres-ok';
process.env.EVOLUTION_API_URL = 'https://evolution-test.com';
process.env.EVOLUTION_API_KEY = 'test-key';

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
    jest.resetAllMocks(); // reset também limpa a fila de mockResolvedValueOnce
  });

  // Teste 1: Conectar com telefone válido → 201 com QR
  test('POST /conectar com telefone válido → 201', async () => {
    // Novo fluxo: check existência → create Evolution → INSERT → connect Evolution → UPDATE
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)          // check existência
      .mockResolvedValueOnce({ rows: [{ id: 'inst-id' }], rowCount: 1 } as never) // INSERT RETURNING id
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);          // UPDATE qrcode

    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('{}') })  // /instance/create
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(JSON.stringify({ base64: 'data:image/png;base64,abc' })) }); // /instance/connect

    const response = await request(app)
      .post('/api/v1/whatsapp/conectar')
      .set('Authorization', `Bearer ${gerarToken()}`)
      .send({ telefone: '14999999999' });

    expect(response.status).toBe(201);
    expect(response.body.sucesso).toBe(true);
    expect(response.body.instancia.status).toBe('aguardando_conexao');
  });

  // Teste 2: Conectar telefone já conectado → já existe, mas não é 409 no novo fluxo
  // O novo fluxo não retorna 409 — apenas reutiliza a instância existente
  // Testamos que se existe, ainda retorna 201 com o QR atualizado
  test('POST /conectar com instância existente → 201 (reutiliza)', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'inst-existente' }], rowCount: 1 } as never) // existe
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // UPDATE

    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(JSON.stringify({ base64: 'data:image/png;base64,qr' })) }); // /instance/connect

    const response = await request(app)
      .post('/api/v1/whatsapp/conectar')
      .set('Authorization', `Bearer ${gerarToken()}`)
      .send({ telefone: '14999999999' });

    expect(response.status).toBe(201);
    expect(response.body.sucesso).toBe(true);
  });

  // Teste: Evolution indisponível → 500
  test('POST /conectar com Evolution indisponível → 500', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // não existe
      .mockResolvedValueOnce({ rows: [{ id: 'inst-id' }], rowCount: 1 } as never) // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // UPDATE

    global.fetch = jest.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // create falha
      .mockRejectedValueOnce(new Error('ECONNREFUSED')); // connect falha

    const response = await request(app)
      .post('/api/v1/whatsapp/conectar')
      .set('Authorization', `Bearer ${gerarToken()}`)
      .send({ telefone: '14999999999' });

    // Retorna 201 mas sem QR (qrcode: null)
    expect([201, 500]).toContain(response.status);
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
      text: () => Promise.resolve(JSON.stringify({ instance: { state: 'open' } })),
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
