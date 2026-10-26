# 002 — Infra local, banco e Redis

- **Status:** rascunho
- **Branch:** `spec/002-infra-local-database`
- **Depende de:** 001

## Objetivo

Ter PostgreSQL e Redis rodando localmente e no CI, com o Prisma como singleton bem configurado e um client Redis compartilhado, para que as specs seguintes (multi-tenancy, rate limit, cache, auth) tenham onde se apoiar.

## Comportamento esperado

- `docker-compose.yml` na raiz com `postgres` e `redis` (volumes nomeados, healthchecks, portas configuráveis). Um comando documentado sobe tudo.
- Prisma com o adapter de driver `pg` (`@prisma/adapter-pg`): **um único** `PrismaClient` exportado por `src/infrastructure/database/`, nunca criado por requisição. Pool com `max`, `idleTimeoutMillis`, `connectionTimeoutMillis` e `statement_timeout` vindos da config. TLS preservado quando a URL pedir.
- Client Redis (`ioredis`) singleton em `src/infrastructure/cache/redis.client.ts`, com reconexão e log de erro sem derrubar o processo.
- Variáveis novas validadas na config: `DATABASE_URL`, `REDIS_URL`, `DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`.
- `GET /health/ready` (readiness) que checa o banco (`SELECT 1`) e o Redis (`PING`). `GET /health` continua só indicando que o processo está vivo.
- Helper de transação em `src/infrastructure/database/` com retry e backoff exponencial **somente** para erros recuperáveis (`P2034` conflito de escrita/deadlock e `P2028` transação expirada), com `maxWait`, `timeout` e nível de isolamento configuráveis.
- Primeira migration (vazia ou só com extensão necessária) para provar o fluxo `migrate`; scripts `db:migrate`, `db:generate` e `db:studio` documentados.
- Shutdown gracioso: ao receber `SIGTERM`/`SIGINT`, fecha o Fastify, o pool e o Redis.
- CI sobe Postgres e Redis como services e roda as migrations antes dos testes.
- Métricas de pool (`totalCount`, `idleCount`, `waitingCount`) expostas por função, para a spec 004 publicar.

## Critérios de aceite

- [ ] `docker compose up -d` sobe os dois serviços saudáveis e `pnpm db:migrate` aplica a migration em banco limpo.
- [ ] Teste de integração: `GET /health/ready` retorna 200 com banco e Redis no ar e 503 quando um deles está indisponível.
- [ ] Teste: importar o módulo de database duas vezes devolve a mesma instância do `PrismaClient`.
- [ ] Teste do helper de transação: repete em `P2034` com backoff, não repete em erro não recuperável e faz rollback quando a função lança.
- [ ] Teste: shutdown fecha conexões (nenhum handle aberto depois do `close`).
- [ ] CI verde com os services.

## Casos de borda e erros

- Banco indisponível no boot: o erro é claro e o processo falha rápido; Redis indisponível no boot: ver decisão abaixo.
- Redis cai com o servidor no ar: operações que dependem dele degradam conforme definido em cada spec; aqui só se loga e se reconecta.
- Timeout de query vira `DatabaseError` (500) com `context`, sem vazar SQL ao cliente.

## Isolamento entre clientes

Não se aplica (sem dados de cliente ainda).

## Fora de escopo

- Modelos de negócio (spec 003).
- Fila de jobs (BullMQ), PgBouncer, réplicas de leitura, Dockerfile da aplicação e deploy.

## Decisões e dependências novas

- Dependências: `prisma`, `@prisma/client`, `@prisma/adapter-pg`, `pg`, `ioredis`.
- **Decisão a confirmar:** no boot, Redis fora do ar derruba o processo (padrão sugerido, pois auth e rate limit dependem dele) ou o servidor sobe degradado?
- Versão do PostgreSQL: a LTS mais recente suportada pelo Prisma; fixar a tag no compose.
