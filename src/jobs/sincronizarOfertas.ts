// Worker da fila de sincronização do catálogo (Shopee / Mercado Livre).
import { filaOfertas, executarSyncShopee, executarSyncML } from '../routes/ofertas.routes';
import { logger } from '../utils/logger';

filaOfertas.process('sincronizar-ofertas', 1, async (job) => {
  const { usuarioId, plataforma } = job.data as { usuarioId: string; plataforma: 'shopee' | 'mercadolivre' };
  logger.info({ usuarioId, plataforma, jobId: job.id }, 'Sincronização de ofertas iniciada');
  const r = plataforma === 'shopee' ? await executarSyncShopee(usuarioId) : await executarSyncML(usuarioId);
  logger.info({ usuarioId, plataforma, novos: r.totalNovos, erros: r.erros.length }, 'Sincronização de ofertas concluída');
  return r;
});
