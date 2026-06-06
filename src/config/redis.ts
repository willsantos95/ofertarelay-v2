import { createClient } from 'redis';
import { logger } from '../utils/logger';

export const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
  password: process.env.REDIS_PASSWORD || undefined,
});

redisClient.on('error', (err) => {
  logger.error({ err }, 'Erro de conexão Redis');
});

export async function connectRedis(): Promise<void> {
  await redisClient.connect();
  logger.info('Conexão com Redis estabelecida');
}

// String de conexão para o Bull (que usa o pacote redis v3 internamente)
export function getRedisBullConfig() {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
  };
}
