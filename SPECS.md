# OfertaRelay v2 — Especificações Técnicas

> Última atualização: 2026-06-07

---

## Visão Geral

O **OfertaRelay** é uma plataforma SaaS para afiliados do Shopee e Mercado Livre.  
A funcionalidade central é o **relay automático de grupos WhatsApp**: o sistema monitora grupos de
promoções, detecta links de produto, gera o link de afiliado do usuário logado e encaminha a mensagem
para os grupos de destino — 24h por dia, sem intervenção manual.

Além do relay, a plataforma oferece sincronização via API/scraping, melhoramento de legendas com IA,
fila de agendamento e envio direto para WhatsApp e Telegram.

---

## Arquitetura

```
ofertarelay-v2/          ← Backend Node.js/TypeScript
ofertarelay-frontend/    ← Frontend React/Vite/Tailwind
```

### Stack Backend

| Camada        | Tecnologia                                         |
|---------------|----------------------------------------------------|
| Runtime       | Node.js 20 + TypeScript                           |
| Framework     | Express 4                                          |
| Banco         | PostgreSQL (via `pg` pool)                         |
| Cache/Fila    | Redis + Bull                                       |
| Auth          | JWT (cookie HttpOnly `auth_token`, 7 dias)         |
| Logs          | Pino                                               |
| Testes        | Jest + Supertest                                   |

### Stack Frontend

| Camada        | Tecnologia                                         |
|---------------|----------------------------------------------------|
| Framework     | React 18 + Vite                                    |
| Estilos       | Tailwind CSS                                       |
| Roteamento    | react-router-dom v6                                |
| HTTP          | Fetch nativo (wrapper `src/lib/api.ts`)            |

---

## Estrutura de Arquivos — Backend

```
src/
├── index.ts                      # Entry point: conecta DB/Redis, inicia servidor e worker
├── server.ts                     # criarApp(): cria Express, registra middlewares e rotas
│
├── config/
│   ├── database.ts               # Pool PostgreSQL (conecta e expõe `pool`)
│   └── redis.ts                  # Cliente Redis + helper getRedisBullConfig()
│
├── middleware/
│   ├── authRequired.ts           # autenticacaoRequerida: verifica JWT via cookie ou Bearer
│   ├── autenticacaoN8n.ts        # Verifica x-api-key (chave_api do usuário)
│   ├── errorHandler.ts           # Middleware global de erro (resposta JSON padronizada)
│   └── rateLimiter.ts            # Limitadores por rota (registro, login, webhook, n8n)
│
├── routes/
│   ├── auth.routes.ts            # /api/v1/auth — registro, login, logout, /me
│   ├── whatsapp.routes.ts        # /api/v1/whatsapp — conectar, status, grupos, sincronizar
│   ├── n8n.routes.ts             # /api/v1/n8n — configurações, grupos, registrar-log
│   ├── n8n-compat.routes.ts      # /api/n8n — compatibilidade com workflow legado
│   ├── relay.routes.ts           # /api/v1/relay — logs de relay, stats
│   ├── ofertas.routes.ts         # /api/v1/ofertas — CRUD, sync Shopee/ML, envio, IA
│   ├── agendamento.routes.ts     # /api/v1/agendamento — config e fila de envio
│   ├── afiliado.routes.ts        # /api/v1/afiliado — logs de links de afiliado
│   ├── settings.routes.ts        # /api/v1/settings — configurações afiliado e telegram
│   └── billing.routes.ts         # /api/v1/faturamento (alias /billing) — webhook MP
│
├── services/
│   ├── afiliado.service.ts       # Geração de links (Shopee GraphQL, ML scraping+cookie)
│   ├── envio.service.ts          # Envio WhatsApp/Telegram com geração de link na hora
│   └── ia.service.ts             # Melhora legenda via OpenAI GPT-4o-mini
│
├── jobs/
│   ├── processarFilaAgendamento.ts  # Worker setInterval(60s): drip de envios agendados
│   └── sincronizarGrupos.ts         # Bull job para sincronizar grupos WhatsApp via Evolution API
│
├── migrations/
│   ├── 001_create_users.sql
│   ├── 002_create_billing.sql
│   ├── 003_create_whatsapp.sql
│   ├── 004_create_n8n.sql
│   ├── 005_create_user_settings.sql
│   ├── 006_update_subscriptions.sql
│   ├── 007_add_is_admin_group_cache.sql
│   ├── 008_add_owner_fields.sql
│   ├── 009_add_owner_lid.sql
│   ├── 010_create_ofertas.sql
│   ├── 011_update_ofertas_plataforma.sql
│   ├── 012_create_agendamento.sql    # agendamento_config + agendamento_itens
│   └── 013_affiliate_link_logs.sql   # affiliate_link_logs
│
├── tests/
│   ├── auth.test.ts              # 13 testes — registro, login, cookie, segurança
│   ├── billing.test.ts           # 13 testes — webhook MP, HMAC, idempotência, ROLLBACK
│   ├── n8n.test.ts               # 13 testes — autenticação x-api-key, HMAC, isolamento
│   ├── relay.test.ts             # 13 testes — logs relay, stats, WhatsApp dashboard/grupos
│   ├── settings.test.ts          # 13 testes — affiliate settings, telegram, /auth/me
│   ├── ofertas.test.ts           # 30 testes — CRUD, sync, gerar-link, envio, IA
│   ├── agendamento.test.ts       # 27 testes — config, fila (CRUD), isolamento
│   ├── afiliado.test.ts          # 20 testes — logs, filtros, paginação, delete
│   └── ia.service.test.ts        # 18 testes — OpenAI call, safeguards, erros
│
└── utils/
    ├── logger.ts                 # Wrapper Pino
    └── tokens.ts                 # Geração de JWT e chave_api
```

---

## Estrutura de Arquivos — Frontend

```
src/
├── main.tsx                      # Entry point React
├── App.tsx                       # Rotas: / (landing), /login, /register, /app/* (autenticadas)
├── index.css                     # Tailwind + componentes globais (.card, .btn, .input, .label)
│
├── contexts/
│   └── AuthContext.tsx           # Estado global de usuário + entrar/registrar/sair
│
├── lib/
│   ├── api.ts                    # Wrapper fetch com base URL, cookie, erro 401
│   └── utils.ts                  # Helpers gerais
│
├── components/
│   ├── Layout.tsx                # Sidebar desktop + nav mobile inferior + header
│   ├── ProtectedRoute.tsx        # Redireciona para /login se não autenticado
│   ├── PageHeader.tsx            # Cabeçalho de página (título, subtítulo, action slot)
│   ├── Alert.tsx                 # Componente de alerta (sucesso/erro)
│   └── OnboardingWizard.tsx      # Wizard de configuração inicial
│
└── pages/
    ├── Landing.tsx               # Página pública de venda (relay, features, preço, FAQ)
    ├── Login.tsx                 # Formulário de login
    ├── Register.tsx              # Formulário de cadastro
    ├── ForgotPassword.tsx        # Recuperação de senha
    ├── Dashboard.tsx             # Stats de relay + status WhatsApp + grupos
    ├── WhatsAppSettings.tsx      # Conectar WhatsApp (QR), gerenciar instância
    ├── Groups.tsx                # Configurar grupos de origem e destino
    ├── Ofertas.tsx               # Listar/filtrar ofertas, sync, envio, IA, agendamento
    ├── Agendamento.tsx           # Configurar e gerenciar fila de envio agendado
    ├── AffiliateSettings.tsx     # Credenciais de afiliado (Shopee, ML, Amazon, Magalu, Ali)
    ├── AfiliadoLogs.tsx          # Histórico de links gerados com filtros e resumo
    ├── TelegramSettings.tsx      # Configurar bot e canais Telegram
    ├── Billing.tsx               # Planos e faturamento (Mercado Pago)
    ├── RelayLogs.tsx             # Histórico detalhado de relays
    └── Help.tsx                  # Central de ajuda
```

---

## Banco de Dados — Tabelas Principais

### `users`
| Coluna            | Tipo        | Descrição                                      |
|-------------------|-------------|------------------------------------------------|
| id                | UUID PK     | Identificador único                            |
| nome              | TEXT        |                                                |
| email             | TEXT UNIQUE |                                                |
| senha_hash        | TEXT        | bcryptjs rounds=10                             |
| chave_api         | TEXT UNIQUE | Prefixo `rn8n_` — usada pelo n8n               |
| status_plano      | TEXT        | `trial` · `ativo` · `cancelado` · `suspenso`   |
| trial_termina_em  | TIMESTAMPTZ | Criado com +15 dias                            |

### `whatsapp_instances`
| Coluna          | Tipo    | Descrição                                        |
|-----------------|---------|--------------------------------------------------|
| id              | UUID PK |                                                  |
| usuario_id      | UUID FK |                                                  |
| nome_instancia  | TEXT    | `minisaas_user_{usuarioId}_{telefone}`           |
| telefone        | TEXT    |                                                  |
| status          | TEXT    | `aguardando_conexao` · `conectado` · `desconectado` |
| qrcode          | TEXT    | base64 do QR                                     |

### `whatsapp_groups`
| Coluna     | Tipo | Descrição                              |
|------------|------|----------------------------------------|
| group_jid  | TEXT | JID do grupo (`12036...@g.us`)         |
| usuario_id | UUID |                                        |
| papel      | TEXT | `origem` · `destino`                   |
| nicho      | TEXT |                                        |
| ativo      | BOOL |                                        |

### `relay_logs`
Histórico de mensagens relayadas pelo n8n.

### `ofertas`
| Coluna         | Tipo    | Descrição                                     |
|----------------|---------|-----------------------------------------------|
| id             | UUID PK |                                               |
| item_id        | TEXT UNIQUE | ID da plataforma (itemId Shopee, MLB-xxx) |
| nome           | TEXT    |                                               |
| preco          | NUMERIC |                                               |
| preco_original | NUMERIC | null se sem desconto                          |
| desconto_pct   | INT     |                                               |
| imagem_url     | TEXT    |                                               |
| link_produto   | TEXT    | URL original do produto                       |
| link_afiliado  | TEXT    | Link gerado por quem sincronizou              |
| comissao       | NUMERIC |                                               |
| taxa_comissao  | NUMERIC |                                               |
| categoria_nome | TEXT    | Nome livre (keyword Shopee ou "Mercado Livre")|
| plataforma     | TEXT    | `shopee` · `mercadolivre`                     |
| status         | TEXT    | `pendente` · `enviado`                        |

> **Importante:** `link_afiliado` é global (de quem sincronizou). No envio, o sistema
> regenera o link com as credenciais do usuário logado via `resolverLinkAfiliado()`.

### `agendamento_config`
| Coluna           | Tipo    | Descrição                              |
|------------------|---------|----------------------------------------|
| usuario_id       | UUID PK |                                        |
| intervalo_min    | INT     | Padrão: 7 minutos                      |
| ativo            | BOOL    |                                        |
| grupos           | JSONB   | Array de group JIDs de destino         |
| enviar_telegram  | BOOL    |                                        |
| proximo_envio_em | TIMESTAMPTZ | Quando disparar o próximo item    |

### `agendamento_itens`
| Coluna     | Tipo    | Descrição                                          |
|------------|---------|----------------------------------------------------|
| id         | UUID PK |                                                    |
| usuario_id | UUID FK |                                                    |
| oferta_id  | UUID FK |                                                    |
| legenda    | TEXT    | Legenda personalizada (pode ter sido editada/IA)   |
| status     | TEXT    | `pendente` · `enviado` · `erro`                    |
| enviado_em | TIMESTAMPTZ |                                                |
| erro       | TEXT    | Mensagem de erro se status = `erro`                |

### `affiliate_link_logs`
| Coluna      | Tipo    | Descrição                                       |
|-------------|---------|-------------------------------------------------|
| id          | UUID PK |                                                 |
| usuario_id  | UUID FK |                                                 |
| plataforma  | TEXT    | `shopee` · `mercadolivre`                       |
| contexto    | TEXT    | `envio` · `sincronizacao` · `manual`            |
| url_origem  | TEXT    | URL do produto original                         |
| url_gerada  | TEXT    | Short link gerado (null se falhou)              |
| sucesso     | BOOL    |                                                 |
| erro        | TEXT    |                                                 |
| duracao_ms  | INT     | Tempo de resposta da API                        |

### `user_settings`
Armazena configurações de afiliado (chave: `affiliate`, `telegram`) como JSONB.  
Campos sensíveis (cookies, appSecret, botToken) são mascarados (`***`) ao ler via API.

---

## Rotas da API

### Autenticação — `/api/v1/auth`

| Método | Rota        | Auth | Descrição                                  |
|--------|-------------|------|--------------------------------------------|
| POST   | /registrar  | —    | Cria conta + define cookie JWT             |
| POST   | /entrar     | —    | Login + define cookie JWT                  |
| POST   | /sair       | —    | Limpa cookie `auth_token`                  |
| GET    | /me         | JWT  | Retorna dados do usuário logado            |

### WhatsApp — `/api/v1/whatsapp`

| Método | Rota                    | Auth | Descrição                              |
|--------|-------------------------|------|----------------------------------------|
| POST   | /conectar               | JWT  | Cria instância + retorna QR code       |
| GET    | /status                 | JWT  | Status da instância (Evolution API)    |
| GET    | /dashboard              | JWT  | Instância + grupos + summary           |
| GET    | /grupos                 | JWT  | Lista grupos salvos                    |
| POST   | /grupos/sincronizar     | JWT  | Dispara job de sync via Evolution API  |
| GET    | /grupos/status-sync     | JWT  | Status do job de sync                  |
| POST   | /grupos/salvar          | JWT  | Salva grupos origem/destino            |

### Ofertas — `/api/v1/ofertas`

| Método | Rota                          | Auth | Descrição                                    |
|--------|-------------------------------|------|----------------------------------------------|
| GET    | /                             | JWT  | Lista paginada com filtros                   |
| GET    | /categorias                   | JWT  | Categorias disponíveis com contagem          |
| DELETE | /                             | JWT  | Remove ofertas (all ou por plataforma/status)|
| POST   | /sincronizar                  | JWT  | Importa do Shopee (API Affiliate)            |
| POST   | /sincronizar/mercadolivre     | JWT  | Importa do ML (scraping + cookies)           |
| POST   | /:id/gerar-link-afiliado      | JWT  | Gera link personalizado do usuário logado    |
| POST   | /:id/legenda-ia               | JWT  | Melhora legenda com GPT-4o-mini              |
| POST   | /:id/enviar-whatsapp          | JWT  | Envia oferta para grupos WhatsApp            |
| POST   | /:id/enviar-telegram          | JWT  | Envia oferta para canais Telegram            |

### Agendamento — `/api/v1/agendamento`

| Método | Rota         | Auth | Descrição                                      |
|--------|--------------|------|------------------------------------------------|
| GET    | /config      | JWT  | Retorna (ou cria) config do usuário            |
| PUT    | /config      | JWT  | Atualiza intervalo, ativo, grupos, telegram    |
| GET    | /itens       | JWT  | Lista fila com detalhes da oferta              |
| POST   | /itens       | JWT  | Adiciona ofertas à fila                        |
| PATCH  | /itens/:id   | JWT  | Edita legenda de item pendente                 |
| DELETE | /itens/:id   | JWT  | Remove item da fila                            |
| DELETE | /itens       | JWT  | Limpa fila (all ou por status)                 |

### Afiliado Logs — `/api/v1/afiliado`

| Método | Rota  | Auth | Descrição                                           |
|--------|-------|------|-----------------------------------------------------|
| GET    | /logs | JWT  | Histórico com filtros, resumo e paginação           |
| DELETE | /logs | JWT  | Remove logs antigos (`?dias=N`, padrão 30)          |

### Settings — `/api/v1/settings`

| Método | Rota             | Auth | Descrição                              |
|--------|------------------|------|----------------------------------------|
| GET    | /affiliate       | JWT  | Credenciais de afiliado (mascaradas)   |
| PUT    | /affiliate       | JWT  | Salva credenciais de afiliado          |
| GET    | /telegram        | JWT  | Config Telegram (botToken mascarado)   |
| PUT    | /telegram        | JWT  | Salva config Telegram                  |
| POST   | /telegram/test   | JWT  | Testa conexão com bot                  |

### N8N — `/api/v1/n8n`

| Método | Rota             | Auth       | Descrição                           |
|--------|------------------|------------|-------------------------------------|
| GET    | /configuracoes   | x-api-key  | Config completa para o workflow     |
| GET    | /grupos          | x-api-key  | Grupos origem/destino               |
| POST   | /registrar-log   | x-api-key + HMAC | Registra log de relay         |

### Faturamento — `/api/v1/faturamento`

| Método | Rota                    | Auth      | Descrição                          |
|--------|-------------------------|-----------|-------------------------------------|
| POST   | /webhook/mercadopago    | HMAC-SHA256 | Recebe notificações do MP         |

---

## Serviços

### `afiliado.service.ts`

```typescript
getShopeeCredenciais(usuarioId): { appId, appSecret } | null
getMLCredenciais(usuarioId): { tag, cookies, urls[] } | null
shopeeSign(appId, ts, payload, secret): string          // SHA256
gerarShortLinkShopee(appId, secret, originUrl, opts?): string | null
gerarLinkAfiliadoML(url, tag, cookies, opts?): { shortUrl, cookiesAtualizados }
persistirCookiesML(usuarioId, cookies): void            // fire-and-forget
resolverLinkAfiliado(usuarioId, oferta, contexto?): string
logLink(opts): void                                     // fire-and-forget → affiliate_link_logs
```

**Contextos de log:** `'envio'` | `'sincronizacao'` | `'manual'`

### `envio.service.ts`

```typescript
gerarLegendaPadrao(oferta: OfertaLegenda): string
prepararEnvio(usuarioId, ofertaId, legenda): { legenda, imagem_url }
  // regenera link de afiliado do usuário logado + substitui na legenda
enviarOfertaWhatsApp(usuarioId, ofertaId, legenda, grupos?): { sucesso, enviados, erros }
enviarOfertaTelegram(usuarioId, ofertaId, legenda, chatIds?): { sucesso, enviados, erros }
```

### `ia.service.ts`

```typescript
iaConfigurada(): boolean   // verifica OPENAI_API_KEY
melhorarLegendaIA(legendaAtual, ctx: ContextoLegenda): Promise<string>
```

**System prompt:** estilo coloquial brasileiro, linguagem de amigo que achou oferta.  
**Safeguards:** mantém link idêntico, mantém preço, max 4 emojis, até 4 linhas.  
**Post-processamento:** remove aspas, reinsere link se removido pela IA.

---

## Jobs

### `processarFilaAgendamento.ts`

- `setInterval(processarFila, 60_000)` — roda a cada 60 segundos
- Para cada `agendamento_config` com `ativo=true` e `proximo_envio_em <= NOW()`:
  1. Busca o item `pendente` mais antigo do usuário
  2. Chama `enviarOfertaWhatsApp` e/ou `enviarOfertaTelegram`
  3. Marca item como `enviado` ou `erro`
  4. Avança `proximo_envio_em` pelo `intervalo_min`
- Itens com config inválida (sem WhatsApp) voltam para `pendente` (retry no próximo tick)

### `sincronizarGrupos.ts`

Bull job que consulta Evolution API e atualiza `whatsapp_groups` com os grupos disponíveis.

---

## Integrações Externas

### Shopee Affiliate API
- **URL:** `https://open-api.affiliate.shopee.com.br/graphql`
- **Auth:** `SHA256 Credential={appId}, Timestamp={ts}, Signature={sig}`
- **Assinatura:** `HMAC-SHA256(appId + ts + JSON.stringify(payload), appSecret)`
- **Query:** `productOfferV2` com args: `listType`, `keyword`, `sortType`, `page`, `limit`
- **Short link:** mutation `generateShortLink(originUrl)` → `shortLink`

### Mercado Livre (scraping)
- Scraping de páginas de categoria com `node-html-parser`
- Seletores: `.poly-card` → `.poly-card__content` → `h3 > a`, `.poly-component__price`
- Geração de link: GET para atualizar cookies + POST `createLink` com tag e cookies
- Cookies são persistidos após cada atualização

### Evolution API (WhatsApp)
- **Endpoints:** `POST /message/sendMedia`, `POST /message/sendText`
- **Auth:** `apikey` header
- **Webhook n8n:** `POST https://n8n.relampagodeofertas.shop/webhook/...` ao conectar

### Telegram Bot API
- `POST https://api.telegram.org/bot{token}/sendPhoto` (com caption)
- `POST .../sendMessage` (para fallback sem imagem)
- `parse_mode: Markdown`

### OpenAI
- **Modelo:** `gpt-4o-mini` (ou `OPENAI_MODEL` env)
- **Endpoint:** `POST https://api.openai.com/v1/chat/completions`
- **Parâmetros:** `temperature: 0.8`, `max_tokens: 400`, timeout: 30s

### Mercado Pago (webhook)
- Assinatura: `HMAC-SHA256` no header `x-signature` (formato `ts=...,v1=...`)
- Idempotência: tabela `webhook_idempotency`
- Timeout de timestamp: 300 segundos

---

## Segurança

| Mecanismo          | Onde                                     | Detalhe                              |
|--------------------|------------------------------------------|--------------------------------------|
| JWT HttpOnly       | Cookie `auth_token`                      | 7 dias, `sameSite: strict`           |
| Limpeza no logout  | `POST /auth/sair`                        | `res.clearCookie('auth_token')`      |
| HMAC-SHA256        | Webhook MP, registrar-log n8n            | Timestamp max 300s                   |
| x-api-key          | Rotas n8n                                | Prefixo `rn8n_`, indexado no banco   |
| Isolamento         | Todas as queries autenticadas            | `WHERE usuario_id = $N`              |
| Mascaramento       | GET /settings/affiliate, GET /telegram   | Campos sensíveis → `***`             |
| Sanitização XSS    | express-validator `.escape()` no nome   | Registro                             |
| Rate limiting      | express-rate-limit por rota              | Registro, login, webhook             |

---

## Variáveis de Ambiente

### Backend (`ofertarelay-v2`)

```env
# Obrigatórias
DATABASE_URL=postgresql://user:pass@host:5432/dbname
JWT_SECRET=<min 32 chars>
REDIS_URL=redis://host:6379

# Evolution API (WhatsApp)
EVOLUTION_API_URL=https://seu-evolution.com
EVOLUTION_API_KEY=sua-chave

# Mercado Pago
MERCADOPAGO_WEBHOOK_SECRET=<min 32 chars>
MERCADOPAGO_ACCESS_TOKEN=APP_USR-...
MERCADOPAGO_API_URL=https://api.mercadopago.com

# N8N
N8N_WEBHOOK_SECRET=<min 32 chars>
N8N_WEBHOOK_CONECTAR=https://n8n.relampagodeofertas.shop/webhook/2a92f9c3-...

# IA (opcional)
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini   # padrão

# App
PORT=3000
FRONTEND_URL=https://seu-frontend.com
```

### Frontend (`ofertarelay-frontend`)

```env
VITE_API_URL=https://sua-api.com/api/v1
```

---

## Testes

### Executar

```bash
cd ofertarelay-v2
npm test                    # todos os testes
npm test -- --testPathPattern=auth       # módulo específico
npm test -- --coverage                   # com cobertura
```

### Suítes disponíveis

| Arquivo                   | Módulo        | Testes | Cobertura principal                                   |
|---------------------------|---------------|--------|-------------------------------------------------------|
| `auth.test.ts`            | Auth          | 13     | Registro, login, cookie HttpOnly, segurança           |
| `billing.test.ts`         | Billing       | 13     | Webhook MP, HMAC, idempotência, ROLLBACK, status      |
| `n8n.test.ts`             | N8N           | 13     | x-api-key, HMAC, isolamento, chave_api nunca exposta  |
| `relay.test.ts`           | Relay/WA      | 13     | Logs relay, stats, dashboard, grupos                  |
| `settings.test.ts`        | Settings      | 13     | Afiliado settings, mascaramento, telegram, /auth/me   |
| `ofertas.test.ts`         | Ofertas       | 30     | CRUD, filtros, sync, gerar-link, IA, envio WA/TG      |
| `agendamento.test.ts`     | Agendamento   | 27     | Config (range), fila CRUD, isolamento, legenda vazia  |
| `afiliado.test.ts`        | Afiliado Logs | 20     | Filtros, paginação, delete, estrutura de log          |
| `ia.service.test.ts`      | IA Service    | 18     | OpenAI call, safeguards, link reinsert, erros API     |
| **Total**                 |               | **160**|                                                       |

### Padrão de mock

Todos os testes de integração (supertest) usam o mesmo padrão de isolamento:

```typescript
jest.mock('../config/database', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../config/redis',    () => ({ redisClient: { ... }, getRedisBullConfig: ... }));
jest.mock('../middleware/rateLimiter', () => ({ /* bypassAll */ }));
jest.mock('bull', () => jest.fn().mockImplementation(() => ({ add, process, on })));
// Serviços externos mockados individualmente por suíte
```

Os serviços de terceiros (`fetch`, `afiliado.service`, `envio.service`, `ia.service`) são
mockados com `jest.fn()` para que os testes sejam determinísticos e não façam chamadas reais.

---

## Rotas Frontend

| Path                  | Componente          | Auth | Descrição                     |
|-----------------------|---------------------|------|-------------------------------|
| `/`                   | Landing             | —    | Landing page pública          |
| `/landing`            | Landing             | —    | Alias público                 |
| `/login`              | Login               | —    |                               |
| `/register`           | Register            | —    |                               |
| `/forgot-password`    | ForgotPassword      | —    |                               |
| `/app`                | Dashboard           | ✓    |                               |
| `/app/whatsapp`       | WhatsAppSettings    | ✓    |                               |
| `/app/groups`         | Groups              | ✓    |                               |
| `/app/ofertas`        | Ofertas             | ✓    |                               |
| `/app/agendamento`    | Agendamento         | ✓    |                               |
| `/app/affiliate`      | AffiliateSettings   | ✓    |                               |
| `/app/affiliate/logs` | AfiliadoLogs        | ✓    |                               |
| `/app/telegram`       | TelegramSettings    | ✓    |                               |
| `/app/billing`        | Billing             | ✓    |                               |
| `/app/relay-logs`     | RelayLogs           | ✓    |                               |
| `/app/help`           | Help                | ✓    |                               |

---

## Fluxo de Relay (principal)

```
1. Usuário conecta WhatsApp via QR (Evolution API)
2. Workflow n8n recebe mensagens dos grupos monitorados (origem)
3. n8n detecta link Shopee/ML na mensagem
4. n8n consulta GET /api/v1/n8n/configuracoes?instancia=... (x-api-key)
5. n8n consulta GET /api/v1/n8n/grupos?instancia=... → grupos de destino
6. n8n gera link de afiliado usando credenciais do usuário
7. n8n encaminha mensagem com novo link para grupos de destino (WhatsApp + Telegram)
8. n8n registra log: POST /api/v1/n8n/registrar-log (x-api-key + HMAC)
9. Log aparece em /app/relay-logs
```

## Fluxo de Envio Manual

```
1. Usuário acessa /app/ofertas
2. Clica em "Enviar" numa oferta
3. Modal abre → sistema chama POST /ofertas/:id/gerar-link-afiliado
   → Shopee: generateShortLink com appId/secret do usuário
   → ML: refresh cookies + createLink com tag do usuário
4. Link é injetado na legenda (substitui o link global armazenado)
5. Usuário pode clicar "Melhorar com IA" → POST /ofertas/:id/legenda-ia
6. Usuário seleciona grupos e confirma → POST /ofertas/:id/enviar-whatsapp
```

## Fluxo de Agendamento

```
1. Usuário seleciona ofertas em /app/ofertas → checkbox + "Adicionar à fila"
2. POST /agendamento/itens → insere em agendamento_itens (status: pendente)
3. Em /app/agendamento: configura intervalo_min e ativa
4. Worker (setInterval 60s): a cada tick, para cada config ativa vencida:
   a. Busca item pendente mais antigo
   b. Chama enviarOfertaWhatsApp + enviarOfertaTelegram (via envio.service)
      → regenera link de afiliado na hora com credenciais do usuário
   c. Marca enviado/erro · avança proximo_envio_em
```
