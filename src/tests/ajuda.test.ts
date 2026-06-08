// Testes do chat de suporte com IA (ajuda.routes + ajuda.service)

import request from 'supertest';
import { criarApp } from '../server';

jest.mock('../config/database', () => ({ pool: { query: jest.fn() } }));
jest.mock('../config/redis', () => ({
  redisClient: { connect: jest.fn(), sendCommand: jest.fn() },
  getRedisBullConfig: jest.fn(() => ({ host: 'localhost', port: 6379 })),
}));
jest.mock('bull', () => jest.fn().mockImplementation(() => ({
  add: jest.fn(), process: jest.fn(), on: jest.fn(),
})));
jest.mock('../middleware/rateLimiter', () => ({
  limitadorRegistro: (_req: unknown, _res: unknown, next: () => void) => next(),
  limitadorEntrada:  (_req: unknown, _res: unknown, next: () => void) => next(),
  limitadorWebhook:  (_req: unknown, _res: unknown, next: () => void) => next(),
  criarLimitadorN8n: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Mock do fetch global para simular OpenAI
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const app = criarApp();

function mockOpenAISuccess(content: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  });
}

function mockOpenAIError(status: number, body = 'Erro OpenAI') {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => body,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OPENAI_API_KEY;
});

// ---------------------------------------------------------------------------
// GET /api/v1/ajuda/status
// ---------------------------------------------------------------------------
describe('GET /api/v1/ajuda/status', () => {
  it('disponivel=false quando OPENAI_API_KEY não está configurada', async () => {
    const res = await request(app).get('/api/v1/ajuda/status');
    expect(res.status).toBe(200);
    expect(res.body.disponivel).toBe(false);
  });

  it('disponivel=true quando OPENAI_API_KEY está configurada', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const res = await request(app).get('/api/v1/ajuda/status');
    expect(res.status).toBe(200);
    expect(res.body.disponivel).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/ajuda/chat — validações
// ---------------------------------------------------------------------------
describe('POST /api/v1/ajuda/chat — validações', () => {
  it('400 quando mensagem ausente', async () => {
    const res = await request(app).post('/api/v1/ajuda/chat').send({});
    expect(res.status).toBe(400);
    expect(res.body.sucesso).toBe(false);
  });

  it('400 quando mensagem é string vazia', async () => {
    const res = await request(app).post('/api/v1/ajuda/chat').send({ mensagem: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.sucesso).toBe(false);
  });

  it('400 quando mensagem excede 1000 caracteres', async () => {
    const res = await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'a'.repeat(1001) });
    expect(res.status).toBe(400);
    expect(res.body.sucesso).toBe(false);
  });

  it('503 quando OPENAI_API_KEY não está configurada', async () => {
    const res = await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'Como funciona o relay?' });
    expect(res.status).toBe(503);
    expect(res.body.sucesso).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/ajuda/chat — sucesso
// ---------------------------------------------------------------------------
describe('POST /api/v1/ajuda/chat — sucesso', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  it('retorna resposta da IA com sucesso', async () => {
    mockOpenAISuccess('O relay funciona assim: você configura grupos de origem e destino...');
    const res = await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'Como funciona o relay?' });

    expect(res.status).toBe(200);
    expect(res.body.sucesso).toBe(true);
    expect(typeof res.body.resposta).toBe('string');
    expect(res.body.resposta.length).toBeGreaterThan(0);
  });

  it('passa o histórico corretamente para a IA', async () => {
    mockOpenAISuccess('Sim, funciona 24h!');
    const res = await request(app)
      .post('/api/v1/ajuda/chat')
      .send({
        mensagem: 'E quando meu celular está desligado?',
        historico: [
          { role: 'user', content: 'O relay funciona sempre?' },
          { role: 'assistant', content: 'Sim, o relay funciona no servidor.' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.sucesso).toBe(true);

    // Verifica que o fetch foi chamado com o histórico
    const chamada = JSON.parse(mockFetch.mock.calls[0][1].body);
    const roles = chamada.messages.map((m: { role: string }) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    expect(roles).toContain('system');
  });

  it('usa o modelo correto (padrão gpt-4o-mini)', async () => {
    mockOpenAISuccess('Resposta qualquer');
    await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'Teste' });

    const chamada = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(chamada.model).toBe('gpt-4o-mini');
  });

  it('usa modelo customizado via OPENAI_MODEL', async () => {
    process.env.OPENAI_MODEL = 'gpt-4o';
    mockOpenAISuccess('Resposta qualquer');
    await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'Teste' });

    const chamada = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(chamada.model).toBe('gpt-4o');
    delete process.env.OPENAI_MODEL;
  });

  it('temperature=0.4 e max_tokens=600', async () => {
    mockOpenAISuccess('ok');
    await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'Teste' });

    const chamada = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(chamada.temperature).toBe(0.4);
    expect(chamada.max_tokens).toBe(600);
  });

  it('system prompt contém "OfertaRelay"', async () => {
    mockOpenAISuccess('ok');
    await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'Teste' });

    const chamada = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMsg = chamada.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMsg?.content).toContain('OfertaRelay');
  });

  it('system prompt contém "relay"', async () => {
    mockOpenAISuccess('ok');
    await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'Teste' });

    const chamada = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMsg = chamada.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMsg?.content.toLowerCase()).toContain('relay');
  });

  it('limita histórico a 10 entradas', async () => {
    mockOpenAISuccess('ok');
    const historico = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant' as 'user' | 'assistant',
      content: `Mensagem ${i}`,
    }));

    await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'Última mensagem', historico });

    const chamada = JSON.parse(mockFetch.mock.calls[0][1].body);
    // system (1) + histórico limitado (10) + mensagem atual (1) = 12
    expect(chamada.messages.length).toBeLessThanOrEqual(12);
  });

  it('ignora entradas de histórico com role inválido', async () => {
    mockOpenAISuccess('ok');
    await request(app)
      .post('/api/v1/ajuda/chat')
      .send({
        mensagem: 'Teste',
        historico: [
          { role: 'invalid', content: 'não deve aparecer' },
          { role: 'user', content: 'mensagem válida' },
        ],
      });

    const chamada = JSON.parse(mockFetch.mock.calls[0][1].body);
    const historicoPassado = chamada.messages.filter(
      (m: { role: string; content: string }) => m.role !== 'system' && m.content !== 'Teste',
    );
    expect(historicoPassado.every((m: { role: string }) => ['user', 'assistant'].includes(m.role))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/ajuda/chat — erros da OpenAI
// ---------------------------------------------------------------------------
describe('POST /api/v1/ajuda/chat — erros OpenAI', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  it('500 em erro 4xx da OpenAI', async () => {
    mockOpenAIError(429, 'Rate limit exceeded');
    const res = await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'Teste' });

    expect(res.status).toBe(500);
    expect(res.body.sucesso).toBe(false);
  });

  it('500 quando OpenAI retorna choices vazio', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [] }),
    });

    const res = await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'Teste' });

    expect(res.status).toBe(500);
    expect(res.body.sucesso).toBe(false);
  });

  it('500 quando OpenAI retorna content null', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null } }] }),
    });

    const res = await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'Teste' });

    expect(res.status).toBe(500);
    expect(res.body.sucesso).toBe(false);
  });

  it('500 quando fetch lança erro de rede', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const res = await request(app)
      .post('/api/v1/ajuda/chat')
      .send({ mensagem: 'Teste' });

    expect(res.status).toBe(500);
    expect(res.body.sucesso).toBe(false);
  });
});
