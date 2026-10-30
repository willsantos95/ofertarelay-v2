/**
 * Rotas usadas pelo fluxo de relay do n8n (/api/n8n/*).
 * Mantêm o formato do backend antigo (minisaas) e identificam o usuário pela instância.
 * Protegidas pelo header x-n8n-key (ver middleware/chaveN8n).
 */
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../config/database';
import { logger } from '../utils/logger';
import { exigirChaveN8n } from '../middleware/chaveN8n';
import { lerTodosSettings, normalizarConfigRelay } from '../services/settings.service';
import { calcularPlanoAtivo, bloqueioPlanoLigado } from '../services/plano.service';
import { gerarLinkParaUrl } from '../services/linkRelay.service';
import { registrarRelayLog } from '../services/relayLog.service';

const router = Router();

router.use(exigirChaveN8n);
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.N8N_RATE_LIMIT_COMPAT || '600'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Muitas requisições do n8n. Tente novamente em instantes.' },
  skip: () => process.env.NODE_ENV === 'test',
}));

interface UsuarioInstancia {
  user_id: string; name: string; email: string; plan_status: string; trial_ends_at: Date | null;
  instance_name: string; phone: string; instance_status: string;
  premium_until?: Date | null; blocked_at?: Date | null;
}

// Busca usuário pela instância
async function getUserByInstance(instanceName: string): Promise<UsuarioInstancia | undefined> {
  const result = await pool.query(
    `SELECT u.id AS user_id, u.nome AS name, u.email, u.status_plano AS plan_status,
            u.trial_termina_em AS trial_ends_at, u.premium_ate AS premium_until,
            u.bloqueado_em AS blocked_at, wi.nome_instancia AS instance_name,
            wi.telefone AS phone, wi.status AS instance_status
     FROM whatsapp_instances wi
     JOIN users u ON u.id = wi.usuario_id
     WHERE wi.nome_instancia = $1 AND u.deletado_em IS NULL
     LIMIT 1`,
    [instanceName]
  );
  return result.rows[0] as UsuarioInstancia | undefined;
}

function nomeInstancia(req: Request): string {
  return String(req.query.instance || req.query.instanceName || (req.body as Record<string, unknown>)?.instance || '');
}

const mapGroup = (instanceName: string) => (g: Record<string, unknown>) => ({
  id: g.id, user_id: g.user_id,
  instance_name: instanceName,
  name: g.group_name, group_name: g.group_name,
  group_code: g.group_jid, group_jid: g.group_jid, remote_jid: g.group_jid,
  role: g.role, niche: g.niche || 'geral', status: 'active',
});

// GET /api/n8n/settings?instance=minisaas_user_xxx
router.get('/settings', async (req: Request, res: Response): Promise<void> => {
  try {
    const instanceName = nomeInstancia(req);
    const niche = req.query.niche as string | undefined;

    if (!instanceName) {
      res.status(400).json({ success: false, message: 'Informe instance na query.' });
      return;
    }

    const user = await getUserByInstance(instanceName);
    if (!user) {
      res.status(404).json({ success: false, message: 'Usuário não encontrado para esta instância.' });
      return;
    }

    const settings = await lerTodosSettings(user.user_id);
    const affiliate = (settings.affiliate as Record<string, unknown>) || {};
    const telegram = (settings.telegram as Record<string, unknown>) || {};
    const relay = normalizarConfigRelay(settings.relay);
    const planOk = calcularPlanoAtivo(user.plan_status, user.trial_ends_at, user.email, { premiumAte: user.premium_until, bloqueadoEm: user.blocked_at });

    let groupsSql = `
      SELECT id, usuario_id AS user_id, group_jid, nome AS group_name, papel AS role, nicho AS niche
      FROM usuario_whatsapp_grupos
      WHERE usuario_id = $1 AND deletado_em IS NULL`;
    const params: unknown[] = [user.user_id];
    if (niche) { params.push(niche); groupsSql += ` AND nicho = $${params.length}`; }
    groupsSql += ' ORDER BY papel, nome';

    const groups = (await pool.query(groupsSql, params)).rows.map(mapGroup(instanceName));

    res.json({
      success: true,
      user: {
        id: user.user_id, name: user.name, email: user.email,
        plan_status: user.plan_status,
        plan_ok: planOk,
        plan_enforced: bloqueioPlanoLigado() || !!user.blocked_at,
        blocked: !!user.blocked_at,
      },
      instance: { instance_name: user.instance_name, phone: user.phone, status: user.instance_status },
      settings: {
        ...settings,
        relay,
        branding: { header: relay.cabecalho, footer: relay.rodape },
      },
      telegram: {
        botToken: (telegram.botToken as string) || '',
        chatIds: Array.isArray(telegram.chatIds) ? telegram.chatIds : [],
        status: (telegram.status as string) || 'inactive',
      },
      affiliate,
      originGroups: groups.filter((g) => g.role === 'origem'),
      destinationGroups: groups.filter((g) => g.role === 'destino'),
    });
  } catch (erro) {
    logger.error({ erro }, 'Erro n8n compat /settings');
    res.status(500).json({ success: false, message: 'Erro interno ao buscar configurações.' });
  }
});

// GET /api/n8n/groups?instance=X&copy=true  ou  ?send=true
router.get('/groups', async (req: Request, res: Response): Promise<void> => {
  try {
    const instanceName = nomeInstancia(req);
    const copy  = req.query.copy === 'true';
    const send  = req.query.send  === 'true';
    const niche = req.query.niche as string | undefined;

    if (!instanceName) {
      res.status(400).json({ success: false, message: 'Informe instance na query.' });
      return;
    }

    const user = await getUserByInstance(instanceName);
    if (!user) {
      res.status(404).json({ success: false, message: 'Usuário não encontrado para esta instância.' });
      return;
    }

    const role = copy ? 'origem' : send ? 'destino' : null;

    let sql = `
      SELECT id, usuario_id AS user_id, group_jid, nome AS group_name, papel AS role, nicho AS niche
      FROM usuario_whatsapp_grupos
      WHERE usuario_id = $1 AND deletado_em IS NULL`;
    const params: unknown[] = [user.user_id];

    if (role) { params.push(role); sql += ` AND papel = $${params.length}`; }
    if (niche) { params.push(niche); sql += ` AND nicho = $${params.length}`; }
    sql += ' ORDER BY nome';

    const groups = (await pool.query(sql, params)).rows.map(mapGroup(instanceName));

    res.json({
      success: true,
      instanceName,
      role: copy ? 'origin' : send ? 'destination' : null,
      niche: niche || null,
      count: groups.length,
      groups,
    });
  } catch (erro) {
    logger.error({ erro }, 'Erro n8n compat /groups');
    res.status(500).json({ success: false, message: 'Erro interno ao buscar grupos.' });
  }
});

// POST /api/n8n/affiliate-link  { instance, url }
// Gera o link de afiliado do dono da instância para qualquer URL de produto.
router.post('/affiliate-link', async (req: Request, res: Response): Promise<void> => {
  try {
    const instanceName = nomeInstancia(req);
    const url = String((req.body as Record<string, unknown>)?.url || '').trim();

    if (!instanceName || !/^https?:\/\//i.test(url)) {
      res.status(400).json({ success: false, message: 'Informe instance e uma url http(s).' });
      return;
    }

    const user = await getUserByInstance(instanceName);
    if (!user) {
      res.status(404).json({ success: false, message: 'Instância não encontrada.' });
      return;
    }

    const r = await gerarLinkParaUrl(user.user_id, url, 'relay');
    res.json({
      success: r.sucesso,
      store: r.loja,
      code: r.codigo,
      affiliate_url: r.linkAfiliado,
      original_url: r.urlOriginal,
      final_url: r.urlFinal,
      error: r.erro,
    });
  } catch (erro) {
    logger.error({ erro }, 'Erro n8n compat /affiliate-link');
    res.status(500).json({ success: false, code: 'falha_link', message: 'Erro interno ao gerar link.' });
  }
});

// POST /api/n8n/relay-log
// Aceita o formato antigo (uma linha por grupo de destino) e o da v3 (uma linha por oferta).
router.post('/relay-log', async (req: Request, res: Response): Promise<void> => {
  try {
    const b = req.body as Record<string, unknown>;
    const instanceName = String(b.instance_name || '');

    if (!instanceName) {
      res.status(400).json({ success: false, message: 'Informe instance_name.' });
      return;
    }

    const user = await getUserByInstance(instanceName);
    if (!user) {
      res.status(404).json({ success: false, message: 'Instância não encontrada.' });
      return;
    }

    const s = (k: string) => (b[k] === undefined || b[k] === null ? null : String(b[k]));

    await registrarRelayLog({
      usuarioId: user.user_id,
      instancia: instanceName,
      origem: 'relay',
      status: s('status') || 'success',
      motivo: s('reason'),
      grupoOrigemJid: s('origin_group_jid'),
      grupoOrigemNome: s('origin_group_name'),
      grupoDestinoJid: s('destination_group_jid'),
      grupoDestinoNome: s('destination_group_name'),
      loja: s('store'),
      nicho: s('niche'),
      urlOriginal: s('original_url'),
      urlAfiliada: s('affiliate_url'),
      titulo: s('title'),
      preco: s('price'),
      destinosTotal: b.destinations_total as number | undefined,
      destinosOk: b.destinations_ok as number | undefined,
      duracaoMs: b.duration_ms as number | undefined,
      temImagem: typeof b.has_image === 'boolean' ? b.has_image : (b.has_image === 'true' ? true : b.has_image === 'false' ? false : null),
      messageId: s('message_id'),
      execucaoId: s('execution_id'),
      quando: s('received_at'),
    });

    res.status(201).json({ success: true });
  } catch (erro) {
    logger.error({ erro }, 'Erro n8n compat /relay-log');
    res.status(500).json({ success: false, message: 'Erro interno ao registrar log.' });
  }
});

export default router;
