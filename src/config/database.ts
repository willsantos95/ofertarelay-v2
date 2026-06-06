import { Pool } from 'pg';
import { logger } from '../utils/logger';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Erro inesperado no pool do banco de dados');
});

export async function connectDatabase(): Promise<void> {
  const client = await pool.connect();
  client.release();
  logger.info('Conexão com banco de dados estabelecida');
}
