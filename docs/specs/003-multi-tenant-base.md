# 003 — Base multi-tenant e isolamento entre clientes

- **Status:** aprovada
- **Branch:** `spec/003-multi-tenant-base`
- **Depende de:** 002 (concluída)
- **Implementação:** feita na branch e verificada localmente (ver critérios); falta só a confirmação do CI no GitHub, que não é acessível ao implementer. O status muda para `concluída` depois dela.

## Objetivo

Garantir por design que nenhum cliente (tenant) acessa dado de outro. Esta spec cria o modelo `Client`, o tipo `ClientId`, uma base de repositório que só opera com o cliente informado e uma segunda barreira no próprio Prisma Client, de modo que consultar dado de tenant sem filtro por cliente falhe no tipo, no lint e em runtime.

## Estado de partida (herdado da 002)

- Existem `shared`, `infrastructure` e `presentation`. **`domain` e `application` nascem nesta spec.**
- `getPrisma()`/`getDatabase()` em `src/infrastructure/database/`; `runInTransaction` (retry em `P2034`/`P2028`) e `withDatabaseErrors` (conversão explícita para `DatabaseError`, **sem** `$extends`). Os repositórios desta spec devem usá-los.
- `Brand<T, B>` e `Result` em `src/shared/types/`; erros em `src/shared/errors/` (não existe `ConflictError`).
- Prisma 7: client gerado em `src/generated/prisma`, `schema.prisma` ainda sem models, nenhuma migration.
- **Não existem** `AsyncLocalStorage` (nasce na spec 004) nem `ADMIN_API_KEY` na config.

## Pré-requisitos e limites

- Criar a primeira migration e aplicá-la no banco de desenvolvimento `soprei` (`prisma migrate dev`, que usa um shadow database; o role tem `CREATEDB` para isso) e no `soprei_test` (`pnpm db:migrate:deploy` com `.env.test`) é **esperado** nesta spec.
- Continuam proibidos sem pedir: alterar roles ou senhas, `migrate reset`, `DROP`, apagar dados que o implementer não criou. Os testes criam os próprios clientes com slug único e removem só o que criaram.

## Comportamento esperado

**Modelo de dados (Prisma + migration)**
- `Client`: id UUID, `name`, `slug` único (minúsculas, `[a-z0-9-]`, 3 a 63 caracteres), `status` (`ACTIVE` | `SUSPENDED`), `createdAt`, `updatedAt`, `deletedAt` (soft delete, nulo = ativo). `Client` é a raiz do tenant e **não** é filtrado por `clientId`.
- `Conversation` (mínimo, só para provar o isolamento; campos reais vêm em specs futuras): id UUID, `clientId` obrigatório com FK para `Client` (`ON DELETE RESTRICT`) e índice, `createdAt`, `updatedAt`.
- Versão do UUID (v4 ou v7): o implementer escolhe e registra na spec.

**Domínio (`src/domain/`, sem importar Prisma nem Fastify)**
- `ClientId`: branded type com factory `ClientId.parse(value: string): ClientId` que valida UUID e lança `ValidationError`. Nenhuma API de tenant aceita `string` solta.
- Entidades `Client` e `Conversation` como tipos de domínio (o `Conversation` carrega `clientId: ClientId`).
- Interface `TenantRepository<T, TCreate, TUpdate>` com todos os métodos recebendo `ClientId` como **primeiro parâmetro**: `findById`, `list` (paginação por cursor, `limit` padrão 50 e máximo 200, ordem estável por `createdAt` e `id`), `create`, `update`, `delete`, `count`. O tipo de `TCreate` **não** contém `clientId`.
- Interface de repositório de `Client` (raiz, sem `ClientId`).

**Infraestrutura (`src/infrastructure/database/`)**
- Mapeadores linha do Prisma para entidade de domínio.
- Base de repositório de tenant em que:
  - o filtro por cliente é injetado pela base, **nunca** pelo chamador;
  - o `clientId` do `create` vem do parâmetro e é aplicado **depois** do spread dos dados, então um `clientId` vindo em `data` em runtime não pode sobrescrevê-lo;
  - usa só `findFirst`, `findMany`, `create`, `updateMany`, `deleteMany` e `count`, sempre com `clientId` no `where`; `update`/`delete` que afetam 0 linhas viram `NotFoundError` (id de outro cliente se comporta como inexistente);
  - usa `withDatabaseErrors`; violação de unicidade (`P2002`) vira `ConflictError`;
  - pode ser ligada a uma transação (`forTransaction(tx)`), mantendo as mesmas garantias dentro de `runInTransaction`;
  - sem `any`: genéricos ligados aos tipos gerados pelo Prisma.
- **Segunda barreira (Prisma Client Extension `$extends` com `query.$allOperations`)** aplicada ao client singleton:
  - registro explícito de modelos de tenant (`Conversation`) e de modelos globais (`Client`);
  - em modelo de tenant, **rejeita** (`TenantScopeError`, erro de programação, 500 não operacional) qualquer operação sem `clientId` no `where` (ou nos `data`, no `create`) e **proíbe** `findUnique`, `findUniqueOrThrow`, `update`, `delete` e `upsert`, que não carregam o filtro por cliente;
  - proíbe `$queryRaw`/`$executeRaw` (e variantes `Unsafe`) fora de um módulo dedicado e revisado, ver lint abaixo.
- **Teste de cobertura do registro:** lê o schema gerado (`Prisma.dmmf`) e falha se existir um model com campo `clientId` que não esteja no registro de tenant, ou um model sem `clientId` que não esteja na lista de modelos globais. Assim, todo model novo precisa ser classificado.
- Contexto de cliente por requisição **não** entra aqui: o `ClientId` é sempre passado explicitamente. A resolução a partir da identidade e o `AsyncLocalStorage` ficam para as specs 004 e 007.

**Lint (ESLint, `no-restricted-imports` e `no-restricted-syntax`)**
- Fora de `src/infrastructure/database/**`, é proibido importar `src/generated/prisma` e o módulo `database` do `PrismaClient`/`getPrisma`; presentation e application só enxergam interfaces do domínio.
- Fora de `src/infrastructure/database/**`, é proibido `$queryRaw`, `$queryRawUnsafe`, `$executeRaw` e `$executeRawUnsafe`.
- Exceções documentadas por comentário: o health check, que já está nessa pasta.

**Erros**
- `ConflictError` (409) em `src/shared/errors/`, com teste na hierarquia e no error handler.
- `TenantScopeError` (500, `isOperational: false`).

**Aplicação e HTTP**
- `ClientService` em `src/application/` (criar, buscar por id e por slug, listar, atualizar nome e status, remover por soft delete) com `ClientRepository` injetado.
- Rotas administrativas `/admin/clients` em `src/presentation/` (controllers finos, validação Zod; o parâmetro de rota `:id` vira `ClientId` no validador, id inválido responde 400).
- **`ADMIN_API_KEY`** entra na config: obrigatória e com no mínimo 32 caracteres quando `NODE_ENV=production`; opcional em desenvolvimento e teste. Enviada em `Authorization: Bearer <chave>`, comparada em tempo constante (`timingSafeEqual`). Chave ausente na config ou na requisição: 401 (sem revelar qual). Documentada em `.env.example` e `.env.test.example`.
- A chave de administração é uma credencial **entre clientes** e temporária; seu destino é decidido nas specs 007/008. Não há rate limit até a spec 005; isso fica registrado como risco conhecido.

## Critérios de aceite

- [x] **Isolamento no repositório:** com clientes A e B, cada operação do repositório de `Conversation` feita com o `ClientId` de A nunca lê, altera nem apaga registros de B (`findById`, `list`, `update`, `delete`, `count`); o id de B usado com o `ClientId` de A resulta em `NotFoundError`. _(`conversation.repository.integration.test.ts`, contra `soprei_test`; a base também tem testes unitários com operações falsas.)_
- [x] Teste: `list` e `count` de A não incluem registros de B, inclusive com paginação por cursor atravessando várias páginas.
- [x] Teste: `create` com `clientId` de outro cliente injetado em `data` em runtime (via `as`) grava no cliente do parâmetro, não no injetado.
- [x] **Segunda barreira:** chamar `prisma.conversation.findMany({})` (sem `clientId`), `findUnique`, `update`, `delete` e `upsert` no client estendido lança `TenantScopeError`; o mesmo vale dentro de `runInTransaction`.
- [x] Teste de cobertura do registro falha se um model com `clientId` não estiver registrado (simular com a lista do registro, ou verificar o schema real). _(`tenant-scope.test.ts`: verifica o schema real e simula models novos; ver a decisão sobre `Prisma.dmmf`.)_
- [x] **Tipos:** arquivo de teste compilado por `pnpm typecheck` com `// @ts-expect-error` prova que chamar o repositório sem `ClientId`, ou com `string`, e passar `clientId` em `TCreate`, não compila.
- [x] Teste: `ClientId.parse` aceita UUID válido e rejeita string vazia, texto e UUID malformado com `ValidationError`.
- [x] **Lint:** um arquivo de fixture fora da pasta permitida que importe `src/generated/prisma` ou use `$queryRaw` faz o ESLint falhar (teste executa o ESLint programaticamente ou o CI garante com o próprio `pnpm lint`; registrar qual). _(Registrado: `src/eslint-rules.test.ts` executa o ESLint programaticamente com o `eslint.config.js` real; o CI também roda `pnpm lint`.)_
- [x] CRUD de `Client` com testes de rota (`fastify.inject`): sucesso com a chave, 401 sem chave, com chave errada e com `ADMIN_API_KEY` não configurada; 400 para `:id` inválido; 404 para inexistente e para removido; 409 para slug duplicado; slug inválido 400.
- [x] Teste: config em produção sem `ADMIN_API_KEY` ou com menos de 32 caracteres impede o boot com mensagem clara.
- [x] Teste: respostas de erro de banco e de `TenantScopeError` não vazam SQL nem detalhes internos.
- [x] Migration criada e aplicada em `soprei` e em `soprei_test` (que estava vazio) com `prisma migrate deploy`; `prisma migrate status` confirma os dois em dia. _(No `soprei_test` foi usado `node --env-file=.env.test node_modules/prisma/build/index.js migrate deploy`, o comando documentado no CLAUDE.md, equivalente a `pnpm db:migrate:deploy` com `.env.test`.)_
- [ ] CI verde no GitHub (services com Postgres 18 e Redis 8, `db:generate` antes do typecheck, `db:migrate:deploy` com a migration nova). **Pendente:** o CI não é acessível ao implementer; o workflow não precisou mudar.

## Casos de borda e erros

- Slug duplicado: 409. Cliente removido (soft delete) some de buscas e listagens e seu slug não pode ser reutilizado (decisão: manter a unicidade global; registrar).
- `status: SUSPENDED`: o CRUD continua lendo e editando o cliente; o efeito do status (bloquear login e API) é da spec 007.
- Remover `Client` com `Conversation`s vinculadas: soft delete não apaga dados; a FK `RESTRICT` impede remoção física acidental.
- Dois pedidos simultâneos criando o mesmo slug: um 201 e o outro 409 (a unicidade é do banco, não só do service), coberto por teste.
- `limit` fora do intervalo ou cursor inválido: 400.

## Isolamento entre clientes

É o assunto da spec. Há três barreiras independentes e cada uma tem teste: (1) a base de repositório injeta o filtro; (2) o Prisma Client estendido rejeita operação de tenant sem filtro; (3) o lint impede acesso direto ao Prisma e SQL cru fora da camada. Os testes de isolamento passam a ser o modelo que toda spec futura com dados de tenant deve copiar.

## Fora de escopo

- Autenticação, resolução do cliente a partir da identidade e `AsyncLocalStorage` (004, 007), papéis (008), cache (006), rate limit (005).
- Row Level Security do Postgres como defesa em profundidade: **spec separada logo depois desta**, se o dono decidir.
- Modelos reais de conversa, mensagem e documento.
- Papel de super-admin da plataforma (ver nota da `ADMIN_API_KEY`).

## Decisões e dependências novas

- **Sem dependências novas** (Prisma Client Extensions já vêm no Prisma 7; `zod` e `node:crypto` já existiam).
- **Decisão proposta (implementada):** soft delete com slug reservado para sempre (a unicidade do índice vale para todas as linhas), FK `RESTRICT` e `Conversation` com remoção física permitida só pelo repositório de tenant. A entidade de domínio `Client` não expõe `deletedAt` (removido nunca chega ao domínio).
- **Decisão do dono:** RLS do Postgres fica para uma spec separada **depois da 009** (e antes de entrar com dados reais de clientes).

### Decisões tomadas na implementação

- **UUID v7** (`@default(uuid(7))`, gerado pelo Prisma no client): ordenável por tempo, bom para índices e para o desempate da paginação. `ClientId.parse` aceita qualquer UUID RFC (versões 1 a 8) e normaliza para minúsculas (o que o PostgreSQL devolve).
- **Nomes no banco em snake_case** (`@@map`/`@map`: `clients`, `conversations`, `client_id`, `created_at`...; enum `client_status`). Índice `conversations(client_id, created_at, id)`, que serve ao filtro por cliente e à paginação por cursor. Migration `20261026193548_init_clients_conversations`.
- **Desvio: `Prisma.dmmf` não existe no Prisma 7.** O teste de cobertura e a extensão leem o modelo de dados que o client gerado carrega em `_runtimeDataModel` (API interna), em um único módulo (`schema-info.ts`) com a forma validada por Zod; se uma atualização do Prisma mudar isso, falha alto. Além do teste, a classificação é conferida **na construção do client** (um model novo sem classificar derruba o boot) e **pelo compilador** (`MODEL_SCOPES ... satisfies Record<Prisma.ModelName, ...>`).
- **`findById` lança `NotFoundError`** (em vez de devolver `null`), nos dois repositórios, para um id de outro cliente ser indistinguível de inexistente. Id malformado também é `NotFoundError` e nem vai ao banco (o cast para `uuid` daria 500).
- **A segunda barreira vai além do mínimo da spec:** em model de tenant só aceita `clientId` como string não vazia ou `{ equals: string }` no `where` (`undefined`, `null`, `in`, `not` e `OR` não valem); `updateMany` não pode alterar `clientId` nem `client`; `create`/`createMany` exigem `clientId` em todos os registros e recusam criar por relacionamento; operação desconhecida é recusada (falha fechada); e, em model **global**, `include`/`select`/`_count` de relacionamento que leva a model de tenant é recusado (senão `client.findMany({ include: { conversations: true } })` leria conversas de todos os clientes).
- **`$queryRaw` e afins não são bloqueados em runtime**, só pelo lint: o health check e os testes usam SQL cru dentro de `infrastructure/database/`, como a spec previa ("ver lint").
- **Lint além do mínimo:** fora de `infrastructure/database/**` também é proibido importar `@prisma/*` e `pg`; `application`, `presentation` e `domain` não importam `infrastructure/database`; `domain` só importa de `shared`. O `health.integration.test.ts` saiu de `presentation/` para `infrastructure/http/` por montar infraestrutura real.
- **`update` de `Conversation`:** sem campos editáveis, só marca `updatedAt`. O `update` dos repositórios é `updateMany` + `findFirst` (duas consultas, não atômicas): se o registro some entre elas, `NotFoundError`.
- **`ADMIN_API_KEY`:** variável vazia vale como ausente; fora de produção aceita qualquer valor não vazio; as chaves são comparadas pelo SHA-256 de cada uma com `timingSafeEqual` (tamanho fixo, sem vazar o comprimento); esquema `Bearer` sem diferenciar maiúsculas; 401 idêntico para ausente, malformada e errada. Em produção o boot falha sem a chave ou com menos de 32 caracteres (os testes de boot em produção passaram a informar uma chave descartável).
- **API:** `POST /admin/clients` (201), `GET /admin/clients` (`?limit=&cursor=`; resposta `{ items, nextCursor }`), `GET|PATCH|DELETE /admin/clients/:id` (DELETE responde 204). `PATCH` aceita só `name` e `status` (o slug é imutável); os corpos e a query são `.strict()` (chave desconhecida, como `clientId`, é 400). Não há busca por slug em rota: `ClientService.getBySlug` existe e é testado.
- **Risco conhecido (da spec):** sem rate limit nas rotas `/admin` até a spec 005, e a chave vale para todos os clientes.
- **Ferramentas de teste novas** em `src/test-support/`: `tenant-fixtures.ts` (clientes com slug único, limpeza só do criado) e `in-memory-client.repository.ts`.
- **Verificado com:** Node 24.18.0 e Node 22.23.2 (nvm, chamado por caminho), `typecheck`, `lint`, `format:check`, `test`, `test:integration`, `build`, `prisma migrate status` nos dois bancos e servidor real com curl (create, get, list, patch, delete, 401, 409, 400) contra `soprei_test` e Redis /15, com os dados criados removidos depois.
