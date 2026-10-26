# 005 — Rate limiting

- **Status:** rascunho
- **Branch:** `spec/005-rate-limiting`
- **Depende de:** 002, 004

## Objetivo

Proteger a API contra abuso com limites por contexto, armazenados em Redis para valer entre várias instâncias.

## Comportamento esperado

- Implementação sobre `@fastify/rate-limit` com store Redis e `keyGenerator` próprio, em vez de limiter escrito à mão. Se o plugin não atender a algum critério, justificar na spec antes de escrever código próprio.
- Perfis de limite configuráveis (valores iniciais do guia, ajustáveis por env):
  - `public`: 100 requisições por 15 min por IP;
  - `authenticated`: 1000 por 15 min por usuário;
  - `critical` (login, refresh, troca de senha): 5 por minuto, por IP e por identificador da conta;
  - `upload`: 50 por hora por usuário;
  - `webhook`: por chave/identificador do remetente.
- Cada rota declara seu perfil; rota sem perfil usa `public`.
- Chave sempre inclui o `clientId` quando o contexto existir, para um cliente não consumir a cota de outro.
- Resposta `429` com `retryAfter` no corpo (via erro tipado `RateLimitError` no formato padrão da API) e headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
- **Limite adaptativo:** o máximo efetivo é reduzido quando o atraso do event loop (`perf_hooks.monitorEventLoopDelay`) passa de um limiar configurável, e volta ao normal quando se recupera.
- **Redis indisponível:** fail-open (a requisição passa), com log de erro e métrica; configurável para fail-closed nos perfis `critical`.
- IP correto atrás de proxy: `trustProxy` configurável e testado.
- Métrica `rate_limit_hits_total{profile}` alimentada.

## Critérios de aceite

- [ ] Teste: a requisição seguinte ao limite recebe 429 com `retryAfter` e os 4 headers.
- [ ] Teste: cada perfil aplica o seu limite (usar valores pequenos em teste).
- [ ] Teste: cotas de dois clientes diferentes são independentes.
- [ ] Teste: a janela expira e o contador zera (sem chave sem TTL no Redis).
- [ ] Teste: com Redis fora, rota `public` passa e rota `critical` segue a política configurada.
- [ ] Teste: o limite adaptativo reduz o máximo sob atraso simulado de event loop.
- [ ] Teste: `X-Forwarded-For` só é respeitado com `trustProxy` ligado.

## Casos de borda e erros

- IPv6 e IPs com porta normalizados antes de virar chave.
- Rate limit não deve contar requisições de health check e métricas.

## Isolamento entre clientes

Chaves namespaced por cliente; teste de cotas independentes acima.

## Fora de escopo

- Bloqueio permanente de IP, WAF, CAPTCHA.
- Limites por plano comercial (spec futura).

## Decisões e dependências novas

- Dependência: `@fastify/rate-limit`.
- O guia usa `INCR` + `EXPIRE` em pipeline; o plugin cobre isso. Atenção a chaves sem TTL se o processo cair entre os dois comandos (por isso o teste acima).
