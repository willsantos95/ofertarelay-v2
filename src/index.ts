import 'dotenv/config';
import { criarApp } from './server';
import { connectDatabase } from './config/database';
import { connectRedis } from './config/redis';
import { logger } from './utils/logger';
import './jobs/sincronizarGrupos';
import { iniciarWorkerAgendamento } from './jobs/processarFilaAgendamento';

const PORT = parseInt(process.env.PORT || '3000');

async function main(): Promise<void> {
  await connectDatabase();
  await connectRedis();

  const app = criarApp();

  app.listen(PORT, () => {
    logger.info({ port: PORT }, `OfertaRelay API rodando na porta ${PORT}`);
  });

  // Inicia o worker de envio agendado (fila de ofertas)
  iniciarWorkerAgendamento();
}

main().catch((err) => {
  logger.error({ err }, 'Falha ao iniciar servidor');
  process.exit(1);
});
