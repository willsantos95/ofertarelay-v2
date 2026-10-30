// Landing page pública do usuário ("link na bio"): imagem, nome do grupo e botões.

import { pool } from '../config/database';

export const TIPOS_BOTAO = ['whatsapp_grupo', 'whatsapp_canal', 'telegram', 'instagram', 'link'] as const;
export type TipoBotao = typeof TIPOS_BOTAO[number];

/** Caminhos que já são do app ou da infraestrutura e não podem virar slug. */
export const SLUGS_RESERVADOS = new Set([
  'app', 'api', 'admin', 'landing', 'login', 'register', 'cadastro', 'entrar', 'sair', 'logout',
  'forgot-password', 'esqueci-senha', 'reset-password', 'redefinir-senha', 'confirmar-email', 'help', 'ajuda', 'assets', 'static', 'public',
  'health', 'billing', 'checkout', 'ofertas', 'grupos', 'groups', 'whatsapp', 'telegram', 'afiliado',
  'affiliate', 'relay', 'relay-logs', 'agendamento', 'dashboard', 'configuracoes', 'settings',
  'termos', 'privacidade', 'suporte', 'contato', 'ofertarelay', 'www', 'index', 'favicon',
]);

export interface Botao {
  id?: string;
  rotulo: string;
  url: string;
  tipo: TipoBotao;
  ativo: boolean;
  ordem?: number;
  cliques?: number;
}

export interface Landing {
  id: string;
  usuario_id: string;
  slug: string;
  titulo: string;
  descricao: string;
  cor: string;
  publicada: boolean;
  tem_imagem: boolean;
  imagem_atualizada_em: string | null;
  visitas: number;
  botoes: Botao[];
}

export function normalizarSlug(s: unknown): string {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Mensagem de erro, ou null quando o slug é válido (não verifica se está livre). */
export function validarSlug(slug: string): string | null {
  if (slug.length < 3 || slug.length > 40) return 'O endereço deve ter de 3 a 40 caracteres.';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return 'Use apenas letras minúsculas, números e hífen.';
  if (SLUGS_RESERVADOS.has(slug)) return 'Esse endereço é reservado. Escolha outro.';
  return null;
}

/** Só http(s), sem credenciais embutidas. */
export function urlSegura(u: unknown): string | null {
  const s = String(u || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(s)) return null;
  if (/^https?:\/\/[^/]*@/i.test(s)) return null;
  return s.slice(0, 2000);
}

export function corValida(c: unknown): string {
  const s = String(c || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : '#16a34a';
}

export async function slugDisponivel(slug: string, usuarioId?: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT usuario_id FROM landing_pages WHERE LOWER(slug) = LOWER($1)`,
    [slug]
  );
  if (!r.rows.length) return true;
  return !!usuarioId && r.rows[0].usuario_id === usuarioId;
}

const COLUNAS = `id, usuario_id, slug, titulo, descricao, cor, publicada,
  (imagem IS NOT NULL) AS tem_imagem, imagem_atualizada_em, visitas`;

async function anexarBotoes(l: Omit<Landing, 'botoes'>, apenasAtivos: boolean): Promise<Landing> {
  const r = await pool.query(
    `SELECT id, rotulo, url, tipo, ativo, ordem, cliques
     FROM landing_botoes
     WHERE landing_id = $1 ${apenasAtivos ? 'AND ativo = TRUE' : ''}
     ORDER BY ordem, criado_em`,
    [l.id]
  );
  return { ...l, botoes: r.rows as Botao[] };
}

export async function buscarLandingDoUsuario(usuarioId: string): Promise<Landing | null> {
  const r = await pool.query(`SELECT ${COLUNAS} FROM landing_pages WHERE usuario_id = $1`, [usuarioId]);
  if (!r.rows.length) return null;
  return anexarBotoes(r.rows[0], false);
}

export async function buscarLandingPublica(slug: string): Promise<Landing | null> {
  const r = await pool.query(
    `SELECT ${COLUNAS} FROM landing_pages WHERE LOWER(slug) = LOWER($1) AND publicada = TRUE`,
    [slug]
  );
  if (!r.rows.length) return null;
  return anexarBotoes(r.rows[0], true);
}
