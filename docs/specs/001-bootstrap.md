# 001 — Bootstrap do projeto

- **Status:** aprovada (implementada; só falta o critério "CI verde no PR", que só dá para verificar depois do push)
- **Branch:** `spec/001-bootstrap`
- **Depende de:** nenhuma

## Objetivo

Ter um projeto Node 22+ + TypeScript + Fastify + Prisma + Pino que sobe, tem scripts de verificação e roda no CI, para que as próximas specs tenham onde se apoiar.

## Comportamento esperado

- `package.json` com `engines.node >= 22` (sem teto de versão), gerenciador de pacotes único (pnpm, confirmado) e os scripts: `dev`, `build`, `start`, `test`, `typecheck`, `lint`, `format`, `db:generate`, `db:migrate`.
- `tsconfig.json` com `strict: true`.
- Estrutura de camadas criada conforme `docs/context.md` (`domain`, `application`, `infrastructure`, `presentation`, `shared`), só com o que a spec usa; pastas vazias não entram.
- Servidor Fastify em `src/infrastructure/http/` com logger Pino (pretty em dev, JSON em produção) e `GET /health` retornando `200 { "status": "ok" }`. A rota fica em `src/presentation/`.
- Variáveis de ambiente lidas e validadas por Zod em `src/infrastructure/config/` com `z.coerce` para números; falha de validação loga o erro e encerra com `process.exit(1)` e mensagem clara. Acesso por um módulo único de config. `.env.example` documenta cada variável.
- `src/shared/errors/` com `BaseError` (`code`, `statusCode`, `isOperational`, `context`) e as subclasses `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `DatabaseError` e `ExternalServiceError`.
- Error handler central do Fastify: erro de domínio vira JSON com o `statusCode` da classe; erro de validação Zod vira 400; erro inesperado vira 500 genérico. Stack e detalhes internos nunca vão na resposta, só no log.
- `src/shared/types/` com `Brand` e `Result<T, E>`.
- Prisma inicializado com `prisma/schema.prisma` e o `datasource` configurado via `DATABASE_URL`, **sem models ainda** (modelos entram na spec de multi-tenancy).
- ESLint + Prettier configurados.
- Workflow de CI em `.github/workflows/ci.yml` que roda `typecheck`, `lint` e `test` em PR, com matriz de Node (22 e a versão LTS mais recente) para garantir que versões maiores funcionam.
- `.gitignore` já existente cobre `.env`, `node_modules` e `dist`.
- Atualizar a seção "Comandos" do `CLAUDE.md` com os scripts reais.

## Critérios de aceite

- [x] `pnpm install` e `pnpm typecheck` passam em clone limpo.
- [x] `pnpm lint` e `pnpm test` passam.
- [x] Teste do `GET /health` (usando `fastify.inject`) verifica status 200 e corpo esperado.
- [x] Teste verifica que o boot falha com mensagem clara quando uma variável obrigatória está ausente.
- [x] Teste verifica que um `NotFoundError` lançado numa rota vira `404` em JSON sem stack, que erro de validação vira `400` e que erro inesperado vira `500` genérico sem vazar mensagem interna.
- [x] Teste unitário de `Result` (sucesso, falha e `Result.from` com promise rejeitada).
- [x] `pnpm build` gera `dist/` e `pnpm start` sobe o servidor.
- [ ] CI roda e fica verde no PR.

## Casos de borda e erros

- `.env` ausente em dev: erro explicando que deve copiar `.env.example`.
- Porta em uso: o erro do Fastify aparece no log, sem engolir.

## Isolamento entre clientes

Não se aplica (sem acesso a dados de cliente).

## Fora de escopo

- Models do Prisma, migrations, escolha final de banco/fila/LLM.
- Dockerfile e deploy.
- Qualquer rota além de `/health`.

## Decisões e dependências novas

- Dependências previstas: `fastify`, `zod`, `pino`, `pino-pretty` (dev), `prisma` e `@prisma/client`, `dotenv`, `typescript`, `tsx`, `eslint`, `typescript-eslint`, `prettier`.
- Test runner: nativo do Node (`node --test`) com `tsx`, a menos que a spec seja ajustada.
- Dependências efetivamente adicionadas (versões estáveis mais recentes no momento): `fastify`, `zod` (v4), `pino`, `dotenv`, `@prisma/client` (7.10.1); dev: `typescript`, `tsx`, `prisma`, `pino-pretty`, `eslint`, `typescript-eslint`, `prettier`, mais `@eslint/js`, `eslint-config-prettier`, `globals` e `@types/node` (necessárias para a flat config do ESLint, para desligar regras de estilo que conflitam com o Prettier e para tipar o Node).
- **TypeScript 6.0.3, não 7.x:** `typescript-eslint` declara peer `typescript <6.1.0`; usar o 7 quebraria o lint com tipos. Revisar quando o `typescript-eslint` suportar o 7.
- **Prisma 7.10.1 fixado:** a tag `latest` do pacote `prisma` aponta hoje para um RC (`8.0.0-rc.27`), que não é estável e destoa do `@prisma/client` 7.10.1. Manter CLI e client na mesma versão.
- **Prisma 7:** a URL do banco não fica mais no `schema.prisma`; é lida de `DATABASE_URL` em `prisma.config.ts`. O generator é `prisma-client` com saída em `src/generated/prisma` (ignorado pelo git; regenerar com `pnpm db:generate`). `db:generate` roda offline e funcionou sem models. `db:migrate` é `prisma migrate dev`: exige um PostgreSQL acessível e não foi executado, pois ainda não há banco nem models (spec 002/003).
- **pnpm 12 e scripts de build:** `pnpm-workspace.yaml` autoriza o postinstall de `prisma` e `@prisma/engines` e bloqueia o de `esbuild` (o binário vem por dependência opcional; `tsx` funciona sem o script).
- `packageManager: pnpm@12.3.4` no `package.json` (usado pelo `pnpm/action-setup` no CI). `.gitattributes` força LF para o Prettier e o git não brigarem no Windows.
- `DATABASE_URL` é **obrigatória** na config (aceita só `postgres://` ou `postgresql://`), embora nada conecte ao banco nesta spec; as demais variáveis têm default: `NODE_ENV` (development), `HOST` (0.0.0.0), `PORT` (3000), `LOG_LEVEL` (info).
- Formato de erro HTTP: `{ "error": { "code", "message", "requestId", "details"? } }`. `details` só existe em erro de validação Zod (caminho e mensagem de cada campo). Erros com status 5xx sempre respondem a mensagem genérica "Erro interno do servidor"; `context` do erro nunca vai na resposta. Rota inexistente e erros 4xx do próprio Fastify (ex.: JSON malformado) também usam esse formato.
- Só existem `shared`, `infrastructure` e `presentation`: `domain` e `application` não têm nada a abrigar ainda e não foram criadas.
- ESLint: `strictTypeChecked`; `no-floating-promises` fica desligada só em `*.test.ts`, porque `describe`/`it` do `node:test` devolvem promises que o runner aguarda. Um único `eslint-disable-next-line` documentado em `result.test.ts` (rejeição com valor que não é `Error`).
- Encerramento limpo em SIGINT/SIGTERM (`app.close()`) em `src/index.ts`.
- CI também roda em push para `main`, além de PR.

## Verificação

Rodado localmente (Node 24, pnpm 12.3.4): `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (26 testes), `pnpm build` e `pnpm start` com `GET /health` real (200 `{"status":"ok"}`), em modo pretty e em modo JSON (`NODE_ENV=production`). Clone limpo e `pnpm install --frozen-lockfile` verificados em um clone temporário da branch. Node 22 não estava disponível localmente; a matriz do CI cobre 22 e a LTS.
