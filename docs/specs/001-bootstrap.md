# 001 — Bootstrap do projeto

- **Status:** aprovada
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

- [ ] `pnpm install` e `pnpm typecheck` passam em clone limpo.
- [ ] `pnpm lint` e `pnpm test` passam.
- [ ] Teste do `GET /health` (usando `fastify.inject`) verifica status 200 e corpo esperado.
- [ ] Teste verifica que o boot falha com mensagem clara quando uma variável obrigatória está ausente.
- [ ] Teste verifica que um `NotFoundError` lançado numa rota vira `404` em JSON sem stack, que erro de validação vira `400` e que erro inesperado vira `500` genérico sem vazar mensagem interna.
- [ ] Teste unitário de `Result` (sucesso, falha e `Result.from` com promise rejeitada).
- [ ] `pnpm build` gera `dist/` e `pnpm start` sobe o servidor.
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
