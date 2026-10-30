// Links de conta enviados por e-mail (redefinir senha, confirmar e-mail).
import crypto from 'crypto';
import { Request } from 'express';
import { pool } from '../config/database';
import { lerConfigEmail, urlAppPadrao, enviarEmailEmSegundoPlano } from './email.service';

export const HORA = 60 * 60 * 1000;

export function hashToken(t: string): string {
  return crypto.createHash('sha256').update(t).digest('hex');
}

/** Endereço do painel para montar links: config do admin > PUBLIC_URL/FRONTEND_URL > origem do pedido. */
export async function urlApp(req: Request): Promise<string> {
  const c = await lerConfigEmail().catch(() => null);
  if (c?.urlApp) return c.urlApp;
  const padrao = urlAppPadrao();
  if (padrao) return padrao;
  const origem = req.headers.origin;
  if (typeof origem === 'string' && /^https?:\/\//.test(origem)) return origem.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0]}`;
}

type UsuarioEmail = { id: string; nome: string; email: string };

/** Gera o link de redefinição (1 h) e envia por e-mail. Devolve o link (o admin pode copiar). */
export async function enviarLinkRedefinicao(req: Request, u: UsuarioEmail): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO tokens_reset_senha (usuario_id, hash_token, expira_em) VALUES ($1, $2, $3)`,
    [u.id, hashToken(token), new Date(Date.now() + HORA)]
  );
  const url = `${await urlApp(req)}/reset-password?token=${token}`;
  enviarEmailEmSegundoPlano(u.email, 'redefinir_senha', { nome: u.nome, url });
  return url;
}

/** Gera o link de confirmação de cadastro (3 dias) e envia por e-mail. */
export async function enviarConfirmacao(req: Request, u: UsuarioEmail): Promise<void> {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO tokens_confirmacao_email (usuario_id, hash_token, expira_em) VALUES ($1, $2, $3)`,
    [u.id, hashToken(token), new Date(Date.now() + 72 * HORA)]
  );
  enviarEmailEmSegundoPlano(u.email, 'confirmar_email', {
    nome: u.nome,
    url: `${await urlApp(req)}/confirmar-email?token=${token}`,
  });
}
