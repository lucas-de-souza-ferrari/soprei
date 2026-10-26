# Soprei

Sistema de atendimento via IA. Contexto completo, decisões e roadmap em [docs/context.md](docs/context.md) — leia antes de propor arquitetura.

## Stack (decidida — não trocar sem perguntar)

- Node.js 22 ou superior (`engines.node >= 22`; versões maiores são aceitas), TypeScript strict
- Fastify (HTTP) + Zod (validação de entrada)
- Prisma (ORM, migrations) sobre PostgreSQL
- Redis (rate limit, cache, revogação de tokens, tempo real)
- Pino (logs estruturados) + `prom-client` (métricas)
- JWT + refresh token, RBAC, SSE e Socket.IO (specs 007 a 009)

Ainda não decididos: fila de jobs, provedor de LLM, canal de mensagens, hospedagem. Ver "Decisões em aberto" em `docs/context.md`. Não assuma nenhum deles; proponha em uma spec.

As specs 001 a 009 formam a base de engenharia e são implementadas **em ordem numérica**; não pule specs.

## Como trabalhamos (Agent-Driven Development)

1. Nada de código sem spec aprovada em `docs/specs/NNN-nome.md` (use `docs/specs/_template.md`).
2. Uma spec = uma branch (`spec/NNN-nome`) = um PR pequeno.
3. Implemente só o que a spec pede. O que ficou de fora vai para "Fora de escopo" da spec ou vira nova spec.
4. Uma spec só está pronta quando todos os critérios de aceite têm teste passando e `typecheck`, `lint` e `test` estão verdes.
5. O humano aprova specs e faz o merge dos PRs. Nunca dê merge nem push direto na `main`.

Subagentes em `.claude/agents/`: `spec-writer` (escreve a spec), `implementer` (implementa uma spec aprovada), `reviewer` (revisa o diff, foco em isolamento de dados e segurança).

## Comandos

Gerenciador de pacotes: **pnpm**. Primeiro uso: `pnpm install`, `pnpm db:generate` (o Prisma Client não vai para o git e o `typecheck` precisa dele), `cp .env.example .env`, `cp .env.test.example .env.test` (preencha a senha nos dois) e a preparação do banco em "Ambiente local" abaixo.

| Script | O que faz |
| --- | --- |
| `pnpm dev` | Sobe o servidor com `tsx watch` (log colorido via `pino-pretty`) |
| `pnpm build` | Compila para `dist/` (`tsc -p tsconfig.build.json`, sem testes) |
| `pnpm start` | Roda `node dist/index.js` (rode `pnpm build` antes) |
| `pnpm test` | Testes **unitários** com `node --test` + `tsx` (`src/**/*.test.ts`, exceto `*.integration.test.ts`); não precisam de Postgres nem de Redis |
| `pnpm test:integration` | Testes de integração (`src/**/*.integration.test.ts`); exigem Postgres e Redis no ar, leem `.env.test` e só rodam contra `soprei_test` e Redis `/15` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint (flat config, `typescript-eslint` strict type-checked) |
| `pnpm format` / `pnpm format:check` | Prettier (escreve / só verifica) |
| `pnpm db:generate` | `prisma generate` (Prisma Client em `src/generated/prisma`, ignorado pelo git) |
| `pnpm db:migrate` | `prisma migrate dev` (cria e aplica migration no banco de desenvolvimento; exige PostgreSQL acessível em `DATABASE_URL` e usa shadow database) |
| `pnpm db:migrate:deploy` | `prisma migrate deploy` (aplica migrations pendentes; é o que o CI roda) |

Antes de dar uma spec como pronta: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration`. O CI roda esses quatro (mais `db:generate` e `db:migrate:deploy`) em Node 22 e na LTS mais recente, com Postgres e Redis como services do job.

### Ambiente local (sem Docker)

PostgreSQL e Redis rodam **nativos** na máquina, em `localhost:5432` e `localhost:6379`. O projeto não usa Docker nem `docker-compose` no desenvolvimento. Preparação única, feita por quem administra a máquina (um agente não cria nem altera roles, bancos ou senhas), em um `psql` ou pgAdmin como administrador:

```sql
CREATE ROLE soprei LOGIN PASSWORD '<escolha-uma-senha>' CREATEDB;
CREATE DATABASE soprei OWNER soprei;
CREATE DATABASE soprei_test OWNER soprei;
```

`CREATEDB` é necessário porque `prisma migrate dev` cria um shadow database. Dois bancos separam desenvolvimento (`soprei`) e testes (`soprei_test`). No Redis, índice `0` para desenvolvimento e `15` para testes.

Depois: `cp .env.example .env` e `cp .env.test.example .env.test`, trocando `<senha>` pela senha escolhida (ambos ficam fora do git). `.env` aponta para `soprei` e Redis `/0`; `.env.test` para `soprei_test` e Redis `/15`.

Confirmar que os serviços estão no ar (o servidor também verifica os dois no boot e encerra com código 1 se algum faltar):

- Postgres: `psql "postgresql://soprei@localhost:5432/soprei_test" -c "SELECT 1"` (ou `pg_isready -h localhost -p 5432`).
- Redis: `redis-cli -h localhost -p 6379 ping` (resposta `PONG`).
- Com o servidor rodando: `curl localhost:3000/health` (processo vivo) e `curl localhost:3000/health/ready` (banco e Redis; 200 ou 503).

Migrations contra o banco de testes (sem tocar no de desenvolvimento): `node --env-file=.env.test node_modules/prisma/build/index.js migrate deploy`. Um model novo exige migration, classificação em `MODEL_SCOPES` (ver "Acesso a dados e isolamento") e `pnpm db:generate` antes de testar.

**Segurança dos testes:** os testes de integração se recusam a rodar se `DATABASE_URL` não apontar para `soprei_test` ou `REDIS_URL` para o índice 15 (ambos em localhost), nunca usam `FLUSHALL`/`FLUSHDB` e cada teste remove só as chaves que criou, com prefixo único (`src/test-support/`). Testes que precisam de infra devem se chamar `*.integration.test.ts` e começar com `loadIntegrationConfig()`.

## Regras invariantes

- **Isolamento entre clientes (tenants):** toda entidade pertence a um cliente e toda query filtra por ele, sem exceção. Acesso a dados passa por uma camada que exige o identificador do cliente; query solta deve ser impossível por design. Todo código novo de acesso a dados precisa de teste provando que um cliente não enxerga dado de outro. As três barreiras e as regras de acesso a dados estão em "Acesso a dados e isolamento" abaixo.
- **Erro nunca vira silêncio:** falha de IA ou de integração responde com fallback educado ao usuário final e loga com contexto.
- **Webhooks respondem rápido** e processam em background; nada de chamada de IA no fluxo síncrono do webhook.
- **LLM é peça trocável:** chamadas ao modelo ficam atrás de uma interface única (`LLMProvider`), com implementação `mock` para testes e dev offline. Trocar de modelo é mudar configuração, não código de negócio.
- Validar toda entrada externa com Zod antes de usar.
- Sem `any` solto e sem `// @ts-ignore` sem comentário explicando o motivo.
- Logar com Pino, estruturado, incluindo o identificador do cliente quando houver.
- Nunca commitar `.env`, chaves ou tokens. Toda variável de ambiente é validada em um único módulo de config e documentada em `.env.example`.
- Não adicionar dependência sem justificar na spec ou no PR.

## Arquitetura e padrões

Seguimos o guia [Engenharia Backend Node.js + TypeScript](https://www.vivodecodigo.com.br/backend/engenharia-backend-nodejs-typescript-guia-definitivo) (Vivo de Código), adaptado a Fastify. Resumo do que vale aqui; detalhes e desvios em `docs/context.md`.

**Camadas** (dependências apontam para o domínio; `domain` não importa de nenhuma outra camada):

```
src/
├── domain/          # entities, value-objects, interfaces de repositório
├── application/     # services/use-cases e interfaces (ex.: LLMProvider)
├── infrastructure/  # database (Prisma), http (Fastify), cache, external-apis, config, logger
├── presentation/    # controllers/rotas, hooks/middlewares, validators Zod
└── shared/          # errors, types (Brand, Result), utils
```

- **Dependências entre camadas (o ESLint impõe):** `domain` só importa de `shared` (nem Prisma, nem Fastify); `application` e `presentation` não importam `infrastructure/database`. Elas dependem de **interfaces do domínio** (`ClientRepository`, `TenantRepository`...) e recebem a implementação por injeção (testes de integração que precisam do banco ficam em `infrastructure/`); quem liga tudo é `src/index.ts` e `infrastructure/http/server.ts`. `ClientId` e as entidades vivem em `src/domain/`.
- **Config:** variáveis de ambiente validadas com Zod no boot (`z.coerce.number()` para números); se falhar, loga e encerra com `process.exit(1)`. Acesso por um único módulo de config, nunca `process.env` espalhado.
- **Erros:** hierarquia a partir de `BaseError` (`code`, `statusCode`, `isOperational`, `context`) com `ValidationError` 400, `UnauthorizedError` 401, `ForbiddenError` 403, `NotFoundError` 404, `ConflictError` 409, `DatabaseError` 500, `TenantScopeError` 500 (não operacional: consulta de tenant sem escopo é bug de programação), `ExternalServiceError` 502. Um error handler central do Fastify converte em JSON; nunca vaza stack nem detalhe interno ao cliente. Nunca `throw new Error('...')` genérico em regra de negócio.
- **Result:** erros esperados em operações críticas (ex.: chamada de LLM, canal externo) voltam como `Result<T, E>`; exceção fica para o excepcional.
- **Tipos:** branded types para identificadores (`ClientId`, `ConversationId`...) criados por factory que valida; o `ClientId` é parâmetro obrigatório de todo repositório, o que faz o isolamento entre clientes ser garantido pelo compilador. Uniões discriminadas para estados. Sem `any` em repositório genérico (o guia usa; nós não).
- **Prisma:** um único client (singleton), nunca por requisição; pool configurado (`max`, timeouts, `statement_timeout`), TLS preservado, health check com `SELECT 1`. Transação com retry só para erros recuperáveis. `select` restrito aos campos necessários; evitar N+1 buscando em lote com `in`.
- **Logs:** Pino, JSON em produção e `pino-pretty` em dev; contexto por requisição via `AsyncLocalStorage` (`requestId`, `clientId`, operação).
- **Rotas:** finas. Validam com Zod, chamam o service, devolvem só campos seguros e deixam o erro subir ao handler central. Pergunta-guia ao escrever: "como essa rota pode falhar?".
- **Itens da base, cada um em sua spec (004 a 009):** observabilidade (logs com contexto + `prom-client`), rate limiting em Redis, cache L1/L2 (sem decorators), JWT com refresh token (access de 15 min, rotação com detecção de reuso, só o hash no Redis com TTL), RBAC e tempo real (SSE e Socket.IO). Implemente cada um somente na sua spec.
- **Chaves de cache, de rate limit, salas e canais de tempo real sempre derivam do `ClientId`** (do token assinado, nunca de header ou corpo da requisição).

### Acesso a dados e isolamento (spec 003)

Três barreiras independentes, cada uma com teste:

1. **Repositório de tenant.** Todo método recebe `ClientId` como **primeiro parâmetro**; o filtro por cliente é montado pela base (`PrismaTenantRepository`, em `infrastructure/database/`), nunca pelo chamador. Só usa `findFirst`, `findMany`, `create`, `updateMany`, `deleteMany` e `count`, sempre com `clientId` no `where`; id de outro cliente é `NotFoundError`. Os tipos de criação e atualização não têm `clientId`. Dentro de `runInTransaction`, use `repo.forTransaction(tx)`. `Client` é a raiz do tenant (model global, repositório próprio, sem `ClientId`).
2. **Prisma Client Extension (`tenant-scope.ts`).** O client singleton (`getPrisma()`) é estendido: em model de tenant, qualquer operação sem `clientId` no `where` (ou nos `data`) lança `TenantScopeError`, e `findUnique`, `findUniqueOrThrow`, `update`, `delete` e `upsert` são proibidos. **Todo model novo precisa ser classificado em `MODEL_SCOPES`** (`tenant` se tem `clientId`, `global` se não tem); o compilador e o teste de cobertura exigem.
3. **Lint.** Fora de `src/infrastructure/database/**` é proibido importar `src/generated/prisma`, `@prisma/*`, `pg`, `getPrisma`/`PrismaClient` e usar `$queryRaw`, `$queryRawUnsafe`, `$executeRaw`, `$executeRawUnsafe`. A única exceção é essa pasta (inclui o health check). Não desligue a regra: se precisa de SQL cru, ele entra num módulo revisado dentro de `infrastructure/database/`, filtrando por `clientId`.

O `ClientId` é sempre passado explicitamente (contexto por requisição vem nas specs 004 e 007). Rotas `/admin/*` usam `ADMIN_API_KEY` (Bearer, tempo constante), credencial temporária **entre clientes** que as specs 007/008 substituem; ela nunca vai em log nem em resposta. Dados de teste: use `src/test-support/tenant-fixtures.ts` (clientes com slug único e limpeza só do que o teste criou) e copie o modelo de `conversation.repository.integration.test.ts` para provar o isolamento em cada repositório novo.

**Código em geral:** `async/await`, funções pequenas, responsabilidade única, services sem dependência de Fastify (`req`/`res`). Sufixos de arquivo: `.service.ts`, `.repository.ts`, `.controller.ts`.

**Testes** (o guia não cobre; regra nossa): ao lado do código (`*.test.ts`), runner nativo do Node, salvo decisão em spec. Os que precisam de Postgres ou Redis são `*.integration.test.ts` (ver "Ambiente local"). Rotas testadas com `fastify.inject`. Toda regra de acesso a dados tem teste de isolamento entre clientes.

## Nunca faça sem perguntar

- Trocar item da stack ou reverter decisão registrada em `docs/context.md`.
- Relaxar o isolamento entre clientes.
- Apagar ou reescrever migrations já aplicadas.
- Criar ou alterar roles, bancos, senhas ou dados no PostgreSQL e no Redis locais do dono, ou rodar `FLUSHALL`/`FLUSHDB`/`DROP DATABASE`. Eles rodam nativos na máquina (sem Docker) e podem ter outros dados; testes só tocam `soprei_test` e Redis `/15`.
- Rodar comandos destrutivos em banco, `git push --force`, ou mexer em segredos.
