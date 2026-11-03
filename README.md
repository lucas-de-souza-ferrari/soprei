# Soprei

O repositório reúne o servidor em `backend/` e o site de apresentação em `frontend/`. As decisões e o roadmap ficam em [docs/context.md](docs/context.md).

Com Node 22 ou superior e pnpm instalado, execute `pnpm install` na raiz. Para configurar o servidor, crie `backend/.env` e `backend/.env.test` a partir dos exemplos na mesma pasta e siga as instruções de ambiente em [AGENTS.md](AGENTS.md); então execute `pnpm db:generate` na raiz. Em instalações anteriores à spec 016, mova os arquivos locais `.env` e `.env.test` da raiz para `backend/`; eles não devem ser versionados.

- `pnpm dev`: servidor backend.
- `pnpm dev:frontend`: site local.
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` e `pnpm test`: verificações dos dois pacotes.
- `pnpm test:integration`: integração do backend, que exige PostgreSQL e Redis locais configurados conforme `AGENTS.md`.

O site é estático e não depende do backend para funcionar. A publicação e a hospedagem serão definidas separadamente.
