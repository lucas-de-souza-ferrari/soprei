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

Ainda não existem; são criados pela spec 001 (`docs/specs/001-bootstrap.md`). Quando existirem, liste aqui os scripts reais de `package.json`: `dev`, `build`, `test`, `typecheck`, `lint`, e os de Prisma.

## Regras invariantes

- **Isolamento entre clientes (tenants):** toda entidade pertence a um cliente e toda query filtra por ele, sem exceção. Acesso a dados passa por uma camada que exige o identificador do cliente; query solta deve ser impossível por design. Todo código novo de acesso a dados precisa de teste provando que um cliente não enxerga dado de outro.
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

- **Config:** variáveis de ambiente validadas com Zod no boot (`z.coerce.number()` para números); se falhar, loga e encerra com `process.exit(1)`. Acesso por um único módulo de config, nunca `process.env` espalhado.
- **Erros:** hierarquia a partir de `BaseError` (`code`, `statusCode`, `isOperational`, `context`) com `ValidationError` 400, `UnauthorizedError` 401, `ForbiddenError` 403, `NotFoundError` 404, `DatabaseError` 500, `ExternalServiceError` 502. Um error handler central do Fastify converte em JSON; nunca vaza stack nem detalhe interno ao cliente. Nunca `throw new Error('...')` genérico em regra de negócio.
- **Result:** erros esperados em operações críticas (ex.: chamada de LLM, canal externo) voltam como `Result<T, E>`; exceção fica para o excepcional.
- **Tipos:** branded types para identificadores (`ClientId`, `ConversationId`...) criados por factory que valida; o `ClientId` é parâmetro obrigatório de todo repositório, o que faz o isolamento entre clientes ser garantido pelo compilador. Uniões discriminadas para estados. Sem `any` em repositório genérico (o guia usa; nós não).
- **Prisma:** um único client (singleton), nunca por requisição; pool configurado (`max`, timeouts, `statement_timeout`), TLS preservado, health check com `SELECT 1`. Transação com retry só para erros recuperáveis. `select` restrito aos campos necessários; evitar N+1 buscando em lote com `in`.
- **Logs:** Pino, JSON em produção e `pino-pretty` em dev; contexto por requisição via `AsyncLocalStorage` (`requestId`, `clientId`, operação).
- **Rotas:** finas. Validam com Zod, chamam o service, devolvem só campos seguros e deixam o erro subir ao handler central. Pergunta-guia ao escrever: "como essa rota pode falhar?".
- **Itens da base, cada um em sua spec (004 a 009):** observabilidade (logs com contexto + `prom-client`), rate limiting em Redis, cache L1/L2 (sem decorators), JWT com refresh token (access de 15 min, rotação com detecção de reuso, só o hash no Redis com TTL), RBAC e tempo real (SSE e Socket.IO). Implemente cada um somente na sua spec.
- **Chaves de cache, de rate limit, salas e canais de tempo real sempre derivam do `ClientId`** (do token assinado, nunca de header ou corpo da requisição).

**Código em geral:** `async/await`, funções pequenas, responsabilidade única, services sem dependência de Fastify (`req`/`res`). Sufixos de arquivo: `.service.ts`, `.repository.ts`, `.controller.ts`.

**Testes** (o guia não cobre; regra nossa): ao lado do código (`*.test.ts`), runner nativo do Node, salvo decisão em spec. Rotas testadas com `fastify.inject`. Toda regra de acesso a dados tem teste de isolamento entre clientes.

## Nunca faça sem perguntar

- Trocar item da stack ou reverter decisão registrada em `docs/context.md`.
- Relaxar o isolamento entre clientes.
- Apagar ou reescrever migrations já aplicadas.
- Rodar comandos destrutivos em banco, `git push --force`, ou mexer em segredos.
