import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/database';
import { logger } from '../utils/logger';

export interface RequestN8n extends Request {
  usuarioN8n?: { id: string; nome: string; email: string };
  instanciaWhatsapp?: { id: string };
}

export async function autenticacaoN8n(
  req: RequestN8n,
  res: Response,
  next: NextFunction
): Promise<void> {
  const chaveApi = req.headers['x-api-key'] as string | undefined;

  if (!chaveApi) {
    res.status(401).json({
      sucesso: false,
      erro: { codigo: 'N8N_CHAVE_AUSENTE', mensagem: 'Header x-api-key é obrigatório', codigoStatus: 401 },
    });
    return;
  }

  try {
    const usuario = await pool.query(
      'SELECT id, nome, email FROM users WHERE chave_api = $1 AND deletado_em IS NULL',
      [chaveApi]
    );

    if (usuario.rows.length === 0) {
      res.status(401).json({
        sucesso: false,
        erro: { codigo: 'N8N_CHAVE_INVALIDA', mensagem: 'Chave de API inválida', codigoStatus: 401 },
      });
      return;
    }

    req.usuarioN8n = usuario.rows[0] as { id: string; nome: string; email: string };
    next();
  } catch (erro: unknown) {
    logger.error({ erro }, 'Erro ao validar chave n8n');
    res.status(500).json({
      sucesso: false,
      erro: { codigo: 'ERRO_VALIDACAO', mensagem: 'Erro ao validar chave', codigoStatus: 500 },
    });
  }
}

export async function verificarInstancia(
  req: RequestN8n,
  res: Response,
  next: NextFunction
): Promise<void> {
  const instancia = req.query.instancia as string | undefined;
  const usuarioId = req.usuarioN8n!.id;

  if (!instancia) {
    res.status(400).json({
      sucesso: false,
      erro: { codigo: 'ERRO_VALIDACAO', mensagem: 'Parâmetro instancia é obrigatório', codigoStatus: 400 },
    });
    return;
  }

  const instanciaUsuario = await pool.query(
    `SELECT id FROM whatsapp_instances
     WHERE nome_instancia = $1 AND usuario_id = $2 AND deletado_em IS NULL`,
    [instancia, usuarioId]
  );

  if (instanciaUsuario.rows.length === 0) {
    res.status(403).json({
      sucesso: false,
      erro: { codigo: 'N8N_ACESSO_NEGADO', mensagem: 'Sem permissão para acessar esta instância', codigoStatus: 403 },
    });
    return;
  }

  req.instanciaWhatsapp = instanciaUsuario.rows[0] as { id: string };
  next();
}
