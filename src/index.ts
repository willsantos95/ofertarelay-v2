import 'dotenv/config';
import { criarApp } from './server';
import { connectDatabase } from './config/database';
import { connectRedis } from './config/redis';
import { logger } from './utils/logger';
import './jobs/sincronizarGrupos';

const PORT = parseInt(process.env.PORT || '3000');

async function main(): Promise<void> {
  await connectDatabase();
  await connectRedis();

  const app = criarApp();

  app.listen(PORT, () => {
    logger.info({ port: PORT }, `OfertaRelay API rodando na porta ${PORT}`);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Falha ao iniciar servidor');
  process.exit(1);
});
