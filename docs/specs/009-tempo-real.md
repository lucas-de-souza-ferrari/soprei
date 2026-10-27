# 009 — Tempo real: SSE e WebSocket

- **Status:** esboço (sob demanda: reler contra o código antes de aprovar; gatilho: painel precisar de eventos ao vivo)
- **Branch:** `spec/009-tempo-real`
- **Depende de:** 002, 004, 005, 007, 008

## Objetivo

Permitir que o painel e outros clientes recebam eventos em tempo real (ex.: nova mensagem em uma conversa) e, onde precisar de comunicação bidirecional, usar WebSocket, com autenticação e isolamento entre clientes.

## Comportamento esperado

Critério de escolha (do guia): **SSE** para fluxos só servidor → cliente (padrão); **WebSocket** apenas onde houver comunicação bidirecional real.

**Camada comum**
- Barramento de eventos em `src/application/` (interface) com implementação sobre Redis pub/sub em `src/infrastructure/`, para valer com várias instâncias.
- Todo evento carrega `clientId`; a entrega só ocorre para conexões daquele cliente.

**SSE**
- `GET /events` com `Content-Type: text/event-stream`, autenticado pelo access token (header `Authorization`).
- Ping periódico para manter a conexão viva atrás de proxies.
- Histórico curto por cliente (tamanho e TTL limitados, em Redis) para replay via `Last-Event-ID` após reconexão.
- Fechamento limpo no shutdown do servidor.

**WebSocket (Socket.IO)**
- Autenticação no handshake com o access token; conexão sem token válido é recusada.
- Salas por usuário (`user:{id}`) **e** por cliente (`client:{clientId}`); entrada em sala só com base na identidade do token, nunca em dado enviado pelo cliente.
- Adapter Redis para funcionar em cluster.
- Rate limit de mensagens por conexão (padrão: 100 por minuto), com desconexão ou aviso ao exceder.
- Eventos de entrada validados com Zod.
- Permissões da spec 008 verificadas por evento.

**Geral**
- Limite de conexões simultâneas por usuário (configurável).
- Métricas: conexões abertas por tipo, eventos entregues, eventos descartados.
- Token expirado durante a conexão: encerra ou exige reautenticação (definir e testar).

## Critérios de aceite

- [ ] Teste: SSE sem token recebe 401; com token recebe o evento publicado para o seu cliente.
- [ ] Teste de isolamento: evento publicado para o cliente A não chega a conexões (SSE e WebSocket) do cliente B.
- [ ] Teste: reconexão SSE com `Last-Event-ID` recebe apenas os eventos perdidos, dentro do limite do histórico.
- [ ] Teste: handshake do WebSocket com token inválido é recusado.
- [ ] Teste: cliente não consegue entrar em sala de outro usuário ou cliente enviando o id dela.
- [ ] Teste: duas instâncias do servidor (simuladas) entregam evento publicado em uma para conexões da outra via Redis.
- [ ] Teste: excesso de mensagens por conexão aciona o limite.
- [ ] Teste: shutdown encerra conexões sem handles pendentes.
- [ ] Teste: evento de entrada inválido é rejeitado pelo Zod sem derrubar a conexão.

## Casos de borda e erros

- Redis fora: SSE e WebSocket respondem 503 / recusam novas conexões; as existentes seguem só localmente e logam o problema.
- Cliente lento: buffer limitado e descarte ou desconexão para não estourar memória.

## Isolamento entre clientes

É o ponto crítico desta spec: o canal do evento e a sala são derivados do `clientId` do token. Testes acima.

## Fora de escopo

- Notificações push, e-mail e SMS.
- Presença (quem está online) e digitando.
- Definir os eventos de negócio: aqui só se entrega o mecanismo e um evento de exemplo.

## Decisões e dependências novas

- Dependências: `socket.io` e `@socket.io/redis-adapter` (confirmar integração com Fastify, por exemplo `fastify-socket.io`, na implementação).
- **Pergunta:** o painel precisa mesmo de WebSocket ou SSE basta? Se SSE bastar, a parte WebSocket pode ser adiada sem custo.
