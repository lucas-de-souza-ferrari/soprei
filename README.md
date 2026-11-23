# Soprei

Atendimento por inteligência artificial no WhatsApp para várias empresas. Cada empresa conecta o próprio número, escreve a persona do atendente, carrega documentos e estoque, configura a agenda e acompanha as conversas por um painel na web.

## O que há no repositório

| Pasta       | Conteúdo                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `backend/`  | API e worker da fila (Node.js, TypeScript, Fastify, Prisma sobre PostgreSQL, Redis e BullMQ)   |
| `frontend/` | Site, telas de conta e painel da empresa (React, Vite, Tailwind)                               |
| `deploy/`   | Script de deploy com rollback, programa de entrada do deploy automático e exemplos do servidor |
| `docs/`     | Contexto, specs, regras por área, operação e passagem de turno                                 |

## Documentação

- [AGENTS.md](AGENTS.md): regras que valem para qualquer tarefa (stack, fluxo de trabalho, comandos, regras invariantes, arquitetura, isolamento entre empresas). Leitura obrigatória para pessoas e agentes.
- [docs/areas/](docs/areas/): regras de cada área (canal WhatsApp, cobrança, agenda, painel...). A tabela "Áreas" do `AGENTS.md` diz qual ler.
- [docs/context.md](docs/context.md): objetivo, decisões, roadmap e histórico de decisões.
- [docs/specs/README.md](docs/specs/README.md): índice das specs e o estado de cada uma. Nada é implementado sem spec aprovada.
- [docs/handoff.md](docs/handoff.md): estado da última sessão de trabalho e passos pendentes.
- [docs/ops/deploy.md](docs/ops/deploy.md) e [docs/ops/staging.md](docs/ops/staging.md): operação do servidor.

## Rodar localmente

Requisitos: Node.js na versão do `.nvmrc` (22 ou superior funciona), pnpm, PostgreSQL e Redis nativos (sem Docker).

1. `pnpm install` na raiz.
2. Crie `backend/.env` e `backend/.env.test` a partir dos exemplos da mesma pasta e prepare o banco conforme "Ambiente local" no [AGENTS.md](AGENTS.md). Esses arquivos nunca são versionados.
3. `pnpm db:generate` e `pnpm db:migrate:deploy`.
4. `pnpm dev` (backend) e `pnpm dev:frontend` (site). Se o backend estiver em outra porta, copie `frontend/.env.example` para `frontend/.env`.

O cadastro, o login e o painel exigem `ACCOUNTS_ENABLED=true`, `APP_ORIGIN` com a origem exata do site e um SMTP (Mailpit no desenvolvimento); ver `backend/.env.example`. Canal WhatsApp, IA real, cobrança e checkout são desligados por padrão e têm as próprias variáveis.

## Verificações

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` e `pnpm build`: os dois pacotes.
- `pnpm test`: testes unitários. `pnpm test:integration`: integração do backend (exige PostgreSQL e Redis locais; só toca `soprei_test` e o Redis `/15`).
- `pnpm --filter soprei-frontend test:browser`: Playwright.

O CI do GitHub Actions é a palavra final. Cada merge na `main` com o CI verde é publicado na produção pelo deploy automático (`.github/workflows/deploy.yml`).
