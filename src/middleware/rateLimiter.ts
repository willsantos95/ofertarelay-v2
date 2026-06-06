import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redisClient } from '../config/redis';

function criarStore(prefix: string) {
  return new RedisStore({
    sendCommand: (...args: string[]) => redisClient.sendCommand(args),
    prefix,
  });
}

export const limitadorRegistro = rateLimit({
  store: criarStore('rl:registrar:'),
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: {
    sucesso: false,
    erro: {
      codigo: 'TAXA_LIMITADA',
      mensagem: 'Muitas contas criadas deste IP. Tente novamente após uma hora.',
      codigoStatus: 429,
      tentarAposSegundos: 3600,
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV !== 'production',
});

export const limitadorEntrada = rateLimit({
  store: criarStore('rl:entrar:'),
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: {
    sucesso: false,
    erro: {
      codigo: 'TAXA_LIMITADA',
      mensagem: 'Muitas tentativas de login. Tente novamente em 5 minutos.',
      codigoStatus: 429,
      tentarAposSegundos: 300,
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const limitadorWebhook = rateLimit({
  store: criarStore('rl:webhook:'),
  windowMs: 60 * 1000,
  max: parseInt(process.env.WEBHOOK_RATE_LIMIT || '100'),
  message: {
    sucesso: false,
    erro: {
      codigo: 'TAXA_LIMITADA',
      mensagem: 'Muitos webhooks recebidos. Tente novamente em 1 minuto.',
      codigoStatus: 429,
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export function criarLimitadorN8n(prefix: string, max: number) {
  return rateLimit({
    store: criarStore(`rl:n8n:${prefix}:`),
    windowMs: 60 * 1000,
    max,
    keyGenerator: (req) => {
      const r = req as unknown as { usuarioN8n?: { id: string }; ip?: string };
      return r.usuarioN8n?.id || r.ip || 'unknown';
    },
    message: {
      sucesso: false,
      erro: {
        codigo: 'TAXA_LIMITADA_N8N',
        mensagem: 'Muitas requisições. Tente novamente em 1 minuto.',
        codigoStatus: 429,
        tentarAposSegundos: 60,
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV !== 'production',
  });
}
