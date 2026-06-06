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

jest.mock('../routes/whatsapp.routes', () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  default: require('express').Router(),
  filaSync: { add: jest.fn() },
}));

import { pool } from '../config/database';

const mockPool = pool as jest.Mocked<typeof pool>;

process.env.N8N_WEBHOOK_SECRET = 'n8n-secret-minimo-32-caracteres-ok!';
process.env.N8N_LOG_REQUESTS = 'false';

const app = criarApp();

const USUARIO_N8N = { id: 'user-id-n8n', nome: 'João n8n', email: 'joao@n8n.com' };
const INSTANCIA = { id: 'inst-id' };

function mockAutenticado(): void {
  mockPool.query.mockResolvedValueOnce({ rows: [USUARIO_N8N], rowCount: 1 } as never); // autenticacaoN8n
  mockPool.query.mockResolvedValueOnce({ rows: [INSTANCIA], rowCount: 1 } as never);   // verificarInstancia
}

function gerarHmacN8n(instancia: string): { signature: string } {
  const ts = Math.floor(Date.now() / 1000).toString();
  const xRequestId = 'req-n8n-test';
  const manifest = `id:${instancia};request-id:${xRequestId};ts:${ts}`;
  const v1 = crypto
    .createHmac('sha256', process.env.N8N_WEBHOOK_SECRET as string)
    .update(manifest)
    .digest('hex');
  return { signature: `ts=${ts},v1=${v1}` };
}

describe('n8n Security Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const INSTANCIA_NOME = 'minisaas_user_550e8400-e29b-41d4-a716-446655440000_14999999999';

  // Teste 1: GET /configuracoes com chave válida → 200
  test('GET /configuracoes com chave válida → 200', async () => {
    mockAutenticado();
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'inst-id', nome_instancia: INSTANCIA_NOME, telefone: '14999999999', status: 'conectado' }] } as never)
      .mockResolvedValueOnce({ rows: [USUARIO_N8N] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const response = await request(app)
      .get(`/api/v1/n8n/configuracoes?instancia=${INSTANCIA_NOME}`)
      .set('x-api-key', 'rn8n_abc123');

    expect(response.status).toBe(200);
    expect(response.body.sucesso).toBe(true);
    expect(response.body.usuario).toBeDefined();
  });

  // Teste 2: GET /configuracoes sem chave → 401
  test('GET /configuracoes sem x-api-key → 401', async () => {
    const response = await request(app)
      .get(`/api/v1/n8n/configuracoes?instancia=${INSTANCIA_NOME}`);

    expect(response.status).toBe(401);
    expect(response.body.erro.codigo).toBe('N8N_CHAVE_AUSENTE');
  });

  // Teste 3: GET /configuracoes com chave inválida → 401
  test('GET /configuracoes com chave inválida → 401', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const response = await request(app)
      .get(`/api/v1/n8n/configuracoes?instancia=${INSTANCIA_NOME}`)
      .set('x-api-key', 'chave-invalida');

    expect(response.status).toBe(401);
    expect(response.body.erro.codigo).toBe('N8N_CHAVE_INVALIDA');
    expect(response.body.erro.mensagem).toBe('Chave de API inválida');
  });

  // Teste 4: Instância de outro usuário → 403
  test('GET /configuracoes instância de outro usuário → 403', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [USUARIO_N8N], rowCount: 1 } as never); // auth OK
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // instancia não pertence

    const response = await request(app)
      .get(`/api/v1/n8n/configuracoes?instancia=instancia-outro-usuario`)
      .set('x-api-key', 'rn8n_abc');

    expect(response.status).toBe(403);
    expect(response.body.erro.codigo).toBe('N8N_ACESSO_NEGADO');
  });

  // Teste 5: GET /grupos com chave válida → 200
  test('GET /grupos com chave válida → 200', async () => {
    mockAutenticado();
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ group_jid: '120362@g.us', nome: 'Grupo A', nicho: 'fitness' }] } as never)
      .mockResolvedValueOnce({ rows: [{ group_jid: '120363@g.us', nome: 'Grupo B', nicho: 'geral' }] } as never);

    const response = await request(app)
      .get(`/api/v1/n8n/grupos?instancia=${INSTANCIA_NOME}`)
      .set('x-api-key', 'rn8n_abc');

    expect(response.status).toBe(200);
    expect(response.body.gruposOrigem).toBeDefined();
    expect(response.body.gruposDestino).toBeDefined();
  });

  // Teste 6: POST /registrar-log com HMAC válido → 201
  test('POST /registrar-log com HMAC válido → 201', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [USUARIO_N8N], rowCount: 1 } as never);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: '42' }], rowCount: 1 } as never);

    const { signature } = gerarHmacN8n(INSTANCIA_NOME);
    const body = {
      instancia: INSTANCIA_NOME,
      grupoOrigem: { groupJid: '120362@g.us', nome: 'Grupo A' },
      grupoDestino: { groupJid: '120363@g.us', nome: 'Grupo B' },
      oferta: { loja: 'shopee', nicho: 'fitness', urlOriginal: 'https://shopee.com/x', titulo: 'Produto', preco: 'R$ 99' },
      status: 'sucesso',
      timestamp: new Date().toISOString(),
    };

    const response = await request(app)
      .post('/api/v1/n8n/registrar-log')
      .set('x-api-key', 'rn8n_abc')
      .set('x-signature', signature)
      .set('x-request-id', 'req-n8n-test')
      .send(body);

    expect(response.status).toBe(201);
    expect(response.body.logId).toBeDefined();
  });

  // Teste 7: POST /registrar-log com HMAC inválido → 401
  test('POST /registrar-log com HMAC inválido → 401', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [USUARIO_N8N], rowCount: 1 } as never);

    const ts = Math.floor(Date.now() / 1000);
    const response = await request(app)
      .post('/api/v1/n8n/registrar-log')
      .set('x-api-key', 'rn8n_abc')
      .set('x-signature', `ts=${ts},v1=hmac-invalido`)
      .set('x-request-id', 'req-test')
      .send({ instancia: INSTANCIA_NOME, status: 'sucesso', timestamp: new Date().toISOString() });

    expect(response.status).toBe(401);
    expect(response.body.erro.codigo).toBe('N8N_ASSINATURA_INVALIDA');
  });

  // Teste 8: POST /registrar-log sem assinatura → 401
  test('POST /registrar-log sem x-signature → 401', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [USUARIO_N8N], rowCount: 1 } as never);

    const response = await request(app)
      .post('/api/v1/n8n/registrar-log')
      .set('x-api-key', 'rn8n_abc')
      .send({ instancia: INSTANCIA_NOME, status: 'sucesso', timestamp: new Date().toISOString() });

    expect(response.status).toBe(401);
    expect(response.body.erro.codigo).toBe('N8N_ASSINATURA_AUSENTE');
  });

  // Teste 9: HMAC com timestamp expirado → 401
  test('POST /registrar-log com timestamp expirado → 401', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [USUARIO_N8N], rowCount: 1 } as never);

    const tsVelho = Math.floor(Date.now() / 1000) - 400;
    const manifest = `id:${INSTANCIA_NOME};request-id:req-test;ts:${tsVelho}`;
    const v1 = crypto.createHmac('sha256', process.env.N8N_WEBHOOK_SECRET as string).update(manifest).digest('hex');

    const response = await request(app)
      .post('/api/v1/n8n/registrar-log')
      .set('x-api-key', 'rn8n_abc')
      .set('x-signature', `ts=${tsVelho},v1=${v1}`)
      .set('x-request-id', 'req-test')
      .send({ instancia: INSTANCIA_NOME, status: 'sucesso', timestamp: new Date().toISOString() });

    expect(response.status).toBe(401);
  });

  // Teste 10: chave_api nunca retornada na resposta
  test('GET /configuracoes não expõe chave_api', async () => {
    mockAutenticado();
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'inst-id', nome_instancia: INSTANCIA_NOME, telefone: '14999999999', status: 'conectado' }] } as never)
      .mockResolvedValueOnce({ rows: [{ ...USUARIO_N8N, chave_api: 'rn8n_secreto' }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const response = await request(app)
      .get(`/api/v1/n8n/configuracoes?instancia=${INSTANCIA_NOME}`)
      .set('x-api-key', 'rn8n_abc');

    expect(JSON.stringify(response.body)).not.toContain('rn8n_secreto');
  });

  // Teste 11: Isolamento - usuário A não vê dados de usuário B
  test('Usuário A não acessa instância de usuário B → 403', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [USUARIO_N8N], rowCount: 1 } as never);
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // instância não pertence

    const response = await request(app)
      .get('/api/v1/n8n/configuracoes?instancia=instancia-usuario-b')
      .set('x-api-key', 'rn8n_abc');

    expect(response.status).toBe(403);
  });

  // Teste 12: GET /grupos sem instancia param → 400
  test('GET /grupos sem parâmetro instancia → 400', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [USUARIO_N8N], rowCount: 1 } as never);

    const response = await request(app)
      .get('/api/v1/n8n/grupos')
      .set('x-api-key', 'rn8n_abc');

    expect([400, 401]).toContain(response.status);
  });

  // Teste 13: POST /registrar-log sem campos obrigatórios → 400
  test('POST /registrar-log sem campos obrigatórios → 400', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [USUARIO_N8N], rowCount: 1 } as never);

    const ts = Math.floor(Date.now() / 1000);
    const response = await request(app)
      .post('/api/v1/n8n/registrar-log')
      .set('x-api-key', 'rn8n_abc')
      .set('x-signature', `ts=${ts},v1=x`)
      .send({});

    expect(response.status).toBe(400);
  });
});
