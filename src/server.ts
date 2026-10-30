import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.routes';
import billingRoutes from './routes/billing.routes';
import whatsappRoutes from './routes/whatsapp.routes';
import n8nRoutes from './routes/n8n.routes';
import settingsRoutes from './routes/settings.routes';
import relayRoutes from './routes/relay.routes';
import ofertasRoutes from './routes/ofertas.routes';
import agendamentoRoutes from './routes/agendamento.routes';
import afiliadoRoutes from './routes/afiliado.routes';
import n8nCompatRoutes from './routes/n8n-compat.routes';
import ajudaRoutes from './routes/ajuda.routes';
import landingRoutes from './routes/landing.routes';
import publicRoutes from './routes/public.routes';
import adminRoutes from './routes/admin.routes';
import { errorHandler } from './middleware/errorHandler';

export function criarApp(): express.Application {
  const app = express();

  app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  }));

  // Proxy (Easypanel/nginx) na frente: necessário para o IP real nos rate limits
  app.set('trust proxy', 1);

  // Upload da imagem da landing chega em base64 (até 2 MB de imagem)
  app.use('/api/v1/landing/imagem', express.json({ limit: '4mb' }));
  app.use(express.json());
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/faturamento', billingRoutes);
  app.use('/api/v1/billing', billingRoutes);      // alias em inglês para o frontend
  app.use('/api/v1/whatsapp', whatsappRoutes);
  app.use('/api/v1/n8n', n8nRoutes);
  app.use('/api/v1/settings', settingsRoutes);
  app.use('/api/v1/relay', relayRoutes);
  app.use('/api/v1/ofertas', ofertasRoutes);
  app.use('/api/v1/agendamento', agendamentoRoutes);
  app.use('/api/v1/afiliado', afiliadoRoutes);
  // Rotas de compatibilidade com o workflow n8n antigo (mesmo path do backend anterior)
  app.use('/api/n8n', n8nCompatRoutes);
  // Chat de suporte com IA (público — sem autenticação)
  app.use('/api/v1/ajuda', ajudaRoutes);
  // Landing page do usuário: editor (autenticado) e página pública
  app.use('/api/v1/landing', landingRoutes);
  app.use('/api/v1/public', publicRoutes);
  app.use('/api/v1/admin', adminRoutes);

  app.use(errorHandler);

  return app;
}
