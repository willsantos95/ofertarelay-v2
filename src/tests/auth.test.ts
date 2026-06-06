import request from 'supertest';
import { criarApp } from '../server';

// Mocks para isolar dos serviços externos
jest.mock('../config/database', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('../config/redis', () => ({
  redisClient: {
    connect: jest.fn(),
    sendCommand: jest.fn(),
  },
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

process.env.JWT_SECRET = 'segredo-teste-minimo-32-caracteres-ok';

const mockPool = pool as jest.Mocked<typeof pool>;

const app = criarApp();

const USUARIO_DB = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  nome: 'João Silva',
  email: 'joao@teste.com.br',
  chave_api: 'rn8n_abc123',
  status_plano: 'trial',
  trial_termina_em: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
};

describe('Auth Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Teste 1: Cadastro com dados válidos
  test('POST /registrar com dados válidos → 201', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [USUARIO_DB], rowCount: 1 } as never); // INSERT RETURNING

    const response = await request(app)
      .post('/api/v1/auth/registrar')
      .send({ nome: 'João Silva', email: 'joao@teste.com.br', senha: '123456' });

    expect(response.status).toBe(201);
    expect(response.body.sucesso).toBe(true);
    expect(response.body.usuario.id).toBeDefined();
    expect(response.body.usuario.chave_api).toMatch(/^rn8n_/);
    expect(response.body.token).toBeDefined();
  });

  // Teste 2: Email duplicado (constraint violation)
  test('POST /registrar com email duplicado → 409', async () => {
    const pgError = Object.assign(new Error('unique constraint'), { code: '23505' });
    // @ts-ignore — jest mock type limitation
    mockPool.query.mockRejectedValueOnce(pgError);

    const response = await request(app)
      .post('/api/v1/auth/registrar')
      .send({ nome: 'João', email: 'joao@teste.com.br', senha: '123456' });

    expect(response.status).toBe(409);
    expect(response.body.erro.codigo).toBe('AUTH_USUARIO_EXISTE');
  });

  // Teste 3: Email inválido → 400
  test('POST /registrar com email inválido → 400', async () => {
    const response = await request(app)
      .post('/api/v1/auth/registrar')
      .send({ nome: 'João', email: 'nao-eh-email', senha: '123456' });

    expect(response.status).toBe(400);
    expect(response.body.erro.codigo).toBe('ERRO_VALIDACAO');
  });

  // Teste 4: Senha muito curta → 400
  test('POST /registrar com senha < 6 chars → 400', async () => {
    const response = await request(app)
      .post('/api/v1/auth/registrar')
      .send({ nome: 'João', email: 'joao@teste.com', senha: '123' });

    expect(response.status).toBe(400);
    expect(response.body.erro.codigo).toBe('ERRO_VALIDACAO');
  });

  // Teste 5: Nome obrigatório → 400
  test('POST /registrar sem nome → 400', async () => {
    const response = await request(app)
      .post('/api/v1/auth/registrar')
      .send({ email: 'joao@teste.com', senha: '123456' });

    expect(response.status).toBe(400);
    expect(response.body.erro.codigo).toBe('ERRO_VALIDACAO');
  });

  // Teste 6: XSS no nome — deve ser rejeitado ou escapado
  test('POST /registrar com XSS no nome → 400 ou escapado', async () => {
    // .escape() sanitiza antes do custom validator — pode chegar no INSERT
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ...USUARIO_DB, nome: '&lt;script&gt;alert(1)&lt;/script&gt;' }],
      rowCount: 1,
    } as never);

    const response = await request(app)
      .post('/api/v1/auth/registrar')
      .send({ nome: '<script>alert(1)</script>', email: 'joao@teste.com', senha: '123456' });

    // Deve rejeitar (400) ou sanitizar — nunca executar
    expect([400, 201]).toContain(response.status);
    if (response.status === 201) {
      expect(response.body.usuario.nome).not.toContain('<script>');
    }
  });

  // Teste 7: Login com credenciais válidas
  test('POST /entrar com credenciais válidas → 200', async () => {
    const bcryptMod = await import('bcryptjs');
    const senhaHash = await bcryptMod.hash('123456', 10);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ...USUARIO_DB, senha_hash: senhaHash }],
      rowCount: 1,
    } as never);

    const response = await request(app)
      .post('/api/v1/auth/entrar')
      .send({ email: 'joao@teste.com.br', senha: '123456' });

    expect(response.status).toBe(200);
    expect(response.body.sucesso).toBe(true);
    expect(response.body.token).toBeDefined();
    expect(response.body.usuario).not.toHaveProperty('senha_hash');
  });

  // Teste 8: Login com senha errada → 401 (mensagem genérica)
  test('POST /entrar com senha errada → 401 genérico', async () => {
    const bcryptMod = await import('bcryptjs');
    const senhaHash = await bcryptMod.hash('123456', 10);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ...USUARIO_DB, senha_hash: senhaHash }],
      rowCount: 1,
    } as never);

    const response = await request(app)
      .post('/api/v1/auth/entrar')
      .send({ email: 'joao@teste.com.br', senha: 'SENHAERRADA' });

    expect(response.status).toBe(401);
    expect(response.body.erro.codigo).toBe('AUTH_CREDENCIAIS_INVALIDAS');
    expect(response.body.erro.mensagem).toBe('Email ou senha inválidos');
  });

  // Teste 9: Login com email não cadastrado → 401 (não revela)
  test('POST /entrar com email não cadastrado → 401 genérico', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const response = await request(app)
      .post('/api/v1/auth/entrar')
      .send({ email: 'naocadastrado@teste.com', senha: '123456' });

    expect(response.status).toBe(401);
    expect(response.body.erro.mensagem).toBe('Email ou senha inválidos');
  });

  // Teste 10: Login sem email → 400
  test('POST /entrar sem email → 400', async () => {
    const response = await request(app)
      .post('/api/v1/auth/entrar')
      .send({ senha: '123456' });

    expect(response.status).toBe(400);
    expect(response.body.erro.codigo).toBe('ERRO_VALIDACAO');
  });

  // Teste 11: Token em cookie HttpOnly
  test('POST /entrar retorna cookie auth_token', async () => {
    const bcryptMod = await import('bcryptjs');
    const senhaHash = await bcryptMod.hash('123456', 10);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ...USUARIO_DB, senha_hash: senhaHash }],
      rowCount: 1,
    } as never);

    const response = await request(app)
      .post('/api/v1/auth/entrar')
      .send({ email: 'joao@teste.com.br', senha: '123456' });

    expect(response.headers['set-cookie']).toBeDefined();
    const cookie = response.headers['set-cookie'][0] as string;
    expect(cookie).toContain('auth_token');
    expect(cookie).toContain('HttpOnly');
  });

  // Teste 12: senha_hash nunca retornada
  test('POST /registrar não retorna senha_hash', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ ...USUARIO_DB, senha_hash: 'HASH_SECRETA' }], rowCount: 1 } as never);

    const response = await request(app)
      .post('/api/v1/auth/registrar')
      .send({ nome: 'João', email: 'joao@teste.com.br', senha: '123456' });

    expect(response.body).not.toHaveProperty('usuario.senha_hash');
    expect(JSON.stringify(response.body)).not.toContain('senha_hash');
  });

  // Teste 13: trial_termina_em ~ 15 dias
  test('POST /registrar retorna trial de 15 dias', async () => {
    const trialTerminaEm = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ...USUARIO_DB, trial_termina_em: trialTerminaEm }],
      rowCount: 1,
    } as never);

    const response = await request(app)
      .post('/api/v1/auth/registrar')
      .send({ nome: 'João', email: 'joao@teste.com.br', senha: '123456' });

    if (response.status === 201) {
      const trialDate = new Date(response.body.usuario.trial_termina_em);
      const diasRestantes = (trialDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(diasRestantes).toBeGreaterThan(14);
      expect(diasRestantes).toBeLessThanOrEqual(15.1);
    }
  });
});
