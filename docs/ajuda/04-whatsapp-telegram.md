# Configurando WhatsApp e Telegram

## WhatsApp

### Por que precisa de um número dedicado?

O OfertaRelay usa o **Evolution API** para controlar o WhatsApp. Isso significa que o número precisa estar conectado ao sistema 24h. Use um chip dedicado apenas para isso — não o seu número pessoal.

### Criando a instância

1. Acesse **WhatsApp** no menu
2. Clique em **Criar instância**
3. Dê um nome para a instância (ex: "ofertarelay-principal")
4. Escaneie o QR Code no aplicativo do WhatsApp do número dedicado
5. Aguarde o status ficar **Conectado** (ícone verde)

### Status da instância

| Status | Significado |
|--------|-------------|
| 🟢 Conectado | Funcionando normalmente |
| 🟡 Conectando | Aguardando conexão |
| 🔴 Desconectado | Reconecte escaneando o QR Code novamente |

### Se a instância desconectar

1. Acesse **WhatsApp**
2. Clique em **Reconectar**
3. Escaneie o QR Code novamente

> Às vezes o WhatsApp desconecta sozinho. O sistema envia alerta quando isso acontece (se configurado).

### Dicas para evitar banimento

- ✅ Use um número dedicado (não pessoal)
- ✅ Não envie mensagens em excesso num curto período
- ✅ Ative o agendamento com intervalos razoáveis (mínimo 5 min entre envios)
- ❌ Não envie spam ou conteúdo repetido em sequência
- ❌ Não use o número para outras automações simultaneamente

---

## Telegram

O Telegram é **opcional**. Configure se quiser que as ofertas também sejam enviadas para canais/grupos do Telegram.

### Criando um bot

1. No Telegram, converse com **@BotFather**
2. Digite `/newbot` e siga as instruções
3. Copie o **token do bot** fornecido (ex: `7123456789:AAHxxxxxx`)

### Obtendo o Chat ID

Para canais:
1. Adicione o bot como administrador do canal
2. Envie uma mensagem no canal
3. Acesse: `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Copie o `chat.id` da resposta (canais têm ID negativo, ex: `-1001234567890`)

Para grupos:
1. Adicione o bot ao grupo
2. Envie uma mensagem mencionando o bot
3. Acesse o `getUpdates` e copie o `chat.id`

### Configurando no OfertaRelay

1. Acesse **Telegram → Configurações**
2. Cole o **Token do bot**
3. Adicione os **Chat IDs** dos seus canais/grupos
4. Clique em **Testar conexão**
5. Se aparecer ✅, está funcionando

---

## Dúvidas frequentes

**Posso ter mais de uma instância do WhatsApp?**
Sim. Cada instância usa um número diferente.

**O Telegram pode receber ofertas do relay também?**
Sim. Se o Telegram estiver configurado e ativo, ele recebe as mesmas ofertas relayadas.

**O bot do Telegram precisa ser administrador?**
Sim, para canais. Para grupos privados, basta ser membro.
