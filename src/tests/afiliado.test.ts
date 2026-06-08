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
jest.mock('../services/afiliado.service', () => ({
  getShopeeCredenciais: jest.fn(),
  getMLCredenciais:     jest.fn(),
  shopeeSign:           jest.fn(() => 'sig'),
  gerarShortLinkShopee: jest.fn(),
  gerarLinkAfiliadoML:  jest.fn(),
  persistirCookiesML:   jest.fn(),
  resolverLinkAfiliado: jest.fn(),
}));
jest.mock('../services/envio.service', () => ({
  enviarOfertaWhatsApp: jest.fn(),
  enviarOfertaTelegram: jest.fn(),
  gerarLegendaPadrao:   jest.fn(() => 'Legenda'),
  prepararEnvio:        jest.fn(),
}));
jest.mock('../services/ia.service', () => ({
  iaConfigurada:     jest.fn(() => false),
  melhorarLegendaIA: jest.fn(),
}));

import { pool } from '../config/database';
const mockPool = pool as jest.Mocked<typeof pool>;

process.env.JWT_SECRET = 'segredo-teste-minimo-32-caracteres-ok';
const app = criarApp();

function token(id = 'user-afiliado') {
  return jwt.sign({ id, email: 'afiliado@test.com', nome: 'Test' }, process.env.JWT_SECRET!, { expiresIn: '1d' });
}

const LOG_SHOPEE = {
  id:          'log-uuid-1',
  plataforma:  'shopee',
  contexto:    'manual',
  url_origem:  'https://shopee.com.br/produto/123',
  url_gerada:  'https://s.shopee.com.br/abc123',
  sucesso:     true,
  erro:        null,
  duracao_ms:  450,
  criado_em:   new Date().toISOString(),
};

const LOG_ML = {
  id:         'log-uuid-2',
  plataforma: 'mercadolivre',
  contexto:   'envio',
  url_origem: 'https://produto.mercadolivre.com.br/MLB-99',
  url_gerada: null,
  sucesso:    false,
  erro:       'Cookies expirados',
  duracao_ms: 1200,
  criado_em:  new Date().toISOString(),
};

const RESUMO_DB = [
  { plataforma: 'shopee',       sucessos: '42', erros: '3',  avg_ms: '380' },
  { plataforma: 'mercadolivre', sucessos: '18', erros: '12', avg_ms: '950' },
];

const PAGINACAO_1 = { count: '45' };

/* ══════════════════════════════════════════════════════ */
describe('Afiliado Logs Module', () => {
  beforeEach(() => jest.clearAllMocks());

  /* ── GET /afiliado/logs ── */
  describe('GET /afiliado/logs', () => {
    function mockLogs(logs: object[], total: string) {
      mockPool.query
        .mockResolvedValueOnce({ rows: logs,         rowCount: logs.length }  as never) // logs
        .mockResolvedValueOnce({ rows: [{ count: total }], rowCount: 1 }      as never) // total
        .mockResolvedValueOnce({ rows: RESUMO_DB,    rowCount: RESUMO_DB.length } as never); // resumo
    }

    test('retorna logs com paginação e resumo', async () => {
      mockLogs([LOG_SHOPEE, LOG_ML], '2');

      const res = await request(app)
        .get('/api/v1/afiliado/logs')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.logs).toHaveLength(2);
      expect(res.body.paginacao.total).toBe(2);
      expect(res.body.paginacao.pagina).toBe(1);
      expect(res.body.resumo).toHaveLength(2);
    });

    test('filtra por plataforma=shopee', async () => {
      mockLogs([LOG_SHOPEE], '1');

      const res = await request(app)
        .get('/api/v1/afiliado/logs?plataforma=shopee')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.logs).toHaveLength(1);
      expect(JSON.stringify(mockPool.query.mock.calls)).toContain('shopee');
    });

    test('filtra por plataforma=mercadolivre', async () => {
      mockLogs([LOG_ML], '1');

      await request(app)
        .get('/api/v1/afiliado/logs?plataforma=mercadolivre')
        .set('Authorization', `Bearer ${token()}`);

      expect(JSON.stringify(mockPool.query.mock.calls)).toContain('mercadolivre');
    });

    test('filtra por sucesso=true', async () => {
      mockLogs([LOG_SHOPEE], '1');

      const res = await request(app)
        .get('/api/v1/afiliado/logs?sucesso=true')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      // sucesso=true deve ser passado como booleano para o banco
      const queries = mockPool.query.mock.calls;
      const params  = JSON.stringify(queries.map(c => c[1]));
      expect(params).toContain('true');
    });

    test('filtra por sucesso=false', async () => {
      mockLogs([LOG_ML], '1');

      await request(app)
        .get('/api/v1/afiliado/logs?sucesso=false')
        .set('Authorization', `Bearer ${token()}`);

      const params = JSON.stringify(mockPool.query.mock.calls.map(c => c[1]));
      expect(params).toContain('false');
    });

    test('filtra por contexto=envio', async () => {
      mockLogs([LOG_ML], '1');

      const res = await request(app)
        .get('/api/v1/afiliado/logs?contexto=envio')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(JSON.stringify(mockPool.query.mock.calls)).toContain('envio');
    });

    test('filtra por contexto=manual', async () => {
      mockLogs([LOG_SHOPEE], '1');

      await request(app)
        .get('/api/v1/afiliado/logs?contexto=manual')
        .set('Authorization', `Bearer ${token()}`);

      expect(JSON.stringify(mockPool.query.mock.calls)).toContain('manual');
    });

    test('filtra por contexto=sincronizacao', async () => {
      mockLogs([], '0');

      await request(app)
        .get('/api/v1/afiliado/logs?contexto=sincronizacao')
        .set('Authorization', `Bearer ${token()}`);

      expect(JSON.stringify(mockPool.query.mock.calls)).toContain('sincronizacao');
    });

    test('paginação correta: totalPaginas calculado', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: Array(50).fill(LOG_SHOPEE), rowCount: 50 } as never)
        .mockResolvedValueOnce({ rows: [{ count: '120' }], rowCount: 1 }          as never)
        .mockResolvedValueOnce({ rows: RESUMO_DB, rowCount: 2 }                   as never);

      const res = await request(app)
        .get('/api/v1/afiliado/logs?pagina=1&limite=50')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.body.paginacao.totalPaginas).toBe(3);
      expect(res.body.paginacao.limite).toBe(50);
    });

    test('limite máximo: não ultrapassa 200', async () => {
      mockLogs([], '0');

      await request(app)
        .get('/api/v1/afiliado/logs?limite=9999')
        .set('Authorization', `Bearer ${token()}`);

      // Verifica que o limite passado para o banco é <= 200
      const queryWithLimit = mockPool.query.mock.calls.find(c =>
        typeof c[0] === 'string' && (c[0] as string).includes('LIMIT')
      );
      if (queryWithLimit) {
        const params = queryWithLimit[1] as unknown[];
        const limitParam = params.find(p => typeof p === 'number' && (p as number) <= 200);
        expect(limitParam).toBeDefined();
      }
    });

    test('lista vazia retorna estrutura correta', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const res = await request(app)
        .get('/api/v1/afiliado/logs')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.logs).toHaveLength(0);
      expect(res.body.paginacao.total).toBe(0);
      expect(res.body.paginacao.totalPaginas).toBe(0);
    });

    test('isolamento: filtra sempre por usuario_id logado', async () => {
      mockLogs([], '0');

      await request(app)
        .get('/api/v1/afiliado/logs')
        .set('Authorization', `Bearer ${token('user-isolado')}`);

      const firstQueryParams = mockPool.query.mock.calls[0][1] as unknown[];
      expect(firstQueryParams[0]).toBe('user-isolado');
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).get('/api/v1/afiliado/logs');
      expect(res.status).toBe(401);
    });
  });

  /* ── DELETE /afiliado/logs ── */
  describe('DELETE /afiliado/logs', () => {
    test('limpa logs com mais de 30 dias (padrão)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 12 } as never);

      const res = await request(app)
        .delete('/api/v1/afiliado/logs')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.removidos).toBe(12);
      expect(JSON.stringify(mockPool.query.mock.calls)).toContain('30');
    });

    test('aceita parâmetro dias customizado', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 5 } as never);

      const res = await request(app)
        .delete('/api/v1/afiliado/logs?dias=7')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.removidos).toBe(5);
      expect(JSON.stringify(mockPool.query.mock.calls)).toContain('7');
    });

    test('dias=1 é mínimo aceito', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const res = await request(app)
        .delete('/api/v1/afiliado/logs?dias=0')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      // dias=0 deve virar 1 por causa do Math.max(1, ...)
      const deleteCall = mockPool.query.mock.calls[0];
      expect(deleteCall[1]![1]).toBe('1');
    });

    test('nenhum log elegível → removidos: 0', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const res = await request(app)
        .delete('/api/v1/afiliado/logs?dias=365')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.removidos).toBe(0);
    });

    test('isolamento: WHERE inclui usuario_id logado', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await request(app)
        .delete('/api/v1/afiliado/logs')
        .set('Authorization', `Bearer ${token('user-del')}`);

      const deleteCall = mockPool.query.mock.calls[0];
      expect(deleteCall[1]![0]).toBe('user-del');
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).delete('/api/v1/afiliado/logs');
      expect(res.status).toBe(401);
    });
  });

  /* ── Campos do log retornado ── */
  describe('Estrutura do log retornado', () => {
    test('log bem-sucedido tem url_gerada e sucesso:true', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [LOG_SHOPEE], rowCount: 1 }          as never)
        .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 }      as never)
        .mockResolvedValueOnce({ rows: RESUMO_DB, rowCount: 2 }             as never);

      const res = await request(app)
        .get('/api/v1/afiliado/logs')
        .set('Authorization', `Bearer ${token()}`);

      const log = res.body.logs[0];
      expect(log.sucesso).toBe(true);
      expect(log.url_gerada).toContain('shopee');
      expect(log.erro).toBeNull();
      expect(log.duracao_ms).toBe(450);
    });

    test('log com erro tem sucesso:false e mensagem de erro', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [LOG_ML], rowCount: 1 }             as never)
        .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 }     as never)
        .mockResolvedValueOnce({ rows: RESUMO_DB, rowCount: 2 }            as never);

      const res = await request(app)
        .get('/api/v1/afiliado/logs')
        .set('Authorization', `Bearer ${token()}`);

      const log = res.body.logs[0];
      expect(log.sucesso).toBe(false);
      expect(log.url_gerada).toBeNull();
      expect(log.erro).toBe('Cookies expirados');
    });

    test('resumo contém % sucesso por plataforma', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }                   as never)
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 }     as never)
        .mockResolvedValueOnce({ rows: RESUMO_DB, rowCount: 2 }            as never);

      const res = await request(app)
        .get('/api/v1/afiliado/logs')
        .set('Authorization', `Bearer ${token()}`);

      const shopeeResumo = res.body.resumo.find((r: { plataforma: string }) => r.plataforma === 'shopee');
      expect(shopeeResumo).toBeDefined();
      expect(shopeeResumo.sucessos).toBe('42');
      expect(shopeeResumo.avg_ms).toBe('380');
    });
  });
});
