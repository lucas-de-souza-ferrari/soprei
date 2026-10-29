# Passagem de turno entre agentes

> Atualize no fim de cada sessão (ver "Trabalho em turnos entre agentes" em `AGENTS.md`). Curto e factual; o histórico de decisões fica em `docs/context.md` e nas specs.

**Última atualização:** 2026-10-29, por Claude Code (Sonnet 5.5), fim da implementação da spec 007.

## Onde estamos

- **Concluídas e mergeadas:** specs 001 a 005 e 010 a 014 (ver "Roadmap" em `docs/context.md`). O canal WhatsApp funciona de ponta a ponta com o número de teste da Meta e com token permanente de usuário do sistema; o atendimento ainda responde com o `LlmProvider` `mock`.
- **Branch em andamento:** `spec/007-autenticacao-jwt` (spec 007 implementada, 5 commits de código + docs, árvore limpa); **falta o `reviewer` (spec de segurança, de preferência outro agente/modelo), push, PR e CI do humano.** A spec segue `aprovada` (o dono a marca `concluída` depois do merge). A branch `docs/validation-levels` (só docs) continua precisando de push e PR do humano, se ainda não foi.
- **Verde na última verificação (branch da 007):** `pnpm typecheck`, `lint`, `format:check`, 838 testes unitários e 284 de integração, `pnpm build` e smoke do compilado, em Node 22.23.2 e 24.18.0 (local; CI ainda não rodou).
- **Estabilidade da 014:** suítes novas e alteradas repetidas de 4 a 5 vezes em cada Node, sem falha (`anthropic-llm.provider.test.ts`, `anthropic-attendance.test.ts`, `attendance-llm.service.test.ts`, config, métricas, `attendance.integration.test.ts`).

## Próximo passo sugerido

0. **Antes de subir o servidor com a 007:** o `.env` do dono precisa de `JWT_SECRET` (obrigatória, mínimo 32 caracteres: `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`); a `ADMIN_API_KEY` não vale mais (pode apagar). Aplique a migration no banco de desenvolvimento (`pnpm db:migrate:deploy`; a migration é aditiva: `users` e `platform_admins`). Primeiro acesso: `pnpm auth:cli create-platform-admin --email <e-mail>` (senha pedida no terminal) -> `POST /auth/platform/login` -> `POST /admin/clients` -> `pnpm auth:cli create-user --client <slug> --email <e-mail> --role OWNER` -> `POST /auth/login`. O simulador e a leitura de conversas agora são do `User` do cliente (o administrador da plataforma recebe 403 nelas, decisão 5). Nenhum agente rodou o CLI contra o banco do dono.

1. **Teste manual da 014 com a chave real** (Anthropic Console: defina um limite de gasto mensal antes; `LLM_PROVIDER=anthropic` e `ANTHROPIC_API_KEY` no `.env`; ver "Provedor de LLM real" em `AGENTS.md`). Depois, o dono confere os termos de dados da Anthropic (LGPD) antes de clientes reais.
2. Antes de **dados reais de clientes**: política de retenção e LGPD (inclui limpeza do Redis, jobs do BullMQ e o último job retido), RLS do Postgres, varredura de mensagens pendentes antigas.

## Decisões do dono que não são óbvias no código

- Specs sob demanda; a ordem é a do roadmap, não a numeração dos arquivos. O humano aprova specs e faz push, PR e merge.
- Sem Docker: PostgreSQL e Redis nativos. Node 22 ou superior, sem teto.
- Cliente suspenso **não recebe nada** do canal (nem texto padrão), decisão de 2026-10-28.
- Mensagens rápidas do mesmo contato são agrupadas: as mensagens ficam **no banco** (descartado um buffer no Redis); janela deslizante de 5 s com teto de 20 s (configurável).
- `TRUST_PROXY` só aceita `false`, `true` (nunca em produção) ou lista de IPs/CIDRs; inteiro não existe (o Fastify 5.12.7 o trata como fail-closed).

## Armadilhas já encontradas

- O `pnpm dev` não observa o `.env`: reinicie depois de editar.
- O que se grava em `whatsappPhoneNumberId` do cliente é o **ID do número de telefone** da Meta, não o telefone; a URL de callback na Meta termina em `/webhooks/whatsapp` (sem barra no fim).
- O token temporário do número de teste da Meta expira em cerca de 24 h (erro 190 no log do envio); use o token permanente de um usuário do sistema.
- Teste sensível ao relógio já falhou no CI: use relógio injetável e esperas com prazo, e repita as suítes novas várias vezes.
- Erro do ioredis e do BullMQ não pode ir inteiro ao log (carrega `command.args` com chave e IP).
- (Obsoleto desde a 007) a `ADMIN_API_KEY` foi removida; `/admin` exige token (ver acima).
- Provedor Anthropic: nunca logue nem copie `error.message`, corpo ou o objeto de erro do SDK (podem ecoar persona, histórico e texto do contato); só `{ provider, status, errorType, retryable }`. O SDK 1.3.0 manda a chave em `Authorization: Bearer`. O tokenizador do Haiku 5.5 conta cerca de 30% mais tokens que o do 4.5.
- Provedor Anthropic: `redirect: 'error'` no fetch do SDK (nunca reenviar o corpo a outro host) e `ANTHROPIC_CUSTOM_HEADERS` escondido do SDK; `LLM_MAX_OUTPUT_TOKENS` conta o pensamento adaptivo (suba o teto com esforço `medium` ou `high`). SDK fixo em 1.3.0.
- Testes que comparam o `systemPrompt` precisam esperar persona mais a instrução de estilo (`ATTENDANCE_STYLE_INSTRUCTION`).

## O que não vem pelo git (recriar em cada máquina)

- `.env` e `.env.test` (copiar dos `.example` e preencher senha e tokens), PostgreSQL e Redis nativos com o role e os bancos `soprei` e `soprei_test` (ver "Ambiente local" em `AGENTS.md`), Node 22 e 24, pnpm, e um túnel HTTPS se for testar a Meta.

## Pendências abertas (não bloqueiam o próximo passo)

- Suporte a contatos que usam nome de usuário do WhatsApp (BSUID, sem telefone): hoje a mensagem é descartada com métrica `missing_sender`.
- Confirmar que o túnel usado acrescenta ao `X-Forwarded-For` em vez de repassar o cabeçalho do cliente.
- Respostas gravadas e não enviadas (token expirado, falha do Graph) não são reenviadas sozinhas; `sentAt` aparece na API administrativa.

## Spec 007: pontos para o reviewer e armadilhas

- Olhar: fixação do algoritmo e das claims (`jose-access-token.service.ts`), scripts Lua (`redis-session-store.ts`: rotação, reuso, `revokeByRefresh`, `revokeAll` com chaves montadas no script), vazamento entre clientes nas chaves e no `:clientId` (`requireUser({ clientParam })`), enumeração e hash fictício no login (`auth.service.ts`), fail-closed (store, limiter dos perfis `login`/`refresh`, `authenticate`), `redact` e privacidade de log/erro, remoção completa da `ADMIN_API_KEY`, CLI (senha só por terminal/stdin). Desvios e decisões estão no "Registro da implementação" da spec (logout confere o segredo; senha do login sem mínimo de 12; `revokeAll` fora da regra "tudo em KEYS"; `:clientId` malformado agora é 404).
- Armadilhas: o hook `authenticate` precisa vir antes de `requireUser`/`requirePlatform` (o plugin de rotas o registra com `addHook`); teste de rota novo emite token por `buildTestAuth(...).userToken(clientId)` (o cliente precisa existir no mesmo `ClientRepository` passado ao `buildTestAuth`); o ESLint proíbe `jose` fora de `infrastructure/auth` (inclusive em testes: use `src/test-support/forge-jwt.ts`); `loadIntegrationConfig()` injeta um `JWT_SECRET` descartável; token e `nbf` têm precisão de segundos (testes de `logout-all` avançam o relógio); o Redis precisa aceitar `TIME` antes de escrita em Lua (Redis >= 5, padrão); `scrypt` real usa ~128 MiB por hash (testes usam custo baixo, só um teste paga o custo cheio).
- `.env.test` do dono não precisa mudar. Redis `/15` ganhou só chaves com prefixo único `soprei:test:...` (removidas pelos testes).

## Experimento em curso (2026-10-29)

- O roteiro do implementer passou a validar em níveis (typecheck e teste do arquivo a cada passo; lint e suíte da área antes de cada commit; bateria completa e repetições só no final). Na **próxima spec**, o humano ou o agente que a verificar conta quantas falhas só apareceram na validação final (e se algum teste intermitente chegou ao CI). Se forem mais que antes, volte ao ciclo antigo e registre aqui.
- **Resultado na spec 007 (validação em níveis):** **0 falhas apareceram só na validação final** (Node 22.23.2 e 24.18.0, bateria completa, build e smoke, tudo verde na primeira execução; suítes novas repetidas 5 vezes sem falha). Três problemas apareceram antes, nos níveis 1 e 2 (esquema Zod exigindo chave ausente, prefixo de Redis repetido entre testes, regra do ESLint pegando um teste), todos pegos pelo `typecheck`, pelo arquivo de teste ou pelo `lint` da área. O CI ainda não rodou: se aparecer teste intermitente nele, anote aqui.
- Pendências abertas pela 007 (fora de escopo, já na spec): RBAC e CRUD de usuários por HTTP (008), troca da própria senha por API e recuperação por e-mail, rotação de `JWT_SECRET`, `nbf` em massa ao suspender cliente, política de retenção/LGPD de dados de usuário.
