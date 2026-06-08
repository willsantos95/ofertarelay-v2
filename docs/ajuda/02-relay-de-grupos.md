# Como Funciona o Relay de Grupos

## O que é o Relay?

O **relay** é a funcionalidade principal do OfertaRelay. Ele funciona assim:

```
[Grupo de origem]                    [Seus grupos destino]
Alguém posta uma        ──relay──►   Sua audiência recebe
oferta com link                      a mesma oferta, mas
de outro afiliado                    com o SEU link de afiliado
```

Você entra nos grupos de ofertas de outros criadores como membro comum. O OfertaRelay fica monitorando esses grupos 24h e, quando uma oferta aparece, automaticamente:

1. **Detecta** a mensagem com link de produto
2. **Identifica** a plataforma (Shopee ou Mercado Livre)
3. **Gera** seu link de afiliado para o mesmo produto
4. **Repassa** a mensagem para seus grupos destino com seu link

---

## Configurando grupos de origem (monitorados)

São os grupos **de outros criadores** onde você entra para capturar ofertas.

1. Acesse **Grupos** no menu
2. Na coluna **Papel**, selecione `Origem` para os grupos que deseja monitorar
3. Salve

> Você precisa ser membro desses grupos no WhatsApp conectado.

---

## Configurando grupos destino (seus grupos)

São os grupos **da sua audiência** para onde as ofertas serão repassadas.

1. Acesse **Grupos** no menu
2. Na coluna **Papel**, selecione `Destino` para seus grupos
3. Salve

---

## Como o link de afiliado é gerado no relay

Para cada oferta detectada:
- Se for **Shopee**: usa a API do Shopee Partner para gerar um link de rastreamento
- Se for **Mercado Livre**: gera o link de afiliado com seu ID

Se não for possível gerar o link (ex: produto fora da plataforma suportada), a oferta é repassada com o link original.

---

## Relay para Telegram

Se você também usa Telegram:
1. Configure seu bot em **Telegram → Configurações**
2. Adicione os Chat IDs dos seus canais
3. As ofertas relayadas também serão enviadas para o Telegram automaticamente

---

## Logs do relay

Em **Histórico → Relay Logs**, você vê:
- Horário da oferta capturada
- Grupo de origem
- Destinos para onde foi enviada
- Se o link de afiliado foi gerado com sucesso

---

## Dúvidas frequentes

**O relay funciona quando meu celular está desligado?**
Sim. O relay roda no servidor, não no seu celular. Funciona 24h/7 dias.

**Posso monitorar grupos de qualquer pessoa?**
Sim, desde que o número conectado seja membro desses grupos.

**E se o mesmo produto aparecer várias vezes?**
O sistema detecta duplicatas recentes e não repassa a mesma oferta duas vezes no mesmo período.
