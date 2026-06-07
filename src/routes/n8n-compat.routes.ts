/**
 * Rotas de compatibilidade com o backend antigo (minisaas).
 * Aceitam os mesmos parâmetros e retornam o mesmo formato de resposta.
 * Não precisam de x-api-key — identificam o usuário pela instância.
 */
import { Router, Request, Response } from 'express';
import { pool } from '../config/database';
import { logger } from '../utils/logger';

const router = Router();

// Busca usuário pela instância
async function getUserByInstance(instanceName: string) {
  const result = await pool.query(
    `SELECT u.id AS user_id, u.nome AS name, u.email, u.status_plano AS plan_status,
            u.chave_api AS api_key, wi.nome_instancia AS instance_name,
            wi.telefone AS phone, wi.status AS instance_status
     FROM whatsapp_instances wi
     JOIN users u ON u.id = wi.usuario_id
     WHERE wi.nome_instancia = $1 AND u.deletado_em IS NULL
     LIMIT 1`,
    [instanceName]
  );
  return result.rows[0] as {
    user_id: string; name: string; email: string; plan_status: string;
    api_key: string; instance_name: string; phone: string; instance_status: string;
  } | undefined;
}

// GET /api/n8n/settings?instance=minisaas_user_xxx
router.get('/settings', async (req: Request, res: Response): Promise<void> => {
  try {
    const instanceName = String(req.query.instance || req.query.instanceName || '');
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

    // Buscar configurações
    const settingsResult = await pool.query(
      `SELECT tipo AS category, payload FROM user_settings WHERE usuario_id = $1`,
      [user.user_id]
    );

    const settings = settingsResult.rows.reduce((acc: Record<string, unknown>, row) => {
      acc[row.category as string] = row.payload;
      return acc;
    }, {});

    const affiliate = (settings.affiliate as Record<string, unknown>) || {};
    const telegram = (settings.telegram as Record<string, unknown>) || {};

    // Buscar grupos
    let groupsSql = `
      SELECT id, usuario_id AS user_id, group_jid, nome AS group_name, papel AS role, nicho AS niche
      FROM usuario_whatsapp_grupos
      WHERE usuario_id = $1 AND deletado_em IS NULL`;
    const params: unknown[] = [user.user_id];

    if (niche) { params.push(niche); groupsSql += ` AND nicho = $${params.length}`; }
    groupsSql += ' ORDER BY papel, nome';

    const groupsResult = await pool.query(groupsSql, params);

    const mapGroup = (g: Record<string, unknown>) => ({
      id: g.id, user_id: g.user_id,
      instance_name: instanceName,
      name: g.group_name, group_name: g.group_name,
      group_code: g.group_jid, group_jid: g.group_jid, remote_jid: g.group_jid,
      role: g.role, niche: g.niche || 'geral', status: 'active',
    });

    const groups = groupsResult.rows.map(mapGroup);
    const originGroups = groups.filter((g) => g.role === 'origem');
    const destinationGroups = groups.filter((g) => g.role === 'destino');

    res.json({
      success: true,
      user: { id: user.user_id, name: user.name, email: user.email, plan_status: user.plan_status },
      instance: { instance_name: user.instance_name, phone: user.phone, status: user.instance_status },
      settings,
      telegram: {
        botToken: (telegram.botToken as string) || '',
        chatIds: Array.isArray(telegram.chatIds) ? telegram.chatIds : [],
        status: (telegram.status as string) || 'inactive',
      },
      affiliate,
      // Também retornar no novo formato para compatibilidade futura
      originGroups,
      destinationGroups,
    });
  } catch (erro) {
    logger.error({ erro }, 'Erro n8n compat /settings');
    res.status(500).json({ success: false, message: (erro as Error).message });
  }
});

// GET /api/n8n/groups?instance=X&copy=true  ou  ?send=true
router.get('/groups', async (req: Request, res: Response): Promise<void> => {
  try {
    const instanceName = String(req.query.instance || req.query.instanceName || '');
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

    const result = await pool.query(sql, params);

    const groups = result.rows.map((g) => ({
      id: g.id, user_id: g.user_id, instance_name: instanceName,
      name: g.group_name, group_name: g.group_name,
      group_code: g.group_jid, group_jid: g.group_jid, remote_jid: g.group_jid,
      role: g.role, niche: g.niche || 'geral', status: 'active',
    }));

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
    res.status(500).json({ success: false, message: (erro as Error).message });
  }
});

// POST /api/n8n/relay-log
router.post('/relay-log', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      instance_name, origin_group_jid, origin_group_name,
      destination_group_jid, destination_group_name,
      store, niche, original_url, affiliate_url, status,
    } = req.body as Record<string, string>;

    if (!instance_name) {
      res.status(400).json({ success: false, message: 'Informe instance_name.' });
      return;
    }

    const user = await getUserByInstance(instance_name);
    if (!user) {
      res.status(404).json({ success: false, message: 'Instância não encontrada.' });
      return;
    }

    await pool.query(
      `INSERT INTO relay_logs
       (usuario_id, instancia_nome, grupo_origem_jid, grupo_origem_nome,
        grupo_destino_jid, grupo_destino_nome, loja, nicho,
        url_original, url_afiliada, status, relayado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
      [
        user.user_id, instance_name,
        origin_group_jid || null, origin_group_name || null,
        destination_group_jid || null, destination_group_name || null,
        store || null, niche || 'geral',
        original_url || null, affiliate_url || null,
        status || 'success',
      ]
    );

    res.status(201).json({ success: true });
  } catch (erro) {
    logger.error({ erro }, 'Erro n8n compat /relay-log');
    res.status(500).json({ success: false, message: (erro as Error).message });
  }
});

export default router;
