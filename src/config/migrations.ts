// Executa as migrations de src/migrations na subida da API.
// Todas as migrations deste projeto são idempotentes (IF NOT EXISTS), então rodar
// em um banco que já recebeu os SQLs à mão é seguro: elas só são registradas.
// Desligue com RODAR_MIGRATIONS=false.

import fs from 'fs';
import path from 'path';
import { pool } from './database';
import { logger } from '../utils/logger';

const PASTA = path.join(process.cwd(), 'src', 'migrations');
const TRAVA = 787_351; // pg_advisory_lock: evita duas réplicas migrando ao mesmo tempo

export async function rodarMigrations(): Promise<void> {
  if (process.env.RODAR_MIGRATIONS === 'false') {
    logger.info('Migrations automáticas desligadas (RODAR_MIGRATIONS=false)');
    return;
  }
  if (!fs.existsSync(PASTA)) {
    logger.warn({ pasta: PASTA }, 'Pasta de migrations não encontrada; pulando');
    return;
  }

  const arquivos = fs.readdirSync(PASTA).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [TRAVA]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        arquivo     VARCHAR(255) PRIMARY KEY,
        aplicada_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    const feitas = new Set(
      (await client.query('SELECT arquivo FROM schema_migrations')).rows.map((r: { arquivo: string }) => r.arquivo)
    );

    for (const arquivo of arquivos) {
      if (feitas.has(arquivo)) continue;
      const sql = fs.readFileSync(path.join(PASTA, arquivo), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (arquivo) VALUES ($1)', [arquivo]);
        await client.query('COMMIT');
        logger.info({ arquivo }, 'Migration aplicada');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ arquivo, err: (err as Error).message }, 'Falha ao aplicar migration');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [TRAVA]).catch(() => undefined);
    client.release();
  }
}
