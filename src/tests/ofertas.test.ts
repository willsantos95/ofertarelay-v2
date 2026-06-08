import request from 'supertest';
import jwt from 'jsonwebtoken';
import { criarApp } from '../server';

/* ── mocks globais ── */
jest.mock('../config/database', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../config/redis', () => ({
  redisClient: { connect: jest.fn(), sendCommand: jest.fn() },
  getRedisBullConfig: jest.fn(() => ({ host: 'localhost', port: 6379 })),
}));
jest.mock('../middleware/rateLimiter', () => ({
  limitadorRegistro: (_: unknown, __: unknown, next: () => void) => next(),
  limitadorEntrada:  (_: unknown, __: unknown, next: () => void) => next(),
  limitadorWebhook:  (_: unknown, __: unknown, next: () => void) => next(),
  criarLimitadorN8n: () => (_: unknown, __: unknown, next: () => void) => next(),
}));
jest.mock('bull', () => jest.fn().mockImplementation(() => ({
  add: jest.fn(), process: jest.fn(), on: jest.fn(),
})));

/* ── mocks dos serviços externos ── */
jest.mock('../services/afiliado.service', () => ({
  getShopeeCredenciais:  jest.fn(),
  getMLCredenciais:      jest.fn(),
  shopeeSign:            jest.fn(() => 'mock-sig'),
  gerarShortLinkShopee:  jest.fn(),
  gerarLinkAfiliadoML:   jest.fn(),
  persistirCookiesML:    jest.fn(),
  resolverLinkAfiliado:  jest.fn(),
}));
jest.mock('../services/envio.service', () => ({
  enviarOfertaWhatsApp: jest.fn(),
  enviarOfertaTelegram: jest.fn(),
  gerarLegendaPadrao:   jest.fn(() => 'Legenda padrão'),
  prepararEnvio:        jest.fn(),
}));
jest.mock('../services/ia.service', () => ({
  iaConfigurada:    jest.fn(() => true),
  melhorarLegendaIA: jest.fn(),
}));

import { pool } from '../config/database';
import * as afiliadoService from '../services/afiliado.service';
import * as envioService    from '../services/envio.service';
import * as iaService       from '../services/ia.service';

const mockPool      = pool                   as jest.Mocked<typeof pool>;
const mockAfiliado  = afiliadoService        as jest.Mocked<typeof afiliadoService>;
const mockEnvio     = envioService           as jest.Mocked<typeof envioService>;
const mockIa        = iaService              as jest.Mocked<typeof iaService>;

process.env.JWT_SECRET = 'segredo-teste-minimo-32-caracteres-ok';
const app = criarApp();

function token(id = 'user-test') {
  return jwt.sign({ id, email: 'test@test.com', nome: 'Test' }, process.env.JWT_SECRET!, { expiresIn: '1d' });
}

const OFERTA_DB = {
  id: 'oferta-uuid-1',
  item_id: 'shopee-item-123',
  nome: 'Fone JBL Tune 520BT',
  preco: 189.90,
  preco_original: null,
  desconto_pct: 25,
  imagem_url: 'https://cf.shopee.com.br/file/img.jpg',
  link_produto: 'https://shopee.com.br/produto/123',
  link_afiliado: 'https://s.shopee.com.br/abc123',
  comissao: 18.99,
  taxa_comissao: 0.10,
  categoria_nome: 'Eletrônicos',
  plataforma: 'shopee',
  status: 'pendente',
  criado_em: new Date().toISOString(),
};

/* ══════════════════════════════════════════════════════ */
describe('Ofertas Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockIa.iaConfigurada as jest.Mock).mockReturnValue(true);
  });

  /* ── GET /ofertas ── */
  describe('GET /ofertas', () => {
    test('retorna lista paginada de ofertas', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [OFERTA_DB], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 } as never);

      const res = await request(app)
        .get('/api/v1/ofertas')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.ofertas).toHaveLength(1);
      expect(res.body.ofertas[0].nome).toBe('Fone JBL Tune 520BT');
      expect(res.body.paginacao.total).toBe(1);
    });

    test('filtra por plataforma', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [OFERTA_DB], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 } as never);

      const res = await request(app)
        .get('/api/v1/ofertas?plataforma=shopee')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      const queryCalls = mockPool.query.mock.calls;
      expect(JSON.stringify(queryCalls)).toContain('shopee');
    });

    test('filtra por categoria_nome', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);

      const res = await request(app)
        .get('/api/v1/ofertas?categoria=Eletr%C3%B4nicos')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(JSON.stringify(mockPool.query.mock.calls)).toContain('Eletrônicos');
    });

    test('filtra por status', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);

      await request(app)
        .get('/api/v1/ofertas?status=enviado')
        .set('Authorization', `Bearer ${token()}`);

      expect(JSON.stringify(mockPool.query.mock.calls)).toContain('enviado');
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).get('/api/v1/ofertas');
      expect(res.status).toBe(401);
    });

    test('paginação calcula totalPaginas corretamente', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: Array(24).fill(OFERTA_DB), rowCount: 24 } as never)
        .mockResolvedValueOnce({ rows: [{ count: '60' }], rowCount: 1 } as never);

      const res = await request(app)
        .get('/api/v1/ofertas?pagina=1&limite=24')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.body.paginacao.totalPaginas).toBe(3);
      expect(res.body.paginacao.pagina).toBe(1);
    });
  });

  /* ── GET /ofertas/categorias ── */
  describe('GET /ofertas/categorias', () => {
    test('retorna lista de categorias com contagem', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { nome: 'Eletrônicos', plataforma: 'shopee', total: '42' },
          { nome: 'Beleza',      plataforma: 'shopee', total: '18' },
        ],
        rowCount: 2,
      } as never);

      const res = await request(app)
        .get('/api/v1/ofertas/categorias')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.categorias).toHaveLength(2);
      expect(res.body.categorias[0].nome).toBe('Eletrônicos');
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).get('/api/v1/ofertas/categorias');
      expect(res.status).toBe(401);
    });
  });

  /* ── DELETE /ofertas ── */
  describe('DELETE /ofertas', () => {
    test('deleta todas as ofertas sem filtro', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 15 } as never);

      const res = await request(app)
        .delete('/api/v1/ofertas')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.removidas).toBe(15);
    });

    test('deleta ofertas filtradas por plataforma', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 8 } as never);

      const res = await request(app)
        .delete('/api/v1/ofertas?plataforma=shopee')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.removidas).toBe(8);
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).delete('/api/v1/ofertas');
      expect(res.status).toBe(401);
    });
  });

  /* ── POST /ofertas/sincronizar (Shopee) ── */
  describe('POST /ofertas/sincronizar (Shopee)', () => {
    test('sem credenciais Shopee → 400', async () => {
      (mockAfiliado.getShopeeCredenciais as jest.Mock).mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/v1/ofertas/sincronizar')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(400);
      expect(res.body.erro.mensagem).toContain('App ID');
    });

    test('com credenciais + API mock → retorna resumo', async () => {
      (mockAfiliado.getShopeeCredenciais as jest.Mock).mockResolvedValueOnce({
        appId: 'app123', appSecret: 'secret123',
      });

      // Mock da API Shopee: retorna 1 produto em todas as listas
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            productOfferV2: {
              nodes: [{
                itemId: 'item-1', productName: 'Fone JBL',
                price: '189.90', commissionRate: '0.10', commission: '18.99',
                imageUrl: 'https://img.jpg', productLink: 'https://shopee.com.br/1',
                offerLink: 'https://s.shopee.com.br/abc',
              }],
              pageInfo: { page: 1, limit: 50, hasNextPage: false },
            },
          },
        }),
      }) as jest.Mock;

      // Mock do INSERT no banco
      mockPool.query.mockResolvedValue({ rows: [{ inserido: true }], rowCount: 1 } as never);

      const res = await request(app)
        .post('/api/v1/ofertas/sincronizar')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.plataforma).toBe('shopee');
      expect(res.body).toHaveProperty('totalNovos');
      expect(res.body).toHaveProperty('totalIgnorados');
      expect(res.body).toHaveProperty('detalhes');
      expect(res.body).toHaveProperty('erros');
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).post('/api/v1/ofertas/sincronizar');
      expect(res.status).toBe(401);
    });
  });

  /* ── POST /ofertas/sincronizar/mercadolivre ── */
  describe('POST /ofertas/sincronizar/mercadolivre', () => {
    test('sem credenciais ML → 400', async () => {
      (mockAfiliado.getMLCredenciais as jest.Mock).mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/v1/ofertas/sincronizar/mercadolivre')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(400);
      expect(res.body.erro.mensagem).toContain('Tag');
    });

    test('sem URLs configuradas → 400', async () => {
      (mockAfiliado.getMLCredenciais as jest.Mock).mockResolvedValueOnce({
        tag: 'GT123', cookies: 'cookie=x', urls: [],
      });

      const res = await request(app)
        .post('/api/v1/ofertas/sincronizar/mercadolivre')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(400);
      expect(res.body.erro.mensagem).toContain('URL');
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).post('/api/v1/ofertas/sincronizar/mercadolivre');
      expect(res.status).toBe(401);
    });
  });

  /* ── POST /ofertas/:id/gerar-link-afiliado ── */
  describe('POST /ofertas/:id/gerar-link-afiliado', () => {
    test('oferta não encontrada → 404', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const res = await request(app)
        .post('/api/v1/ofertas/id-inexistente/gerar-link-afiliado')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(404);
    });

    test('Shopee sem credenciais → 400', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...OFERTA_DB, plataforma: 'shopee' }], rowCount: 1,
      } as never);
      (mockAfiliado.getShopeeCredenciais as jest.Mock).mockResolvedValueOnce(null);

      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/gerar-link-afiliado`)
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(400);
      expect(res.body.erro.mensagem).toContain('App ID');
    });

    test('Shopee com credenciais → retorna shortLink', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...OFERTA_DB, plataforma: 'shopee' }], rowCount: 1,
      } as never);
      (mockAfiliado.getShopeeCredenciais as jest.Mock).mockResolvedValueOnce({ appId: 'id', appSecret: 'sec' });
      (mockAfiliado.gerarShortLinkShopee as jest.Mock).mockResolvedValueOnce('https://s.shopee.com.br/novo');

      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/gerar-link-afiliado`)
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.linkAfiliado).toBe('https://s.shopee.com.br/novo');
    });

    test('Shopee API falha → sucesso: false com link original', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...OFERTA_DB, plataforma: 'shopee' }], rowCount: 1,
      } as never);
      (mockAfiliado.getShopeeCredenciais as jest.Mock).mockResolvedValueOnce({ appId: 'id', appSecret: 'sec' });
      (mockAfiliado.gerarShortLinkShopee as jest.Mock).mockResolvedValueOnce(null); // falha silenciosa

      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/gerar-link-afiliado`)
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(false);
      expect(res.body.linkAfiliado).toBe(OFERTA_DB.link_afiliado); // fallback
    });

    test('ML com credenciais → retorna shortUrl', async () => {
      const ofertaML = { ...OFERTA_DB, plataforma: 'mercadolivre', link_produto: 'https://produto.mercadolivre.com.br/MLB-99' };
      mockPool.query.mockResolvedValueOnce({ rows: [ofertaML], rowCount: 1 } as never);
      (mockAfiliado.getMLCredenciais as jest.Mock).mockResolvedValueOnce({
        tag: 'GT123', cookies: 'cookie=x', urls: [],
      });
      (mockAfiliado.gerarLinkAfiliadoML as jest.Mock).mockResolvedValueOnce({
        shortUrl: 'https://meli.la/novo', cookiesAtualizados: 'cookie=x',
      });

      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/gerar-link-afiliado`)
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.linkAfiliado).toBe('https://meli.la/novo');
    });

    test('oferta sem URL de produto → 400', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...OFERTA_DB, link_produto: null, link_afiliado: null }], rowCount: 1,
      } as never);

      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/gerar-link-afiliado`)
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(400);
      expect(res.body.erro.mensagem).toContain('URL');
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).post(`/api/v1/ofertas/${OFERTA_DB.id}/gerar-link-afiliado`);
      expect(res.status).toBe(401);
    });
  });

  /* ── POST /ofertas/:id/legenda-ia ── */
  describe('POST /ofertas/:id/legenda-ia', () => {
    test('IA não configurada → 400', async () => {
      (mockIa.iaConfigurada as jest.Mock).mockReturnValueOnce(false);

      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/legenda-ia`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ legenda: 'Legenda atual' });

      expect(res.status).toBe(400);
      expect(res.body.erro.mensagem).toContain('IA');
    });

    test('legenda ausente no body → 400', async () => {
      (mockIa.iaConfigurada as jest.Mock).mockReturnValueOnce(true);

      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/legenda-ia`)
        .set('Authorization', `Bearer ${token()}`)
        .send({});

      expect(res.status).toBe(400);
    });

    test('oferta não encontrada → 404', async () => {
      (mockIa.iaConfigurada as jest.Mock).mockReturnValueOnce(true);
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const res = await request(app)
        .post(`/api/v1/ofertas/id-invalido/legenda-ia`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ legenda: 'Legenda' });

      expect(res.status).toBe(404);
    });

    test('IA retorna legenda melhorada', async () => {
      (mockIa.iaConfigurada as jest.Mock).mockReturnValueOnce(true);
      mockPool.query.mockResolvedValueOnce({ rows: [OFERTA_DB], rowCount: 1 } as never);
      (mockIa.melhorarLegendaIA as jest.Mock).mockResolvedValueOnce('🔥 Corre! Fone JBL por R$ 189,90!');

      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/legenda-ia`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ legenda: 'Fone JBL R$ 189,90 https://s.shopee.com.br/abc' });

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.legenda).toContain('🔥');
    });

    test('IA falha → 500 com mensagem', async () => {
      (mockIa.iaConfigurada as jest.Mock).mockReturnValueOnce(true);
      mockPool.query.mockResolvedValueOnce({ rows: [OFERTA_DB], rowCount: 1 } as never);
      (mockIa.melhorarLegendaIA as jest.Mock).mockRejectedValueOnce(new Error('OpenAI timeout'));

      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/legenda-ia`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ legenda: 'Legenda atual' });

      expect(res.status).toBe(500);
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).post(`/api/v1/ofertas/${OFERTA_DB.id}/legenda-ia`);
      expect(res.status).toBe(401);
    });
  });

  /* ── POST /ofertas/:id/enviar-whatsapp ── */
  describe('POST /ofertas/:id/enviar-whatsapp', () => {
    test('envio bem-sucedido → 200', async () => {
      (mockEnvio.enviarOfertaWhatsApp as jest.Mock).mockResolvedValueOnce({ sucesso: true, enviados: 2, erros: [] });

      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/enviar-whatsapp`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ legenda: 'Legenda da oferta https://s.shopee.com.br/abc', grupos: ['group1', 'group2'] });

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
    });

    test('sem legenda → 400', async () => {
      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/enviar-whatsapp`)
        .set('Authorization', `Bearer ${token()}`)
        .send({});

      expect(res.status).toBe(400);
    });

    test('envio com erro do Evolution API → retorna detalhes', async () => {
      (mockEnvio.enviarOfertaWhatsApp as jest.Mock).mockResolvedValueOnce({
        sucesso: false, enviados: 0, erros: ['WhatsApp não conectado'],
      });

      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/enviar-whatsapp`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ legenda: 'Legenda https://s.shopee.com.br/abc' });

      expect(res.status).toBe(200);
      expect(res.body.erros).toHaveLength(1);
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).post(`/api/v1/ofertas/${OFERTA_DB.id}/enviar-whatsapp`);
      expect(res.status).toBe(401);
    });
  });

  /* ── POST /ofertas/:id/enviar-telegram ── */
  describe('POST /ofertas/:id/enviar-telegram', () => {
    test('envio Telegram bem-sucedido → 200', async () => {
      (mockEnvio.enviarOfertaTelegram as jest.Mock).mockResolvedValueOnce({ sucesso: true, enviados: 1, erros: [] });

      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/enviar-telegram`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ legenda: 'Legenda https://s.shopee.com.br/abc' });

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
    });

    test('sem legenda → 400', async () => {
      const res = await request(app)
        .post(`/api/v1/ofertas/${OFERTA_DB.id}/enviar-telegram`)
        .set('Authorization', `Bearer ${token()}`)
        .send({});

      expect(res.status).toBe(400);
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).post(`/api/v1/ofertas/${OFERTA_DB.id}/enviar-telegram`);
      expect(res.status).toBe(401);
    });
  });
});
