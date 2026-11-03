# Soprei

O repositório reúne o servidor em `backend/` e o site de apresentação em `frontend/`. As decisões e o roadmap ficam em [docs/context.md](docs/context.md).

Com Node 22 ou superior e pnpm instalado, execute `pnpm install` na raiz. Para configurar o servidor, crie `backend/.env` e `backend/.env.test` a partir dos exemplos na mesma pasta e siga as instruções de ambiente em [AGENTS.md](AGENTS.md); então execute `pnpm db:generate` na raiz. Em instalações anteriores à spec 016, mova os arquivos locais `.env` e `.env.test` da raiz para `backend/`; eles não devem ser versionados.

- `pnpm dev`: servidor backend.
- `pnpm dev:frontend`: site local.
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` e `pnpm test`: verificações dos dois pacotes.
- `pnpm test:integration`: integração do backend, que exige PostgreSQL e Redis locais configurados conforme `AGENTS.md`.

A página de apresentação é estática. A publicação e a hospedagem serão definidas separadamente.

O cadastro/login e a área de empresas da spec 017 dependem do backend. Configure `ACCOUNTS_ENABLED=true`, `APP_ORIGIN` com a origem exata do Vite, e o SMTP (`EMAIL_PROVIDER_*`, Mailpit no desenvolvimento; ver `backend/.env.example`) em `backend/.env`. Copie `frontend/.env.example` para `frontend/.env` se o backend estiver em outra porta. Migre o banco somente após conferir colisões de e-mails legados; não una contas automaticamente. O cadastro pede e-mail/senha; copie o código recebido por e-mail na tela de confirmação. Para contas migradas, use o reenvio com e-mail e senha anteriores. Sem SMTP configurado, mantenha o modo novo desligado; testes nunca exigem conta real.
