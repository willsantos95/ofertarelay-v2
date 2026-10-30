import request from 'supertest';

jest.mock('../config/database', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../config/redis', () => ({ redisClient: { connect: jest.fn(), sendCommand: jest.fn() }, getRedisBullConfig: jest.fn(() => ({ host: 'localhost', port: 6379 })) }));
jest.mock('bull', () => jest.fn().mockImplementation(() => ({ add: jest.fn(), process: jest.fn(), on: jest.fn(), getJob: jest.fn() })));

process.env.FRONTEND_URL = 'https://ofertarelay-ofertarelay-frontend.fgxtfw.easypanel.host';
process.env.PUBLIC_URL = 'https://ofertarelay.com.br/';
process.env.JWT_SECRET = 'segredo-teste-minimo-32-caracteres-ok';

import { criarApp, origensPermitidas } from '../server';

const app = criarApp();

describe('CORS', () => {
  test('aceita o domínio do Easypanel, o domínio próprio e o www', async () => {
    expect(origensPermitidas()).toEqual(expect.arrayContaining([
      'https://ofertarelay-ofertarelay-frontend.fgxtfw.easypanel.host',
      'https://ofertarelay.com.br',
      'https://www.ofertarelay.com.br',
    ]));
    for (const origin of ['https://ofertarelay.com.br', 'https://www.ofertarelay.com.br']) {
      const res = await request(app).options('/api/v1/auth/entrar').set('Origin', origin).set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    }
  });

  test('recusa outro domínio', async () => {
    const res = await request(app).options('/api/v1/auth/entrar').set('Origin', 'https://golpe.com').set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
