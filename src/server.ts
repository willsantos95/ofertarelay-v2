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

/** Domínios que podem chamar a API pelo navegador: FRONTEND_URL, PUBLIC_URL (e www) e CORS_ORIGINS. */
export function origensPermitidas(): string[] {
  const lista = [process.env.FRONTEND_URL, process.env.PUBLIC_URL, process.env.CORS_ORIGINS]
    .flatMap((v) => String(v || '').split(','))
    .map((v) => v.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const comWww = lista.flatMap((o) => {
    const m = o.match(/^(https?:\/\/)(www\.)?(.+)$/);
    return m ? [`${m[1]}${m[3]}`, `${m[1]}www.${m[3]}`] : [o];
  });
  const todas = [...new Set(comWww)];
  return todas.length ? todas : ['http://localhost:3000'];
}

export function criarApp(): express.Application {
  const app = express();

  app.use(cors({
    origin: origensPermitidas(),
    credentials: true,
  }));

  // Proxies na frente (Traefik do Easypanel e, pelo frontend, o nginx): confia nos IPs de rede
  // interna para achar o IP real do visitante nos rate limits.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

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
