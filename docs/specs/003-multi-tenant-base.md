# 003 — Base multi-tenant e isolamento entre clientes

- **Status:** rascunho
- **Branch:** `spec/003-multi-tenant-base`
- **Depende de:** 002

## Objetivo

Garantir por design que nenhum cliente (tenant) acessa dado de outro. Esta spec cria o modelo `Client`, o tipo `ClientId` e a base de repositório que torna impossível consultar dados de tenant sem informar o cliente.

## Comportamento esperado

- Modelo Prisma `Client` (id UUID, nome, slug único, status, timestamps). `Client` é a raiz do tenant e não é filtrado por `clientId`.
- Um modelo mínimo escopado por tenant, `Conversation` (id, `clientId` obrigatório com FK e índice, timestamps), usado apenas para provar o isolamento. Campos reais entram em specs futuras.
- Branded type `ClientId` em `src/domain/` com factory que valida (UUID). Nenhum repositório de tenant aceita `string` solta.
- Interface `TenantRepository<T>` em `src/domain/` e implementação base em `src/infrastructure/database/` em que:
  - todo método (`findById`, `list`, `create`, `update`, `delete`...) recebe `ClientId` como primeiro parâmetro obrigatório;
  - o filtro `clientId` é injetado pela base, nunca pelo chamador;
  - `update`/`delete` por id também filtram por `clientId` (id de outro cliente se comporta como inexistente: `NotFoundError`);
  - sem `any`: tipos genéricos ligados aos tipos gerados pelo Prisma.
- Contexto do cliente por requisição: `ClientId` resolvido a partir da identidade (spec 007 definirá como; aqui há só o ponto de extensão no `AsyncLocalStorage`).
- Regra de lint/teste de arquitetura que falha se um arquivo fora de `infrastructure/database/` importar o `PrismaClient` diretamente.
- CRUD de `Client` (service + rotas administrativas mínimas, sem autenticação ainda: protegidas apenas por `ADMIN_API_KEY` da config até a spec 007).

## Critérios de aceite

- [ ] Teste de isolamento: com dois clientes A e B, cada operação do repositório de `Conversation` feita com o `ClientId` de A nunca lê, altera nem apaga registros de B (cobrir `findById`, `list`, `update`, `delete`).
- [ ] Teste de tipos (`tsc`) mostra que chamar o repositório sem `ClientId`, ou com `string`, não compila.
- [ ] Teste: `ClientId.create` rejeita valor que não é UUID.
- [ ] Teste de arquitetura: importar `PrismaClient` fora da camada permitida falha o lint/teste.
- [ ] CRUD de `Client` funcionando com testes de rota (`fastify.inject`), 401 sem `ADMIN_API_KEY`.
- [ ] Migration criada e aplicada em banco limpo.

## Casos de borda e erros

- `ClientId` inválido em rota: `ValidationError` 400.
- Cliente inexistente ou suspenso: `NotFoundError` 404 / `ForbiddenError` 403, conforme o status.
- Remoção de `Client` com dados vinculados: definir comportamento (soft delete sugerido); testar.

## Isolamento entre clientes

É o assunto da spec. A prova são os testes de isolamento acima, e eles passam a ser o modelo que toda spec futura com dados de tenant deve copiar.

## Fora de escopo

- Autenticação e papéis (007, 008).
- Row Level Security do Postgres: avaliar como defesa em profundidade em spec própria.
- Modelos reais de conversa, mensagem e documento.

## Decisões e dependências novas

- Sem dependências novas além das da 002.
- **Pergunta:** adicionar RLS do Postgres desde já como segunda barreira? (sugestão: spec separada depois desta.)
