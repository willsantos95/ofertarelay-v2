import { Request, Response, NextFunction } from 'express';
import { verificarToken } from '../utils/tokens';
import { logger } from '../utils/logger';

export interface RequestComUsuario extends Request {
  usuario?: {
    id: string;
    email: string;
    nome: string;
  };
}

export function autenticacaoRequerida(
  req: RequestComUsuario,
  res: Response,
  next: NextFunction
): void {
  try {
    let token: string | undefined;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (req.cookies?.auth_token) {
      token = req.cookies.auth_token;
    }

    if (!token) {
      res.status(401).json({
        sucesso: false,
        erro: {
          codigo: 'AUTH_TOKEN_AUSENTE',
          mensagem: 'Token de autenticação é obrigatório',
          codigoStatus: 401,
        },
      });
      return;
    }

    const payload = verificarToken(token);
    req.usuario = { id: payload.id, email: payload.email, nome: payload.nome };
    next();
  } catch (erro: unknown) {
    logger.warn({ erro }, 'Token inválido ou expirado');
    res.status(401).json({
      sucesso: false,
      erro: {
        codigo: 'AUTH_TOKEN_INVALIDO',
        mensagem: 'Token inválido ou expirado',
        codigoStatus: 401,
      },
    });
  }
}
