# 003 — Base multi-tenant e isolamento entre clientes

- **Status:** aprovada
- **Branch:** `spec/003-multi-tenant-base`
- **Depende de:** 002 (concluída)

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

- [ ] **Isolamento no repositório:** com clientes A e B, cada operação do repositório de `Conversation` feita com o `ClientId` de A nunca lê, altera nem apaga registros de B (`findById`, `list`, `update`, `delete`, `count`); o id de B usado com o `ClientId` de A resulta em `NotFoundError`.
- [ ] Teste: `list` e `count` de A não incluem registros de B, inclusive com paginação por cursor atravessando várias páginas.
- [ ] Teste: `create` com `clientId` de outro cliente injetado em `data` em runtime (via `as`) grava no cliente do parâmetro, não no injetado.
- [ ] **Segunda barreira:** chamar `prisma.conversation.findMany({})` (sem `clientId`), `findUnique`, `update`, `delete` e `upsert` no client estendido lança `TenantScopeError`; o mesmo vale dentro de `runInTransaction`.
- [ ] Teste de cobertura do registro falha se um model com `clientId` não estiver registrado (simular com a lista do registro, ou verificar o schema real).
- [ ] **Tipos:** arquivo de teste compilado por `pnpm typecheck` com `// @ts-expect-error` prova que chamar o repositório sem `ClientId`, ou com `string`, e passar `clientId` em `TCreate`, não compila.
- [ ] Teste: `ClientId.parse` aceita UUID válido e rejeita string vazia, texto e UUID malformado com `ValidationError`.
- [ ] **Lint:** um arquivo de fixture fora da pasta permitida que importe `src/generated/prisma` ou use `$queryRaw` faz o ESLint falhar (teste executa o ESLint programaticamente ou o CI garante com o próprio `pnpm lint`; registrar qual).
- [ ] CRUD de `Client` com testes de rota (`fastify.inject`): sucesso com a chave, 401 sem chave, com chave errada e com `ADMIN_API_KEY` não configurada; 400 para `:id` inválido; 404 para inexistente e para removido; 409 para slug duplicado; slug inválido 400.
- [ ] Teste: config em produção sem `ADMIN_API_KEY` ou com menos de 32 caracteres impede o boot com mensagem clara.
- [ ] Teste: respostas de erro de banco e de `TenantScopeError` não vazam SQL nem detalhes internos.
- [ ] Migration criada, aplicada em `soprei` e em `soprei_test` limpo via `pnpm db:migrate:deploy`; CI verde (services com Postgres 18 e Redis 8, `db:generate` antes do typecheck).

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

- Sem dependências novas esperadas (Prisma Client Extensions já vêm no Prisma 7).
- **Decisão proposta:** soft delete com slug reservado para sempre, FK `RESTRICT` e `Conversation` com remoção física permitida só pelo repositório de tenant.
- **Decisão do dono:** RLS do Postgres fica para uma spec separada **depois da 009** (e antes de entrar com dados reais de clientes).
