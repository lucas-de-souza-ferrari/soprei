# 004 — Observabilidade: logs com contexto e métricas

- **Status:** aprovada
- **Branch:** `spec/004-observabilidade`
- **Depende de:** 002 e 003 (concluídas)

## Objetivo

Toda requisição e todo log carregam contexto (id da requisição, cliente, usuário), segredos nunca aparecem nos logs, e o sistema expõe métricas de HTTP, banco e processo para medir latência, erros e saúde. É a base para depurar a fatia vertical do produto, que vem logo depois.

## Pré-requisito

A `main` precisa compilar e ter `typecheck`, `lint`, `test` e `test:integration` verdes. A duplicidade de `ConflictError`/`TenantScopeError` que quebrava o `typecheck` já foi corrigida e mergeada pelo dono (commit `136af89`).

## Estado de partida (herdado da 001 a 003)

- `buildServer({ logger, readiness, admin })` em `src/infrastructure/http/server.ts` cria `Fastify({ loggerInstance })` com o logger Pino de `createLogger(config)` (sem `redact`, sem `mixin`). O Fastify usa o log de requisição padrão e o `request.id` padrão (`req-1`...), que o error handler já devolve em `error.requestId`.
- `src/infrastructure/http/test-server.ts` (`buildTestServer`) monta servidor com log silencioso para os testes.
- Rotas: `GET /health`, `GET /health/ready` e `/admin/clients` (hook `adminAuthHook` em `presentation/admin/`, Bearer comparado em tempo constante).
- Banco: `getDatabase()` com `poolMetrics()` (total, idle, waiting) e o Prisma Client estendido pelo `tenant-scope`. Redis: `getRedis()`.
- Config Zod em `src/infrastructure/config/env.schema.ts` (`LOG_LEVEL` já existe). Não existe contexto por requisição nem `prom-client`.
- Camadas: `shared` não pode importar de `domain` (o `domain` importa de `shared`), então o contexto guarda ids como `string`.

## Comportamento esperado

**Contexto por requisição (`AsyncLocalStorage`)**
- Módulo em `src/shared/request-context/`, sem dependência de Fastify: `runWithContext(store, fn)`, `getContext()` e setters tipados (`setClientId`, `setUserId`, `setOperation`) que alteram o store da requisição atual e não fazem nada fora de uma requisição. Campos: `requestId`, `clientId?`, `userId?`, `operation?`, todos `string`.
- Hook `onRequest` do Fastify abre o contexto de cada requisição (padrão `als.run(store, done)`) e define `operation` como `"<MÉTODO> <padrão da rota>"`. Como nenhuma rota autenticada existe ainda, `clientId` e `userId` ficam vazios por enquanto; as specs de autenticação os preencherão pelos setters. **O contexto precisa sobreviver a `await`, a hooks posteriores e ao handler de erro**; isso é testado (critério abaixo), porque é o ponto frágil dessa abordagem.

**Request id**
- `genReqId` do Fastify: reaproveita o header `x-request-id` quando casa com `^[A-Za-z0-9._-]{8,128}$`; senão gera um UUID. O header é sempre devolvido na resposta (`onSend`). O id é o mesmo em `request.id`, no contexto, nos logs (campo `requestId`, via `requestIdLogLabel`) e no `error.requestId` do corpo de erro.

**Logs (Pino)**
- `createLogger` ganha `mixin()` que lê o contexto e acrescenta `clientId`, `userId` e `operation` quando existirem. Assim, qualquer log feito durante a requisição, inclusive de um service que use o logger raiz e não o `request.log`, sai com o contexto. Fora de requisição (boot, shutdown) o mixin devolve `{}`.
- `createLogger` aceita destino opcional (stream) para os testes capturarem as linhas.
- Log de requisição próprio no lugar do padrão do Fastify (`disableRequestLogging: true`): um log ao fim (`onResponse`) com método, **padrão da rota** (nunca a URL crua), status e duração em ms, em nível `info` (`warn` para 4xx e `error` para 5xx). `/health`, `/health/ready` e `/metrics` logam em `debug` para não gerar ruído.
- **Redação** de segredos (`redact` do Pino, valor `[Redacted]`): `authorization`, `cookie`, `password`, `refreshToken`, `accessToken`, `token`, `apiKey` e os caminhos `req.headers.authorization`, `req.headers.cookie`, `headers.authorization`, `headers.cookie`, em nível raiz e um nível abaixo (`*.password` etc.).
- O log do `adminAuthHook` hoje registra `request.url`; passa a registrar o padrão da rota.

**Métricas (`prom-client`)**
- `src/infrastructure/metrics/` com um `Registry` **dedicado** (não o global), criado por `createMetrics()`, para não vazar estado entre testes e para as próximas specs registrarem as suas métricas nele.
- Métricas padrão do processo (`collectDefaultMetrics` no registry dedicado).
- `http_requests_total` e `http_request_duration_seconds` (histograma, buckets explícitos de 5 ms a 10 s) com labels `method`, `route` (padrão da rota; `unmatched` quando nenhuma rota casou) e `status_class` (`2xx`, `4xx`...). `/metrics` não conta a si mesmo.
- `db_query_duration_seconds` (histograma) por `model` e `operation`, medido por uma Prisma Client Extension de tempo aplicada junto da `tenant-scope` (a ordem das extensões é decidida e registrada pelo implementer; a barreira de isolamento continua a primeira a rodar).
- Gauges do pool (`db_pool_connections{state="total|idle|waiting"}`) preenchidos no momento da coleta (`collect()` lendo `poolMetrics()`), sem timers.
- **Não criar** contadores de rate limit nem de cache: as specs delas registram as próprias métricas no registry.
- **Cardinalidade controlada:** nenhum label com `clientId`, `userId`, id de recurso ou URL crua.
- Falha ao registrar métrica nunca derruba a requisição (try/catch com log em `warn`).

**`GET /metrics`**
- Formato de texto do Prometheus. Só é registrado quando `METRICS_TOKEN` está definido (mínimo 32 caracteres); sem o token a rota **não existe** (404), para não expor por engano. Autenticação por `Authorization: Bearer`, com a mesma comparação em tempo constante do admin: o implementer extrai um helper compartilhado (ex.: `bearerAuthHook`) e `adminAuthHook` passa a usá-lo, sem mudar o comportamento nem os testes existentes.
- Config nova: `METRICS_TOKEN` (opcional; se informada, mínimo 32 caracteres; vazia vale como ausente), documentada em `.env.example` e `.env.test.example`.

## Critérios de aceite

- [ ] Teste: duas requisições **concorrentes**, com atrasos que se intercalam, geram logs (do hook e de um service que usa o logger raiz depois de um `await`) cada um com o seu `requestId` e `clientId`, sem mistura de contexto.
- [ ] Teste: o contexto definido pelo setter dentro do handler chega ao log de requisição e ao log do error handler quando o handler lança.
- [ ] Teste: `x-request-id` válido é reaproveitado e devolvido no header; inválido (curto, com espaço, longo demais) é substituído por UUID; o `requestId` do corpo de erro é o mesmo do header.
- [ ] Teste: campos sensíveis (`authorization`, `cookie`, `password`, `refreshToken`, `apiKey`, `token`) aparecem como `[Redacted]` no log, em nível raiz e aninhado; a chave de admin usada numa requisição não aparece em nenhuma linha de log.
- [ ] Teste: o log de requisição usa o padrão da rota (`/admin/clients/:id`), nunca o id real, e `/health` loga em `debug`.
- [ ] Teste: `GET /metrics` retorna 404 sem `METRICS_TOKEN` configurado, 401 sem token ou com token errado e 200 com o correto; o corpo contém `http_requests_total` e `process_cpu_user_seconds_total` depois de uma requisição.
- [ ] Teste: o label `route` é `/admin/clients/:id` (não o UUID) e `unmatched` para rota inexistente; nenhuma linha da saída de `/metrics` contém um UUID de cliente nem `clientId`.
- [ ] Teste de integração: depois de operações reais com o Prisma, `db_query_duration_seconds` tem amostras por `model`/`operation`, e o gauge do pool reflete `poolMetrics()`.
- [ ] Teste: a extensão de métricas do banco não enfraquece a `tenant-scope` (as suítes da 003 continuam passando sem alteração).
- [ ] Teste: uma falha forçada ao registrar métrica não muda o status nem o corpo da resposta.
- [ ] Teste: config rejeita `METRICS_TOKEN` com menos de 32 caracteres; o `adminAuthHook` refatorado mantém todos os testes existentes verdes.
- [ ] Shutdown continua sem handles abertos (o teste de shutdown da 002 passa com as métricas padrão ligadas).
- [ ] CI verde em Node 22 e na LTS (confirmado pelo dono).

## Casos de borda e erros

- Fora de requisição (boot, shutdown, jobs futuros): `getContext()` devolve `undefined`, os setters são no-op e o mixin não falha.
- Requisição que termina antes de responder (cliente desconectou): o log e a métrica de fim ainda saem uma única vez.
- Rota inexistente (404): `route="unmatched"`, sem explodir cardinalidade.
- Cabeçalho `x-request-id` repetido ou com valor não string: tratado como inválido.

## Isolamento entre clientes

Contexto e logs são por requisição e nunca globais; o teste de concorrência acima cobre vazamento de `requestId` e `clientId` entre requisições. As métricas não têm `clientId` como label, então nada de um cliente aparece no `/metrics` de outro. O contexto não é fonte de verdade de segurança: o `ClientId` das operações de dados continua passado explicitamente aos repositórios.

## Fora de escopo

- Tracing distribuído (OpenTelemetry), dashboards, alertas e coleta externa (Prometheus/Grafana).
- Métricas de rate limit, cache, Redis, fila e negócio (cada spec registra as suas).
- Preencher `clientId` e `userId` de verdade: depende da autenticação (spec 007, sob demanda).
- Rotação e envio de logs para fora do processo.

## Decisões e dependências novas

- Dependência: `prom-client` (versão estável mais recente, sem inventar número).
- **Decisão proposta:** `/metrics` só existe com `METRICS_TOKEN`; sem ele a rota responde 404.
- **Decisão proposta:** log de requisição próprio em vez do padrão do Fastify, para ter padrão de rota, duração e contexto num único log por requisição.
- Possível ajuste de escopo para a fatia vertical: se quiser, o implementer entrega primeiro contexto, request id, redação e log de requisição, e as métricas ficam como segunda metade da mesma spec; ambas as partes devem fechar antes do status `concluída`.
