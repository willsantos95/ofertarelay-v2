import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool } from '../config/database';
import { gerarToken } from '../utils/tokens';
import { limitadorRegistro, limitadorEntrada } from '../middleware/rateLimiter';
import { autenticacaoRequerida, RequestComUsuario } from '../middleware/authRequired';
import { logger } from '../utils/logger';

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
      `SELECT id, nome, email, senha_hash, chave_api, status_plano, trial_termina_em
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

    const token = gerarToken({ id: usuario.id, email: usuario.email, nome: usuario.nome });
    setCookieAuth(res, token);

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
      `SELECT id, nome, email, chave_api, status_plano, trial_termina_em
       FROM users
       WHERE id = $1 AND deletado_em IS NULL`,
      [usuarioId]
    );

    if (resultado.rows.length === 0) {
      res.status(404).json({ sucesso: false, erro: { codigo: 'USUARIO_NAO_ENCONTRADO', mensagem: 'Usuário não encontrado', codigoStatus: 404 } });
      return;
    }

    res.json({ sucesso: true, usuario: resultado.rows[0] });
  } catch (erro) {
    logger.error({ erro }, 'Erro ao buscar usuário');
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
