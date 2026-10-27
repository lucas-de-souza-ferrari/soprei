# 004 — Observabilidade: logs com contexto e métricas

- **Status:** concluída
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

- [x] Teste: duas requisições **concorrentes**, com atrasos que se intercalam, geram logs (do hook e de um service que usa o logger raiz depois de um `await`) cada um com o seu `requestId` e `clientId`, sem mistura de contexto.
- [x] Teste: o contexto definido pelo setter dentro do handler chega ao log de requisição e ao log do error handler quando o handler lança.
- [x] Teste: `x-request-id` válido é reaproveitado e devolvido no header; inválido (curto, com espaço, longo demais) é substituído por UUID; o `requestId` do corpo de erro é o mesmo do header.
- [x] Teste: campos sensíveis (`authorization`, `cookie`, `password`, `refreshToken`, `apiKey`, `token`) aparecem como `[Redacted]` no log, em nível raiz e aninhado; a chave de admin usada numa requisição não aparece em nenhuma linha de log.
- [x] Teste: o log de requisição usa o padrão da rota (`/admin/clients/:id`), nunca o id real, e `/health` loga em `debug`.
- [x] Teste: `GET /metrics` retorna 404 sem `METRICS_TOKEN` configurado, 401 sem token ou com token errado e 200 com o correto; o corpo contém `http_requests_total` e `process_cpu_user_seconds_total` depois de uma requisição.
- [x] Teste: o label `route` é `/admin/clients/:id` (não o UUID) e `unmatched` para rota inexistente; nenhuma linha da saída de `/metrics` contém um UUID de cliente nem `clientId`.
- [x] Teste de integração: depois de operações reais com o Prisma, `db_query_duration_seconds` tem amostras por `model`/`operation`, e o gauge do pool reflete `poolMetrics()`.
- [x] Teste: a extensão de métricas do banco não enfraquece a `tenant-scope` (as suítes da 003 continuam passando sem alteração).
- [x] Teste: uma falha forçada ao registrar métrica não muda o status nem o corpo da resposta.
- [x] Teste: config rejeita `METRICS_TOKEN` com menos de 32 caracteres; o `adminAuthHook` refatorado mantém todos os testes existentes verdes.
- [x] Shutdown continua sem handles abertos (o teste de shutdown da 002 passa com as métricas padrão ligadas).
- [x] CI verde em Node 22 e na LTS (confirmado pelo dono no GitHub).

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

### Registro da implementação (implementer, 2026-10-27)

Status passou a `concluída` depois que o dono confirmou o CI verde no GitHub (critério final, não verificável localmente pelo implementer).

**Verificado localmente:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (311 unitários), `pnpm test:integration` (74), `pnpm build`; unitários e integração também em Node v22.23.2 (binário do nvm, sem trocar a versão global); smoke manual com o servidor compilado (`/health`, `/admin/clients`, `/metrics` sem e com `METRICS_TOKEN`): chave e token ausentes de todas as linhas de log, rota sempre como padrão (`/admin/clients/:id`, `unmatched`), `/metrics` fora de `http_requests_total`. O cliente criado no banco de desenvolvimento no smoke foi removido.

**Contexto (`AsyncLocalStorage`): resultado do ponto frágil.** O padrão `als.run(store, done)` no `onRequest` mantém o contexto em hooks posteriores, handler, `await`, error handler e `onResponse`, inclusive com POST com corpo e conexões keep-alive num servidor HTTP real (teste de concorrência com `fetch`, além de `inject`). Um teste de mutação (chamar `done()` fora do `run`) derruba 7 testes, então eles realmente detectam perda. **Exceção encontrada:** o `onRequestAbort` é disparado por um evento `close` do socket, que o Node entrega fora do `run`; o log de aborto saía sem `operation`/`clientId`. Correção: o store é guardado por requisição (`WeakMap`) e o fim da requisição (`onResponse` ou aborto) roda dentro dele (`runWithContext`), uma única vez.

**Decisões e desvios:**
- **Ordem das extensões do Prisma:** o Prisma executa as extensões de `query` na ordem em que foram adicionadas (a primeira é a mais externa; confirmado com um experimento de duas extensões). Por isso o client é `extendWithTenantScope(base).$extends(queryTimingExtension(observer))`: a `tenant-scope` roda primeiro e rejeita antes de qualquer coisa; a de tempo só mede o que ela deixou passar (inclusive queries que falham no banco). `tenant-scope.ts` não foi alterado. Teste: operação sem escopo lança `TenantScopeError` e não gera amostra. Só operações de model são medidas (o `SELECT 1` do health check e outros `$queryRaw` não).
- **`LogController` no lugar das opções de topo:** no Fastify 5.12.7, `disableRequestLogging` e `requestIdLogLabel` no topo das opções emitem aviso de deprecação (removidas no Fastify 6). O mesmo efeito vem de `logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'requestId' })`. Mais `requestIdHeader: false`, para `genReqId` decidir sozinho.
- **`requestId` no mixin:** o teste de concorrência exige `requestId` em logs do logger raiz, então o mixin o acrescenta. Para não repetir a chave nos loggers filhos do Fastify (que já a têm nos bindings), o mixin consulta os bindings do logger (cache em `WeakMap`).
- **Níveis do log de requisição:** `/health`, `/health/ready` e `/metrics` logam em `debug` só quando o status é menor que 400; 4xx e 5xx neles seguem `warn`/`error` (um 503 de readiness ou um 401 em `/metrics` não deve sumir).
- **Cliente desconectado:** `onRequestAbort` registra o fim uma vez, com status 499 (convenção do nginx; `status_class` `4xx`); se o handler terminar depois, nada é registrado de novo.
- **Estrutura:** `bearerAuthHook(token, onRejected?)` em `presentation/bearer-auth.hook.ts` (o `adminAuthHook` agora só o chama, comportamento e testes inalterados); `routePattern(request)` em `presentation/route-pattern.ts` (normaliza barra final: `/admin/clients/` vira `/admin/clients`); `presentation/metrics.controller.ts` depende da interface `MetricsSource`, não da infraestrutura; `buildServer` recebe `metrics` e `metricsToken`.
- **Log do `adminAuthHook`:** o campo `path` (URL crua) virou `route` (padrão da rota).
- **Gauges do pool:** criados em `createMetrics()` e ligados à fonte por `metrics.bindPool(() => database.poolMetrics())` (necessário porque o banco recebe o observer das queries e as métricas leem o pool dele). `createDatabase` aceita `{ queryObserver }`; a falha do observer vira só um `warn`.
- **`METRICS_TOKEN`:** mínimo de 32 caracteres em qualquer ambiente quando informado; opcional também em produção (sem ele, `/metrics` simplesmente não existe).
- **`createLogger(config, destination?)`:** com destino, o transporte `pino-pretty` de desenvolvimento não é usado (o Pino aceita só um dos dois). Helper de teste em `src/test-support/log-capture.ts`.
- **Dependência adicionada:** `prom-client` 15.1.3 (versão estável mais recente resolvida pelo `pnpm add`).
- **Não verificado:** CI do GitHub em Node 22 e na LTS (critério final), que depende do dono. Localmente, Node 22 e 24 passaram.
