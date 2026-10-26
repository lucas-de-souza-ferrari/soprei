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
| Canal | WhatsApp Cloud API (Meta), outros | Protótipo usou Cloud API oficial com Embedded Signup. |
| Hospedagem | VPS (protótipo: Hetzner) | — |

## 3.1. Modelo de IA em desenvolvimento

- Interface única `LLMProvider` (gerar resposta, gerar embedding).
- Três implementações: `mock` (respostas determinísticas, usada nos testes e no CI), um modelo barato ou gratuito para dev manual, e o modelo de produção.
- A escolha vem de variável de ambiente (por exemplo `LLM_PROVIDER`), validada na config.

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
│   ├── database/    # Prisma singleton, implementações de repositório
│   ├── http/        # servidor Fastify, error handler central
│   ├── cache/       # (por spec)
│   └── external-apis/  # LLM (mock + real), canal de mensagens
├── presentation/    # controllers/rotas, hooks, validators Zod
├── shared/          # errors (BaseError...), types (Brand, Result), utils
└── index.ts         # bootstrap
prisma/
└── schema.prisma
```

## 5. Roadmap (fatias)

Cada item vira uma ou mais specs em `docs/specs/`. Não pular a ordem sem motivo.

Base de engenharia (specs escritas em `docs/specs/`):

1. 001 — Bootstrap (camadas, config, erros, Result, `/health`)
2. 002 — Infra local, Postgres, Redis, Prisma singleton
3. 003 — Base multi-tenant e isolamento
4. 004 — Observabilidade (logs com contexto, métricas)
5. 005 — Rate limiting
6. 006 — Cache L1/L2
7. 007 — Autenticação JWT + refresh
8. 008 — RBAC
9. 009 — Tempo real (SSE + WebSocket)

Produto (specs a escrever quando a base estiver pronta):

10. `LLMProvider` com `mock` e um provedor real
11. Entrada de mensagens (webhook/canal) + fila
12. Pipeline de resposta com persona e fallback de erro
13. Base de conhecimento (ingestão de documentos + busca)
14. Painel admin (separado, depois do backend)
15. Deploy

## 6. Estado atual

- Repositório criado, sem código. Estrutura de ADD (CLAUDE.md, specs, subagentes) montada.
- Specs 001 a 009 em rascunho. Próximo passo: aprovar e executar `docs/specs/001-bootstrap.md`, na ordem numérica.

## 7. Histórico de decisões

- Stack Node 22+ + TypeScript + Fastify + Prisma + Pino definida pelo dono do projeto.
- O protótipo `customer-service` usava TypeORM; o Soprei usa Prisma. As regras de arquitetura do protótipo (isolamento por cliente, webhook rápido, LLM trocável) foram mantidas.
