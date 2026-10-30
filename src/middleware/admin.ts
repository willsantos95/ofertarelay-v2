import { Response, NextFunction } from 'express';
import { RequestComUsuario } from './authRequired';

/** E-mails com permissão de administrador (variável ADMIN_EMAILS, separados por vírgula). */
export function eAdmin(email: string | undefined | null): boolean {
  if (!email) return false;
  const lista = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return lista.includes(email.toLowerCase());
}

/** Usar depois de autenticacaoRequerida. */
export function exigirAdmin(req: RequestComUsuario, res: Response, next: NextFunction): void {
  if (!eAdmin(req.usuario?.email)) {
    res.status(403).json({
      sucesso: false,
      erro: { codigo: 'ACESSO_NEGADO', mensagem: 'Apenas administradores podem fazer isso.', codigoStatus: 403 },
    });
    return;
  }
  next();
}
