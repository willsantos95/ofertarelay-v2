// Criptografia simétrica (AES-256-GCM) para credenciais guardadas em user_settings.
// Opt-in: só criptografa quando CHAVE_CRIPTOGRAFIA está definida. Valores antigos,
// em texto puro, continuam sendo lidos normalmente — a migração acontece no próximo save.

import crypto from 'crypto';

const PREFIXO = 'enc:v1:';

function obterChave(): Buffer | null {
  const bruta = process.env.CHAVE_CRIPTOGRAFIA || '';
  if (!bruta) return null;
  // Aceita hex (64 caracteres) ou qualquer texto — neste caso deriva 32 bytes via SHA-256
  if (/^[0-9a-fA-F]{64}$/.test(bruta)) return Buffer.from(bruta, 'hex');
  return crypto.createHash('sha256').update(bruta).digest();
}

export function criptografiaAtiva(): boolean {
  return obterChave() !== null;
}

export function estaCriptografado(valor: unknown): boolean {
  return typeof valor === 'string' && valor.startsWith(PREFIXO);
}

/** Criptografa um texto. Sem chave configurada, devolve o texto como veio. */
export function criptografar(texto: string): string {
  const chave = obterChave();
  if (!chave || !texto || estaCriptografado(texto)) return texto;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const corpo = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIXO + Buffer.concat([iv, tag, corpo]).toString('base64');
}

/** Descriptografa um texto. Texto puro passa direto; sem chave, valor criptografado vira ''. */
export function descriptografar(valor: string): string {
  if (!estaCriptografado(valor)) return valor;
  const chave = obterChave();
  if (!chave) return '';
  try {
    const dados = Buffer.from(valor.slice(PREFIXO.length), 'base64');
    const iv = dados.subarray(0, 12);
    const tag = dados.subarray(12, 28);
    const corpo = dados.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', chave, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(corpo), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
