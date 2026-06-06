import jwt from 'jsonwebtoken';

interface UsuarioPayload {
  id: string;
  email: string;
  nome: string;
}

export function gerarToken(usuario: UsuarioPayload): string {
  return jwt.sign(
    { id: usuario.id, email: usuario.email, nome: usuario.nome },
    process.env.JWT_SECRET as string,
    { expiresIn: '7d' }
  );
}

export function verificarToken(token: string): UsuarioPayload & { iat: number; exp: number } {
  try {
    return jwt.verify(token, process.env.JWT_SECRET as string) as UsuarioPayload & {
      iat: number;
      exp: number;
    };
  } catch (erro: unknown) {
    if (erro instanceof Error && erro.name === 'TokenExpiredError') {
      throw new Error('Token expirado');
    }
    throw new Error('Token inválido');
  }
}
