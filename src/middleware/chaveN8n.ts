import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

let avisouSemChave = false;

function igual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Protege as rotas usadas pelo n8n (/api/n8n/*).
 * Exige o header `x-n8n-key` igual a N8N_API_KEY.
 * Sem N8N_API_KEY definida, deixa passar (modo de compatibilidade) e avisa no log —
 * assim o deploy não derruba o fluxo antes de a chave ser configurada nos dois lados.
 */
export function exigirChaveN8n(req: Request, res: Response, next: NextFunction): void {
  const esperada = process.env.N8N_API_KEY || '';

  if (!esperada) {
    if (!avisouSemChave) {
      logger.warn('N8N_API_KEY não definida: rotas /api/n8n estão SEM autenticação. Defina a variável e o header x-n8n-key no n8n.');
      avisouSemChave = true;
    }
    next();
    return;
  }

  const recebida = String(req.headers['x-n8n-key'] || '');
  if (!recebida || !igual(recebida, esperada)) {
    res.status(401).json({ success: false, message: 'Chave do n8n ausente ou inválida (header x-n8n-key).' });
    return;
  }
  next();
}
