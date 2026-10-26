# 002 — Infra local, banco e Redis

- **Status:** aprovada
- **Branch:** `spec/002-infra-local-database`
- **Depende de:** 001 (concluída)

## Objetivo

Ter PostgreSQL e Redis rodando localmente e no CI, com o Prisma como singleton bem configurado e um client Redis compartilhado, para que as specs seguintes (multi-tenancy, rate limit, cache, auth) tenham onde se apoiar.

## Pré-requisitos

- **Sem Docker no desenvolvimento local** (decisão do dono). PostgreSQL e Redis já rodam **nativos** na máquina do dono, em `localhost:5432` e `localhost:6379`. O projeto não terá `docker-compose.yml`.
- **O implementer não cria nem altera nada nos serviços locais do dono** (roles, bancos, senhas, dados, configuração). Quem prepara o ambiente é o dono, com o SQL documentado abaixo, e informa a `DATABASE_URL` e a `REDIS_URL` no `.env`. Se o `.env` não tiver credenciais funcionando, o implementer para e pede, em vez de adivinhar senha ou usar o usuário administrador.
- Preparação única, a ser feita pelo dono em um `psql` (ou pgAdmin) como administrador, e documentada no `CLAUDE.md`:

  ```sql
  CREATE ROLE soprei LOGIN PASSWORD '<escolha-uma-senha>' CREATEDB;
  CREATE DATABASE soprei OWNER soprei;
  CREATE DATABASE soprei_test OWNER soprei;
  ```

  `CREATEDB` é necessário porque `prisma migrate dev` cria um shadow database. Dois bancos separam desenvolvimento e testes.
- Redis: usar o índice de banco `0` para desenvolvimento e `15` para testes (`REDIS_URL` com `/0` e `/15`).

## Estado de partida (herdado da 001)

- `DATABASE_URL` já é obrigatória na config (`src/infrastructure/config/env.schema.ts`), mas nada conecta ao banco.
- Prisma 7.10.x: URL do banco em `prisma.config.ts`; generator `prisma-client` com saída em `src/generated/prisma` (ignorada pelo git); `schema.prisma` sem models.
- Existem `shared`, `infrastructure` e `presentation`. `domain` e `application` ainda não.
- `pnpm test` roda `src/**/*.test.ts` e o CI não tem serviços de banco.

## Comportamento esperado

**Ambiente**
- Instruções de preparação do ambiente local (SQL da seção "Pré-requisitos", como confirmar que Postgres e Redis estão no ar) documentadas no `CLAUDE.md`. Sem Docker.
- `.env.example` atualizado com todas as variáveis novas e valores de exemplo para o ambiente nativo (`soprei` / `soprei_test`, Redis `/0` e `/15`), com a senha como placeholder.
- Arquivo de ambiente de testes: os testes de integração leem `.env.test` (ignorado pelo git, com `.env.test.example` versionado), que aponta para `soprei_test` e Redis `/15`. Nenhum teste roda contra o banco de desenvolvimento.

**Prisma (Prisma 7 exige driver adapter)**
- `@prisma/adapter-pg` com `pg`: **um único** `PrismaClient` exportado por `src/infrastructure/database/`, nunca criado por requisição, importado de `src/generated/prisma`.
- Pool configurado pelo adapter (`max`, `idleTimeoutMillis`, `connectionTimeoutMillis`, `statement_timeout`) com valores vindos da config. TLS preservado quando a URL pedir.
- Função de checagem de saúde do banco (`SELECT 1`).
- Helper de transação em `src/infrastructure/database/` com retry e backoff exponencial **somente** para erros recuperáveis (`P2034` conflito de escrita/deadlock e `P2028` transação expirada), com `maxWait`, `timeout` e nível de isolamento configuráveis.
- Função que expõe métricas do pool (`totalCount`, `idleCount`, `waitingCount`) para a spec 004 publicar.
- Erros do Prisma e do driver (timeout, conexão recusada) convertidos em `DatabaseError` (500, não operacional) com `context` interno e sem vazar SQL ao cliente.

**Redis**
- Client `ioredis` singleton em `src/infrastructure/cache/redis.client.ts`, com reconexão automática e log de erro sem derrubar o processo em runtime. Função de checagem (`PING`).

**Configuração**
- Variáveis novas validadas em `env.schema.ts`: `REDIS_URL` (obrigatória) e `DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS` (com defaults). `DATABASE_URL` continua como está.

**HTTP e ciclo de vida**
- `GET /health` continua só indicando que o processo está vivo. Novo `GET /health/ready` checa banco e Redis: 200 se ambos respondem, 503 se algum falhar (corpo indica qual, sem detalhes internos).
- No boot, o servidor verifica banco e Redis e **falha rápido** (log claro e `process.exit(1)`) se algum estiver indisponível. *Decisão proposta; ver "Decisões".*
- Shutdown gracioso em `SIGTERM`/`SIGINT`: fecha o Fastify, depois o pool e o Redis.

**Migrations**
- Sem models nesta spec, `prisma migrate dev` não gera migration; a primeira migration real vem na spec 003. Aqui entra o script `db:migrate:deploy` (`prisma migrate deploy`) e o fluxo é provado aplicando-o em banco limpo (sem migrations pendentes, termina com sucesso). Mantém-se `db:migrate` como está.

**Testes e CI**
- Separar testes que precisam de infra: arquivos `*.integration.test.ts`. `pnpm test` passa a rodar **só os unitários** (sem banco, rápido) e o novo `pnpm test:integration` roda os de integração, exigindo Postgres e Redis no ar.
- Segurança dos testes de integração: só se conectam a `soprei_test` e Redis `/15`; **recusam rodar** (falha clara) se a URL apontar para outro banco; **nunca** usam `FLUSHALL`/`FLUSHDB`: cada teste usa um prefixo de chave único e remove só as chaves que criou.
- CI (GitHub Actions) sobe Postgres e Redis como `services` do job no runner hospedado, define `DATABASE_URL` e `REDIS_URL`, roda `db:migrate:deploy` e depois `pnpm test` e `pnpm test:integration`, em toda a matriz de Node. Isso é só do CI; nada de container no desenvolvimento local.

## Critérios de aceite

- [ ] Com Postgres e Redis nativos no ar e o `.env` preenchido, `pnpm db:migrate:deploy` termina com sucesso no banco `soprei_test` limpo.
- [ ] Teste: a suíte de integração se recusa a rodar quando `DATABASE_URL` não aponta para `soprei_test` e nunca emite `FLUSHALL`/`FLUSHDB`.
- [ ] Integração: `GET /health/ready` retorna 200 com banco e Redis no ar e 503 quando um deles está indisponível (simular desconectando o client ou apontando para porta fechada).
- [ ] Teste: importar o módulo de database duas vezes devolve a mesma instância do `PrismaClient`.
- [ ] Integração do helper de transação: repete em `P2034` com backoff (erro simulado), não repete em erro não recuperável e faz rollback quando a função lança.
- [ ] Integração: query que excede `statement_timeout` vira `DatabaseError` sem vazar SQL.
- [ ] Teste de config: `REDIS_URL` ausente impede o boot com mensagem clara; as variáveis de pool respeitam defaults e limites.
- [ ] Teste: boot com banco ou Redis indisponível sai com código 1 e mensagem clara.
- [ ] Teste: shutdown fecha pool e Redis (nenhum handle aberto depois do `close`).
- [ ] `pnpm test` roda sem infra e `pnpm test:integration` roda com infra; ambos verdes no CI, em Node 22 e na LTS.

## Casos de borda e erros

- Redis cai com o servidor no ar: o client reconecta, `/health/ready` passa a retornar 503, e as specs seguintes definem a degradação de cada recurso. Aqui só se loga e se reconecta.
- Banco cai com o servidor no ar: queries falham com `DatabaseError`; o pool recupera quando o banco volta.
- Variáveis de pool inválidas (ex.: `max` zero ou negativo): erro de config no boot.

## Isolamento entre clientes

Não se aplica (sem dados de cliente ainda).

## Fora de escopo

- Models de negócio e primeira migration (spec 003).
- Docker e Compose no desenvolvimento local, Dockerfile da aplicação, fila de jobs (BullMQ), PgBouncer, réplicas de leitura e deploy.
- Criar ou alterar roles, bancos e dados dos serviços locais do dono (é feito por ele, ver "Pré-requisitos").
- Métricas Prometheus em si (spec 004); aqui só a função que expõe os números do pool.

## Decisões e dependências novas

- Dependências: `@prisma/adapter-pg`, `pg` (e `@types/pg`), `ioredis`.
- **Decisão proposta (aprovar a spec = aceitar):** no boot, banco ou Redis indisponível **derruba o processo**. Motivo: auth e rate limit dependem do Redis, e subir "meio vivo" esconde problema. Em runtime a degradação é tratada por spec.
- Versão do PostgreSQL: o implementer registra aqui a versão do Postgres local do dono (`SHOW server_version`) e usa a mesma major no CI, confirmando que o Prisma 7.10 a suporta.
- Se o `prisma migrate deploy` exigir ao menos uma migration em alguma versão do Prisma, o implementer registra aqui o desvio e adota a alternativa mais simples (por exemplo, `prisma migrate status` no teste).
