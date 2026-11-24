# Soprei

**Vocabulário do domínio (spec 022, renomeado):** **empresa** (`Company`, `CompanyId`, `companyId`, tabela `companies`, coluna `company_id`) é quem usa o Soprei e o **tenant**; **conta** (`Account`, global) é a pessoa que entra no site; **vínculo** (`Membership`, `MembershipId`, tabela `memberships`) é a participação de uma conta numa empresa, com papel e estado (model de tenant); **contato** (`contact`, `contactRef`) é quem escreve no WhatsApp; **administrador da plataforma** (`PlatformAdmin`) é global. O termo antigo da empresa não é mais usado (nem no código, nem nesta documentação): diga "empresa" ou "contato". O `claim` `cid` do token continua com esse nome (agora é o id da empresa) e a mensagem do contato continua com `MessageRole.USER`. Um teste (`backend/src/domain-vocabulary.test.ts`) falha se um nome antigo voltar a aparecer fora da lista de exceções declarada. As specs 001 a 021 e o histórico de decisões usam os nomes antigos; a tabela abaixo traduz.

<!-- vocabulario-antigo:inicio -->

| Antigo (specs 001 a 021)                                                                                                                | Novo (desde a spec 022)                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Client`, `ClientId`, `clientId`, tabela `clients`, coluna `client_id`, `client_status`, `ClientStatus`                                 | `Company`, `CompanyId`, `companyId`, `companies`, `company_id`, `company_status`, `CompanyStatus`                                                        |
| `User` (o vínculo), `UserId`, `userId`, tabela `users`, `user_role`, `UserRole`                                                         | `Membership`, `MembershipId`, `membershipId`, `memberships`, `membership_role`, `MembershipRole`                                                         |
| `user_status` (compartilhado por `accounts`, `platform_admins` e vínculos), `UserStatus`                                                | `access_status`, `AccessStatus`                                                                                                                          |
| `actor_user_id`, `target_user_id`, `actorUserId`, `targetUserId`                                                                        | `actor_membership_id`, `target_membership_id`, `actorMembershipId`, `targetMembershipId`                                                                 |
| ações de auditoria `USER_CREATED`, `USER_ROLE_CHANGED`, `USER_DISABLED`, `USER_ENABLED`, `USER_PASSWORD_RESET`, `USER_PASSWORD_CHANGED` | `MEMBERSHIP_CREATED`, `MEMBERSHIP_ROLE_CHANGED`, `MEMBERSHIP_DISABLED`, `MEMBERSHIP_ENABLED`, `MEMBERSHIP_PASSWORD_RESET`, `MEMBERSHIP_PASSWORD_CHANGED` |
| `ClientRepository`, `ClientService`, `UserRepository`, `UserAdminService`, `UserAdminUnitOfWork`, `lockClient`, `forClient`             | `CompanyRepository`, `CompanyService`, `MembershipRepository`, `MembershipAdminService`, `MembershipAdminUnitOfWork`, `lockCompany`, `forCompany`        |
| `/admin/clients`, `/admin/clients/:clientId/...`, `.../users`, `.../users/:userId`, `/account/companies/:clientId/select`               | `/admin/companies`, `/admin/companies/:companyId/...`, `.../memberships`, `.../memberships/:membershipId`, `/account/companies/:companyId/select`        |
| campos `clientId`, `userId`, `clientSlug`, `selectedClientId`                                                                           | `companyId`, `membershipId`, `companySlug`, `selectedCompanyId`                                                                                          |
| permissões `user:read`, `user:manage`                                                                                                   | `membership:read`, `membership:manage`                                                                                                                   |
| `kind: 'user'` (token, identidade, label de `auth_logins_total`), `userAuth`, `requireUser`                                             | `kind: 'membership'`, `membershipAuth`, `requireMembership`                                                                                              |
| cabeçalho `X-Soprei-Client: web` (CSRF do cookie)                                                                                       | `X-Soprei-App: web`                                                                                                                                      |
| campos de log `clientId`, `userId` (contexto), `setClientId`, `setUserId`                                                               | `companyId`, `actorId` (quem agiu: vínculo ou administrador da plataforma), `setCompanyId`, `setActorId`                                                 |
| métrica `user_admin_actions_total`, resultado `client_unavailable` de `channel_inbound_messages_total`                                  | `membership_admin_actions_total`, `company_unavailable`                                                                                                  |
| audiência `soprei-api` (e `soprei-api:v2` com contas), chaves de sessão sem segmento (e `v2:`)                                          | audiência `soprei-api:v3` e chaves `<prefixo>v3:...` (`v3-legacy` com `ACCOUNTS_ENABLED` desligado)                                                      |
| `pnpm auth:cli ... --client <slug>`                                                                                                     | `pnpm auth:cli ... --company <slug>`                                                                                                                     |

<!-- vocabulario-antigo:fim -->

**Organização do workspace (spec 016):** o backend e seus arquivos de configuração, Prisma e exemplos de ambiente ficam em `backend/`; o site fica em `frontend/`; o app do admin da plataforma (spec 044, E3), em `admin/`. Os caminhos `src/` e `prisma/` mencionados neste documento são relativos a `backend/`. Os comandos `pnpm` da tabela são executados na raiz e encaminhados ao backend; `pnpm dev:frontend` inicia o site e `pnpm dev:admin` o admin (porta 5175), e `pnpm build`, `typecheck`, `lint`, `test` e `format:check` incluem os dois. Crie `backend/.env` e `backend/.env.test` a partir dos respectivos exemplos; ao atualizar uma instalação antiga, mova seus arquivos locais para essa pasta sem versioná-los. O comando manual de migrations de teste deve ser executado dentro de `backend/`.

Sistema de atendimento via IA. Contexto completo, decisões e roadmap em [docs/context.md](docs/context.md) — leia antes de propor arquitetura.

## Áreas (leia antes de tocar)

Este arquivo guarda só o que vale para qualquer tarefa. As regras de cada área ficam em `docs/areas/` (spec 042) e **são tão obrigatórias quanto as daqui**: antes de escrever spec, implementar ou revisar algo de uma área, leia o arquivo dela inteiro. Quando este arquivo, uma spec ou um arquivo de área citar uma seção que não está no próprio arquivo (pelo nome, como "Autenticação" ou "Agrupamento de mensagens", pelo número da spec, ou por "abaixo" e "acima"), ela está no arquivo da lista; "os limites por perfil e IP (seção abaixo)" é "Rate limiting", em `http-base.md`. Documentação de área nova entra em `docs/areas/` (arquivo existente ou novo, com item nesta lista), não aqui.

- [docs/areas/contas.md](docs/areas/contas.md) — **Seções:** Contas globais (017); Código de confirmação de e-mail (020); Recuperação de senha e expurgo de contas (021). **Leia antes de tocar em:** `application/auth/` (conta, confirmação, recuperação, expurgo), `infrastructure/external-apis/email/`, rotas `/auth/*` das contas e `/account/*`, telas de conta do site.
- [docs/areas/autenticacao-e-papeis.md](docs/areas/autenticacao-e-papeis.md) — **Seções:** Autenticação (007); Autorização por papéis (008). **Leia antes de tocar em:** `application/auth/` (`AuthService`, identidade, credenciais), `presentation/auth/`, `infrastructure/auth/`, `presentation/common/auth.hooks.ts`, `domain/permissions.ts`, `application/memberships/`, e qualquer rota `/admin/*` nova.
- [docs/areas/plataforma.md](docs/areas/plataforma.md) — **Seções:** Entrada do admin da plataforma (044, E1); Leituras agregadas e ações (044, E2); App `admin/` (044, E3); Publicação (044, E4). **Leia antes de tocar em:** `application/platform/`, `presentation/platform/`, `platform-read-model.ts`, `PlatformAuditEvent`, `admin/`, `deploy/nginx/admin*.conf.example`, `docs/ops/admin.md`, e qualquer rota `/platform/*` nova (com `autenticacao-e-papeis.md` para o `AuthService` e as sessões).
- [docs/areas/http-base.md](docs/areas/http-base.md) — **Seções:** Rate limiting (005); Observabilidade (004). **Leia antes de tocar em:** `infrastructure/http/`, `infrastructure/metrics/`, `infrastructure/logger/`, `infrastructure/cache/`, `shared/request-context/`, e qualquer rota, métrica, log ou uso de Redis novo.
- [docs/areas/canal-whatsapp.md](docs/areas/canal-whatsapp.md) — **Seções:** Canal WhatsApp (011); Capacidade do canal (034); Agrupamento de mensagens (013); Credenciais do canal por empresa e Embedded Signup (015); Conectar o WhatsApp pelo site (023, com persona, Testar, `frontend/src/api.ts` e a ponte do cookie); Coexistência com o aplicativo WhatsApp Business (039). **Leia antes de tocar em:** `application/channel/`, `infrastructure/queue/`, `infrastructure/external-apis/whatsapp/`, `infrastructure/security/`, `presentation/webhooks/`, `presentation/admin/channel.controller.ts` e `persona.controller.ts`, `infrastructure/process-guard.ts`, `infrastructure/lifecycle.ts`, `src/index.ts`, config do pool e da fila, `frontend/src/api.ts`, telas Canal, Persona e Testar.
- [docs/areas/llm.md](docs/areas/llm.md) — **Seções:** Provedor de LLM real (014). **Leia antes de tocar em:** `application/ports/llm-provider.ts`, `infrastructure/external-apis/llm/`, o prompt e a chamada ao provedor em `application/attendance/`.
- [docs/areas/painel.md](docs/areas/painel.md) — **Seções:** Painel de conversas (024); Convites por e-mail e equipe (025); Primeiros passos (030); Notificações: a IA pede atendimento humano (038). **Leia antes de tocar em:** `application/invitations/`, `application/onboarding/`, `application/notifications/`, `application/attendance/contact-label.ts` e `handoff-tool.ts`, controllers de conversas, convites, onboarding e notificações em `presentation/admin/`, as telas correspondentes em `frontend/src/company/` e `frontend/src/invite/`, e qualquer resposta de API com dado de contato.
- [docs/areas/conhecimento-e-estoque.md](docs/areas/conhecimento-e-estoque.md) — **Seções:** Base de conhecimento da IA e estoque (026, com a leitura de PDF e DOCX da 041). **Leia antes de tocar em:** `application/knowledge/`, `application/inventory/`, `application/attendance/knowledge-prompt.ts`, repositórios de conhecimento e estoque, `presentation/admin/knowledge.controller.ts` e `inventory.controller.ts`, abas Conhecimento e Estoque.
- [docs/areas/agenda.md](docs/areas/agenda.md) — **Seções:** Agenda da empresa (027); A IA e a agenda por ferramentas (028). **Leia antes de tocar em:** `application/schedule/`, `domain/schedule*.ts`, `application/attendance/schedule-*.ts`, `presentation/admin/schedule.controller.ts`, telas da Agenda.
- [docs/areas/cobranca.md](docs/areas/cobranca.md) — **Seções:** Planos e assinaturas (031 e 040: catálogo, cotas, checkout, tela de Assinatura, avisos, Política de Privacidade versão 2 e contato comercial). **Leia antes de tocar em:** `application/billing/`, `domain/billing*.ts`, `infrastructure/external-apis/infinitepay/`, `presentation/billing/`, `presentation/admin/entitlements.controller.ts`, `application/contact/`, `presentation/contact/`, `application/companies/` (limite de empresas), `SubscriptionPage.tsx`, `frontend/src/contact/`, `frontend/src/legal/privacidade.md`, e qualquer rota de escrita de tenant nova (gate de assinatura).
- [docs/areas/frontend.md](docs/areas/frontend.md) — **Seções:** Interface do frontend (018); Páginas legais (032); Redesign do painel (029); App do admin da plataforma (044, E3). **Leia antes de tocar em:** qualquer coisa em `frontend/` ou `admin/`.

Os caminhos sem `frontend/` são relativos a `backend/src/`. Três casos atravessam as áreas:

- **`application/attendance/attendance.service.ts` (e as partes dele desde a spec 035, E4: `attendance.types.ts`, `attendance-prompt.ts`, `attendance-llm.ts` e `attendance-takeover.ts`) é ponto de cruzamento:** antes de mexer nele, leia `canal-whatsapp.md` (agrupamento, pausa da IA), `cobranca.md` (medição e cota antes do provedor), `painel.md` (notificação na transação da resposta), `conhecimento-e-estoque.md`, `agenda.md` e `llm.md`.
- **Log, métrica ou uso de Redis novo, em qualquer área:** leia "Rate limiting" e "Observabilidade" em `http-base.md` (lista do `redact`, nada de URL crua, id ou IP em log e label, erro do ioredis só por `describeRedisError`) e os itens "Privacidade" de `autenticacao-e-papeis.md` (e-mail, senha, hash e tokens) e de `canal-whatsapp.md` (o `wamid` carrega o telefone: logue `messageRef`).
- **Resposta de API ou tela nova com dado de contato:** leia "Painel de conversas" em `painel.md` (`contactRef` e `externalId` nunca saem; o contato aparece só pelo rótulo mascarado).

## Stack (decidida — não trocar sem perguntar)

- Node.js 22 ou superior (`engines.node >= 22`; versões maiores são aceitas), TypeScript strict. O CI dos PRs e a produção usam a versão do `.nvmrc` (hoje 24, spec 036)
- Fastify (HTTP) + Zod (validação de entrada)
- Prisma (ORM, migrations) sobre PostgreSQL
- Redis (rate limit, cache, revogação de tokens, tempo real); `@fastify/rate-limit` para os limites (spec 005)
- BullMQ sobre o Redis (fila de entrada do canal, spec 011); WhatsApp Cloud API oficial da Meta como canal (spec 011)
- Provedor de LLM real: Claude Haiku 5.5 pela API da Anthropic, com o SDK oficial `@anthropic-ai/sdk` (spec 014); o `mock` segue como padrão de testes e dev offline
- Pino (logs estruturados) + `prom-client` (métricas)
- JWT (`jose`, HS256, só atrás de `AccessTokenService`) + refresh token opaco com rotação, hash de senha `scrypt` do `node:crypto` (spec 007, pronta); RBAC por permissões, gestão de usuários e auditoria (spec 008, pronta); SSE e Socket.IO (spec 009)

Hospedagem: servidor próprio (PM2 + nginx; spec 037, `docs/ops/deploy.md`). O que ainda não foi decidido está em "Decisões em aberto" de `docs/context.md`. Não assuma o que não está decidido; proponha em uma spec.

A ordem de execução das specs é a do **roadmap em `docs/context.md` (seção 5)**, não a numeração dos arquivos. Só a próxima spec é detalhada; specs com status `esboço` (hoje 005 a 009) **não são implementadas** até serem relidas contra o código real, reescritas se preciso, e aprovadas. Specs de segurança (autenticação, autorização, isolamento, RLS) passam pelo agente `reviewer` antes do merge.

## Como trabalhamos (Agent-Driven Development)

1. Nada de código sem spec aprovada em `docs/specs/NNN-nome.md` (use `docs/specs/_template.md`).
2. Uma spec = uma branch (`spec/NNN-nome`) = um PR pequeno.
3. Implemente só o que a spec pede. O que ficou de fora vai para "Fora de escopo" da spec ou vira nova spec.
4. Uma spec só está pronta quando todos os critérios de aceite têm teste passando e `typecheck`, `lint` e `test` estão verdes.
5. O humano aprova specs e faz o merge dos PRs. Nunca dê merge nem push direto na `main`.

Funções de agente (spec-writer, implementer, reviewer): cada uma tem um roteiro em `docs/agents/` (`spec-writer.md`, `implementer.md`, `reviewer.md`) que **qualquer** agente segue, seja qual for a ferramenta. No Claude Code existem também como subagentes em `.claude/agents/`, que apenas apontam para esses roteiros.

## Trabalho em turnos entre agentes (Claude Code, Codex ou outro)

O projeto é tocado por mais de um agente, em sessões separadas e em máquinas diferentes. Nada que importa pode ficar só na conversa de um agente ou fora do git:

1. **O estado vive no repositório:** specs (`docs/specs/`), `docs/context.md` (decisões, roadmap, estado) e `docs/handoff.md` (passagem de turno). Memória pessoal de uma ferramenta não conta.
2. **Ao começar uma sessão:** leia este arquivo, `docs/context.md` e `docs/handoff.md`; confira `git status`, a branch atual e o `git log` recente; rode `pnpm install` e `pnpm db:generate` se a máquina for nova.
3. **Uma branch (uma spec) por vez tem um único dono.** Quem implementa faz tudo na branch; o outro agente só revisa (o reviewer é, de preferência, **outro** agente/modelo, porque a revisão fica mais independente).
4. **Ao terminar uma sessão:** deixe a árvore limpa, com commits pequenos e descritivos; atualize `docs/handoff.md` (branch, o que está verde, o que falta, decisões ainda sem spec, armadilhas, próximo passo); e avise o humano para dar push. O agente não dá push na `main`, não faz merge, não usa `git push --force`.
5. **Decisões e mudança de rumo:** registre em `docs/context.md` (seção "Histórico de decisões") ou na spec, nunca só no chat. O que o humano decidiu é decisão; o que um agente sugeriu e o humano não confirmou não é.
6. **Segredos e ambiente:** `.env` e `.env.test` não vão para o git e não são impressos nem colados em chat; cada máquina cria os seus (ver "Ambiente local"). O que um agente não pode fazer sozinho (criar roles ou bancos, mexer em Redis alheio, push) vale para todos.
7. **Validação (decisão do dono, 2026-11-03):** os testes (`pnpm test`, `pnpm test:integration`) **não são executados localmente por rotina**; quem os executa é o GitHub Actions, **na versão do Node do `.nvmrc`** (decisão do dono, 2026-11-11, spec 036; as outras versões, 22 e a LTS mais recente, rodam numa execução semanal, que não bloqueia PR). **Exceção (decisão do dono, 2026-11-03):** quando um teste falha no CI, ou para verificar uma correção, o agente roda localmente só o arquivo que falhou (e a área afetada), um comando por vez e em primeiro plano; o CI continua sendo a palavra final. O agente continua **escrevendo** os testes que a spec exige e roda localmente só as checagens rápidas e estáticas (`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, e `pnpm build` se necessário). Depois do push o humano informa o resultado do CI; spec só está pronta com o CI verde (jobs `static`, `tests` e as fatias de `browser`). Quem assume uma sessão confere também a última execução do workflow semanal "Compatibilidade do Node"; se estiver vermelha, a correção é um PR normal. Nunca desative regra nem pule teste para passar.
8. **Sem ferramenta de subagente:** siga o roteiro de `docs/agents/` na mão, em sessões separadas (uma para implementar, outra para revisar), e cole o resultado da revisão no PR ou em `docs/handoff.md`.

## Comandos

Gerenciador de pacotes: **pnpm**. Primeiro uso: `pnpm install`, `pnpm db:generate` (o Prisma Client não vai para o git e o `typecheck` precisa dele), `cp .env.example .env`, `cp .env.test.example .env.test` (preencha a senha nos dois; no `.env`, defina também `JWT_SECRET`, obrigatória: `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`) e a preparação do banco em "Ambiente local" abaixo.

| Script                              | O que faz                                                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                          | Sobe o servidor com `tsx watch` (log colorido via `pino-pretty`)                                                                                           |
| `pnpm build`                        | Compila para `dist/` (`tsc -p tsconfig.build.json`, sem testes)                                                                                            |
| `pnpm start`                        | Roda `node dist/index.js` (rode `pnpm build` antes)                                                                                                        |
| `pnpm test`                         | Testes **unitários** com `node --test` + `tsx` (`src/**/*.test.ts`, exceto `*.integration.test.ts`); não precisam de Postgres nem de Redis                 |
| `pnpm test:integration`             | Testes de integração (`src/**/*.integration.test.ts`); exigem Postgres e Redis no ar, leem `.env.test` e só rodam contra `soprei_test` e Redis `/15`       |
| `pnpm typecheck`                    | `tsc --noEmit`                                                                                                                                             |
| `pnpm lint`                         | ESLint (flat config, `typescript-eslint` strict type-checked)                                                                                              |
| `pnpm format` / `pnpm format:check` | Prettier (escreve / só verifica)                                                                                                                           |
| `pnpm db:generate`                  | `prisma generate` (Prisma Client em `src/generated/prisma`, ignorado pelo git)                                                                             |
| `pnpm db:migrate`                   | `prisma migrate dev` (cria e aplica migration no banco de desenvolvimento; exige PostgreSQL acessível em `DATABASE_URL` e usa shadow database)             |
| `pnpm db:migrate:deploy`            | `prisma migrate deploy` (aplica migrations pendentes; é o que o CI roda)                                                                                   |
| `pnpm auth:cli`                     | Comando local do dono (spec 007): `create-platform-admin`, `create-user`, `reset-password`; senha pedida sem eco, nunca por argumento (ver "Autenticação") |

Fora da tabela: `pnpm --filter soprei-backend config:check` (spec 037) valida o `.env` do diretório atual com o mesmo schema do boot, **sem conectar a nada**: imprime `ok` ou só os nomes das variáveis inválidas, nunca valores (o `deploy/deploy.sh` o roda no build novo antes de migrar).

Antes de dar uma spec como pronta, localmente: `pnpm typecheck && pnpm lint && pnpm format:check`; os testes (`pnpm test` e `pnpm test:integration`) são verificados só no CI (decisão do dono, 2026-11-03; o humano informa o resultado). Os scripts de teste continuam valendo para quem quiser rodá-los. O CI (spec 036, `.github/workflows/ci.yml`) roda na versão do Node do `.nvmrc`, em jobs paralelos: `static` (`db:generate`, `typecheck`, `lint`, `format:check`, `build`), `tests` (`db:migrate:deploy`, `pnpm test` e `pnpm test:integration`, com Postgres e Redis como services) e `browser` (Playwright em 3 fatias, `--shard`, 1 worker cada, navegador em cache pela versão do Playwright, **sem `apt`/`install-deps`**: a imagem do runner já tem as bibliotecas do Chromium e o `apt` já derrubou o job por falha de DNS). Push novo no mesmo PR cancela a execução anterior. O workflow semanal `node-compat.yml` chama o mesmo arquivo em Node 22 e `lts/*`. `backend/src/ci-workflow.test.ts` falha se um comando sair da suíte, se a matriz de versões voltar aos PRs ou se `--test-concurrency=1` da integração mudar (há testes de integração que agem no banco inteiro; não suba esse valor).

### Ambiente local (sem Docker)

PostgreSQL e Redis rodam **nativos** na máquina, em `localhost:5432` e `localhost:6379`. O projeto não usa Docker nem `docker-compose` no desenvolvimento. Preparação única, feita por quem administra a máquina (um agente não cria nem altera roles, bancos ou senhas), em um `psql` ou pgAdmin como administrador:

```sql
CREATE ROLE soprei LOGIN PASSWORD '<escolha-uma-senha>' CREATEDB;
CREATE DATABASE soprei OWNER soprei;
CREATE DATABASE soprei_test OWNER soprei;
```

`CREATEDB` é necessário porque `prisma migrate dev` cria um shadow database. Dois bancos separam desenvolvimento (`soprei`) e testes (`soprei_test`). No Redis, índice `0` para desenvolvimento e `15` para testes.

Depois: `cp .env.example .env` e `cp .env.test.example .env.test`, trocando `<senha>` pela senha escolhida (ambos ficam fora do git). `.env` aponta para `soprei` e Redis `/0`; `.env.test` para `soprei_test` e Redis `/15`.

Confirmar que os serviços estão no ar (o servidor também verifica os dois no boot e encerra com código 1 se algum faltar):

- Postgres: `psql "postgresql://soprei@localhost:5432/soprei_test" -c "SELECT 1"` (ou `pg_isready -h localhost -p 5432`).
- Redis: `redis-cli -h localhost -p 6379 ping` (resposta `PONG`).
- Com o servidor rodando: `curl localhost:3000/health` (processo vivo) e `curl localhost:3000/health/ready` (banco e Redis; 200 ou 503).

Migrations contra o banco de testes (sem tocar no de desenvolvimento): `node --env-file=.env.test node_modules/prisma/build/index.js migrate deploy`. Um model novo exige migration, classificação em `MODEL_SCOPES` (ver "Acesso a dados e isolamento") e `pnpm db:generate` antes de testar.

**Segurança dos testes:** os testes de integração se recusam a rodar se `DATABASE_URL` não apontar para `soprei_test` ou `REDIS_URL` para o índice 15 (ambos em localhost), nunca usam `FLUSHALL`/`FLUSHDB` e cada teste remove só as chaves que criou, com prefixo único (`src/test-support/`). Testes que precisam de infra devem se chamar `*.integration.test.ts` e começar com `loadIntegrationConfig()`.

## Regras invariantes

- **Isolamento entre empresas (tenants):** toda entidade pertence a uma empresa e toda query filtra por ele, sem exceção. Acesso a dados passa por uma camada que exige o identificador da empresa; query solta deve ser impossível por design. Todo código novo de acesso a dados precisa de teste provando que uma empresa não enxerga dado de outro. As três barreiras e as regras de acesso a dados estão em "Acesso a dados e isolamento" abaixo.
- **Erro nunca vira silêncio:** falha de IA ou de integração responde com fallback educado ao usuário final e loga com contexto.
- **Webhooks respondem rápido** e processam em background; nada de chamada de IA no fluxo síncrono do webhook.
- **LLM é peça trocável:** chamadas ao modelo ficam atrás de uma interface única (`LlmProvider`, em `src/application/ports/llm-provider.ts`; nos textos antigos aparece como `LLMProvider`), com as implementações `mock` (testes e dev offline) e `anthropic` (spec 014), em `src/infrastructure/external-apis/llm/`. Trocar de modelo é mudar configuração (`LLM_PROVIDER`), não código de negócio. `generate` devolve `Result<LlmReply, ExternalServiceError>`; o texto do contato vai sempre como mensagem `membership`, nunca concatenado ao `systemPrompt`.
- **Nunca logar conteúdo de mensagem nem persona** (são dados pessoais), nem pôr em label de métrica: loga-se só id, tamanho e resultado. Vale também para a mensagem e o `context` de erro (o contrato do `LlmProvider` proíbe o provedor de incluí-los). Todo teste de fluxo com mensagens captura o log (`src/test-support/log-capture.ts`) e prova que um texto secreto não aparece.
- Validar toda entrada externa com Zod antes de usar.
- Sem `any` solto e sem `// @ts-ignore` sem comentário explicando o motivo.
- Logar com Pino, estruturado, incluindo o identificador da empresa quando houver.
- Nunca commitar `.env`, chaves ou tokens. Toda variável de ambiente é validada em um único módulo de config e documentada em `.env.example`.
- Não adicionar dependência sem justificar na spec ou no PR.

## Arquitetura e padrões

Seguimos o guia [Engenharia Backend Node.js + TypeScript](https://www.vivodecodigo.com.br/backend/engenharia-backend-nodejs-typescript-guia-definitivo) (Vivo de Código), adaptado a Fastify. Resumo do que vale aqui; detalhes e desvios em `docs/context.md`.

**Camadas** (dependências apontam para o domínio; `domain` não importa de nenhuma outra camada):

```
src/
├── domain/          # entities, value-objects, interfaces de repositório e permissions.ts (papéis x permissões, spec 008)
├── application/     # services/use-cases e portas
│   ├── attendance/  # AttendanceService e schemas
│   ├── auth/        # AuthService (login, refresh, logout, authenticate) e identidade (spec 007)
│   ├── companies/     # CompanyService
│   ├── channel/     # canal de mensagens (spec 011): entrada do webhook e processador dos jobs
│   ├── memberships/       # MembershipAdminService: usuários da empresa, troca da própria senha e auditoria (spec 008)
│   └── ports/       # interfaces para o exterior: LlmProvider, MessageSender, InboundJobQueue, PasswordHasher, AccessTokenService, SessionStore, MembershipAdminUnitOfWork
├── infrastructure/
│   ├── config/ logger/ metrics/ cache/ lifecycle.ts
│   ├── auth/        # scrypt, jose (AccessTokenService), SessionStore no Redis, createAuthRedis e cli/ (spec 007)
│   ├── external-apis/ # llm/ (mock e anthropic) e whatsapp/ (empresa da Cloud API)
│   ├── queue/       # fila de entrada do canal (BullMQ), conexões Redis próprias
│   ├── database/    # raiz: singleton, transação, erros e barrel (index.ts)
│   │   ├── extensions/    # Prisma Client Extensions: tenant-scope, query-timing, schema-info
│   │   └── repositories/  # PrismaTenantRepository (base), repositórios, unit of work, cursor, mappers
│   └── http/        # raiz: server, test-server, error handler e testes de rota de ponta a ponta
│       ├── observability/ # request id, contexto, log de requisição, métricas HTTP
│       └── rate-limit/    # registerRateLimit e IP do cliente (quem chama)
├── presentation/    # controllers/rotas, hooks/middlewares, validators Zod
│   ├── admin/       # rotas /admin/* (empresas, atendimento, usuários e auditoria)
│   ├── auth/        # rotas /auth/* (spec 007)
│   ├── system/      # /health, /health/ready, /metrics
│   ├── webhooks/    # webhook do WhatsApp (spec 011)
│   └── common/      # bearer auth hook, authenticate/requireMembership/requirePlatform/requirePermission, route pattern, perfil de rate limit
└── shared/          # errors, types (Brand, Result), utils
```

**Convenções de pastas (spec 012):**

1. Pasta por área quando passar de uns 10 arquivos ou juntar duas responsabilidades. Não criar pasta para o futuro: cada spec cria as pastas de que precisa.
2. Teste ao lado do arquivo que testa, na mesma subpasta; teste que atravessa várias partes (fluxo de atendimento, rotas de ponta a ponta) fica na pasta pai.
3. Barrels só onde já existem (`infrastructure/database/index.ts`, `domain/index.ts`), sem barrel novo. Imports de fora de uma camada usam o barrel dela quando ele exporta o símbolo; subpastas internas de uma pasta de infraestrutura (`extensions/`, `repositories/`) não aparecem para fora dela.
4. Sem aliases de caminho (`@/...`): imports relativos.
5. Nomes de arquivo seguem os sufixos `.service.ts`, `.repository.ts`, `.controller.ts`; mover para outra pasta não renomeia.

- **Dependências entre camadas (o ESLint impõe):** `domain` só importa de `shared` (nem Prisma, nem Fastify); `application` e `presentation` não importam `infrastructure/database`. Elas dependem de **interfaces do domínio** (`CompanyRepository`, `TenantRepository`...) e recebem a implementação por injeção (testes de integração que precisam do banco ficam em `infrastructure/`); quem liga tudo é `src/index.ts` e `infrastructure/http/server.ts`. `CompanyId` e as entidades vivem em `src/domain/`.
- **Config:** variáveis de ambiente validadas com Zod no boot (`z.coerce.number()` para números); se falhar, loga e encerra com `process.exit(1)`. Acesso por um único módulo de config, nunca `process.env` espalhado.
- **Erros:** hierarquia a partir de `BaseError` (`code`, `statusCode`, `isOperational`, `context`) com `ValidationError` 400, `UnauthorizedError` 401, `ForbiddenError` 403, `NotFoundError` 404, `ConflictError` 409 (aceita `code` próprio, como `LAST_OWNER`), `RateLimitError` 429 (`RATE_LIMITED`, com `retryAfterSeconds`), `DatabaseError` 500, `TenantScopeError` 500 (não operacional: consulta de tenant sem escopo é bug de programação), `ExternalServiceError` 502, `ServiceUnavailableError` 503 (`SERVICE_UNAVAILABLE`, operacional: dependência de que a autenticação não prescinde, como o Redis das sessões, está fora; fail-closed). Um error handler central do Fastify converte em JSON; nunca vaza stack nem detalhe interno à empresa. Nunca `throw new Error('...')` genérico em regra de negócio.
- **Result:** erros esperados em operações críticas (ex.: chamada de LLM, canal externo) voltam como `Result<T, E>`; exceção fica para o excepcional.
- **Tipos:** branded types para identificadores (`CompanyId`, `ConversationId`...) criados por factory que valida; o `CompanyId` é parâmetro obrigatório de todo repositório, o que faz o isolamento entre empresas ser garantido pelo compilador. Uniões discriminadas para estados. Sem `any` em repositório genérico (o guia usa; nós não).
- **Prisma:** um único client (singleton), nunca por requisição; pool configurado (`max`, timeouts, `statement_timeout`), TLS preservado, health check com `SELECT 1`. Transação com retry só para erros recuperáveis. `select` restrito aos campos necessários; evitar N+1 buscando em lote com `in`.
- **Logs e contexto (spec 004):** Pino, JSON em produção e `pino-pretty` em dev; contexto por requisição via `AsyncLocalStorage` (ver "Observabilidade" abaixo).
- **Rotas:** finas. Validam com Zod, chamam o service, devolvem só campos seguros e deixam o erro subir ao handler central. Pergunta-guia ao escrever: "como essa rota pode falhar?".
- **Atendimento (spec 010):** `AttendanceService` (`src/application/attendance/attendance.service.ts`) é o pipeline mensagem do contato -> conversa -> `LlmProvider` -> resposta, com idempotência por `externalId`, fallback gravado com `isFallback = true` (texto constante em português) e a chamada ao LLM **fora** de qualquer transação (a transação, via `AttendanceUnitOfWork`, só grava conversa e mensagem do contato). Entra pelo simulador `POST /admin/companies/:companyId/messages` e, com o canal ligado, pelo webhook (spec 011, acima); `AttendanceReply` tem `sentAt` e o histórico vem de `MessageRepository.listBefore` (anterior à mensagem, correto também ao retomar uma mensagem antiga), mais `GET .../conversations` e `GET .../conversations/:conversationId/messages` (contrato da spec 024, abaixo: sem `contactRef` nem `externalId`); `persona` da empresa só via `PUT /admin/companies/:companyId/persona` (`null` limpa); o `PATCH /admin/companies/:id` da plataforma **não** aceita `persona` (spec 044, D8), `status` (spec 044, M4 da revisão da E2: suspender e reativar só por `/platform/companies/:companyId/suspend|reactivate`, com motivo e trilha) nem `whatsappPhoneNumberId` (400; o número só entra pelo canal da empresa, spec 015) e devolve `hasPersona`, nunca o texto. No simulador a resposta é síncrona; no canal real o processamento roda em segundo plano na fila. Config: `LLM_PROVIDER`, `LLM_TIMEOUT_MS`, `ATTENDANCE_IN_FLIGHT_TIMEOUT_MS` (só do caminho `handleInboundMessage`/simulador). No canal, o atendimento é dividido em `acceptInboundMessage` e `respondToPending` (ver "Agrupamento de mensagens (spec 013)"). Métricas: `llm_requests_total{provider,result}` (`ok`, `error`, `timeout`, `refusal`, `truncated`), `llm_tokens_total{provider,type}`, `llm_request_duration_seconds{provider}`, `attendance_fallbacks_total`, `attendance_batch_size`, `attendance_batches_total{result}`.
- **Itens da base, cada um em sua spec (006 e 009, sob demanda; a 004, observabilidade, a 005, rate limiting, a 007, autenticação, e a 008, RBAC, estão prontas):** cache L1/L2 (sem decorators) e tempo real (SSE e Socket.IO, que herdará `requirePermission` e as salas por `CompanyId`). Implemente cada um somente na sua spec.
- **Chaves de cache, de rate limit, salas e canais de tempo real sempre derivam do `CompanyId`** (do token assinado, nunca de header ou corpo da requisição). Exceções declaradas (valem antes de existir `CompanyId`): os limites por **perfil e IP** (seção abaixo) e o contador de falhas de login (`<prefixo>login-fail:<HMAC-SHA256(slug + e-mail)>`, com chave derivada do `JWT_SECRET`, spec 007, que vale também para contas inexistentes). As chaves de sessão da 007 derivam do `CompanyId` do usuário (`<prefixo><CompanyId>:...`) ou de `platform:`.

### Deploy com rollback e staging (spec 037, E1, E2 e E3)

O servidor próprio (PM2 + nginx) é atualizado por **um comando**, `deploy/deploy.sh --env <production|staging> [--ref ...]`, que compila em pastas de espera, valida o `.env` com o build novo (`config:check`), aplica as migrations **com a versão antiga ainda no ar**, troca e espera a saúde (várias respostas seguidas e sem reinício do PM2); se não responde, **volta sozinho ao código anterior** (saída 2; saída 3 = intervenção manual). **Migration nunca é revertida**: toda migration deve ser **aditiva e compatível com a versão anterior do código** (o revisor confere em todo PR com migration); a varredura por texto do deploy bloqueia `DROP`, `RENAME`, `SET NOT NULL`, mudança de tipo, `TRUNCATE` e `DELETE FROM` sem a linha `-- breaking-approved: <motivo>` (alarme, não prova). A produção só aceita o SHA que já está no staging (`--allow-unstaged` em emergência). O staging (`deploy/`, `docs/ops/staging.md`) é uma segunda instalação **sem recurso compartilhado** com a produção (banco e role, **instância própria de Redis** na 6380, segredos novos, Mailpit com STARTTLS, `LLM_PROVIDER=mock`, canal e cobrança desligados) e **nunca recebe dado de produção**. O script nunca faz `source` do `.env`, nunca imprime segredo (filtro de redação) e nunca roda `set -x`; um agente **não executa o `deploy.sh` nem toca o servidor**. Uso, códigos de saída e o que fazer em cada falha: `docs/ops/deploy.md`.

**Deploy automático (E3):** depois do merge na `main` com o `CI` verde, `.github/workflows/deploy.yml` (`workflow_run`; interruptor `DEPLOY_ENABLED`; disparo manual só em dry-run; sem `uses:`, sem checkout) manda por SSH só `--env production --ref <SHA>` ao usuário `soprei-deploy`, cujo comando forçado é o programa de entrada (`deploy/soprei-deploy-entry.sh`, instalado à mão em `/usr/local/sbin/`): ele confere o texto, chama a si mesmo pelo `sudo` restrito e roda o `deploy.sh --auto` como `root` com `env -i` (SHA só da `main` e só para a frente; nunca `--allow-breaking`, `--force` nem `--previous`). Mudou o programa de entrada ou `deploy.sh`: o dono reinstala/implanta à mão; `deploy-workflow.test.ts` trava o workflow e o `actionlint` (versão fixa, SHA-256 conferido) roda no job `static`. Passos do dono e desligamento: `docs/ops/deploy.md`.

**Backup (spec 043):** `deploy/backup/soprei-backup.sh` (instalado à mão em `/usr/local/sbin/`, agendado por `systemd`) faz o `pg_dump` diário, cifra com a chave **pública** do `age` e envia **só o arquivo cifrado** para fora do servidor; nunca apaga nada no destino (a expiração e a trava são regras do bucket) e a saída das ferramentas vai só para um registro privado. `soprei-restore-check.sh` restaura num banco temporário de nome fixo e imprime só contagens. Um agente **não executa esses programas no servidor, não vê a credencial do destino nem a chave privada**; os testes usam dublês (`backup-script.behavior.test.ts`, `backup-scripts.test.ts`). Instalação, restauração e o que guardar fora do servidor: `docs/ops/backup.md`.

### Acesso a dados e isolamento (spec 003)

Três barreiras independentes, cada uma com teste:

1. **Repositório de tenant.** Todo método recebe `CompanyId` como **primeiro parâmetro**; o filtro por empresa é montado pela base (`PrismaTenantRepository`, em `infrastructure/database/repositories/`), nunca pelo chamador. Só usa `findFirst`, `findMany`, `create`, `updateMany`, `deleteMany` e `count`, sempre com `companyId` no `where`; id de outra empresa é `NotFoundError`. Os tipos de criação e atualização não têm `companyId`. Dentro de `runInTransaction`, use `repo.forTransaction(tx)`. Métodos próprios do repositório (`findOrCreateByContact`, `findByExternalId`, `findReplyTo`, `listRecent`...) seguem a mesma regra (`CompanyId` primeiro, `companyId` no `where`, passam pela `tenant-scope`); `findOrCreateByContact` usa `createMany({ skipDuplicates })` (`INSERT ... ON CONFLICT DO NOTHING`, permitido pela barreira) para que a corrida entre dois pedidos não aborte a transação. `Company` é a raiz do tenant (model global, repositório próprio, sem `CompanyId`).
2. **Prisma Client Extension (`infrastructure/database/extensions/tenant-scope.ts`).** O client singleton (`getPrisma()`) é estendido: em model de tenant, qualquer operação sem `companyId` no `where` (ou nos `data`) lança `TenantScopeError`, e `findUnique`, `findUniqueOrThrow`, `update`, `delete` e `upsert` são proibidos. **Todo model novo precisa ser classificado em `MODEL_SCOPES`** (`tenant` se tem `companyId`, `global` se não tem); o compilador e o teste de cobertura exigem.
3. **Lint.** Fora de `src/infrastructure/database/**` é proibido importar `src/generated/prisma`, `@prisma/*`, `pg`, `getPrisma`/`PrismaClient` e usar `$queryRaw`, `$queryRawUnsafe`, `$executeRaw`, `$executeRawUnsafe`. A única exceção é essa pasta (inclui o health check). Não desligue a regra: se precisa de SQL cru, ele entra num módulo revisado dentro de `infrastructure/database/`, filtrando por `companyId`.

O `CompanyId` é sempre passado explicitamente (contexto por requisição vem nas specs 004 e 007). As rotas `/admin/*` usam access token (spec 007, seção "Autenticação" acima): o `CompanyId` vem **só do token assinado**. A antiga `ADMIN_API_KEY` foi removida. Dados de teste: use `src/test-support/tenant-fixtures.ts` (empresas com slug único e limpeza só do que o teste criou, mensagens antes das conversas) e copie o modelo de `infrastructure/database/repositories/conversation.repository.integration.test.ts` (ou o de `message.repository.integration.test.ts`, que cobre também chaves estrangeiras compostas e SQL controlado) para provar o isolamento em cada repositório novo. O fluxo completo com duas empresas (histórico enviado ao LLM, persona, `externalId` repetido) está em `attendance.integration.test.ts`, em `infrastructure/database/` e em `infrastructure/http/`; testes de service sem banco usam `src/test-support/in-memory-attendance.ts`.

**Auditoria e bloqueio da empresa (spec 008):** `AuditEvent` é model de tenant (repositório só com `create` e `list`, sem `update`/`delete`; chaves estrangeiras compostas para `memberships`). A regra do último `OWNER` usa `SELECT ... FOR NO KEY UPDATE` na linha de `companies` (serializa a gestão da empresa sem bloquear o `KEY SHARE` das FKs ao gravar mensagem) (`MembershipAdminTransaction.lockCompany`), o único SQL cru novo, parametrizado e dentro de `infrastructure/database/`. Os testes de integração que criam usuários limpam a auditoria antes (`TestTenants.cleanup` já faz).

**Integridade no banco (spec 010):** `Message` tem chaves estrangeiras **compostas** `(conversationId, companyId)` -> `Conversation(id, companyId)` e `(replyToId, companyId)` -> `Message(id, companyId)`; por isso `Conversation` e `Message` têm `@@unique([id, companyId])`. Todo model de tenant novo que aponte para outro model de tenant deve fazer o mesmo, para que ligar dado de uma empresa a dado de outro seja impossível no próprio banco. Mensagens são imutáveis (o `update` do repositório só confirma a existência). A spec 013 acrescenta `answered_by_id`, com a mesma chave estrangeira composta `(answered_by_id, company_id)`; `markSent` e `markAnswered` são as únicas escritas em mensagem, ambas por `updateMany` com `companyId` no `where` (a `tenant-scope` recusa sem ele).

**Código em geral:** `async/await`, funções pequenas, responsabilidade única, services sem dependência de Fastify (`req`/`res`). Sufixos de arquivo: `.service.ts`, `.repository.ts`, `.controller.ts`.

**Testes** (o guia não cobre; regra nossa): ao lado do código (`*.test.ts`), runner nativo do Node, salvo decisão em spec. Os que precisam de Postgres ou Redis são `*.integration.test.ts` (ver "Ambiente local"). Rotas testadas com `fastify.inject`. Toda regra de acesso a dados tem teste de isolamento entre empresas.

## Nunca faça sem perguntar

- Trocar item da stack ou reverter decisão registrada em `docs/context.md`.
- Relaxar o isolamento entre empresas.
- Apagar ou reescrever migrations já aplicadas.
- Criar ou alterar roles, bancos, senhas ou dados no PostgreSQL e no Redis locais do dono, ou rodar `FLUSHALL`/`FLUSHDB`/`DROP DATABASE`. Eles rodam nativos na máquina (sem Docker) e podem ter outros dados; testes só tocam `soprei_test` e Redis `/15`.
- Rodar comandos destrutivos em banco, `git push --force`, ou mexer em segredos.
