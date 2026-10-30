// Regras de plano/assinatura.
// O bloqueio só é aplicado com BLOQUEAR_PLANO_INATIVO=true, para não interromper
// contas atuais no deploy. Sem a variável, o status é calculado e informado, mas nada é bloqueado.

import { Response, NextFunction } from 'express';
import { pool } from '../config/database';
import { RequestComUsuario } from '../middleware/authRequired';
import { eAdmin } from '../middleware/admin';

export interface SituacaoPlano {
  status: string;
  ativo: boolean;
  bloqueado: boolean;
  bloqueioLigado: boolean;
  trialTerminaEm: string | null;
}

export function bloqueioPlanoLigado(): boolean {
  return process.env.BLOQUEAR_PLANO_INATIVO === 'true';
}

export interface ExtrasPlano {
  premiumAte?: Date | string | null;   // cortesia concedida pelo admin
  bloqueadoEm?: Date | string | null;  // conta bloqueada pelo admin
}

/** Plano válido: assinatura ativa, cortesia premium vigente, ou trial dentro do prazo.
 *  Conta bloqueada nunca vale. Administradores sempre valem. */
export function calcularPlanoAtivo(
  status: string, trialTerminaEm: Date | string | null, email?: string | null, extras: ExtrasPlano = {}
): boolean {
  if (eAdmin(email)) return true;
  if (extras.bloqueadoEm) return false;
  if (extras.premiumAte && new Date(extras.premiumAte).getTime() > Date.now()) return true;
  if (status === 'ativo') return true;
  if (status === 'trial') {
    if (!trialTerminaEm) return true;
    return new Date(trialTerminaEm).getTime() > Date.now();
  }
  return false;
}

export async function situacaoPlano(usuarioId: string): Promise<SituacaoPlano> {
  const r = await pool.query(
    `SELECT email, status_plano, trial_termina_em, premium_ate, bloqueado_em
     FROM users WHERE id = $1 AND deletado_em IS NULL`,
    [usuarioId]
  );
  const u = r.rows[0] as {
    email: string; status_plano: string; trial_termina_em: Date | null; premium_ate: Date | null; bloqueado_em: Date | null;
  } | undefined;
  if (!u) return { status: 'inexistente', ativo: false, bloqueado: false, bloqueioLigado: bloqueioPlanoLigado(), trialTerminaEm: null };
  return {
    status: u.status_plano,
    ativo: calcularPlanoAtivo(u.status_plano, u.trial_termina_em, u.email, { premiumAte: u.premium_ate, bloqueadoEm: u.bloqueado_em }),
    bloqueado: !!u.bloqueado_em,
    bloqueioLigado: bloqueioPlanoLigado(),
    trialTerminaEm: u.trial_termina_em ? new Date(u.trial_termina_em).toISOString() : null,
  };
}

/** true quando o usuário pode usar envio/relay (plano ativo ou bloqueio desligado). */
export async function podeEnviar(usuarioId: string): Promise<boolean> {
  const s = await situacaoPlano(usuarioId);
  if (s.bloqueado) return false;          // bloqueio pelo admin vale sempre
  if (!bloqueioPlanoLigado()) return true;
  return s.ativo;
}

/** Middleware: responde 402 quando o bloqueio está ligado e o plano não está ativo. */
export async function exigirPlanoAtivo(req: RequestComUsuario, res: Response, next: NextFunction): Promise<void> {
  try {
    if (await podeEnviar(req.usuario!.id)) { next(); return; }
    res.status(402).json({
      sucesso: false,
      erro: { codigo: 'PLANO_INATIVO', mensagem: 'Seu período de teste terminou ou a assinatura está inativa. Assine para continuar enviando ofertas.', codigoStatus: 402 },
    });
  } catch {
    next();
  }
}
