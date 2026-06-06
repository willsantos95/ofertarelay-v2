import { Router, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import crypto from 'crypto';
import { pool } from '../config/database';
import { autenticacaoN8n, verificarInstancia, RequestN8n } from '../middleware/autenticacaoN8n';
import { criarLimitadorN8n } from '../middleware/rateLimiter';
import { logger } from '../utils/logger';

const router = Router();

const limitadorConfig = criarLimitadorN8n('config', parseInt(process.env.N8N_RATE_LIMIT_CONFIGURACOES || '10'));
const limitadorGrupos = criarLimitadorN8n('grupos', parseInt(process.env.N8N_RATE_LIMIT_GRUPOS || '10'));
const limitadorLog = criarLimitadorN8n('log', parseInt(process.env.N8N_RATE_LIMIT_LOG || '100'));

async function registrarAcesso(req: RequestN8n, statusHttp: number, erroCode?: string): Promise<void> {
  if (process.env.N8N_LOG_REQUESTS !== 'true') return;
  try {
    await pool.query(
      `INSERT INTO n8n_access_logs
       (usuario_id, endpoint, metodo, status_http, instancia_nome, ip_origem, user_agent, erro_codigo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.usuarioN8n!.id,
        req.path,
        req.method,
        statusHttp,
        req.query.instancia || null,
        req.ip,
        req.headers['user-agent'] || null,
        erroCode || null,
      ]
    );
  } catch { /* não bloquear o fluxo por erro de log */ }
}

// GET /api/v1/n8n/configuracoes
router.get(
  '/configuracoes',
  autenticacaoN8n,
  limitadorConfig,
  [query('instancia').notEmpty().withMessage('Parâmetro instancia é obrigatório')],
  verificarInstancia,
  async (req: RequestN8n, res: Response): Promise<void> => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
      res.status(400).json({ sucesso: false, erro: { codigo: 'ERRO_VALIDACAO', mensagem: erros.array()[0].msg, codigoStatus: 400 } });
      return;
    }

    const usuarioId = req.usuarioN8n!.id;
    const instancia = req.query.instancia as string;

    try {
      const instanciaResult = await pool.query(
        `SELECT * FROM whatsapp_instances WHERE nome_instancia = $1 AND usuario_id = $2`,
        [instancia, usuarioId]
      );

      if (instanciaResult.rows.length === 0) {
        await registrarAcesso(req, 404, 'N8N_INSTANCIA_NAOEXISTE');
        res.status(404).json({
          sucesso: false,
          erro: { codigo: 'N8N_INSTANCIA_NAOEXISTE', mensagem: 'Instância WhatsApp não encontrada', codigoStatus: 404 },
        });
        return;
      }

      const usuario = await pool.query(
        'SELECT id, nome, email, status_plano FROM users WHERE id = $1',
        [usuarioId]
      );

      const gruposOrigem = await pool.query(
        `SELECT group_jid, nome, nicho FROM usuario_whatsapp_grupos
         WHERE usuario_id = $1 AND papel = 'origem' AND deletado_em IS NULL`,
        [usuarioId]
      );

      const gruposDestino = await pool.query(
        `SELECT group_jid, nome, nicho FROM usuario_whatsapp_grupos
         WHERE usuario_id = $1 AND papel = 'destino' AND deletado_em IS NULL`,
        [usuarioId]
      );

      const inst = instanciaResult.rows[0];

      await registrarAcesso(req, 200);

      res.json({
        sucesso: true,
        usuario: {
          id: usuario.rows[0].id,
          nome: usuario.rows[0].nome,
          email: usuario.rows[0].email,
          status_plano: usuario.rows[0].status_plano,
        },
        instancia: {
          nome: inst.nome_instancia,
          telefone: inst.telefone,
          status: inst.status,
        },
        configuracoes: {},
        gruposOrigem: gruposOrigem.rows.map((g) => ({ groupJid: g.group_jid, nome: g.nome, nicho: g.nicho })),
        gruposDestino: gruposDestino.rows.map((g) => ({ groupJid: g.group_jid, nome: g.nome, nicho: g.nicho })),
      });
    } catch (erro: unknown) {
      logger.error({ erro }, 'Erro ao buscar configurações n8n');
      await registrarAcesso(req, 500, 'ERRO_INTERNO');
      res.status(500).json({
        sucesso: false,
        erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 },
      });
    }
  }
);

// GET /api/v1/n8n/grupos
router.get(
  '/grupos',
  autenticacaoN8n,
  limitadorGrupos,
  [query('instancia').notEmpty().withMessage('Parâmetro instancia é obrigatório')],
  verificarInstancia,
  async (req: RequestN8n, res: Response): Promise<void> => {
    const usuarioId = req.usuarioN8n!.id;
    const instancia = req.query.instancia as string;

    try {
      const gruposOrigem = await pool.query(
        `SELECT group_jid, nome, nicho FROM usuario_whatsapp_grupos
         WHERE usuario_id = $1 AND papel = 'origem' AND deletado_em IS NULL`,
        [usuarioId]
      );

      const gruposDestino = await pool.query(
        `SELECT group_jid, nome, nicho FROM usuario_whatsapp_grupos
         WHERE usuario_id = $1 AND papel = 'destino' AND deletado_em IS NULL`,
        [usuarioId]
      );

      await registrarAcesso(req, 200);

      res.json({
        sucesso: true,
        instancia,
        gruposOrigem: gruposOrigem.rows.map((g) => ({ groupJid: g.group_jid, nome: g.nome, nicho: g.nicho, statusAtivo: true })),
        gruposDestino: gruposDestino.rows.map((g) => ({ groupJid: g.group_jid, nome: g.nome, nicho: g.nicho, statusAtivo: true })),
      });
    } catch (erro: unknown) {
      logger.error({ erro }, 'Erro ao buscar grupos n8n');
      res.status(500).json({
        sucesso: false,
        erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 },
      });
    }
  }
);

// POST /api/v1/n8n/registrar-log
router.post(
  '/registrar-log',
  autenticacaoN8n,
  limitadorLog,
  [
    body('instancia').notEmpty().withMessage('instancia é obrigatório'),
    body('status').notEmpty().withMessage('status é obrigatório'),
    body('timestamp').notEmpty().withMessage('timestamp é obrigatório'),
  ],
  async (req: RequestN8n, res: Response): Promise<void> => {
    const erros = validationResult(req);
    if (!erros.isEmpty()) {
      res.status(400).json({ sucesso: false, erro: { codigo: 'ERRO_VALIDACAO', mensagem: erros.array()[0].msg, codigoStatus: 400 } });
      return;
    }

    // Validar HMAC
    const signature = req.headers['x-signature'] as string | undefined;
    if (!signature) {
      res.status(401).json({
        sucesso: false,
        erro: { codigo: 'N8N_ASSINATURA_AUSENTE', mensagem: 'Header x-signature é obrigatório', codigoStatus: 401 },
      });
      return;
    }

    const partes = signature.match(/ts=(\d+),v1=([a-f0-9]+)/);
    if (!partes) {
      res.status(401).json({
        sucesso: false,
        erro: { codigo: 'N8N_ASSINATURA_INVALIDA', mensagem: 'Formato de x-signature inválido', codigoStatus: 401 },
      });
      return;
    }

    const [, ts, v1] = partes;

    // Verificar timestamp (não mais de 5 minutos)
    const agora = Math.floor(Date.now() / 1000);
    if (agora - parseInt(ts) > 300) {
      res.status(401).json({
        sucesso: false,
        erro: { codigo: 'N8N_ASSINATURA_INVALIDA', mensagem: 'Assinatura expirada', codigoStatus: 401 },
      });
      return;
    }

    const body = req.body as { instancia: string };
    const xRequestId = req.headers['x-request-id'] || 'unknown';
    const manifest = `id:${body.instancia};request-id:${xRequestId};ts:${ts}`;

    const hmac = crypto
      .createHmac('sha256', process.env.N8N_WEBHOOK_SECRET as string)
      .update(manifest)
      .digest('hex');

    let validoHmac = false;
    try {
      validoHmac = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(hmac));
    } catch {
      validoHmac = false;
    }

    if (!validoHmac) {
      res.status(401).json({
        sucesso: false,
        erro: { codigo: 'N8N_ASSINATURA_INVALIDA', mensagem: 'Assinatura HMAC inválida', codigoStatus: 401 },
      });
      return;
    }

    const {
      instancia,
      grupoOrigem,
      grupoDestino,
      oferta,
      status,
      timestamp,
    } = req.body as {
      instancia: string;
      grupoOrigem?: { groupJid?: string; nome?: string };
      grupoDestino?: { groupJid?: string; nome?: string };
      oferta?: { loja?: string; nicho?: string; urlOriginal?: string; urlAfiliado?: string; titulo?: string; preco?: string };
      status: string;
      timestamp: string;
    };

    try {
      const resultado = await pool.query(
        `INSERT INTO relay_logs
         (usuario_id, instancia_nome, grupo_origem_jid, grupo_origem_nome,
          grupo_destino_jid, grupo_destino_nome, loja, nicho, url_original,
          url_afiliada, titulo_oferta, preco, status, relayado_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [
          req.usuarioN8n!.id,
          instancia,
          grupoOrigem?.groupJid || null,
          grupoOrigem?.nome || null,
          grupoDestino?.groupJid || null,
          grupoDestino?.nome || null,
          oferta?.loja || null,
          oferta?.nicho || 'geral',
          oferta?.urlOriginal || null,
          oferta?.urlAfiliado || null,
          oferta?.titulo || null,
          oferta?.preco || null,
          status,
          timestamp,
        ]
      );

      await registrarAcesso(req, 201);

      res.status(201).json({
        sucesso: true,
        mensagem: 'Log de relay registrado com sucesso',
        logId: `log_${resultado.rows[0].id}`,
        relayId: `relay_${resultado.rows[0].id}`,
      });
    } catch (erro: unknown) {
      logger.error({ erro }, 'Erro ao registrar log n8n');
      res.status(500).json({
        sucesso: false,
        erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro ao registrar log', codigoStatus: 500 },
      });
    }
  }
);

export default router;
