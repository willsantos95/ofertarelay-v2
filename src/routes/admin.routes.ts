// Configurações do sistema, só para administradores (ADMIN_EMAILS).
import { Router, Response } from 'express';
import { pool } from '../config/database';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { exigirAdmin, eAdmin } from '../middleware/admin';
import { calcularPlanoAtivo } from '../services/plano.service';
import { enviarLinkRedefinicao } from '../services/conta.service';
import { logger } from '../utils/logger';
import {
  lerConfigEmail, salvarConfigEmail, configParaTela, normalizarConfigEmail, enviarEmail, criarTransporte,
} from '../services/email.service';

const router = Router();
router.use(autenticacaoRequerida, exigirAdmin);

function erro(res: Response, status: number, mensagem: string, codigo = 'ERRO_VALIDACAO'): void {
  res.status(status).json({ sucesso: false, erro: { codigo, mensagem, codigoStatus: status } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/v1/admin/email
router.get('/email', async (_req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const c = await lerConfigEmail();
    const ult = await pool.query(
      `SELECT para, tipo, status, erro, criado_em FROM email_logs ORDER BY criado_em DESC LIMIT 20`
    ).catch(() => ({ rows: [] }));
    res.json({ sucesso: true, config: configParaTela(c), ultimos: ult.rows });
  } catch (e) {
    logger.error({ e }, 'Erro ao ler config de e-mail');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

// PUT /api/v1/admin/email
router.put('/email', async (req: RequestComUsuario, res: Response): Promise<void> => {
  const b = (req.body || {}) as Record<string, unknown>;
  const c = normalizarConfigEmail(b);
  if (!c.host) { erro(res, 400, 'Informe o servidor SMTP.'); return; }
  if (c.remetenteEmail && !EMAIL_RE.test(c.remetenteEmail)) { erro(res, 400, 'E-mail do remetente inválido.'); return; }
  if (c.responderPara && !EMAIL_RE.test(c.responderPara)) { erro(res, 400, 'E-mail de resposta inválido.'); return; }
  if (c.urlApp && !/^https?:\/\//.test(c.urlApp)) { erro(res, 400, 'O endereço do painel deve começar com https://'); return; }
  try {
    const salva = await salvarConfigEmail(b, req.usuario!.email);
    res.json({ sucesso: true, mensagem: 'Configuração salva.', config: configParaTela(salva) });
  } catch (e) {
    logger.error({ e }, 'Erro ao salvar config de e-mail');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

// POST /api/v1/admin/email/testar { para?, ...config opcional não salva }
// Testa a conexão com o servidor e envia um e-mail de teste.
router.post('/email/testar', async (req: RequestComUsuario, res: Response): Promise<void> => {
  const b = (req.body || {}) as Record<string, unknown>;
  const para = String(b.para || req.usuario!.email).trim();
  if (!EMAIL_RE.test(para)) { erro(res, 400, 'E-mail de destino inválido.'); return; }

  try {
    const salva = await lerConfigEmail();
    // Permite testar o que está na tela antes de salvar (senha vazia/mascarada usa a salva)
    const temCampos = b.host !== undefined;
    const c = temCampos ? normalizarConfigEmail(b) : salva;
    if (temCampos && (!c.senha || c.senha === '********')) c.senha = salva.senha;
    if (!c.host || !c.usuario || !c.senha) { erro(res, 400, 'Preencha servidor, usuário e senha.'); return; }

    try {
      await criarTransporte(c).verify();
    } catch (e) {
      res.json({ sucesso: false, etapa: 'conexao', erro: { mensagem: traduzirErroSmtp(e as Error) } });
      return;
    }

    const r = await enviarEmail(para, 'teste', {}, c);
    if (!r.enviado) { res.json({ sucesso: false, etapa: 'envio', erro: { mensagem: traduzirErroSmtp(new Error(r.erro)) } }); return; }
    res.json({ sucesso: true, mensagem: `E-mail de teste enviado para ${para}.` });
  } catch (e) {
    logger.error({ e }, 'Erro no teste de e-mail');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

// ── Usuários ───────────────────────────────────────────────────────────────

const STATUS_PLANO = ['trial', 'ativo', 'pendente', 'pausado', 'cancelado', 'inativo'];
const SITUACOES = ['trial', 'trial_vencido', 'pago', 'cortesia', 'sem_plano', 'bloqueado', 'admin'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Situação legível, na ordem de prioridade usada pelo calcularPlanoAtivo. */
function situacao(u: Record<string, unknown>): string {
  if (eAdmin(u.email as string)) return 'admin';
  if (u.bloqueado_em) return 'bloqueado';
  if (u.premium_ate && new Date(u.premium_ate as string).getTime() > Date.now()) return 'cortesia';
  if (u.status_plano === 'ativo') return 'pago';
  if (u.status_plano === 'trial') {
    return !u.trial_termina_em || new Date(u.trial_termina_em as string).getTime() > Date.now() ? 'trial' : 'trial_vencido';
  }
  return 'sem_plano';
}

const SQL_SITUACAO: Record<string, string> = {
  bloqueado:     `u.bloqueado_em IS NOT NULL`,
  cortesia:      `u.bloqueado_em IS NULL AND u.premium_ate > NOW()`,
  pago:          `u.bloqueado_em IS NULL AND (u.premium_ate IS NULL OR u.premium_ate <= NOW()) AND u.status_plano = 'ativo'`,
  trial:         `u.bloqueado_em IS NULL AND (u.premium_ate IS NULL OR u.premium_ate <= NOW()) AND u.status_plano = 'trial' AND (u.trial_termina_em IS NULL OR u.trial_termina_em > NOW())`,
  trial_vencido: `u.bloqueado_em IS NULL AND (u.premium_ate IS NULL OR u.premium_ate <= NOW()) AND u.status_plano = 'trial' AND u.trial_termina_em <= NOW()`,
  sem_plano:     `u.bloqueado_em IS NULL AND (u.premium_ate IS NULL OR u.premium_ate <= NOW()) AND u.status_plano NOT IN ('ativo', 'trial')`,
};

async function registrarAcao(admin: string, usuarioId: string, acao: string, detalhes: Record<string, unknown> = {}): Promise<void> {
  await pool.query(
    `INSERT INTO admin_acoes (admin_email, usuario_id, acao, detalhes) VALUES ($1, $2, $3, $4)`,
    [admin, usuarioId, acao, JSON.stringify(detalhes)]
  ).catch((e) => logger.warn({ e }, 'Falha ao registrar ação do admin'));
}

const CAMPOS_USUARIO = `
  u.id, u.nome, u.email, u.status_plano, u.trial_termina_em, u.premium_ate, u.bloqueado_em, u.motivo_bloqueio,
  u.observacao_admin, u.email_confirmado_em, u.ultimo_acesso_em, u.criado_em,
  wi.status AS whatsapp_status, wi.telefone AS whatsapp_telefone,
  (SELECT COUNT(*) FROM relay_logs r WHERE r.usuario_id = u.id AND r.relayado_em > NOW() - INTERVAL '30 days'
     AND r.status IN ('success', 'publicada', 'parcial'))::int AS ofertas_30d,
  (SELECT MAX(r.relayado_em) FROM relay_logs r WHERE r.usuario_id = u.id) AS ultima_oferta_em,
  (SELECT s.status_pagamento FROM subscriptions s WHERE s.usuario_id = u.id ORDER BY s.atualizado_em DESC LIMIT 1) AS assinatura_status,
  (SELECT s.next_payment_at FROM subscriptions s WHERE s.usuario_id = u.id ORDER BY s.atualizado_em DESC LIMIT 1) AS assinatura_proxima_cobranca`;

const JOIN_WHATSAPP = `
  LEFT JOIN LATERAL (
    SELECT status, telefone FROM whatsapp_instances w WHERE w.usuario_id = u.id ORDER BY w.criado_em DESC LIMIT 1
  ) wi ON TRUE`;

function comSituacao(u: Record<string, unknown>) {
  return {
    ...u,
    situacao: situacao(u),
    plano_ativo: calcularPlanoAtivo(u.status_plano as string, u.trial_termina_em as string, u.email as string, {
      premiumAte: u.premium_ate as string, bloqueadoEm: u.bloqueado_em as string,
    }),
    is_admin: eAdmin(u.email as string),
  };
}

// GET /api/v1/admin/resumo — números da plataforma
router.get('/resumo', async (_req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const [u, r] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE u.criado_em > NOW() - INTERVAL '7 days')::int AS novos_7d,
          ${Object.entries(SQL_SITUACAO).map(([k, v]) => `COUNT(*) FILTER (WHERE ${v})::int AS ${k}`).join(',\n          ')}
        FROM users u WHERE u.deletado_em IS NULL`),
      pool.query(`
        SELECT COUNT(*)::int AS ofertas_7d, COUNT(DISTINCT usuario_id)::int AS usuarios_ativos_7d
        FROM relay_logs WHERE relayado_em > NOW() - INTERVAL '7 days' AND status IN ('success', 'publicada', 'parcial')`),
    ]);
    res.json({ sucesso: true, resumo: { ...u.rows[0], ...r.rows[0] } });
  } catch (e) {
    logger.error({ e }, 'Erro no resumo admin');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

// GET /api/v1/admin/usuarios?busca&situacao&page&limit
router.get('/usuarios', async (req: RequestComUsuario, res: Response): Promise<void> => {
  const page = Math.max(1, parseInt(String(req.query.page || '1')) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '25')) || 25));
  const busca = String(req.query.busca || '').trim().slice(0, 100);
  const sit = String(req.query.situacao || '');
  if (sit && !SITUACOES.includes(sit)) { erro(res, 400, 'Situação inválida.'); return; }

  const filtros = ['u.deletado_em IS NULL'];
  const params: unknown[] = [];
  if (busca) { params.push(`%${busca}%`); filtros.push(`(u.nome ILIKE $${params.length} OR u.email ILIKE $${params.length})`); }
  if (sit && SQL_SITUACAO[sit]) filtros.push(SQL_SITUACAO[sit]);
  if (sit === 'admin') {
    const admins = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    params.push(admins); filtros.push(`LOWER(u.email) = ANY($${params.length})`);
  }
  const where = filtros.join(' AND ');

  try {
    const [lista, total] = await Promise.all([
      pool.query(
        `SELECT ${CAMPOS_USUARIO} FROM users u ${JOIN_WHATSAPP}
         WHERE ${where} ORDER BY u.criado_em DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit]
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM users u WHERE ${where}`, params),
    ]);
    const n = Number(total.rows[0]?.n || 0);
    res.json({ sucesso: true, usuarios: lista.rows.map(comSituacao), total: n, page, totalPages: Math.ceil(n / limit) });
  } catch (e) {
    logger.error({ e }, 'Erro ao listar usuários');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

// GET /api/v1/admin/usuarios/:id — detalhes, assinaturas e histórico de ações
router.get('/usuarios/:id', async (req: RequestComUsuario, res: Response): Promise<void> => {
  if (!UUID_RE.test(req.params.id)) { erro(res, 400, 'ID inválido.'); return; }
  try {
    const u = await pool.query(`SELECT ${CAMPOS_USUARIO} FROM users u ${JOIN_WHATSAPP} WHERE u.id = $1 AND u.deletado_em IS NULL`, [req.params.id]);
    if (!u.rows.length) { erro(res, 404, 'Usuário não encontrado.', 'USUARIO_NAO_ENCONTRADO'); return; }
    const [assinaturas, acoes, grupos] = await Promise.all([
      pool.query(
        `SELECT id, provider, nome_plano, valor, status_pagamento, started_at, next_payment_at, cancelled_at, criado_em, atualizado_em
         FROM subscriptions WHERE usuario_id = $1 ORDER BY atualizado_em DESC LIMIT 10`, [req.params.id]),
      pool.query(
        `SELECT admin_email, acao, detalhes, criado_em FROM admin_acoes WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 30`,
        [req.params.id]).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT papel, COUNT(*)::int AS total FROM usuario_whatsapp_grupos
         WHERE usuario_id = $1 AND deletado_em IS NULL GROUP BY papel`, [req.params.id]).catch(() => ({ rows: [] })),
    ]);
    res.json({ sucesso: true, usuario: comSituacao(u.rows[0]), assinaturas: assinaturas.rows, acoes: acoes.rows, grupos: grupos.rows });
  } catch (e) {
    logger.error({ e }, 'Erro ao detalhar usuário');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

function dataOuNull(v: unknown): Date | null | 'invalida' {
  if (v === null || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? 'invalida' : d;
}

// PATCH /api/v1/admin/usuarios/:id/plano
// { status_plano?, trial_termina_em?, premium_ate? (null remove), premium_dias?, premium_vitalicio?, observacao? }
router.patch('/usuarios/:id/plano', async (req: RequestComUsuario, res: Response): Promise<void> => {
  if (!UUID_RE.test(req.params.id)) { erro(res, 400, 'ID inválido.'); return; }
  const b = (req.body || {}) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [req.params.id];
  const detalhes: Record<string, unknown> = {};
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); detalhes[col] = v; };

  if (b.status_plano !== undefined) {
    if (!STATUS_PLANO.includes(String(b.status_plano))) { erro(res, 400, 'Status de plano inválido.'); return; }
    set('status_plano', String(b.status_plano));
  }
  if (b.trial_termina_em !== undefined) {
    const d = dataOuNull(b.trial_termina_em);
    if (d === 'invalida' || d === null) { erro(res, 400, 'Data de fim do teste inválida.'); return; }
    set('trial_termina_em', d);
  }
  if (b.premium_vitalicio === true) {
    set('premium_ate', new Date('2999-12-31T23:59:59Z'));
  } else if (b.premium_dias !== undefined) {
    const dias = Number(b.premium_dias);
    if (!Number.isInteger(dias) || dias < 1 || dias > 3650) { erro(res, 400, 'Informe de 1 a 3650 dias.'); return; }
    // Soma ao que já existe, se a cortesia ainda estiver valendo
    params.push(dias);
    sets.push(`premium_ate = GREATEST(COALESCE(premium_ate, NOW()), NOW()) + ($${params.length} || ' days')::interval`);
    detalhes.premium_dias = dias;
  } else if (b.premium_ate !== undefined) {
    const d = dataOuNull(b.premium_ate);
    if (d === 'invalida') { erro(res, 400, 'Data do premium inválida.'); return; }
    set('premium_ate', d);
  }
  if (b.observacao !== undefined) set('observacao_admin', String(b.observacao).slice(0, 1000) || null);

  if (!sets.length) { erro(res, 400, 'Nada para alterar.'); return; }

  try {
    const r = await pool.query(
      `UPDATE users SET ${sets.join(', ')}, atualizado_em = NOW() WHERE id = $1 AND deletado_em IS NULL RETURNING id`,
      params
    );
    if (!r.rowCount) { erro(res, 404, 'Usuário não encontrado.', 'USUARIO_NAO_ENCONTRADO'); return; }
    await registrarAcao(req.usuario!.email, req.params.id, 'alterar_plano', detalhes);
    const u = await pool.query(`SELECT ${CAMPOS_USUARIO} FROM users u ${JOIN_WHATSAPP} WHERE u.id = $1`, [req.params.id]);
    res.json({ sucesso: true, mensagem: 'Plano atualizado.', usuario: comSituacao(u.rows[0]) });
  } catch (e) {
    logger.error({ e }, 'Erro ao alterar plano');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

async function buscarAlvo(res: Response, id: string): Promise<{ id: string; nome: string; email: string } | null> {
  if (!UUID_RE.test(id)) { erro(res, 400, 'ID inválido.'); return null; }
  const r = await pool.query(`SELECT id, nome, email FROM users WHERE id = $1 AND deletado_em IS NULL`, [id]);
  if (!r.rows.length) { erro(res, 404, 'Usuário não encontrado.', 'USUARIO_NAO_ENCONTRADO'); return null; }
  return r.rows[0];
}

// POST /api/v1/admin/usuarios/:id/bloquear { motivo }
router.post('/usuarios/:id/bloquear', async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const alvo = await buscarAlvo(res, req.params.id);
    if (!alvo) return;
    if (eAdmin(alvo.email)) { erro(res, 400, 'Não é possível bloquear um administrador.'); return; }
    const motivo = String((req.body as Record<string, unknown>)?.motivo || '').slice(0, 500) || null;
    await pool.query(`UPDATE users SET bloqueado_em = NOW(), motivo_bloqueio = $2, atualizado_em = NOW() WHERE id = $1`, [alvo.id, motivo]);
    await registrarAcao(req.usuario!.email, alvo.id, 'bloquear', { motivo });
    res.json({ sucesso: true, mensagem: 'Conta bloqueada. O envio de ofertas para imediatamente.' });
  } catch (e) {
    logger.error({ e }, 'Erro ao bloquear');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

// POST /api/v1/admin/usuarios/:id/desbloquear
router.post('/usuarios/:id/desbloquear', async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const alvo = await buscarAlvo(res, req.params.id);
    if (!alvo) return;
    await pool.query(`UPDATE users SET bloqueado_em = NULL, motivo_bloqueio = NULL, atualizado_em = NOW() WHERE id = $1`, [alvo.id]);
    await registrarAcao(req.usuario!.email, alvo.id, 'desbloquear');
    res.json({ sucesso: true, mensagem: 'Conta desbloqueada.' });
  } catch (e) {
    logger.error({ e }, 'Erro ao desbloquear');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

// POST /api/v1/admin/usuarios/:id/confirmar-email
router.post('/usuarios/:id/confirmar-email', async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const alvo = await buscarAlvo(res, req.params.id);
    if (!alvo) return;
    await pool.query(`UPDATE users SET email_confirmado_em = COALESCE(email_confirmado_em, NOW()) WHERE id = $1`, [alvo.id]);
    await registrarAcao(req.usuario!.email, alvo.id, 'confirmar_email');
    res.json({ sucesso: true, mensagem: 'E-mail marcado como confirmado.' });
  } catch (e) {
    logger.error({ e }, 'Erro ao confirmar e-mail');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

// POST /api/v1/admin/usuarios/:id/redefinir-senha — envia o link por e-mail e devolve o link para copiar
router.post('/usuarios/:id/redefinir-senha', async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const alvo = await buscarAlvo(res, req.params.id);
    if (!alvo) return;
    const link = await enviarLinkRedefinicao(req, alvo);
    await registrarAcao(req.usuario!.email, alvo.id, 'enviar_redefinicao_senha');
    res.json({ sucesso: true, mensagem: `Link enviado para ${alvo.email} (vale por 1 hora).`, link });
  } catch (e) {
    logger.error({ e }, 'Erro ao gerar link de senha');
    erro(res, 500, 'Erro interno', 'ERRO_INTERNO');
  }
});

export function traduzirErroSmtp(e: Error & { code?: string; responseCode?: number }): string {
  const msg = e.message || '';
  if (e.code === 'EAUTH' || e.responseCode === 535 || /auth/i.test(msg)) return 'Usuário ou senha recusados pelo servidor.';
  if (e.code === 'ETIMEDOUT' || /timeout/i.test(msg)) return 'O servidor não respondeu. Confira o endereço e a porta (465 com SSL ou 587 sem SSL).';
  if (e.code === 'ECONNREFUSED') return 'Conexão recusada. Confira a porta.';
  if (e.code === 'EDNS' || /ENOTFOUND/.test(msg)) return 'Servidor não encontrado. Confira o endereço (ex.: smtp.hostinger.com).';
  if (/wrong version number|ssl/i.test(msg)) return 'Combinação de porta e SSL incorreta: use 465 com SSL ligado ou 587 com SSL desligado.';
  return msg.slice(0, 300) || 'Falha ao enviar.';
}

export default router;
