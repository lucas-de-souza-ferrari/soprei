# 004 — Observabilidade: logs com contexto e métricas

- **Status:** rascunho
- **Branch:** `spec/004-observabilidade`
- **Depende de:** 002, 003

## Objetivo

Toda requisição e todo log carregam contexto (id da requisição, cliente, usuário), e o sistema expõe métricas para medir latência, erros e saúde de banco, cache e rate limit.

## Comportamento esperado

**Logs**
- Contexto por requisição em `AsyncLocalStorage` (`src/shared/` ou `infrastructure/`): `requestId`, `clientId`, `userId`, `operation`. O logger Pino injeta esse contexto automaticamente (`mixin`).
- `requestId` vem do header `x-request-id` quando válido, senão é gerado; sempre devolvido no header da resposta.
- Hooks do Fastify registram início e fim da requisição com método, rota (padrão da rota, não a URL crua), status e duração.
- Redação de campos sensíveis nos logs (`authorization`, `cookie`, `password`, `refreshToken`, tokens em geral).
- Nível de log por variável de ambiente.

**Métricas** (`prom-client`)
- Métricas padrão do processo (CPU, memória, event loop, GC).
- `http_requests_total` e `http_request_duration_seconds` (histograma, buckets explícitos) com labels `method`, `route`, `status_class`.
- Duração de queries do banco por modelo/operação, e métricas do pool (usando o que a spec 002 deixou pronto).
- Contadores/gauges que as specs 005 e 006 vão alimentar: `rate_limit_hits_total`, `cache_operations_total{layer,result}`.
- `GET /metrics` no formato Prometheus, protegido por `METRICS_TOKEN` (Bearer) quando definido; em produção o token é obrigatório.
- **Cardinalidade controlada:** nenhum label com `clientId`, `userId` ou URL crua.

## Critérios de aceite

- [ ] Teste: duas requisições concorrentes geram logs com `requestId` diferentes e sem mistura de contexto.
- [ ] Teste: `x-request-id` válido é reaproveitado; inválido é substituído; o header volta na resposta.
- [ ] Teste: campos sensíveis aparecem redigidos no log (`[Redacted]`).
- [ ] Teste: `GET /metrics` retorna 401 sem token (quando configurado) e o corpo contém `http_requests_total` após uma requisição.
- [ ] Teste: o label `route` usa o padrão (`/clients/:id`), não o valor real.
- [ ] Teste: o contexto (`clientId`) criado no `AsyncLocalStorage` chega ao log dentro de um service chamado pela rota.

## Casos de borda e erros

- Falha ao coletar métrica não pode derrubar a requisição.
- Rota inexistente (404) usa label `route="unmatched"` para não explodir cardinalidade.

## Isolamento entre clientes

Logs e métricas não podem vazar dado de um cliente em contexto de outro; o contexto é por requisição e nunca global. Teste de concorrência acima cobre isso.

## Fora de escopo

- Tracing distribuído (OpenTelemetry), dashboards, alertas e coleta externa (Prometheus/Grafana).

## Decisões e dependências novas

- Dependência: `prom-client` (e `pino-pretty` em dev, já previsto).
