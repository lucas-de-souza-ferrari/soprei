# Passagem de turno entre agentes

> Estado **atual**, não histórico (spec 042): cada sessão **substitui** "Última sessão" e corrige as outras seções; nada é empilhado (um teste limita o arquivo a 20 KB). O histórico fica no git, o detalhe de cada entrega no "Registro da implementação" da spec e as decisões em `docs/context.md`.

## Última sessão

2026-11-24, Claude Code (Opus 5.5, spec-writer e implementer). **[Spec 044](specs/044-admin-da-plataforma.md), admin da plataforma:** escrita e aprovada pelo dono no mesmo dia (D1 a D12 como recomendadas; domínio trocado para `soadm.soprei.com`), e **E1 implementada**. Duas branches locais **empilhadas, sem push**, sobre `spec/035-e4-fatiar-atendimento` (topo da pilha anterior; `docs/areas/` e o índice da 042 ainda não estão na `main`):

- **`spec/044-admin-da-plataforma`:** só documentação (spec, índice, `context.md`, este arquivo).
- **`spec/044-e1-entrada-do-dono` (E1):** entrada do dono por cookie `__Host-soprei_platform` com segundo fator TOTP (`/platform/auth/login|logout|session`), cadastro do fator só pela CLI (`pnpm auth:cli enroll-platform-totp`), sessão no Redis, trilha `PlatformAuditEvent` (model global), login Bearer da plataforma exigindo o código com a chave ligada. Tudo atrás de `PLATFORM_ADMIN_ENABLED` (padrão `false`); variáveis novas no `.env.example`. **Migration aditiva** `20261124100000_platform_admin_second_factor`. Regras em `docs/areas/autenticacao-e-papeis.md` ("Entrada do admin da plataforma"). Desvios registrados na spec (colunas `subject_*`, FK da conta `SET NULL` para não travar o expurgo da 021).
- **Verde localmente (Windows, Node 26.13.1):** typecheck, build, lint, `format:check` e 244 unitários das áreas tocadas, mais os gates de docs, vocabulário e migrations. **Não rodado:** os dois testes de integração novos (sem `.env.test` aqui) e as suítes inteiras: CI.
- **Falta:** push e PR das duas branches (depois da pilha #16 a #20); CI; `reviewer` na E1 (segurança); depois a E2 (leituras agregadas e suspender/reativar). Pendente do dono, sem bloquear: conferir se a Política de Privacidade e os Termos cobrem o uso do e-mail da conta (D7).

## Onde estamos

- **Não há servidor de produção hoje** (informado pelo dono em 2026-11-23). Tudo o que as specs dizem estar pronto está na `main`, com o CI verde, e nada está publicado. Passos que dependem de servidor (staging, backup, nginx, `pm2-logrotate`, Cloudflare) ficam parados até existir um.
- **Specs:** o estado de cada uma está em [docs/specs/README.md](specs/README.md). Com etapas por fazer: 031 (E6, pacote extra), 032 (E2 em diante: aceite dos termos, retenção, exclusão), 034 (E4 `PROCESS_ROLE`, E5 limite do webhook), 042 (esta). Em rascunho: 033. Em implementação: 044 (admin da plataforma; E1 na branch). Esboços sob demanda: 006 (cache), 009 (tempo real). Reservada: 035 (eficiência do turno).
- **Validação:** o CI (versão do Node do `.nvmrc`) é a palavra final; confira também a última execução do workflow semanal "Compatibilidade do Node". Localmente, `typecheck`, `lint` e `format:check` da **raiz**; testes só do arquivo que falhou no CI ou da área tocada.

## Passos do dono pendentes

Itens herdados das sessões anteriores; os marcados "conferir" podem já ter sido feitos.

0. **Sem servidor:** conferir no GitHub se `DEPLOY_ENABLED` está `false`; ligado e sem servidor, o workflow de deploy falha a cada merge na `main`.
1. **Spec 042:** push da E1, CI, merge; depois a E2. Apagar, se quiser, as branches remotas já mergeadas (`spec/040-e2-tela`, `spec/041-conhecimento-pdf-docx`, `fix/backup-runuser`, `docs/registro-desligamento`) e a `dev`.
2. **Staging (spec 037, E2):** montar conforme `docs/ops/staging.md`; até lá a produção roda com `ALLOW_UNSTAGED=true` no `entry.conf`. Quando `deploy/soprei-deploy-entry.sh` mudar, reinstalar o programa de entrada à mão.
3. **Backup fora do servidor** (hoje só o diário local, `soprei-backup.sh`): depois do merge da [spec 043](specs/043-backup-externo.md), os passos de `docs/ops/backup.md` (chaves, bucket do R2, instalar, primeiro backup, aviso, teste de restauração).
4. **Anthropic:** termos de dados (LGPD) e limite de gasto mensal na Console.
5. **Spec 028, E0** (roteiro na spec): obrigatório antes de ligar `SCHEDULE_AI_ENABLED` e a opção "A IA pode solicitar, cancelar e remarcar horários" com empresa real.
6. **Spec 041 (conferir):** `location ~* \.mjs$` no nginx do servidor (sem ela o leitor de PDF não carrega) e o teste manual em computador, iPhone e Android.
7. **Spec 040 (conferir):** revisar a Política de Privacidade versão 2; pedido de teste em `/fale-conosco`; pedidos `PENDING` e assinaturas anuais antigas; `BILLING_TRIAL_TOKENS` ausente ou 600000 no `.env` do servidor.
8. **Spec 032 (conferir):** `pm2-logrotate` com 30 dias, `try_files` e log sem query no nginx, campo "URL dos Termos de Serviço" no app da Meta; conferir se o Gmail do SMTP é Workspace.
9. **Spec 030 (conferir):** revisar a redação de `PERSONA_TEMPLATE` (`frontend/src/company/onboarding-steps.ts`).
10. **Cloudflare:** se ligar o proxy, `real_ip` no nginx e `TRUST_PROXY` com as faixas dela.
11. **Máquina do dono (conferir):** `frontend/src/App.tsx` e `.claude/launch.json` tinham mudanças não commitadas, fora de qualquer spec.

## Próximo passo

Prioridade do dono (2026-11-23): **resiliência do atendimento**, [spec 035](specs/035-resiliencia-do-atendimento.md): E1 a E4 prontas nas branches (falta CI). Antes: fechar a 042 (E1, depois E2) e a 043 no GitHub. Parado até existir servidor: staging (037) e a instalação do backup (043). Depois: etapas restantes da 032 antes de empresas reais. Sem spec: lazy loading, error boundary e CSP no site; proteger a `main`.

## Decisões do dono que não são óbvias no código

- Specs sob demanda; a ordem é a do roadmap, não a numeração dos arquivos. O humano aprova specs e faz push, PR e merge (Squash and merge pelo GitHub quando a branch tem commit de merge; não fazer merge pelo GitHub Desktop na `main` local).
- Sem Docker: PostgreSQL e Redis nativos. Node 22 ou superior, sem teto.
- Empresa suspensa **não recebe nada** do canal (nem texto padrão), decisão de 2026-10-28.
- Mensagens rápidas do mesmo contato são agrupadas: ficam **no banco**; janela deslizante de 5 s com teto de 20 s (configurável).
- `TRUST_PROXY` só aceita `false`, `true` (nunca em produção) ou lista de IPs/CIDRs.
- Uma WABA = uma empresa do Soprei até haver spec própria; PIN do `/register` aleatório de 6 dígitos, cifrado.
- Contas: não há contas legadas (produto não lançado); a senha de 6 caracteres (maiúscula e número) do cadastro público é **risco aceito pelo dono** e vale também na recuperação de senha (2026-11-03, decisão 5 da spec 021 revertida pelo dono): a defesa é o bloqueio por conta e o rate limit.
- Testes: só o CI é obrigatório; localmente, só quando um teste falha ou para verificar uma correção.

## Armadilhas

- **Deploy (spec 037):** (a) o `deploy.sh` que **executa** é o da versão já instalada: uma correção nele só vale no deploy seguinte; (b) um agente **nunca** roda o `deploy.sh` nem mexe no servidor, no `.env`, no PM2 ou nos bancos locais; (c) **migration nunca é revertida pelo rollback**: toda migration nova precisa ser aditiva e compatível com a versão anterior (revisor confere), e a varredura por texto do deploy é alarme, não prova; (d) o Git Bash do Windows não tem `flock` nem `ln -s` real: o teste de comportamento do deploy pula os cenários dependentes (com aviso) e a palavra final é o CI Ubuntu; (e) editar `deploy.sh` com `String.replace` e texto que contém `$'`, `$&` ou `\n` corrompe o arquivo (aconteceu duas vezes nesta sessão): use função de substituição ou o Edit; (f) `shellcheck` não existe no PC do dono: avisos de estilo novos só aparecem no CI; (g) o staging **nunca** recebe `pg_dump` de produção (spec 032 pendente). (h) E3: o programa de entrada que roda é a cópia instalada em `/usr/local/sbin/` (um merge não o troca); `actionlint` também não existe no PC do dono (só no CI); o `if:` do job do `deploy.yml` só enxerga variáveis do **repositório** (`DEPLOY_ENABLED`), não as do ambiente.
- **Teste com prazo e promessa que nunca resolve (Node 22):** o timer de `withTimeout` é `unref()` de propósito; sem nada mais vivo, o Node 22 cancela a suíte ("Promise resolution is still pending but the event loop has already resolved") e leva junto os testes vizinhos, enquanto o Node 24 tolera. Use `t.after(keepEventLoopAlive())` (`test-support/keep-alive.ts`) em teste unitário que espera um timeout; em integração nova não use.
- **Log do CI:** `pnpm test` e `pnpm test:integration` rodam com o repórter `dot` (só os que falham aparecem, em "Failed tests"); procure por `Failed tests` no log. O Playwright tem uma retentativa no CI, rastreamento das tentativas que falham e artefato `playwright-traces-1` a `-3` (um por fatia do job `browser`, spec 036; na execução semanal com o sufixo `-node22` ou `-lts`) por 7 dias; abra com `npx playwright show-trace <zip>` (pasta `frontend`); teste que aparece como "flaky" precisa ser corrigido, não ignorado. Nome de artefato não pode ter `/` nem `*` (o valor da matriz do LTS é `lts/*`).
- **Agenda (spec 027):** (a) a violação da restrição de exclusão chega do Prisma 7 como `PrismaClientKnownRequestError` P2039 com `meta.driverAdapterError.cause.originalCode = '23P01'` (mensagem do Postgres é localizada e traz a chave em conflito: nunca copie); a tradução para `SLOT_TAKEN` é só `isExclusionViolation`/`toSlotTaken`; (b) `btree_gist` vem da própria migration (`CREATE EXTENSION IF NOT EXISTS`); o `migrate diff` do teste de drift não enxerga o `EXCLUDE`, por isso o teste novo prova que ele existe; (c) o gate de vocabulário da 022 também pega a palavra antiga da empresa em português (a que começa com "clie") em arquivo rastreado pelo git (arquivo novo só é varrido depois do `git add`): use "contato", "pessoa" ou "atendido"; (d) `assert.equal(x?.campo, false)` estreita `x` para o TypeScript (o ESLint passa a reclamar do `?.` seguinte); (e) o e2e `team.spec.ts` "reenviar" falha localmente (Windows) também no commit base: é tempo da máquina, não regressão; o `theme.spec.ts` "tema salvo escuro" falhou uma vez sob carga e passou sozinho; (f) um navegador a 390 px (projeto `mobile`) e uma verificação a 360 px no e2e da agenda; (g) `git stash push --keep-index` serve para validar o estado staged de uma etapa, mas o `pop` pode dar conflito em arquivo novo que existe nos dois lados: resolva com `git checkout stash@{0} -- <arquivo>` e `git reset`.
- **Limitações aceitas da agenda (revisão da 027):** `updateCustomerLabel` sem filtro de status; bloqueio sem teto de duração nem de antecedência; serialização do exemplo da agenda só em memória do processo. Corrigidos na revisão: corrida em `changeStatus` (uma nova tentativa), leitura da agenda do prompt sob `statement_timeout` de 1,5 s e `isValidTimeZone` só com nome IANA de região ou `UTC`.
- O que se grava em `whatsappPhoneNumberId` é o **ID do número de telefone** da Meta, não o telefone; a URL de callback termina em `/webhooks/whatsapp` (sem barra).
- O token temporário do número de teste da Meta expira em cerca de 24 h (erro 190 no log do envio); use o token permanente de um usuário do sistema.
- Erro do ioredis e do BullMQ não pode ir inteiro ao log (carrega `command.args` com chave e IP): use `describeRedisError`.
- Provedor Anthropic: nunca copie `error.message`, corpo ou o objeto de erro do SDK; `redirect: 'error'`; `LLM_MAX_OUTPUT_TOKENS` conta o pensamento adaptivo.
- **Ambiente Linux do dono (2026-11-11):** o `pnpm` 10.19 instalado tenta baixar o 12.3.4 do `packageManager` e falha; os binários de `backend/node_modules/.bin` e `frontend/node_modules/.bin` (`tsc`, `eslint`, `prettier`, `vite`, `playwright`) funcionam direto. O Playwright não tem navegadores baixados, mas roda com o Chrome do sistema: config temporária com `channel: 'chrome'` e `webServer.command` trocado por `node_modules/.bin/vite --host 127.0.0.1 --port 5186 --strictPort` (apague o arquivo depois). Não há `backend/.env.test`: integração só no CI.
- **Testes que falharam só no CI (aprendizados):** (a) o corpo de erro da API traz `requestId`, que muda a cada resposta: compare só `code` e `message`; (b) código de 6 dígitos pode coincidir por acaso com timestamp ou UUID: use `logContains` (`src/test-support/log-capture.ts`), nunca `includes` cru; (c) o `flush` do canal é agendado **depois** de gravar a mensagem: espere-o aparecer com `waitFor` antes de inspecionar a fila; (d) use relógio injetável e esperas com prazo, nunca sleep fixo como asserção.
- Testes de integração novos NÃO devem chamar `keepEventLoopAlive()` (o arquivo nunca termina); rode comandos sempre em primeiro plano, um por vez, para não deixar `node.exe` órfão. No Windows, `python3` é um stub que trava: use `node` ou a ferramenta de edição.
- `pnpm format:check` rode da raiz, como o CI.
- **Shell do agente:** heredocs com crases ou aspas e `node -e` com crases quebram no Bash da ferramenta; para editar arquivos com crases use a ferramenta de edição ou um script `.cjs` escrito com ela. Não coloque o caractere NUL literal em arquivo de texto (use `String.fromCharCode(0)`), a ferramenta de edição o trata como binário.

<!-- vocabulario-antigo:inicio -->

- **Renome (spec 022):** `MessageRole.USER` (a mensagem do contato), `EMAIL_PROVIDER_USER`, `PrismaClient`, `client_secret` (OAuth da Meta) e `from_user_id` (webhook da Meta) **não** são o vocabulário antigo e ficam como estão; o gate `backend/src/domain-vocabulary.test.ts` tem a lista de exceções com o motivo de cada uma. Testes que reproduzem o schema anterior à 022 em schema temporário (migrations 017, 020, 021 e a de renome) criam o tipo `user_status` no próprio schema, porque o `public` já tem `access_status`. O teste de drift (`schema-catalog.integration.test.ts`) aceita só as duas diferenças que já existiam antes da 022 (`accounts.updated_at` com DEFAULT, que o INSERT cru de `register` usa, e o `ON UPDATE CASCADE` da FK de `account_id`). Não use heredoc com barras invertidas no Bash da ferramenta (elas somem): escreva com a ferramenta de edição.

<!-- vocabulario-antigo:fim -->

- **Convites (spec 025):** o heredoc do Bash da ferramenta perde barras invertidas e sequências `\u`: arquivos com regex e escapes só pela ferramenta de edição (a de escrita também converte `\u2028` em caractere). A ponte do cookie usa só a empresa **selecionada** na sessão: teste com duas empresas da mesma pessoa precisa de `select` entre as chamadas. A cota por **conta convidadora** (50/dia no Redis) estoura em testes que usam o mesmo dono para muitos convites: use um dono novo por teste (`InvitationWorld.setup`). Empresa suspensa responde 401 (não 403) pela ponte do cookie. Fixture e2e da equipe e do convite são **camadas** por cima de `installApi` (`page.route` registrado depois vale primeiro; `route.fallback()` entrega o resto), e o relógio da API falsa não acompanha o `page.clock` (use `team.clockMs`). O token do convite é lido do fragmento no `main.tsx`, antes de o React montar (o `StrictMode` repete inicializadores e o fragmento já teria sumido).
- **Painel de conversas (spec 024):** a fixture e2e usa flags de falha (não contadores) porque o `StrictMode` repete efeitos; o `page.clock.install` antes do `goto` funciona para o limite de 2 min; `getByRole('tab')` traz o rótulo duplicado (beUI), use `toContainText`; o log do atendimento (escrita) ainda carrega `conversationId`, só a leitura não o loga.
- **Embedded Signup (spec 023):** o `MessageEvent` do teste precisa de `origin` explícito (`new MessageEvent('message', { data, origin })`), o `postMessage` real teria a origem do próprio site; o `React.StrictMode` do `dev` roda os efeitos duas vezes, então a API falsa do Playwright não deve contar leituras (mude o estado por evento, como o primeiro 404 do canal); `window.open` fica falso nos testes e o popup bloqueado é `window.open` devolvendo `null`; o relógio do e2e é `page.clock.install()` depois de abrir o painel; a lista de empresas do site agora traz `permissions` (sem ele o menu fica vazio). A troca do `code` usa o parâmetro OAuth da Meta no nome que ela define (ver o marcador de vocabulário abaixo).

<!-- vocabulario-antigo:inicio -->

- **Renome e OAuth da Meta (spec 023):** `client_id` (troca do `code` em `/oauth/access_token`) é nome da Meta e **não** muda; a 022 o tinha trocado por engano. Os arquivos que o citam estão em `domain-vocabulary.allowlist.json`.

<!-- vocabulario-antigo:fim -->

- **Expurgo (spec 021):** `DELETE ... WHERE id IN (SELECT ... LIMIT ... FOR UPDATE SKIP LOCKED)` pode apagar mais que o lote (o planejador reexecuta a subconsulta); use o CTE `MATERIALIZED` como no repositório. O inventário de rotas (`rate-limit.test.ts`) agora também registra as rotas de contas.

## O que não vem pelo git

- `.env` e `.env.test` em `backend/` (copiar dos `.example` e preencher), PostgreSQL e Redis nativos com o role e os bancos `soprei` e `soprei_test` (ver "Ambiente local" em `AGENTS.md`), Node 24 (a versão do `.nvmrc`; o 22 só para investigar a execução semanal), pnpm, um servidor SMTP local (Mailpit) para o cadastro e um túnel HTTPS se for testar a Meta.

## Pendências abertas

- **Assistente de primeiros passos (030), limitações aceitas:** (1) "Sair do passo?" não cobre a troca de aba pelo menu nem o Voltar do navegador (rascunho só em memória); (2) o formulário de serviço não alimenta `onDraft`; (3) entrar no assistente com a empresa dispensada reabre sozinho (o cartão volta em Conversas): intencional; (4) "Salvar e continuar" com colchetes do modelo na persona pede confirmação.

- **Contas (017/020/021):** lista de senhas comuns (e a política de senha de 6 caracteres, risco aceito); auditoria global de contas (a 021 só loga, mede e avisa o titular por e-mail); quem conhece o e-mail alheio pode esgotar o teto de 10 erros da recuperação e bloquear a recuperação da vítima por até 24 h; sessões sem `gen` (anteriores à 021) só caem na primeira revogação; lista de senhas comuns e contador por IP + e-mail; prefixo `__Host-` do cookie; quem pré-cadastra o e-mail de uma vítima pode bloquear a confirmação dela por 24 h com o teto da 020 (risco aceito; o site poderia avisar "se não recebeu o e-mail, tente de novo mais tarde").
- **Frontend (018):** código não usado dos componentes copiados do beUI, CSP (exige tratar o script inline do tema), evento `storage` do tema entre abas, divisão de código do bundle (acima de 500 kB por causa do `motion`).
- **Autenticação (007/008):** limpeza de sessões expiradas no conjunto `usess`; `nbf` em massa ao suspender empresa; bloqueio por conta que permite negar acesso a um e-mail conhecido; 503 depois de rotação confirmada pode exigir novo login; auditoria imutável só por convenção (considerar gatilho/`REVOKE` na spec de retenção); `ALTER TYPE ... ADD VALUE` exige PostgreSQL >= 12.
- **Canal (011/013/015):** contatos por nome de usuário do WhatsApp (BSUID) são descartados (`missing_sender`); respostas gravadas e não enviadas e mensagens pendentes antigas não são retomadas sozinhas (`sentAt` aparece na API); confirmar que o túnel **acrescenta** ao `X-Forwarded-For`; `DELETE` do canal desassina a WABA inteira.
- **Antes de dados reais de empresas:** política de retenção e LGPD (Redis, jobs do BullMQ com texto e `contactRef`, auditoria), RLS do Postgres, base legal e termos de dados da Anthropic.
