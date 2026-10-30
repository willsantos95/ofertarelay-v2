import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool } from '../config/database';
import { gerarToken } from '../utils/tokens';
import { limitadorRegistro, limitadorEntrada } from '../middleware/rateLimiter';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { logger } from '../utils/logger';
import { eAdmin } from '../middleware/admin';
import { calcularPlanoAtivo, bloqueioPlanoLigado } from '../services/plano.service';
import { enviarEmailEmSegundoPlano, lerConfigEmail, emailConfigurado } from '../services/email.service';
import { hashToken, urlApp, enviarConfirmacao, enviarLinkRedefinicao } from '../services/conta.service';

function erroValidacao(res: Response, mensagem: string): void {
  res.status(400).json({ sucesso: false, erro: { codigo: 'ERRO_VALIDACAO', mensagem, codigoStatus: 400 } });
}

const router = Router();

const validacaoRegistro = [
  body('nome')
    .trim()
    .notEmpty().withMessage('Nome é obrigatório')
    .isLength({ min: 1, max: 100 }).withMessage('Nome deve ter 1-100 caracteres')
    .escape()
    .custom((valor: string) => {
      if (/<[^>]*>/g.test(valor)) {
        throw new Error('Tags HTML/script não são permitidas');
      }
      return true;
    }),

  body('email')
    .trim()
    .notEmpty().withMessage('Email é obrigatório')
    .isEmail().withMessage('Formato de email inválido')
    .normalizeEmail(),

  body('senha')
    .notEmpty().withMessage('Senha é obrigatória')
    .isLength({ min: 6, max: 100 }).withMessage('Senha deve ter 6-100 caracteres'),
];

const validacaoEntrada = [
  body('email')
    .trim()
    .notEmpty().withMessage('Email é obrigatório')
    .isEmail().withMessage('Formato de email inválido')
    .normalizeEmail(),

  body('senha')
    .notEmpty().withMessage('Senha é obrigatória')
    .isLength({ min: 1, max: 100 }).withMessage('Comprimento de senha inválido'),
];

function setCookieAuth(res: Response, token: string): void {
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

// POST /api/v1/auth/registrar
router.post('/registrar', limitadorRegistro, validacaoRegistro, async (req: Request, res: Response): Promise<void> => {
  const erros = validationResult(req);
  if (!erros.isEmpty()) {
    res.status(400).json({
      sucesso: false,
      erro: {
        codigo: 'ERRO_VALIDACAO',
        mensagem: erros.array()[0].msg,
        codigoStatus: 400,
        detalhes: { campo: erros.array()[0].type },
      },
    });
    return;
  }

  const { nome, email, senha } = req.body as { nome: string; email: string; senha: string };

  try {
    const senhaHash = await bcrypt.hash(senha, 10);
    const chaveApi = 'rn8n_' + crypto.randomBytes(32).toString('hex');
    const trialTerminaEm = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

    const resultado = await pool.query(
      `INSERT INTO users (nome, email, senha_hash, chave_api, status_plano, trial_termina_em)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, nome, email, chave_api, status_plano, trial_termina_em`,
      [nome, email, senhaHash, chaveApi, 'trial', trialTerminaEm]
    );

    const usuario = resultado.rows[0];
    const token = gerarToken({ id: usuario.id, email: usuario.email, nome: usuario.nome });

    setCookieAuth(res, token);

    // Confirmação de cadastro (só se o servidor de e-mail estiver configurado; não bloqueia o cadastro)
    lerConfigEmail()
      .then((c) => (emailConfigurado(c) ? enviarConfirmacao(req, usuario) : undefined))
      .catch((e) => logger.warn({ e }, 'Não foi possível enviar a confirmação de cadastro'));

    res.status(201).json({
      sucesso: true,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        chave_api: usuario.chave_api,
        status_plano: usuario.status_plano,
        trial_termina_em: usuario.trial_termina_em,
      },
      token,
    });
  } catch (erro: unknown) {
    const pgErr = erro as { code?: string };
    logger.error({ erro, email }, 'Falha no cadastro');

    if (pgErr.code === '23505') {
      res.status(409).json({
        sucesso: false,
        erro: {
          codigo: 'AUTH_USUARIO_EXISTE',
          mensagem: 'Email já cadastrado',
          codigoStatus: 409,
          detalhes: { email },
        },
      });
      return;
    }

    res.status(500).json({
      sucesso: false,
      erro: {
        codigo: 'ERRO_BANCO_DADOS',
        mensagem: 'Falha ao criar conta',
        codigoStatus: 500,
      },
    });
  }
});

// POST /api/v1/auth/entrar
router.post('/entrar', limitadorEntrada, validacaoEntrada, async (req: Request, res: Response): Promise<void> => {
  const erros = validationResult(req);
  if (!erros.isEmpty()) {
    res.status(400).json({
      sucesso: false,
      erro: {
        codigo: 'ERRO_VALIDACAO',
        mensagem: erros.array()[0].msg,
        codigoStatus: 400,
        detalhes: { campo: erros.array()[0].type },
      },
    });
    return;
  }

  const { email, senha } = req.body as { email: string; senha: string };

  try {
    const resultado = await pool.query(
      `SELECT id, nome, email, senha_hash, chave_api, status_plano, trial_termina_em, bloqueado_em
       FROM users
       WHERE LOWER(email) = LOWER($1) AND deletado_em IS NULL`,
      [email]
    );

    if (resultado.rows.length === 0) {
      res.status(401).json({
        sucesso: false,
        erro: {
          codigo: 'AUTH_CREDENCIAIS_INVALIDAS',
          mensagem: 'Email ou senha inválidos',
          codigoStatus: 401,
        },
      });
      return;
    }

    const usuario = resultado.rows[0];
    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash);

    if (!senhaValida) {
      res.status(401).json({
        sucesso: false,
        erro: {
          codigo: 'AUTH_CREDENCIAIS_INVALIDAS',
          mensagem: 'Email ou senha inválidos',
          codigoStatus: 401,
        },
      });
      return;
    }

    if (usuario.bloqueado_em) {
      res.status(403).json({
        sucesso: false,
        erro: { codigo: 'CONTA_BLOQUEADA', mensagem: 'Sua conta está bloqueada. Fale com o suporte.', codigoStatus: 403 },
      });
      return;
    }

    const token = gerarToken({ id: usuario.id, email: usuario.email, nome: usuario.nome });
    setCookieAuth(res, token);
    Promise.resolve(pool.query(`UPDATE users SET ultimo_acesso_em = NOW() WHERE id = $1`, [usuario.id])).catch(() => undefined);

    res.json({
      sucesso: true,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        chave_api: usuario.chave_api,
        status_plano: usuario.status_plano,
        trial_termina_em: usuario.trial_termina_em,
      },
      token,
    });
  } catch (erro: unknown) {
    logger.error({ erro, email }, 'Falha na entrada');
    res.status(500).json({
      sucesso: false,
      erro: {
        codigo: 'ERRO_BANCO_DADOS',
        mensagem: 'Falha na entrada',
        codigoStatus: 500,
      },
    });
  }
});

// GET /api/v1/auth/me
router.get('/me', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  const usuarioId = req.usuario!.id;
  try {
    const resultado = await pool.query(
      `SELECT id, nome, email, chave_api, status_plano, trial_termina_em, email_confirmado_em,
              premium_ate, bloqueado_em
       FROM users
       WHERE id = $1 AND deletado_em IS NULL`,
      [usuarioId]
    );

    if (resultado.rows.length === 0) {
      res.status(404).json({ sucesso: false, erro: { codigo: 'USUARIO_NAO_ENCONTRADO', mensagem: 'Usuário não encontrado', codigoStatus: 404 } });
      return;
    }

    const { bloqueado_em: bloqueadoEm, ...u } = resultado.rows[0];
    if (bloqueadoEm && !eAdmin(u.email)) {
      res.clearCookie('auth_token');
      res.status(403).json({ sucesso: false, erro: { codigo: 'CONTA_BLOQUEADA', mensagem: 'Sua conta está bloqueada. Fale com o suporte.', codigoStatus: 403 } });
      return;
    }
    res.json({
      sucesso: true,
      usuario: {
        ...u,
        email_confirmado: !!u.email_confirmado_em,
        is_admin: eAdmin(u.email),
        plano_ativo: calcularPlanoAtivo(u.status_plano, u.trial_termina_em, u.email, { premiumAte: u.premium_ate }),
        bloqueio_plano: bloqueioPlanoLigado(),
      },
    });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao buscar usuário');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

// POST /api/v1/auth/esqueci-senha { email } — sempre responde igual (não revela se o e-mail existe)
router.post('/esqueci-senha', limitadorEntrada, [body('email').trim().isEmail().normalizeEmail()], async (req: Request, res: Response): Promise<void> => {
  const resposta = { sucesso: true, mensagem: 'Se este e-mail existir, você receberá as instruções em breve.' };
  if (!validationResult(req).isEmpty()) { res.json(resposta); return; }
  const email = String(req.body.email);
  try {
    const r = await pool.query(
      `SELECT id, nome, email FROM users WHERE LOWER(email) = LOWER($1) AND deletado_em IS NULL`,
      [email]
    );
    if (r.rows.length) {
      const u = r.rows[0] as { id: string; nome: string; email: string };
      // Limite simples: no máximo 3 pedidos por hora por conta
      const recentes = await pool.query(
        `SELECT COUNT(*) AS n FROM tokens_reset_senha WHERE usuario_id = $1 AND criado_em > NOW() - INTERVAL '1 hour'`,
        [u.id]
      );
      if (Number(recentes.rows[0]?.n || 0) < 3) {
        await enviarLinkRedefinicao(req, u);
      }
    }
  } catch (erro) {
    logger.error({ erro }, 'Erro em esqueci-senha');
  }
  res.json(resposta);
});

// POST /api/v1/auth/redefinir-senha { token, senha }
router.post('/redefinir-senha', limitadorEntrada, async (req: Request, res: Response): Promise<void> => {
  const token = String(req.body?.token || '');
  const senha = String(req.body?.senha || '');
  if (!/^[a-f0-9]{64}$/.test(token)) { erroValidacao(res, 'Link inválido.'); return; }
  if (senha.length < 6 || senha.length > 100) { erroValidacao(res, 'A senha deve ter de 6 a 100 caracteres.'); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE tokens_reset_senha SET usado_em = NOW()
       WHERE hash_token = $1 AND usado_em IS NULL AND expira_em > NOW()
       RETURNING usuario_id`,
      [hashToken(token)]
    );
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      res.status(400).json({ sucesso: false, erro: { codigo: 'TOKEN_INVALIDO', mensagem: 'Este link expirou ou já foi usado. Peça um novo.', codigoStatus: 400 } });
      return;
    }
    const usuarioId = r.rows[0].usuario_id as string;
    const u = await client.query(
      `UPDATE users SET senha_hash = $2, atualizado_em = NOW(),
         email_confirmado_em = COALESCE(email_confirmado_em, NOW())
       WHERE id = $1 AND deletado_em IS NULL RETURNING nome, email`,
      [usuarioId, await bcrypt.hash(senha, 10)]
    );
    // Invalida os outros links pendentes
    await client.query(`UPDATE tokens_reset_senha SET usado_em = NOW() WHERE usuario_id = $1 AND usado_em IS NULL`, [usuarioId]);
    await client.query('COMMIT');

    if (u.rows.length) {
      const base = await urlApp(req);
      enviarEmailEmSegundoPlano(u.rows[0].email, 'senha_alterada', { nome: u.rows[0].nome, url: `${base}/forgot-password` });
    }
    res.json({ sucesso: true, mensagem: 'Senha alterada. Entre com a nova senha.' });
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.error({ erro }, 'Erro ao redefinir senha');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  } finally {
    client.release();
  }
});

// POST /api/v1/auth/confirmar-email { token }
router.post('/confirmar-email', limitadorEntrada, async (req: Request, res: Response): Promise<void> => {
  const token = String(req.body?.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) { erroValidacao(res, 'Link inválido.'); return; }
  try {
    const r = await pool.query(
      `UPDATE tokens_confirmacao_email SET usado_em = NOW()
       WHERE hash_token = $1 AND usado_em IS NULL AND expira_em > NOW()
       RETURNING usuario_id`,
      [hashToken(token)]
    );
    if (!r.rows.length) {
      res.status(400).json({ sucesso: false, erro: { codigo: 'TOKEN_INVALIDO', mensagem: 'Este link expirou ou já foi usado.', codigoStatus: 400 } });
      return;
    }
    const u = await pool.query(
      `UPDATE users SET email_confirmado_em = COALESCE(email_confirmado_em, NOW())
       WHERE id = $1 RETURNING nome, email`,
      [r.rows[0].usuario_id]
    );
    if (u.rows.length) {
      const base = await urlApp(req);
      enviarEmailEmSegundoPlano(u.rows[0].email, 'boas_vindas', { nome: u.rows[0].nome, url: `${base}/app` });
    }
    res.json({ sucesso: true, mensagem: 'E-mail confirmado.' });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao confirmar e-mail');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

// POST /api/v1/auth/reenviar-confirmacao (logado)
router.post('/reenviar-confirmacao', autenticacaoRequerida, async (req: RequestComUsuario, res: Response): Promise<void> => {
  try {
    const r = await pool.query(
      `SELECT id, nome, email, email_confirmado_em FROM users WHERE id = $1 AND deletado_em IS NULL`,
      [req.usuario!.id]
    );
    const u = r.rows[0];
    if (!u) { res.status(404).json({ sucesso: false, erro: { codigo: 'USUARIO_NAO_ENCONTRADO', mensagem: 'Usuário não encontrado', codigoStatus: 404 } }); return; }
    if (u.email_confirmado_em) { res.json({ sucesso: true, mensagem: 'Seu e-mail já está confirmado.' }); return; }
    if (!emailConfigurado(await lerConfigEmail())) {
      res.status(503).json({ sucesso: false, erro: { codigo: 'EMAIL_INDISPONIVEL', mensagem: 'O envio de e-mails ainda não foi configurado.', codigoStatus: 503 } });
      return;
    }
    const recentes = await pool.query(
      `SELECT COUNT(*) AS n FROM tokens_confirmacao_email WHERE usuario_id = $1 AND criado_em > NOW() - INTERVAL '1 hour'`,
      [u.id]
    );
    if (Number(recentes.rows[0]?.n || 0) >= 3) {
      res.status(429).json({ sucesso: false, erro: { codigo: 'MUITAS_TENTATIVAS', mensagem: 'Aguarde um pouco antes de pedir outro e-mail.', codigoStatus: 429 } });
      return;
    }
    await enviarConfirmacao(req, u);
    res.json({ sucesso: true, mensagem: `Enviamos um link para ${u.email}.` });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao reenviar confirmação');
    res.status(500).json({ sucesso: false, erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno', codigoStatus: 500 } });
  }
});

// POST /api/v1/auth/sair  — limpa o cookie de autenticação
router.post('/sair', (_req: Request, res: Response): void => {
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });
  res.json({ sucesso: true });
});

export default router;
