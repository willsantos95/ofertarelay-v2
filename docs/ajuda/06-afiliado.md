# Configurações de Afiliado

## Como o OfertaRelay gera seus links?

O OfertaRelay integra diretamente com as APIs das plataformas para gerar links de afiliado **rastreáveis**. Cada vez que alguém compra pelo seu link, a comissão cai na sua conta da plataforma.

---

## Shopee Partner API

### Como obter as credenciais

1. Acesse [Shopee Open Platform](https://open.shopee.com/)
2. Crie uma conta de desenvolvedor
3. Crie um aplicativo (App)
4. Copie o **App ID** e o **App Secret**

### Configurando no OfertaRelay

1. Acesse **Afiliado → Configurações**
2. Aba **Shopee**
3. Cole o **App ID** e o **App Secret**
4. Clique em **Salvar**
5. Clique em **Testar** para verificar se está funcionando

### O que a integração faz

- Converte qualquer link de produto Shopee no seu link de afiliado
- Gera links com parâmetro `sub_id` para rastreamento por oferta
- Registra cada link gerado em **Afiliado → Logs**

---

## Mercado Livre

### Como obter seu Affiliate ID

1. Acesse o [Programa de Afiliados do ML](https://www.mercadolibre.com/afiliados)
2. Cadastre-se ou faça login
3. Copie seu **Publisher ID** (ou Affiliate ID)

### Configurando no OfertaRelay

1. Acesse **Afiliado → Configurações**
2. Aba **Mercado Livre**
3. Cole seu **Affiliate ID**
4. Clique em **Salvar**

### O que a integração faz

- Adiciona seu ID de afiliado nos links do Mercado Livre
- Converte URLs normais no formato de afiliado do ML

---

## Logs de afiliado

Em **Afiliado → Logs** você vê:
- Data/hora de cada link gerado
- Produto e plataforma
- Contexto: gerado via **relay**, **envio manual** ou **sincronização**
- Status: sucesso ✅ ou falha ❌ (com motivo do erro)
- **Resumo**: total de links gerados, % de sucesso

### Filtrando os logs

Você pode filtrar por:
- **Plataforma**: Shopee ou Mercado Livre
- **Status**: só sucesso ou só erros
- **Contexto**: relay, envio manual, sincronização

### Limpando logs antigos

Para manter o banco de dados limpo:
1. Acesse **Afiliado → Logs**
2. Clique em **Limpar logs**
3. Escolha o período (padrão: 30 dias atrás)
4. Confirme

---

## Dúvidas frequentes

**As comissões são creditadas automaticamente?**
Sim. O dinheiro vai direto para sua conta Shopee/ML. O OfertaRelay apenas gera o link — o rastreamento é das próprias plataformas.

**E se a API da Shopee falhar?**
O sistema usa o link original como fallback. O log registra o erro para auditoria.

**Posso usar apenas uma das plataformas?**
Sim. Configure somente a que você usa. O sistema ignora plataformas sem credenciais.

**Posso ter credenciais diferentes para múltiplos usuários?**
Sim. Cada usuário tem suas próprias credenciais — os links são sempre do usuário que está enviando.
