import request from 'supertest';
import jwt from 'jsonwebtoken';

jest.mock('../config/database', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../config/redis', () => ({ redisClient: { connect: jest.fn(), sendCommand: jest.fn() }, getRedisBullConfig: jest.fn(() => ({ host: 'localhost', port: 6379 })) }));
jest.mock('../middleware/rateLimiter', () => ({
  limitadorRegistro: (_: unknown, __: unknown, next: () => void) => next(),
  limitadorEntrada:  (_: unknown, __: unknown, next: () => void) => next(),
  limitadorWebhook:  (_: unknown, __: unknown, next: () => void) => next(),
  criarLimitadorN8n: () => (_: unknown, __: unknown, next: () => void) => next(),
}));
jest.mock('bull', () => jest.fn().mockImplementation(() => ({ add: jest.fn(), process: jest.fn(), on: jest.fn(), getJob: jest.fn() })));

import { pool } from '../config/database';
import { criarApp } from '../server';
import { criptografar, descriptografar } from '../utils/cripto';
import { calcularPlanoAtivo } from '../services/plano.service';
import { normalizarSlug, validarSlug, urlSegura } from '../services/landing.service';
import { detectarLoja, gerarLinkMagalu, assinarAliExpress } from '../services/linkRelay.service';
import { renderizarLanding } from '../services/landingHtml';

const mockPool = pool as jest.Mocked<typeof pool>;
process.env.JWT_SECRET = 'segredo-teste-minimo-32-caracteres-ok';
const app = criarApp();

function token() {
  return jwt.sign({ id: 'user-id', email: 'test@test.com', nome: 'Test' }, process.env.JWT_SECRET!, { expiresIn: '1d' });
}

describe('Segredos mascarados não sobrescrevem o valor salvo', () => {
  beforeEach(() => jest.clearAllMocks());

  test('PUT /settings/affiliate com ***abcd mantém o App Secret real', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ payload: { shopee: { appId: 'app', appSecret: 'segredo-real' } } }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const res = await request(app)
      .put('/api/v1/settings/affiliate')
      .set('Authorization', `Bearer ${token()}`)
      .send({ shopee: { appId: 'app', appSecret: '***real' } });

    expect(res.status).toBe(200);
    const gravado = JSON.parse(mockPool.query.mock.calls[1][1]![2] as string);
    expect(gravado.shopee.appSecret).toBe('segredo-real');
  });

  test('PUT /settings/telegram sem trocar o token mantém o token salvo', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ payload: { botToken: '123:ABC', chatIds: ['1'], status: 'active' } }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const res = await request(app)
      .put('/api/v1/settings/telegram')
      .set('Authorization', `Bearer ${token()}`)
      .send({ botToken: '***:ABC', chatIds: ['1', '2'], status: 'active' });

    expect(res.status).toBe(200);
    const gravado = JSON.parse(mockPool.query.mock.calls[1][1]![2] as string);
    expect(gravado.botToken).toBe('123:ABC');
    expect(gravado.chatIds).toEqual(['1', '2']);
  });
});

describe('Rotas do n8n exigem chave quando N8N_API_KEY está definida', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => { delete process.env.N8N_API_KEY; });

  test('sem header → 401', async () => {
    process.env.N8N_API_KEY = 'chave-n8n';
    const res = await request(app).get('/api/n8n/settings?instance=x');
    expect(res.status).toBe(401);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('com header certo → segue (404 para instância inexistente)', async () => {
    process.env.N8N_API_KEY = 'chave-n8n';
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await request(app).get('/api/n8n/settings?instance=x').set('x-n8n-key', 'chave-n8n');
    expect(res.status).toBe(404);
  });

  test('sem N8N_API_KEY configurada → compatível (segue sem header)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await request(app).get('/api/n8n/groups?instance=x');
    expect(res.status).toBe(404);
  });

  test('settings devolve plano e configuração do relay', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ user_id: 'u', name: 'W', email: 'w@x.com', plan_status: 'trial', trial_ends_at: new Date(Date.now() - 1000), instance_name: 'i', phone: '1', instance_status: 'open' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ tipo: 'relay', payload: { cabecalho: '🦫 CAPIVARA', intervaloEnvioSeg: 8 } }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await request(app).get('/api/n8n/settings?instance=i');
    expect(res.status).toBe(200);
    expect(res.body.user.plan_ok).toBe(false);
    expect(res.body.settings.branding.header).toBe('🦫 CAPIVARA');
    expect(res.body.settings.relay.intervaloEnvioSeg).toBe(8);
  });

  test('affiliate-link com loja desconhecida → success false, code loja_desconhecida', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ user_id: 'u', email: 'w@x.com' }], rowCount: 1 } as never);
    global.fetch = jest.fn().mockResolvedValue({ status: 200, headers: { get: () => null } }) as jest.Mock;
    const res = await request(app).post('/api/n8n/affiliate-link').send({ instance: 'i', url: 'https://exemplo.com/produto' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('loja_desconhecida');
  });
});

describe('Funções auxiliares', () => {
  test('criptografia ida e volta, e texto puro passa direto', () => {
    process.env.CHAVE_CRIPTOGRAFIA = 'uma-chave-qualquer';
    const c = criptografar('segredo');
    expect(c.startsWith('enc:v1:')).toBe(true);
    expect(descriptografar(c)).toBe('segredo');
    expect(descriptografar('texto-antigo')).toBe('texto-antigo');
    delete process.env.CHAVE_CRIPTOGRAFIA;
    expect(criptografar('x')).toBe('x');
  });

  test('plano: trial vencido é inativo, ativo é ativo', () => {
    expect(calcularPlanoAtivo('trial', new Date(Date.now() + 86400000))).toBe(true);
    expect(calcularPlanoAtivo('trial', new Date(Date.now() - 1000))).toBe(false);
    expect(calcularPlanoAtivo('ativo', null)).toBe(true);
    expect(calcularPlanoAtivo('cancelado', null)).toBe(false);
  });

  test('slug: normaliza, recusa reservado e curto', () => {
    expect(normalizarSlug('Capivara Ofertas!')).toBe('capivara-ofertas');
    expect(validarSlug('capivaraofertas')).toBeNull();
    expect(validarSlug('login')).not.toBeNull();
    expect(validarSlug('ab')).not.toBeNull();
  });

  test('url do botão: só http(s)', () => {
    expect(urlSegura('https://chat.whatsapp.com/abc')).toBe('https://chat.whatsapp.com/abc');
    expect(urlSegura('javascript:alert(1)')).toBeNull();
    expect(urlSegura('https://user:pass@x.com')).toBeNull();
  });

  test('lojas e Magalu', () => {
    expect(detectarLoja('https://s.shopee.com.br/abc')).toBe('shopee');
    expect(detectarLoja('https://meli.la/1')).toBe('mercado_livre');
    expect(detectarLoja('https://amzn.to/x')).toBe('amazon');
    expect(gerarLinkMagalu('https://www.magazinevoce.com.br/outraloja/produto/p/abc/', 'minhaloja'))
      .toBe('https://www.magazinevoce.com.br/minhaloja/produto/p/abc/');
  });

  test('assinatura AliExpress é estável e em maiúsculas', () => {
    const s = assinarAliExpress({ b: '2', a: '1' }, 'k');
    expect(s).toMatch(/^[0-9A-F]{64}$/);
    expect(s).toBe(assinarAliExpress({ a: '1', b: '2' }, 'k'));
  });

  test('landing HTML escapa texto do usuário', () => {
    const html = renderizarLanding({
      id: '1', usuario_id: 'u', slug: 'capivara', titulo: '<script>x</script>', descricao: 'd', cor: '#16a34a',
      publicada: true, tem_imagem: false, imagem_atualizada_em: null, visitas: 0,
      botoes: [{ id: 'b1', rotulo: 'Entrar', url: 'https://chat.whatsapp.com/a', tipo: 'whatsapp_grupo', ativo: true }],
    }, { baseApi: 'https://x.com/api/v1', urlPagina: 'https://x.com/capivara' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('/public/l/capivara/b1');
  });
});

describe('Landing page', () => {
  beforeEach(() => jest.clearAllMocks());

  test('PUT /landing recusa slug reservado', async () => {
    const res = await request(app)
      .put('/api/v1/landing')
      .set('Authorization', `Bearer ${token()}`)
      .send({ slug: 'login', titulo: 'X', botoes: [] });
    expect(res.status).toBe(400);
  });

  test('PUT /landing recusa botão com link inválido', async () => {
    const res = await request(app)
      .put('/api/v1/landing')
      .set('Authorization', `Bearer ${token()}`)
      .send({ slug: 'capivaraofertas', titulo: 'Capivara', botoes: [{ rotulo: 'Grupo', url: 'javascript:1' }] });
    expect(res.status).toBe(400);
  });

  test('GET /public/l/:slug/:id redireciona para o link do botão', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ url: 'https://chat.whatsapp.com/abc' }], rowCount: 1 } as never);
    const res = await request(app).get('/api/v1/public/l/capivaraofertas/11111111-1111-1111-1111-111111111111');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://chat.whatsapp.com/abc');
  });

  test('GET /public/p/:slug inexistente → 404 em HTML', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const res = await request(app).get('/api/v1/public/p/naoexiste');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
  });
});
