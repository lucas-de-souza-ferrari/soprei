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
| Fila de jobs | BullMQ sobre Redis | Redis já é decisão (ver abaixo); resta decidir BullMQ para processar mensagens fora do webhook. |
| Provedor de LLM | Gemini, Claude, OpenAI | Seja qual for, fica atrás da interface `LLMProvider`. |
| Canal | **WhatsApp Cloud API oficial (decidido)** | Estado da conta Meta (informado pelo dono em 2026-10-27): empresa com verificação de negócio concluída, app Business publicado (live), já é Tech Provider, número de teste da Meta para desenvolver, e quer o fluxo de onboarding de vários clientes (Embedded Signup). A confirmar: moeda e forma de pagamento da conta de cobrança (BRL), onde roda o webhook. Desde 01/10/2026 só as 1 000 primeiras mensagens de serviço por número ao mês são grátis. |
| Hospedagem | VPS (protótipo: Hetzner) | — |

## 3.1. Modelo de IA em desenvolvimento

- Interface única `LlmProvider` (`src/application/llm-provider.ts`; gerar resposta, e mais tarde gerar embedding). Hoje só `generate`, que devolve `Result<LlmReply, ExternalServiceError>`.
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
- **Estratégia de testes** não está no guia: definida no `CLAUDE.md`.
- **Itens do guia que o guia trata como opcionais** (JWT/refresh, RBAC, rate limiting, cache, métricas, WebSocket/SSE) entram desde já na base, cada um em sua spec (004 a 009). Cache sem decorators; rate limiting sobre `@fastify/rate-limit` em vez de limiter próprio.
- Exemplos do guia são incompletos em alguns pontos (refresh token em memória, service layer esqueleto); não copiar literalmente, usar como direção.

### Estrutura de pastas

```
src/
├── domain/          # entities, value-objects (ClientId...), interfaces de repositório
├── application/     # services/use-cases, interfaces (LLMProvider)
├── infrastructure/
│   ├── config/      # env validada com Zod (fail-fast)
│   ├── database/    # Prisma singleton, transação com retry, erros, implementações de repositório
│   ├── http/        # servidor Fastify, error handler central, observabilidade (request id, log de requisição)
│   ├── logger/      # Pino com mixin de contexto e redact
│   ├── metrics/     # prom-client: Registry dedicado (spec 004)
│   ├── cache/       # client Redis singleton (cache em si: spec 006)
│   └── external-apis/  # LLM (mock + real), canal de mensagens
├── presentation/    # controllers/rotas, hooks, validators Zod
├── shared/          # errors (BaseError...), types (Brand, Result), request-context, utils
└── index.ts         # bootstrap
prisma/
└── schema.prisma
```

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

**Fatia vertical (concluída)**

5. **Fatia vertical ([spec 010](specs/010-fatia-vertical-atendimento.md), concluída):** mensagem de entrada → conversa/mensagem do cliente → `LLMProvider` com `mock` → resposta, com isolamento por cliente e fallback de erro. Decisões do dono (todas conforme a recomendação): simulador por API administrativa, processamento síncrono, persona em `Client`, `contactRef` livre, histórico de 20 mensagens e 12 000 caracteres, fallback constante, nunca logar conteúdo de mensagens, política de retenção de dados pessoais só antes de dados reais. Passa pelo `reviewer` antes do merge.

**Próximas, nesta ordem**

6. **Rate limiting ([spec 005](specs/005-rate-limiting.md), aprovada e implementada em 2026-10-27; aguarda CI verde e merge do dono):** `@fastify/rate-limit` em Redis, perfis `public`, `admin` e `webhook` por IP, `TRUST_PROXY` (só `false`, `true` fora de produção ou lista de proxies), fail-open, 429 padronizado. Escopo reduzido: perfis de usuário, login e limite adaptativo ficam para a 007.
7. **Canal WhatsApp, parte A ([spec 011](specs/011-canal-whatsapp.md), aprovada em 2026-10-27):** webhook com verificação e assinatura, fila BullMQ, envio da resposta pela Cloud API, mapeamento `phone_number_id` → cliente, número de teste da Meta, LLM ainda `mock`. Só implementar depois da 005 concluída.

**Sob demanda (esboço; entra quando o gatilho acontecer)**

| Item | Spec | Gatilho |
| --- | --- | --- |
| Autenticação JWT + refresh | 007 | antes de existir usuário humano (painel ou atendente) |
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
- **Spec 010 (fatia vertical): concluída e mergeada**, revisada pelo `reviewer` e com CI verde (unitários e integração, Node 22 e LTS). Já existem: migration aditiva (`Client.persona`, `Conversation.contactRef` e o model `Message`, de tenant, com chaves estrangeiras compostas por `clientId`); `LlmProvider` + `MockLlmProvider` (modo de falha, marcadores `[[mock:fail]]`, `[[mock:hang]]`, `[[mock:empty]]`, `[[mock:huge]]`, registro de entradas só para testes); `AttendanceService` (idempotência por `externalId`, histórico de 20 mensagens e 12 000 caracteres, fallback constante gravado com `isFallback`, LLM fora da transação, timeout por `withTimeout`/`TimeoutError`); rotas `POST /admin/clients/:clientId/messages`, `GET .../conversations`, `GET .../conversations/:conversationId/messages` e `persona` no `PATCH /admin/clients/:id`; métricas `llm_requests_total`, `llm_request_duration_seconds`, `attendance_fallbacks_total`; regra de nunca logar conteúdo de mensagem nem persona, com teste de captura de log. Retenção de dados pessoais (mensagens e `contactRef`) segue sem política: decidir antes de dados reais, junto com a RLS. Specs 005 a 009 como esboço (ver "Roadmap"). Próximo passo: escolher o provedor real de LLM (e, junto, decidir o canal) e escrever a spec seguinte. Lição do CI: testes que conferem ordem por tempo precisam de relógio injetável (`src/test-support/clock.ts`), nunca do relógio real.

## 7. Histórico de decisões

- Stack Node 22+ + TypeScript + Fastify + Prisma + Pino definida pelo dono do projeto.
- 2026-10-27: o dono aprovou mudar o processo para specs sob demanda, fatia vertical cedo e `reviewer` obrigatório em specs de segurança. Motivo: as specs 002 e 003, escritas antes do código, precisaram ser reescritas, e a base completa (JWT, RBAC, cache, tempo real) estava sendo construída antes de existir produto.
- O protótipo `customer-service` usava TypeORM; o Soprei usa Prisma. As regras de arquitetura do protótipo (isolamento por cliente, webhook rápido, LLM trocável) foram mantidas.
