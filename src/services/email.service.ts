// Envio de e-mails transacionais (redefinição de senha, confirmação de cadastro, avisos).
// O servidor SMTP é configurado pelo admin no painel (tabela configuracoes_sistema, chave 'email').
// Sem configuração no banco, usa as variáveis SMTP_* do ambiente, se existirem.

import nodemailer, { Transporter } from 'nodemailer';
import { pool } from '../config/database';
import { logger } from '../utils/logger';
import { criptografar, descriptografar } from '../utils/cripto';

export interface ConfigEmail {
  ativo: boolean;
  host: string;
  porta: number;
  seguro: boolean;          // true = SSL direto (465); false = STARTTLS (587)
  usuario: string;
  senha: string;
  remetenteNome: string;
  remetenteEmail: string;
  responderPara: string;
  urlApp: string;           // endereço do painel, usado nos links dos e-mails
}

export const CONFIG_EMAIL_PADRAO: ConfigEmail = {
  ativo: false,
  host: 'smtp.hostinger.com',
  porta: 465,
  seguro: true,
  usuario: '',
  senha: '',
  remetenteNome: 'OfertaRelay',
  remetenteEmail: '',
  responderPara: '',
  urlApp: '',
};

export type TipoEmail = 'redefinir_senha' | 'confirmar_email' | 'boas_vindas' | 'senha_alterada' | 'teste';

const MASCARA = '********';

function doAmbiente(): Partial<ConfigEmail> {
  if (!process.env.SMTP_HOST) return {};
  return {
    ativo: true,
    host: process.env.SMTP_HOST,
    porta: parseInt(process.env.SMTP_PORT || '465'),
    seguro: (process.env.SMTP_SECURE ?? 'true') !== 'false',
    usuario: process.env.SMTP_USER || '',
    senha: process.env.SMTP_PASS || '',
    remetenteEmail: process.env.SMTP_FROM || process.env.SMTP_USER || '',
    remetenteNome: process.env.SMTP_FROM_NAME || 'OfertaRelay',
  };
}

export function normalizarConfigEmail(x: Record<string, unknown>): ConfigEmail {
  const porta = Number(x.porta);
  return {
    ativo: x.ativo === true,
    host: String(x.host ?? CONFIG_EMAIL_PADRAO.host).trim().slice(0, 200),
    porta: Number.isInteger(porta) && porta > 0 && porta < 65536 ? porta : CONFIG_EMAIL_PADRAO.porta,
    seguro: x.seguro === undefined ? true : x.seguro === true,
    usuario: String(x.usuario ?? '').trim().slice(0, 255),
    senha: String(x.senha ?? ''),
    remetenteNome: String(x.remetenteNome ?? 'OfertaRelay').trim().slice(0, 100) || 'OfertaRelay',
    remetenteEmail: String(x.remetenteEmail ?? '').trim().slice(0, 255),
    responderPara: String(x.responderPara ?? '').trim().slice(0, 255),
    urlApp: String(x.urlApp ?? '').trim().replace(/\/$/, '').slice(0, 255),
  };
}

/** Configuração efetiva (banco > ambiente > padrão), com a senha já descriptografada. */
export async function lerConfigEmail(): Promise<ConfigEmail> {
  const r = await pool.query(`SELECT payload FROM configuracoes_sistema WHERE chave = 'email'`);
  const salvo = (r.rows[0]?.payload || null) as Record<string, unknown> | null;
  if (!salvo) return { ...CONFIG_EMAIL_PADRAO, ...doAmbiente(), urlApp: urlAppPadrao() };
  const c = normalizarConfigEmail(salvo);
  c.senha = c.senha ? descriptografar(c.senha) : '';
  if (!c.urlApp) c.urlApp = urlAppPadrao();
  return c;
}

/** Para a tela do admin: nunca devolve a senha. */
export function configParaTela(c: ConfigEmail): Omit<ConfigEmail, 'senha'> & { senha: string; senhaDefinida: boolean } {
  return { ...c, senha: c.senha ? MASCARA : '', senhaDefinida: !!c.senha };
}

/** Salva; senha vazia ou mascarada mantém a atual. */
export async function salvarConfigEmail(entrada: Record<string, unknown>, adminEmail: string): Promise<ConfigEmail> {
  const atual = await lerConfigEmail();
  const nova = normalizarConfigEmail(entrada);
  const senhaRecebida = typeof entrada.senha === 'string' ? entrada.senha : '';
  nova.senha = !senhaRecebida || senhaRecebida === MASCARA ? atual.senha : senhaRecebida;

  await pool.query(
    `INSERT INTO configuracoes_sistema (chave, payload, atualizado_em, atualizado_por)
     VALUES ('email', $1, NOW(), $2)
     ON CONFLICT (chave) DO UPDATE SET payload = $1, atualizado_em = NOW(), atualizado_por = $2`,
    [JSON.stringify({ ...nova, senha: nova.senha ? criptografar(nova.senha) : '' }), adminEmail]
  );
  return nova;
}

export function urlAppPadrao(): string {
  // APP_URL é o endereço da API (usado pelo Mercado Pago), não serve para links do painel
  return (process.env.PUBLIC_URL || process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/$/, '');
}

export function criarTransporte(c: ConfigEmail): Transporter {
  return nodemailer.createTransport({
    host: c.host,
    port: c.porta,
    secure: c.seguro,
    auth: c.usuario ? { user: c.usuario, pass: c.senha } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

export function emailConfigurado(c: ConfigEmail): boolean {
  return c.ativo && !!c.host && !!c.usuario && !!c.senha;
}

// ── Modelos ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

function layout(titulo: string, corpo: string, botao?: { texto: string; url: string }, rodape?: string): string {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px">
<tr><td style="font-size:20px;font-weight:bold;color:#16a34a;padding-bottom:16px">OfertaRelay</td></tr>
<tr><td style="font-size:18px;font-weight:bold;padding-bottom:12px">${esc(titulo)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55">${corpo}</td></tr>
${botao ? `<tr><td style="padding:24px 0"><a href="${esc(botao.url)}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">${esc(botao.texto)}</a></td></tr>
<tr><td style="font-size:12px;color:#6b7280;word-break:break-all">Se o botão não funcionar, copie e cole este endereço no navegador:<br>${esc(botao.url)}</td></tr>` : ''}
<tr><td style="font-size:12px;color:#9ca3af;padding-top:24px">${rodape ? esc(rodape) : 'Você recebeu este e-mail porque tem uma conta no OfertaRelay.'}</td></tr>
</table></td></tr></table></body></html>`;
}

export function montarEmail(tipo: TipoEmail, dados: { nome?: string; url?: string }): { assunto: string; html: string; texto: string } {
  const nome = dados.nome ? esc(dados.nome) : '';
  const ola = nome ? `Olá, ${nome}!` : 'Olá!';
  switch (tipo) {
    case 'redefinir_senha':
      return {
        assunto: 'Redefinir sua senha do OfertaRelay',
        html: layout('Redefinir senha',
          `<p>${ola}</p><p>Recebemos um pedido para redefinir a senha da sua conta. O link vale por 1 hora.</p><p>Se não foi você, pode ignorar este e-mail: sua senha continua a mesma.</p>`,
          { texto: 'Criar nova senha', url: dados.url! }),
        texto: `${ola}\n\nPara criar uma nova senha, acesse (vale por 1 hora):\n${dados.url}\n\nSe não foi você, ignore este e-mail.`,
      };
    case 'confirmar_email':
      return {
        assunto: 'Confirme seu e-mail no OfertaRelay',
        html: layout('Confirme seu e-mail',
          `<p>${ola}</p><p>Falta só confirmar que este e-mail é seu. O link vale por 3 dias.</p>`,
          { texto: 'Confirmar e-mail', url: dados.url! }),
        texto: `${ola}\n\nConfirme seu e-mail acessando:\n${dados.url}`,
      };
    case 'boas_vindas':
      return {
        assunto: 'Bem-vindo ao OfertaRelay',
        html: layout('Sua conta está pronta',
          `<p>${ola}</p><p>Seu e-mail foi confirmado. Conecte seu WhatsApp e escolha os grupos de origem e destino para começar a publicar ofertas.</p>`,
          dados.url ? { texto: 'Abrir o painel', url: dados.url } : undefined),
        texto: `${ola}\n\nSeu e-mail foi confirmado.${dados.url ? `\n\nAbra o painel: ${dados.url}` : ''}`,
      };
    case 'senha_alterada':
      return {
        assunto: 'Sua senha do OfertaRelay foi alterada',
        html: layout('Senha alterada',
          `<p>${ola}</p><p>A senha da sua conta acabou de ser alterada. Se não foi você, redefina a senha agora e fale com o suporte.</p>`,
          dados.url ? { texto: 'Redefinir senha', url: dados.url } : undefined),
        texto: `${ola}\n\nA senha da sua conta foi alterada. Se não foi você, redefina em: ${dados.url || ''}`,
      };
    case 'teste':
    default:
      return {
        assunto: 'Teste de e-mail do OfertaRelay',
        html: layout('Funcionou!', '<p>O servidor de e-mail do OfertaRelay está configurado corretamente.</p>'),
        texto: 'O servidor de e-mail do OfertaRelay está configurado corretamente.',
      };
  }
}

// ── Envio ──────────────────────────────────────────────────────────────────

export interface ResultadoEnvioEmail { enviado: boolean; erro?: string }

export async function enviarEmail(
  para: string,
  tipo: TipoEmail,
  dados: { nome?: string; url?: string } = {},
  configForcada?: ConfigEmail
): Promise<ResultadoEnvioEmail> {
  let erro: string | undefined;
  try {
    const c = configForcada || await lerConfigEmail();
    if (!configForcada && !emailConfigurado(c)) {
      erro = 'Servidor de e-mail não configurado';
    } else {
      const m = montarEmail(tipo, dados);
      await criarTransporte(c).sendMail({
        from: { name: c.remetenteNome, address: c.remetenteEmail || c.usuario },
        to: para,
        replyTo: c.responderPara || undefined,
        subject: m.assunto,
        html: m.html,
        text: m.texto,
      });
    }
  } catch (e) {
    erro = (e as Error).message?.slice(0, 500) || 'Falha ao enviar';
  }

  pool.query(
    `INSERT INTO email_logs (para, tipo, status, erro) VALUES ($1, $2, $3, $4)`,
    [para, tipo, erro ? 'falha' : 'enviado', erro || null]
  ).catch(() => undefined);

  if (erro) logger.warn({ para, tipo, erro }, 'E-mail não enviado');
  return erro ? { enviado: false, erro } : { enviado: true };
}

/** Dispara sem segurar a resposta HTTP. */
export function enviarEmailEmSegundoPlano(para: string, tipo: TipoEmail, dados: { nome?: string; url?: string } = {}): void {
  enviarEmail(para, tipo, dados).catch(() => undefined);
}
