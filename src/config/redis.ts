// eslint-disable-next-line @typescript-eslint/no-require-imports
import { createClient } from 'redis';
import { logger } from '../utils/logger';

export const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
});

redisClient.on('error', (err) => {
  logger.error({ err }, 'Erro de conexão Redis');
});

export async function connectRedis(): Promise<void> {
  await redisClient.connect();
  logger.info('Conexão com Redis estabelecida');
}
