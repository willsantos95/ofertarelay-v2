// Leitura e gravação centralizadas de user_settings.
// - Descriptografa/criptografa campos sensíveis (ver utils/cripto)
// - Ao salvar, preserva o valor real quando o frontend devolve o valor mascarado (***abcd)

import { pool } from '../config/database';
import { criptografar, descriptografar } from '../utils/cripto';

export type TipoSetting = 'affiliate' | 'telegram' | 'relay';
type Payload = Record<string, unknown>;

/** Caminhos (plataforma.campo ou campo) com segredos, por tipo de setting. */
const CAMPOS_SENSIVEIS: Record<string, string[]> = {
  affiliate: ['amazon.cookies', 'mercadoLivre.cookies', 'shopee.appSecret', 'aliexpress.apiSecret'],
  telegram:  ['botToken'],
  relay:     [],
};

function ler(obj: Payload, caminho: string): unknown {
  return caminho.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Payload)[k] : undefined), obj);
}

function escrever(obj: Payload, caminho: string, valor: unknown): void {
  const partes = caminho.split('.');
  let atual: Payload = obj;
  for (let i = 0; i < partes.length - 1; i++) {
    const k = partes[i];
    if (!atual[k] || typeof atual[k] !== 'object') atual[k] = {};
    atual[k] = { ...(atual[k] as Payload) };
    atual = atual[k] as Payload;
  }
  atual[partes[partes.length - 1]] = valor;
}

function clonar<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? {})) as T;
}

/** Um valor mascarado (como a API devolve no GET) — nunca deve ser gravado. */
export function eValorMascarado(valor: unknown): boolean {
  return typeof valor === 'string' && valor.startsWith('***');
}

export function mascararValor(valor: string): string {
  return valor ? '***' + valor.slice(-4) : '';
}

function transformarSensiveis(tipo: string, payload: Payload, fn: (v: string) => string): Payload {
  const copia = clonar(payload);
  for (const caminho of CAMPOS_SENSIVEIS[tipo] || []) {
    const v = ler(copia, caminho);
    if (typeof v === 'string' && v) escrever(copia, caminho, fn(v));
  }
  return copia;
}

/** Versão do payload para mostrar no frontend (segredos mascarados). */
export function mascararPayload(tipo: string, payload: Payload): Payload {
  return transformarSensiveis(tipo, payload, mascararValor);
}

/** Lê um setting já descriptografado. `null` quando o usuário nunca salvou. */
export async function lerSetting(usuarioId: string, tipo: TipoSetting): Promise<Payload | null> {
  const r = await pool.query(
    `SELECT payload FROM user_settings WHERE usuario_id = $1 AND tipo = $2`,
    [usuarioId, tipo]
  );
  if (!r.rows.length) return null;
  return transformarSensiveis(tipo, (r.rows[0].payload || {}) as Payload, descriptografar);
}

/** Lê todos os settings do usuário, descriptografados, indexados por tipo. */
export async function lerTodosSettings(usuarioId: string): Promise<Record<string, Payload>> {
  const r = await pool.query(
    `SELECT tipo, payload FROM user_settings WHERE usuario_id = $1`,
    [usuarioId]
  );
  const saida: Record<string, Payload> = {};
  for (const row of r.rows as { tipo: string; payload: Payload }[]) {
    saida[row.tipo] = transformarSensiveis(row.tipo, row.payload || {}, descriptografar);
  }
  return saida;
}

/**
 * Grava um setting. Campos sensíveis que chegam mascarados (***abcd) ou ausentes
 * mantêm o valor que já estava salvo; string vazia limpa o campo de propósito.
 */
export async function salvarSetting(usuarioId: string, tipo: TipoSetting, novo: Payload): Promise<Payload> {
  const atual = (await lerSetting(usuarioId, tipo)) || {};
  const final = clonar(novo);

  for (const caminho of CAMPOS_SENSIVEIS[tipo] || []) {
    const valorNovo = ler(final, caminho);
    if (valorNovo === undefined || eValorMascarado(valorNovo)) {
      const valorAntigo = ler(atual, caminho);
      escrever(final, caminho, typeof valorAntigo === 'string' ? valorAntigo : '');
    }
  }

  const gravar = transformarSensiveis(tipo, final, criptografar);
  await pool.query(
    `INSERT INTO user_settings (usuario_id, tipo, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (usuario_id, tipo)
     DO UPDATE SET payload = $3, atualizado_em = NOW()`,
    [usuarioId, tipo, JSON.stringify(gravar)]
  );
  return final;
}

// ─────────────────────────────────────────────
// Configuração do relay (cabeçalho, rodapé, ritmo de envio)
// ─────────────────────────────────────────────

export interface ConfigRelay {
  cabecalho: string;
  rodape: string;
  intervaloEnvioSeg: number;
  limiteDiario: number;
  janelaDedupHoras: number;
}

export const CONFIG_RELAY_PADRAO: ConfigRelay = {
  cabecalho: '',
  rodape: '',
  intervaloEnvioSeg: 5,
  limiteDiario: 0,
  janelaDedupHoras: 12,
};

function inteiroEntre(v: unknown, min: number, max: number, padrao: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, n));
}

export function normalizarConfigRelay(p: Payload | null | undefined): ConfigRelay {
  const o = p || {};
  return {
    cabecalho: String(o.cabecalho ?? '').slice(0, 300),
    rodape: String(o.rodape ?? '').slice(0, 300),
    intervaloEnvioSeg: inteiroEntre(o.intervaloEnvioSeg, 1, 120, CONFIG_RELAY_PADRAO.intervaloEnvioSeg),
    limiteDiario: inteiroEntre(o.limiteDiario, 0, 1000, CONFIG_RELAY_PADRAO.limiteDiario),
    janelaDedupHoras: inteiroEntre(o.janelaDedupHoras, 0, 168, CONFIG_RELAY_PADRAO.janelaDedupHoras),
  };
}

export async function lerConfigRelay(usuarioId: string): Promise<ConfigRelay> {
  return normalizarConfigRelay(await lerSetting(usuarioId, 'relay'));
}
