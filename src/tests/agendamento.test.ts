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
jest.mock('../services/envio.service', () => ({
  enviarOfertaWhatsApp: jest.fn(),
  enviarOfertaTelegram: jest.fn(),
  gerarLegendaPadrao:   jest.fn(() => 'Legenda padrão gerada'),
  prepararEnvio:        jest.fn(),
}));
jest.mock('../services/afiliado.service', () => ({
  getShopeeCredenciais: jest.fn(),
  getMLCredenciais:     jest.fn(),
  shopeeSign:           jest.fn(() => 'sig'),
  gerarShortLinkShopee: jest.fn(),
  gerarLinkAfiliadoML:  jest.fn(),
  persistirCookiesML:   jest.fn(),
  resolverLinkAfiliado: jest.fn(),
}));
jest.mock('../services/ia.service', () => ({
  iaConfigurada:     jest.fn(() => false),
  melhorarLegendaIA: jest.fn(),
}));

import { pool } from '../config/database';
const mockPool = pool as jest.Mocked<typeof pool>;

process.env.JWT_SECRET = 'segredo-teste-minimo-32-caracteres-ok';
const app = criarApp();

function token(id = 'user-agenda') {
  return jwt.sign({ id, email: 'agenda@test.com', nome: 'Test' }, process.env.JWT_SECRET!, { expiresIn: '1d' });
}

const CONFIG_DB = {
  usuario_id:      'user-agenda',
  intervalo_min:   7,
  ativo:           false,
  grupos:          [],
  enviar_telegram: false,
  proximo_envio_em: null,
};

const ITEM_DB = {
  id:          'item-uuid-1',
  oferta_id:   'oferta-uuid-1',
  legenda:     'Legenda do item da fila',
  status:      'pendente',
  enviado_em:  null,
  erro:        null,
  criado_em:   new Date().toISOString(),
  nome:        'Fone JBL',
  preco:       189.90,
  imagem_url:  'https://img.jpg',
  plataforma:  'shopee',
  desconto_pct: 25,
};

/* ══════════════════════════════════════════════════════ */
describe('Agendamento Module', () => {
  beforeEach(() => jest.clearAllMocks());

  /* ── GET /agendamento/config ── */
  describe('GET /agendamento/config', () => {
    test('retorna configuração existente', async () => {
      // obterOuCriarConfig: INSERT ON CONFLICT + SELECT
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // INSERT ON CONFLICT
        .mockResolvedValueOnce({ rows: [CONFIG_DB], rowCount: 1 } as never); // SELECT

      const res = await request(app)
        .get('/api/v1/agendamento/config')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.config.intervalo_min).toBe(7);
      expect(res.body.config.ativo).toBe(false);
    });

    test('cria config padrão se não existir', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // INSERT cria
        .mockResolvedValueOnce({ rows: [CONFIG_DB], rowCount: 1 } as never);

      const res = await request(app)
        .get('/api/v1/agendamento/config')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.config).toHaveProperty('intervalo_min');
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).get('/api/v1/agendamento/config');
      expect(res.status).toBe(401);
    });
  });

  /* ── PUT /agendamento/config ── */
  describe('PUT /agendamento/config', () => {
    test('salva configuração válida', async () => {
      // obterOuCriarConfig: INSERT + SELECT
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [CONFIG_DB], rowCount: 1 } as never)
        // UPDATE RETURNING
        .mockResolvedValueOnce({
          rows: [{ ...CONFIG_DB, intervalo_min: 10, ativo: true, grupos: ['g1', 'g2'] }],
          rowCount: 1,
        } as never);

      const res = await request(app)
        .put('/api/v1/agendamento/config')
        .set('Authorization', `Bearer ${token()}`)
        .send({ intervalo_min: 10, ativo: true, grupos: ['g1', 'g2'], enviar_telegram: false });

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.config.intervalo_min).toBe(10);
    });

    test('intervalo fora do range é clampado (1-1440)', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [CONFIG_DB], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ ...CONFIG_DB, intervalo_min: 1440 }], rowCount: 1 } as never);

      const res = await request(app)
        .put('/api/v1/agendamento/config')
        .set('Authorization', `Bearer ${token()}`)
        .send({ intervalo_min: 99999 }); // deve ser clampado para 1440

      expect(res.status).toBe(200);
      // Verifica que o valor passado para o banco não é 99999
      const updateCall = mockPool.query.mock.calls.find(c =>
        typeof c[0] === 'string' && (c[0] as string).includes('UPDATE agendamento_config')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]![1]).toBeLessThanOrEqual(1440);
    });

    test('intervalo 0 vira 1 (mínimo)', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [CONFIG_DB], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ ...CONFIG_DB, intervalo_min: 1 }], rowCount: 1 } as never);

      const res = await request(app)
        .put('/api/v1/agendamento/config')
        .set('Authorization', `Bearer ${token()}`)
        .send({ intervalo_min: 0 });

      expect(res.status).toBe(200);
      const updateCall = mockPool.query.mock.calls.find(c =>
        typeof c[0] === 'string' && (c[0] as string).includes('UPDATE agendamento_config')
      );
      expect(updateCall![1]![1]).toBeGreaterThanOrEqual(1);
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).put('/api/v1/agendamento/config');
      expect(res.status).toBe(401);
    });
  });

  /* ── GET /agendamento/itens ── */
  describe('GET /agendamento/itens', () => {
    test('retorna itens com detalhes da oferta', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [ITEM_DB], rowCount: 1 } as never) // itens JOIN ofertas
        .mockResolvedValueOnce({                                           // contagem por status
          rows: [{ status: 'pendente', total: '1' }],
          rowCount: 1,
        } as never);

      const res = await request(app)
        .get('/api/v1/agendamento/itens')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.itens).toHaveLength(1);
      expect(res.body.itens[0].legenda).toBe('Legenda do item da fila');
      expect(res.body.contagem).toHaveLength(1);
    });

    test('retorna lista vazia quando fila está zerada', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const res = await request(app)
        .get('/api/v1/agendamento/itens')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.itens).toHaveLength(0);
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).get('/api/v1/agendamento/itens');
      expect(res.status).toBe(401);
    });

    test('isolamento: filtra por usuario_id logado', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await request(app)
        .get('/api/v1/agendamento/itens')
        .set('Authorization', `Bearer ${token('outro-user')}`);

      const calls = mockPool.query.mock.calls;
      expect(calls[0][1]![0]).toBe('outro-user');
    });
  });

  /* ── POST /agendamento/itens ── */
  describe('POST /agendamento/itens', () => {
    test('adiciona lista de ofertaIds → retorna adicionados', async () => {
      // Para cada ofertaId: SELECT para obter legenda padrão + INSERT na fila
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ nome: 'Fone', preco: 189, desconto_pct: 25, link_produto: 'https://p.com', link_afiliado: 'https://af.com', plataforma: 'shopee' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // INSERT
        .mockResolvedValueOnce({ rows: [{ nome: 'Notebook', preco: 2499, desconto_pct: 18, link_produto: 'https://p2.com', link_afiliado: 'https://af2.com', plataforma: 'mercadolivre' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // INSERT

      const res = await request(app)
        .post('/api/v1/agendamento/itens')
        .set('Authorization', `Bearer ${token()}`)
        .send({ ofertaIds: ['oferta-uuid-1', 'oferta-uuid-2'] });

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.adicionados).toBe(2);
    });

    test('formato com legenda customizada no body', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const res = await request(app)
        .post('/api/v1/agendamento/itens')
        .set('Authorization', `Bearer ${token()}`)
        .send({ itens: [{ ofertaId: 'oferta-uuid-1', legenda: 'Legenda customizada do usuário' }] });

      expect(res.status).toBe(200);
      expect(res.body.adicionados).toBe(1);
      // Verifica que a legenda customizada foi usada (sem SELECT na oferta)
      const insertCall = mockPool.query.mock.calls.find(c =>
        typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO agendamento_itens')
      );
      expect(insertCall![1]![2]).toBe('Legenda customizada do usuário');
    });

    test('lista vazia → 400', async () => {
      const res = await request(app)
        .post('/api/v1/agendamento/itens')
        .set('Authorization', `Bearer ${token()}`)
        .send({ ofertaIds: [] });

      expect(res.status).toBe(400);
      expect(res.body.erro.mensagem).toContain('oferta');
    });

    test('body sem itens nem ofertaIds → 400', async () => {
      const res = await request(app)
        .post('/api/v1/agendamento/itens')
        .set('Authorization', `Bearer ${token()}`)
        .send({});

      expect(res.status).toBe(400);
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).post('/api/v1/agendamento/itens');
      expect(res.status).toBe(401);
    });
  });

  /* ── PATCH /agendamento/itens/:id ── */
  describe('PATCH /agendamento/itens/:id', () => {
    test('atualiza legenda de item pendente', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const res = await request(app)
        .patch(`/api/v1/agendamento/itens/${ITEM_DB.id}`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ legenda: 'Nova legenda editada pelo usuário' });

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.atualizado).toBe(true);
    });

    test('legenda vazia → 400', async () => {
      const res = await request(app)
        .patch(`/api/v1/agendamento/itens/${ITEM_DB.id}`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ legenda: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.erro.mensagem).toContain('Legenda');
    });

    test('legenda ausente → 400', async () => {
      const res = await request(app)
        .patch(`/api/v1/agendamento/itens/${ITEM_DB.id}`)
        .set('Authorization', `Bearer ${token()}`)
        .send({});

      expect(res.status).toBe(400);
    });

    test('item não encontrado (outro usuário) → atualizado: false', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const res = await request(app)
        .patch(`/api/v1/agendamento/itens/${ITEM_DB.id}`)
        .set('Authorization', `Bearer ${token('outro-user')}`)
        .send({ legenda: 'Legenda' });

      expect(res.status).toBe(200);
      expect(res.body.atualizado).toBe(false); // rowCount = 0
    });

    test('isolamento: WHERE inclui usuario_id logado', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await request(app)
        .patch(`/api/v1/agendamento/itens/${ITEM_DB.id}`)
        .set('Authorization', `Bearer ${token('user-especifico')}`)
        .send({ legenda: 'Legenda' });

      const updateCall = mockPool.query.mock.calls.find(c =>
        typeof c[0] === 'string' && (c[0] as string).includes('UPDATE agendamento_itens')
      );
      expect(updateCall![1]![2]).toBe('user-especifico');
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).patch(`/api/v1/agendamento/itens/${ITEM_DB.id}`);
      expect(res.status).toBe(401);
    });
  });

  /* ── DELETE /agendamento/itens/:id ── */
  describe('DELETE /agendamento/itens/:id', () => {
    test('remove item existente', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const res = await request(app)
        .delete(`/api/v1/agendamento/itens/${ITEM_DB.id}`)
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.removidas).toBe(1);
    });

    test('item inexistente → removidas: 0 (sem erro)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const res = await request(app)
        .delete(`/api/v1/agendamento/itens/id-inexistente`)
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.removidas).toBe(0);
    });

    test('isolamento: WHERE inclui usuario_id', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await request(app)
        .delete(`/api/v1/agendamento/itens/${ITEM_DB.id}`)
        .set('Authorization', `Bearer ${token('user-x')}`);

      const deleteCall = mockPool.query.mock.calls.find(c =>
        typeof c[0] === 'string' && (c[0] as string).includes('DELETE FROM agendamento_itens')
      );
      expect(deleteCall![1]![1]).toBe('user-x');
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).delete(`/api/v1/agendamento/itens/${ITEM_DB.id}`);
      expect(res.status).toBe(401);
    });
  });

  /* ── DELETE /agendamento/itens (bulk) ── */
  describe('DELETE /agendamento/itens (bulk)', () => {
    test('limpa toda a fila sem filtro de status', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 5 } as never);

      const res = await request(app)
        .delete('/api/v1/agendamento/itens')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.removidas).toBe(5);
    });

    test('limpa apenas itens enviados', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 3 } as never);

      const res = await request(app)
        .delete('/api/v1/agendamento/itens?status=enviado')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.removidas).toBe(3);
      expect(JSON.stringify(mockPool.query.mock.calls)).toContain('enviado');
    });

    test('limpa apenas itens com erro', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 2 } as never);

      const res = await request(app)
        .delete('/api/v1/agendamento/itens?status=erro')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.removidas).toBe(2);
    });

    test('sem autenticação → 401', async () => {
      const res = await request(app).delete('/api/v1/agendamento/itens');
      expect(res.status).toBe(401);
    });
  });
});
