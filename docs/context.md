# Soprei — Contexto do Projeto

> Fonte de verdade para humanos e agentes. Atualize quando uma decisão mudar; decisões aqui não se revertem sem motivo concreto registrado na seção "Histórico".

## 1. Objetivo

Sistema de atendimento via IA. Cada cliente (negócio) tem seu próprio assistente, com persona e base de conhecimento próprias, atendendo os clientes finais daquele negócio.

O assistente não é um chatbot genérico: responde com base nos documentos do cliente e **nunca mistura dados entre clientes**.

> Esta seção foi herdada do protótipo `customer-service` (WhatsApp + RAG por cliente). Confirme ou ajuste o escopo do Soprei aqui.

## 2. Stack decidida

| Camada | Escolha |
| --- | --- |
| Runtime | Node.js 22 ou superior (mínimo 22; versões maiores aceitas) |
| Linguagem | TypeScript (strict) |
| HTTP | Fastify |
| Validação | Zod |
| ORM / migrations | Prisma |
| Logs | Pino |

### Decididas por consequência (avise se discordar)

- **PostgreSQL**: banco relacional do Prisma e do guia. Para RAG, pgvector é candidato; o Prisma só suporta vetores via `Unsupported` ou SQL cru, tratar na spec de base de conhecimento.
- **Redis**: exigido por rate limiting, cache L2, revogação de refresh token e adapter de tempo real. Uma única instância atende tudo no início.
- **Socket.IO** para WebSocket e **SSE** para fluxo só servidor → cliente (ver spec 009).

## 3. Decisões em aberto

Resolver cada uma por spec antes de implementar o que depende dela.

| Tema | Opções conhecidas | Observação |
| --- | --- | --- |
| Fila de jobs | **BullMQ sobre Redis (decidido na spec 011)** | Fila `channel-inbound`, worker no mesmo processo com concorrência 1; fila por cliente e vários workers só quando a latência medida pedir. |
| Provedor de LLM | Gemini, Claude, OpenAI | Seja qual for, fica atrás da interface `LLMProvider`. |
| Canal | **WhatsApp Cloud API oficial (decidido)** | Estado da conta Meta (informado pelo dono em 2026-10-27): empresa com verificação de negócio concluída, app Business publicado (live), já é Tech Provider, número de teste da Meta para desenvolver, e quer o fluxo de onboarding de vários clientes (Embedded Signup). A confirmar: moeda e forma de pagamento da conta de cobrança (BRL), onde roda o webhook. Desde 01/10/2026 só as 1 000 primeiras mensagens de serviço por número ao mês são grátis. |
| Hospedagem | VPS (protótipo: Hetzner) | — |

## 3.1. Modelo de IA em desenvolvimento

- Interface única `LlmProvider` (`src/application/ports/llm-provider.ts`; gerar resposta, e mais tarde gerar embedding). Hoje só `generate`, que devolve `Result<LlmReply, ExternalServiceError>`.
- Três implementações previstas: `mock` (respostas determinísticas, usada nos testes e no CI; **já existe**, em `src/infrastructure/external-apis/llm/`), um modelo barato ou gratuito para dev manual, e o modelo de produção (as duas últimas entram em spec própria).
- A escolha vem de `LLM_PROVIDER` (por ora só `mock`), validada na config, junto de `LLM_TIMEOUT_MS`.

## 4. Arquitetura (princípios)

- **Multi-tenancy por design:** toda entidade tem identificador de cliente; camada de acesso a dados exige esse identificador. Vazamento entre clientes é o pior bug possível para o negócio.
- **Webhook rápido:** responde 200 imediatamente e processa em background.
- **Sem polling:** tudo orientado a evento (webhook + fila).
- **Erros nunca deixam o usuário final em silêncio.**
- **LLM trocável** atrás de interface.

### Padrão de referência

Seguimos o guia [Engenharia Backend Node.js + TypeScript](https://www.vivodecodigo.com.br/backend/engenharia-backend-nodejs-typescript-guia-definitivo) (inspirado em Clean Architecture). As regras resumidas estão no `CLAUDE.md`.

Desvios deliberados em relação ao guia:

- **Fastify** no lugar de Express: o que o guia faz com middleware, aqui vira hook/plugin do Fastify.
- **Sem `any`** no repositório genérico; o guia usa `any` no modelo Prisma e isso enfraquece a tipagem.
- **Isolamento entre clientes** não está no guia: aqui o `ClientId` (branded type) é obrigatório em todo repositório.
- **Estratégia de testes** não está no guia: definida no `AGENTS.md`.
- **Itens do guia que o guia trata como opcionais** (JWT/refresh, RBAC, rate limiting, cache, métricas, WebSocket/SSE) entram desde já na base, cada um em sua spec (004 a 009). Cache sem decorators; rate limiting sobre `@fastify/rate-limit` em vez de limiter próprio.
- Exemplos do guia são incompletos em alguns pontos (refresh token em memória, service layer esqueleto); não copiar literalmente, usar como direção.

### Estrutura de pastas

```
src/
├── domain/          # entities, value-objects (ClientId...), interfaces de repositório
├── application/     # services/use-cases e portas
│   ├── attendance/  # AttendanceService e schemas
│   ├── channel/     # canal de mensagens: entrada do webhook e processador dos jobs (spec 011)
│   ├── clients/     # ClientService
│   └── ports/       # interfaces para o exterior: LlmProvider, MessageSender, InboundJobQueue
├── infrastructure/
│   ├── config/      # env validada com Zod (fail-fast)
│   ├── database/    # raiz: Prisma singleton, transação com retry, erros, barrel (index.ts)
│   │   ├── extensions/    # Prisma Client Extensions: tenant-scope, query-timing, schema-info
│   │   └── repositories/  # base de tenant, implementações de repositório, unit of work, cursor, mappers
│   ├── http/        # raiz: servidor Fastify, error handler central, testes de rota de ponta a ponta
│   │   ├── observability/ # request id, contexto, log de requisição, métricas HTTP
│   │   └── rate-limit/    # registerRateLimit e IP do cliente
│   ├── logger/      # Pino com mixin de contexto e redact
│   ├── metrics/     # prom-client: Registry dedicado (spec 004)
│   ├── cache/       # client Redis singleton (cache em si: spec 006)
│   ├── queue/       # fila de entrada do canal (BullMQ), conexões Redis próprias (spec 011)
│   └── external-apis/  # llm/ (mock; real em spec própria) e whatsapp/ (cliente da Cloud API)
├── presentation/    # controllers/rotas, hooks, validators Zod
│   ├── admin/       # rotas /admin/*
│   ├── system/      # /health, /health/ready, /metrics
│   ├── webhooks/    # webhook do WhatsApp (spec 011)
│   └── common/      # bearer auth hook, route pattern, perfil de rate limit
├── shared/          # errors (BaseError...), types (Brand, Result), request-context, utils
└── index.ts         # bootstrap
prisma/
└── schema.prisma
```

Convenções de pastas (fixadas na [spec 012](specs/012-reorganizacao-pastas.md); versão operacional no `AGENTS.md`):

1. Pasta por área quando passar de uns 10 arquivos ou juntar duas responsabilidades; não criar pasta para o futuro (as pastas da 011 nascem na 011).
2. Teste ao lado do arquivo que testa, na mesma subpasta; teste que atravessa várias partes fica na pasta pai.
3. Barrels só onde já existem (`database/index.ts`, `domain/index.ts`); imports de fora de uma camada usam o barrel quando ele exporta o símbolo.
4. Sem aliases de caminho (`@/...`): imports relativos.
5. Nomes de arquivo não mudam ao mover (sufixos `.service.ts`, `.repository.ts`, `.controller.ts`).

## 5. Roadmap (fatias)

**Como o roadmap funciona (revisado em 2026-10-27, decisão do dono):**

- **Specs sob demanda:** só a próxima spec é detalhada e aprovada. As demais ficam como esboço (uma linha aqui; os arquivos já escritos para 005 a 009 têm status `esboço` e **devem ser relidos contra o código real antes de aprovar**, como aconteceu com a 002 e a 003).
- **Fatia vertical cedo:** em vez de construir toda a base de engenharia antes do produto, entra logo depois da 004 uma fatia fina que prova o produto de ponta a ponta. Rate limit, cache, autenticação, RBAC e tempo real entram quando uma funcionalidade real pedir.
- **Revisão obrigatória pelo agente `reviewer`** antes do merge nas specs de segurança (autenticação, autorização, isolamento e RLS).
- A numeração dos arquivos de spec é só identificador; **a ordem de execução é a deste roadmap**.

**Concluídas**

1. 001 — Bootstrap (camadas, config, erros, Result, `/health`)
2. 002 — Infra local, Postgres, Redis, Prisma singleton
3. 003 — Base multi-tenant e isolamento
4. 004 — Observabilidade: logs com contexto por requisição e métricas
5. 005 — Rate limiting: limite por perfil e por IP em Redis, `TRUST_PROXY`, 429 padronizado
6. **Fatia vertical ([spec 010](specs/010-fatia-vertical-atendimento.md), concluída):** mensagem de entrada → conversa/mensagem do cliente → `LLMProvider` com `mock` → resposta, com isolamento por cliente e fallback de erro. Decisões do dono (todas conforme a recomendação): simulador por API administrativa, processamento síncrono, persona em `Client`, `contactRef` livre, histórico de 20 mensagens e 12 000 caracteres, fallback constante, nunca logar conteúdo de mensagens, política de retenção de dados pessoais só antes de dados reais. Passa pelo `reviewer` antes do merge.
7. 012 — Reorganização de pastas: subpastas por área em `database`, `http`, `application` e `presentation`, sem mudança de comportamento
8. 011 — Canal WhatsApp (webhook assinado, fila BullMQ, envio pela Cloud API, número de teste da Meta, LLM `mock`); teste manual do dono com a Meta funcionou de ponta a ponta
9. 013 — Agrupamento de mensagens rápidas (janela de espera deslizante, lote respondido uma vez; mensagens gravadas no banco, `Message.answeredById`)
10. 014 — Provedor real de LLM: `AnthropicLlmProvider` (Claude Haiku 5.5) atrás do `LlmProvider`, `AbortSignal` no prazo, erro sem texto do contato, `llm_tokens_total`; teste manual com a chave real ainda por fazer (limite de gasto na conta antes)

**Próximas**

- Pendências antes de dados reais: política de retenção e LGPD (inclui limpeza do Redis e dos jobs), RLS do Postgres, varredura de mensagens pendentes antigas, suporte a BSUID (contato sem telefone), confirmar que o túnel/proxy acrescenta ao `X-Forwarded-For`.


**Sob demanda (esboço; entra quando o gatilho acontecer)**

| Item | Spec | Gatilho |
| --- | --- | --- |
| Autenticação JWT + refresh | 007 | **implementada na branch `spec/007-autenticacao-jwt`, aguardando `reviewer`, CI e merge** (aprovada em 2026-10-29 com todas as recomendações). Pré-requisito do onboarding de vários clientes (spec B); substitui a `ADMIN_API_KEY`, que foi removida |
| RBAC | 008 | junto com a autenticação, quando houver mais de um papel |
| Cache L1/L2 | 006 | quando medição mostrar leitura repetida custosa |
| Tempo real (SSE/WebSocket) | 009 | quando o painel precisar de eventos ao vivo |
| Row Level Security do Postgres | a escrever | **antes de dados reais de clientes** (decisão do dono); revisão pelo `reviewer` |

**Produto (esboço, depois da fatia vertical)**

- Provedor real de LLM atrás do `LLMProvider`
- Canal WhatsApp, em duas specs: (A) webhook de entrada com validação de assinatura, envio da resposta e mapeamento `phone_number_id` → cliente, com número de teste da Meta, fila e rate limit (spec 005 como pré-requisito); (B) onboarding de vários clientes com Embedded Signup, que exige autenticação (spec 007/008), tela de onboarding e tokens por cliente guardados cifrados
- Base de conhecimento (ingestão de documentos + busca)
- Painel admin (separado)
- Deploy

## 6. Estado atual

- **Spec 001 (bootstrap): concluída e mergeada**, CI verde em Node 22 e LTS. Já existem: Fastify com `GET /health`, config validada com Zod (fail-fast), Pino, hierarquia de erros com error handler central, `Brand` e `Result`, ESLint + Prettier, Prisma 7 sem models e CI. Camadas `shared`, `infrastructure` e `presentation`; `domain` e `application` nascem quando houver conteúdo.
- Versões fixadas na 001: TypeScript 6.0.x (o `typescript-eslint` ainda não suporta o 7) e Prisma 7.10.x (a tag `latest` do CLI aponta para um RC).
- **Spec 002 (infra local e banco): concluída e mergeada**, CI verde em Node 22 e LTS. Postgres e Redis nativos (sem Docker; PostgreSQL 18.2 e Redis 8.0.1 na máquina do dono). Já existem: Prisma 7 com `@prisma/adapter-pg` (singleton, pool configurável, helper de transação com retry, `DatabaseError`, métricas do pool), client `ioredis` singleton, `GET /health/ready`, boot fail-fast e shutdown gracioso, testes unitários (`pnpm test`) separados dos de integração (`pnpm test:integration`, só contra `soprei_test` e Redis `/15`) e CI com services Postgres 18 e Redis 8.
- **Spec 003 (base multi-tenant): concluída e mergeada**, CI verde no PR. Já existem: models `Client` (raiz, soft delete, slug único e reservado) e `Conversation` (mínima) com a primeira migration; `src/domain/` (`ClientId`, entidades, `TenantRepository`, `ClientRepository`) e `src/application/` (`ClientService`); base de repositório de tenant, que exige `ClientId` e injeta o filtro; segunda barreira no Prisma Client (extension `tenant-scope` com `MODEL_SCOPES` e `TenantScopeError`); regras de ESLint que proíbem Prisma e SQL cru fora de `infrastructure/database/`; `ConflictError`; rotas `/admin/clients` protegidas por `ADMIN_API_KEY` (credencial temporária entre clientes, sem rate limit até a spec 005). A RLS do Postgres fica para spec separada depois da 009.
- A duplicidade de `ConflictError`/`TenantScopeError` que quebrava o `typecheck` foi corrigida na `main` pelo dono (commit `136af89`).
- **Spec 004 (observabilidade): concluída e mergeada**, CI verde. Já existem: contexto por requisição com `AsyncLocalStorage` (`src/shared/request-context/`), `x-request-id` reaproveitado ou UUID, logger com `mixin` de contexto e `redact` de segredos, log de requisição próprio com o padrão da rota, métricas `prom-client` num `Registry` dedicado (HTTP, queries do Prisma por model/operação via extensão aplicada depois da `tenant-scope`, pool de conexões, processo), `GET /metrics` só com `METRICS_TOKEN` (404 sem ele) e `bearerAuthHook` compartilhado com o admin. `clientId`/`userId` do contexto ficam vazios até a autenticação (spec 007). Dependência nova: `prom-client`.
- **Spec 005 (rate limiting): concluída e mergeada**, revisada pelo `reviewer` (um bloqueante e dois importantes corrigidos) e com CI verde. Já existem: `@fastify/rate-limit` como hook `onRequest` da instância raiz (roda antes da autenticação e de ler o corpo), perfis `public` (padrão de rota sem perfil), `admin` e `webhook`, sempre por perfil e por IP normalizado, com store Redis em conexão dedicada (fila offline desligada, prazo curto por comando) e fail-open com log e `rate_limit_store_errors_total`; `RateLimitError` com corpo `{ error: { code: 'RATE_LIMITED', retryAfter } }` e os headers `Retry-After` e `X-RateLimit-*`; `TRUST_PROXY` (só `false`, `true` fora de produção ou lista de IPs/CIDRs dos proxies; o inteiro não existe porque o Fastify 5.12.7 o trata como fail-closed); `RATE_LIMIT_ENABLED` (não pode ser `false` em produção). Rota nova declara o perfil (`rateLimitProfile('webhook')`...); o teste de inventário de rotas falha se esquecer. Dependência nova: `@fastify/rate-limit`.
- **Spec 012 (reorganização de pastas): concluída e mergeada**, CI verde. 39 arquivos movidos com `git mv`, sem mudança de lógica: 466 unitários e 148 de integração com os mesmos nomes. Estrutura e convenções (pasta por área, teste ao lado, sem barrels novos, sem aliases) estão em "Estrutura de pastas" e no `CLAUDE.md`.
- **Spec 011 (canal WhatsApp, parte A): implementada, não mergeada** (aguarda `reviewer`, CI e o teste manual do dono com o número de teste da Meta). Já existem: `GET`/`POST /webhooks/whatsapp` (opt-in por `WHATSAPP_ENABLED`; assinatura HMAC-SHA256 sobre o corpo cru, rate limit `webhook`, resposta 200 depois de enfileirar), fila BullMQ 6 `channel-inbound` com worker no mesmo processo (concorrência 1, encerramento gracioso antes de Redis e banco), `ChannelIntakeService` e `ChannelInboundProcessor` (`application/channel/`), `WhatsappCloudApiClient` (Graph API `v26.0`, `fetch` nativo) atrás da porta `MessageSender`, migration aditiva (`Client.whatsappPhoneNumberId` único, `Message.channelMessageId` e `sentAt`), `findByWhatsappPhoneNumberId` (o único ponto que resolve identificador externo em cliente), `markSent` e `listBefore`, métricas do webhook, do canal e da fila. Dependência nova: `bullmq` (usa o `ioredis` do projeto). Retenção do texto e do `contactRef` nos jobs do Redis (`QUEUE_KEEP_*`) entra na decisão de LGPD antes de dados reais.
- **Spec 013 (agrupamento de mensagens rápidas): implementada, não mergeada** (aguarda `reviewer`, CI e merge). No canal, o job `text` só grava a mensagem (`AttendanceService.acceptInboundMessage`, sem LLM) e agenda um job `flush` por contato (BullMQ, deduplicação com `replace` e `keepLastIfActive`: janela deslizante com teto, e o próximo `flush` guardado se o contato está sendo atendido); o `flush` (`respondToPending`) junta as pendentes num único turno `user`, chama o LLM fora de transação e grava uma resposta que marca o lote inteiro (`Message.answeredById`, chave estrangeira composta, migration aditiva). O simulador `/admin` continua síncrono, e avisos constantes seguem imediatos. Config `CHANNEL_BATCH_*`; métricas `attendance_batch_size` e `attendance_batches_total`. Sem dependência nova.
- **Spec 010 (fatia vertical): concluída e mergeada**, revisada pelo `reviewer` e com CI verde (unitários e integração, Node 22 e LTS). Já existem: migration aditiva (`Client.persona`, `Conversation.contactRef` e o model `Message`, de tenant, com chaves estrangeiras compostas por `clientId`); `LlmProvider` + `MockLlmProvider` (modo de falha, marcadores `[[mock:fail]]`, `[[mock:hang]]`, `[[mock:empty]]`, `[[mock:huge]]`, registro de entradas só para testes); `AttendanceService` (idempotência por `externalId`, histórico de 20 mensagens e 12 000 caracteres, fallback constante gravado com `isFallback`, LLM fora da transação, timeout por `withTimeout`/`TimeoutError`); rotas `POST /admin/clients/:clientId/messages`, `GET .../conversations`, `GET .../conversations/:conversationId/messages` e `persona` no `PATCH /admin/clients/:id`; métricas `llm_requests_total`, `llm_request_duration_seconds`, `attendance_fallbacks_total`; regra de nunca logar conteúdo de mensagem nem persona, com teste de captura de log. Retenção de dados pessoais (mensagens e `contactRef`) segue sem política: decidir antes de dados reais, junto com a RLS. Specs 005 a 009 como esboço (ver "Roadmap"). Próximo passo: escolher o provedor real de LLM (e, junto, decidir o canal) e escrever a spec seguinte. Lição do CI: testes que conferem ordem por tempo precisam de relógio injetável (`src/test-support/clock.ts`), nunca do relógio real.

- **Spec 007 (autenticação JWT): implementada, aguardando revisão e merge.** Já existem: models `User` (tenant, e-mail único por cliente) e `PlatformAdmin` (global); `/auth/login`, `/auth/platform/login`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all`, `/auth/me`; access token HS256 (`jose` atrás de `AccessTokenService`), refresh opaco com rotação atômica em Lua e detecção de reuso, hash `scrypt` com teto de 2 hashes simultâneos, bloqueio por conta, perfis de rate limit `login` e `refresh` fail-closed, hook `authenticate` com `requireUser`/`requirePlatform`, `ClientId` só do token (o `:clientId` do caminho é conferido e vira 404 se divergir), `pnpm auth:cli` para o primeiro usuário. `ADMIN_API_KEY` removida; `JWT_SECRET` obrigatória. Detalhes em `AGENTS.md` ("Autenticação (spec 007)").

## 7. Histórico de decisões

- Stack Node 22+ + TypeScript + Fastify + Prisma + Pino definida pelo dono do projeto.
- 2026-10-27: o dono aprovou mudar o processo para specs sob demanda, fatia vertical cedo e `reviewer` obrigatório em specs de segurança. Motivo: as specs 002 e 003, escritas antes do código, precisaram ser reescritas, e a base completa (JWT, RBAC, cache, tempo real) estava sendo construída antes de existir produto.
- O protótipo `customer-service` usava TypeORM; o Soprei usa Prisma. As regras de arquitetura do protótipo (isolamento por cliente, webhook rápido, LLM trocável) foram mantidas.
- 2026-10-29: o dono aprovou a spec 007 com todas as recomendações da seção "Decisões" (scrypt do `node:crypto`, `jose`, login por `clientSlug` + e-mail, `PlatformAdmin` separado que só alcança o CRUD de clientes, `ADMIN_API_KEY` removida, primeiro usuário por comando local, refresh no corpo, Redis fora = 503, reuso estrito de refresh, bloqueio 5 falhas/15 min, papéis `OWNER`/`AGENT`, um PR, `:clientId` divergente = 404, `JWT_SECRET` obrigatória, access 15 min / refresh ocioso 7 dias / teto 30 dias).
