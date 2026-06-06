import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error({ err }, 'Erro não tratado');
  res.status(500).json({
    sucesso: false,
    erro: {
      codigo: 'ERRO_INTERNO',
      mensagem: 'Erro interno do servidor',
      codigoStatus: 500,
    },
  });
}
