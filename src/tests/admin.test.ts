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
const sendMail = jest.fn().mockResolvedValue({});
const verify = jest.fn().mockResolvedValue(true);
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail, verify })) }));

import { pool } from '../config/database';
import { criarApp } from '../server';
import { calcularPlanoAtivo } from '../services/plano.service';
import { montarEmail } from '../services/email.service';

const mockPool = pool as jest.Mocked<typeof pool>;
process.env.JWT_SECRET = 'segredo-teste-minimo-32-caracteres-ok';
process.env.ADMIN_EMAILS = 'admin@ofertarelay.com';
const app = criarApp();
const UID = '11111111-1111-1111-1111-111111111111';

const tk = (email: string) => jwt.sign({ id: 'a', email, nome: 'X' }, process.env.JWT_SECRET!, { expiresIn: '1d' });
const ADMIN = `Bearer ${tk('admin@ofertarelay.com')}`;
const COMUM = `Bearer ${tk('user@x.com')}`;
const ok = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount } as never);

beforeEach(() => { jest.clearAllMocks(); mockPool.query.mockReset(); });

describe('Acesso', () => {
  test('usuário comum não acessa /admin', async () => {
    const res = await request(app).get('/api/v1/admin/usuarios').set('Authorization', COMUM);
    expect(res.status).toBe(403);
  });
});

describe('Usuários', () => {
  test('lista com situação calculada', async () => {
    mockPool.query
      .mockResolvedValueOnce(ok([
        { id: UID, email: 'a@x.com', status_plano: 'trial', trial_termina_em: new Date(Date.now() - 1000), premium_ate: null, bloqueado_em: null },
        { id: UID, email: 'b@x.com', status_plano: 'cancelado', trial_termina_em: null, premium_ate: new Date(Date.now() + 86400000), bloqueado_em: null },
      ]))
      .mockResolvedValueOnce(ok([{ n: 2 }]));
    const res = await request(app).get('/api/v1/admin/usuarios?situacao=trial_vencido&busca=x').set('Authorization', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.usuarios.map((u: { situacao: string }) => u.situacao)).toEqual(['trial_vencido', 'cortesia']);
    expect(res.body.usuarios[1].plano_ativo).toBe(true);
  });

  test('situação inválida → 400', async () => {
    const res = await request(app).get('/api/v1/admin/usuarios?situacao=xyz').set('Authorization', ADMIN);
    expect(res.status).toBe(400);
  });

  test('dar 30 dias de premium soma ao atual e registra a ação', async () => {
    mockPool.query
      .mockResolvedValueOnce(ok([{ id: UID }]))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok([{ id: UID, email: 'a@x.com', status_plano: 'trial', premium_ate: new Date(Date.now() + 30 * 86400000) }]));
    const res = await request(app).patch(`/api/v1/admin/usuarios/${UID}/plano`).set('Authorization', ADMIN).send({ premium_dias: 30 });
    expect(res.status).toBe(200);
    expect(String(mockPool.query.mock.calls[0][0])).toContain('GREATEST(COALESCE(premium_ate, NOW()), NOW())');
    expect(String(mockPool.query.mock.calls[1][0])).toContain('admin_acoes');
    expect(res.body.usuario.situacao).toBe('cortesia');
  });

  test('status de plano inválido → 400', async () => {
    const res = await request(app).patch(`/api/v1/admin/usuarios/${UID}/plano`).set('Authorization', ADMIN).send({ status_plano: 'vip' });
    expect(res.status).toBe(400);
  });

  test('não bloqueia administrador', async () => {
    mockPool.query.mockResolvedValueOnce(ok([{ id: UID, nome: 'A', email: 'admin@ofertarelay.com' }]));
    const res = await request(app).post(`/api/v1/admin/usuarios/${UID}/bloquear`).set('Authorization', ADMIN).send({});
    expect(res.status).toBe(400);
  });

  test('bloqueia usuário comum', async () => {
    mockPool.query.mockResolvedValueOnce(ok([{ id: UID, nome: 'A', email: 'a@x.com' }])).mockResolvedValue(ok());
    const res = await request(app).post(`/api/v1/admin/usuarios/${UID}/bloquear`).set('Authorization', ADMIN).send({ motivo: 'spam' });
    expect(res.status).toBe(200);
    expect(mockPool.query.mock.calls[1][1]).toEqual([UID, 'spam']);
  });

  test('conta bloqueada nunca tem plano ativo; cortesia vale mesmo cancelado', () => {
    expect(calcularPlanoAtivo('ativo', null, 'a@x.com', { bloqueadoEm: new Date() })).toBe(false);
    expect(calcularPlanoAtivo('cancelado', null, 'a@x.com', { premiumAte: new Date(Date.now() + 1000) })).toBe(true);
    expect(calcularPlanoAtivo('cancelado', null, 'a@x.com', { premiumAte: new Date(Date.now() - 1000) })).toBe(false);
  });
});

describe('Servidor de e-mail', () => {
  test('GET não devolve a senha', async () => {
    mockPool.query
      .mockResolvedValueOnce(ok([{ payload: { ativo: true, host: 'smtp.hostinger.com', porta: 465, seguro: true, usuario: 'contato@ofertarelay.com.br', senha: 'segredo' } }]))
      .mockResolvedValueOnce(ok());
    const res = await request(app).get('/api/v1/admin/email').set('Authorization', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.config.senha).toBe('********');
    expect(res.body.config.senhaDefinida).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('segredo');
  });

  test('PUT com senha mascarada mantém a senha salva', async () => {
    mockPool.query
      .mockResolvedValueOnce(ok([{ payload: { host: 'smtp.hostinger.com', usuario: 'c@x.com', senha: 'segredo' } }]))
      .mockResolvedValueOnce(ok());
    const res = await request(app).put('/api/v1/admin/email').set('Authorization', ADMIN)
      .send({ ativo: true, host: 'smtp.hostinger.com', porta: 465, seguro: true, usuario: 'c@x.com', senha: '********', remetenteEmail: 'c@x.com' });
    expect(res.status).toBe(200);
    const gravado = JSON.parse(mockPool.query.mock.calls[1][1]![0] as string);
    expect(gravado.senha).toBe('segredo');
  });

  test('testar envia e-mail de teste', async () => {
    mockPool.query.mockResolvedValue(ok([{ payload: { ativo: true, host: 'smtp.hostinger.com', usuario: 'c@x.com', senha: 'segredo', remetenteEmail: 'c@x.com' } }]));
    const res = await request(app).post('/api/v1/admin/email/testar').set('Authorization', ADMIN).send({ para: 'w@x.com' });
    expect(res.status).toBe(200);
    expect(res.body.sucesso).toBe(true);
    expect(verify).toHaveBeenCalled();
    expect(sendMail.mock.calls[0][0].to).toBe('w@x.com');
  });

  test('modelo de redefinição contém o link e escapa o nome', () => {
    const m = montarEmail('redefinir_senha', { nome: '<b>Will</b>', url: 'https://app/reset-password?token=abc' });
    expect(m.html).toContain('https://app/reset-password?token=abc');
    expect(m.html).not.toContain('<b>Will</b>');
  });
});

describe('Auth com e-mail', () => {
  test('esqueci-senha responde igual para e-mail inexistente', async () => {
    mockPool.query.mockResolvedValueOnce(ok());
    const res = await request(app).post('/api/v1/auth/esqueci-senha').send({ email: 'nada@x.com' });
    expect(res.status).toBe(200);
    expect(res.body.sucesso).toBe(true);
  });

  test('esqueci-senha gera token e envia e-mail', async () => {
    mockPool.query
      .mockResolvedValueOnce(ok([{ id: UID, nome: 'Will', email: 'w@x.com' }]))
      .mockResolvedValueOnce(ok([{ n: 0 }]))
      .mockResolvedValue(ok([{ payload: { ativo: true, host: 'h', usuario: 'c@x.com', senha: 's', urlApp: 'https://ofertarelay.com.br' } }]));
    const res = await request(app).post('/api/v1/auth/esqueci-senha').send({ email: 'w@x.com' });
    expect(res.status).toBe(200);
    expect(String(mockPool.query.mock.calls[2][0])).toContain('tokens_reset_senha');
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMail).toHaveBeenCalled();
    expect(sendMail.mock.calls[0][0].text).toContain('https://ofertarelay.com.br/reset-password?token=');
  });

  test('redefinir-senha com token expirado → 400', async () => {
    const client = { query: jest.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok()).mockResolvedValue(ok()), release: jest.fn() };
    (mockPool.connect as jest.Mock).mockResolvedValue(client);
    const res = await request(app).post('/api/v1/auth/redefinir-senha').send({ token: 'a'.repeat(64), senha: 'novasenha' });
    expect(res.status).toBe(400);
    expect(res.body.erro.codigo).toBe('TOKEN_INVALIDO');
  });

  test('login de conta bloqueada → 403', async () => {
    const bcrypt = await import('bcryptjs');
    mockPool.query.mockResolvedValueOnce(ok([{ id: UID, nome: 'A', email: 'a@x.com', senha_hash: await bcrypt.hash('123456', 4), bloqueado_em: new Date() }]));
    const res = await request(app).post('/api/v1/auth/entrar').send({ email: 'a@x.com', senha: '123456' });
    expect(res.status).toBe(403);
    expect(res.body.erro.codigo).toBe('CONTA_BLOQUEADA');
  });
});
