# Passagem de turno entre agentes

> Atualize no fim de cada sessão (ver "Trabalho em turnos entre agentes" em `AGENTS.md`). Curto e factual; o histórico de decisões fica em `docs/context.md` e nas specs, e o detalhe de cada spec no "Registro da implementação" dela.

**Última atualização:** 2026-11-03, por Claude Code (Sonnet 5.5): spec 021 (recuperação de senha e expurgo de contas não confirmadas) implementada na branch `spec/021-recuperacao-de-senha`, aguardando push, CI, revisão do `reviewer` (spec de segurança) e merge.

## Onde estamos

- **Concluídas e mergeadas:** specs 001 a 005, 007, 008 e 010 a 020 (a 021 está na branch, ainda não mergeada) (ver "Roadmap" em `docs/context.md`). O canal WhatsApp funciona de ponta a ponta com o número de teste da Meta; cada cliente tem credencial própria cifrada (015); contas globais com cadastro, confirmação de e-mail por **código de 6 dígitos** e cookie HttpOnly (017, 020); e-mail por SMTP genérico (019); site com componentes beUI e modo escuro (018). O atendimento usa o `LlmProvider` `mock` por padrão e o Claude Haiku 5.5 com `LLM_PROVIDER=anthropic`.
- **Em andamento:** branch `spec/021-recuperacao-de-senha` (implementação pronta, árvore limpa, **não enviada**: o agente não dá push). Falta: push, CI verde em Node 22 e LTS (suíte completa, `test:integration`, `test:browser`, `build` e smoke não rodaram localmente por decisão do dono), revisão do `reviewer` de preferência por outro agente/modelo (autenticação, endpoints públicos e sessões) e o merge. Depois do merge o dono marca a spec como `concluída`. O "Registro da implementação" da spec 021 lista o que foi rodado localmente e os desvios (CTE `MATERIALIZED` no expurgo, por exemplo).
- **Validação:** o CI (GitHub Actions, Node 22 e LTS) é a palavra final. Localmente rodam sempre `typecheck`, `lint` e `format:check` (da **raiz**; de dentro de `backend/` o `format:check` dá falso alarme). Os testes só rodam localmente quando um teste falha no CI ou para verificar uma correção (decisão do dono, 2026-11-03, ver `AGENTS.md`).

## Passos do dono (a máquina dele)

0. **Spec 021 (depois do merge):** aplicar a migration no banco de desenvolvimento com `pnpm db:migrate:deploy` (aditiva: colunas `reset_*`, dois CHECKs e o índice parcial das contas não confirmadas); acrescentar ao `backend/.env`, se quiser mudar os padrões, `ACCOUNT_UNVERIFIED_RETENTION_DAYS` (padrão 7) e `ACCOUNT_PURGE_INTERVAL_MINUTES` (padrão 60; `0` desliga o expurgo); reiniciar backend e frontend juntos (as rotas `/auth/password-reset/*` e as telas `/recuperar-senha` e `/redefinir-senha` são novas). A migration foi aplicada **só** em `soprei_test`. Com o Mailpit: pedir o código em `/recuperar-senha`, ler o e-mail na interface (`http://127.0.0.1:8025`) e redefinir em `/redefinir-senha`. A política de senha **não mudou**: a recuperação usa a mesma regra do cadastro (6 caracteres, uma maiúscula e um número).
1. **Aplicar a migration da 020 no banco de desenvolvimento:** `pnpm db:migrate:deploy` (aditiva: colunas de tentativas de confirmação; zera os códigos de confirmação pendentes).
2. **`backend/.env`** precisa de: `ACCOUNTS_ENABLED=true`, `APP_ORIGIN` (exatamente a origem do site, sem barra final), `EMAIL_PROVIDER_HOST/PORT/SECURE/FROM/USER/PSWD` (Mailpit local: `127.0.0.1`, `1025`, `false`, `noreply@ledware.com.br`, USER e PSWD vazios), `JWT_SECRET`, e, para o canal, `WHATSAPP_APP_ID`, `CHANNEL_CREDENTIALS_KEYS` e `CHANNEL_CREDENTIALS_ACTIVE_KEY_ID` (gerar a chave: `node -e "console.log('k1:'+require('node:crypto').randomBytes(32).toString('base64url'))"`; guardar uma cópia fora do repositório). As variáveis `GMAIL_*` não existem mais. O `.env` da raiz do repositório é resquício e nada o lê.
3. **Subir backend e frontend juntos** (o corpo de `POST /auth/verify-email` mudou de `token` para `code`). O `pnpm dev` não observa o `.env`: reinicie depois de editar.
4. **Teste manual da 014 com a chave real da Anthropic** (defina antes um limite de gasto mensal na Console; ver "Provedor de LLM real" em `AGENTS.md`) e, depois, confira os termos de dados da Anthropic (LGPD) antes de clientes reais.
5. **Teste manual da 015 com a Meta real:** as respostas da Graph (`GET /{waba}/phone_numbers`, campos do `debug_token`, Bearer do token de app, erro do `/register` com 2FA, repetir o registro com o mesmo PIN) são suposições ainda não confirmadas.
6. Limpar o stash do GitHub Desktop criado durante a 019 (`!!GitHub_Desktop<spec/019-smtp-generico>`), se ainda existir.

## Próximo passo sugerido

**Fechar a spec 021:** push da branch, CI, revisão do `reviewer` e merge (ver acima). Depois: painel de conversas no site; retenção e LGPD (antes de clientes reais; inclui auditoria global de contas, que a 021 deixou de fora, e a política de retenção do Redis e do banco); lista de senhas comuns e contador de falhas por IP + e-mail; tempo real (009) e cache (006) só com volume.

## Decisões do dono que não são óbvias no código

- Specs sob demanda; a ordem é a do roadmap, não a numeração dos arquivos. O humano aprova specs e faz push, PR e merge (Squash and merge pelo GitHub quando a branch tem commit de merge; não fazer merge pelo GitHub Desktop na `main` local).
- Sem Docker: PostgreSQL e Redis nativos. Node 22 ou superior, sem teto.
- Cliente suspenso **não recebe nada** do canal (nem texto padrão), decisão de 2026-10-28.
- Mensagens rápidas do mesmo contato são agrupadas: ficam **no banco**; janela deslizante de 5 s com teto de 20 s (configurável).
- `TRUST_PROXY` só aceita `false`, `true` (nunca em produção) ou lista de IPs/CIDRs.
- Uma WABA = um cliente do Soprei até haver spec própria; PIN do `/register` aleatório de 6 dígitos, cifrado.
- Contas: não há contas legadas (produto não lançado); a senha de 6 caracteres (maiúscula e número) do cadastro público é **risco aceito pelo dono** e vale também na recuperação de senha (2026-11-03, decisão 5 da spec 021 revertida pelo dono): a defesa é o bloqueio por conta e o rate limit.
- Testes: só o CI é obrigatório; localmente, só quando um teste falha ou para verificar uma correção.

## Armadilhas já encontradas

- O que se grava em `whatsappPhoneNumberId` é o **ID do número de telefone** da Meta, não o telefone; a URL de callback termina em `/webhooks/whatsapp` (sem barra).
- O token temporário do número de teste da Meta expira em cerca de 24 h (erro 190 no log do envio); use o token permanente de um usuário do sistema.
- Erro do ioredis e do BullMQ não pode ir inteiro ao log (carrega `command.args` com chave e IP): use `describeRedisError`.
- Provedor Anthropic: nunca copie `error.message`, corpo ou o objeto de erro do SDK; `redirect: 'error'`; `LLM_MAX_OUTPUT_TOKENS` conta o pensamento adaptivo.
- **Testes que falharam só no CI (aprendizados):** (a) o corpo de erro da API traz `requestId`, que muda a cada resposta: compare só `code` e `message`; (b) código de 6 dígitos pode coincidir por acaso com timestamp ou UUID: use `logContains` (`src/test-support/log-capture.ts`), nunca `includes` cru; (c) o `flush` do canal é agendado **depois** de gravar a mensagem: espere-o aparecer com `waitFor` antes de inspecionar a fila; (d) use relógio injetável e esperas com prazo, nunca sleep fixo como asserção.
- Testes de integração novos NÃO devem chamar `keepEventLoopAlive()` (o arquivo nunca termina); rode comandos sempre em primeiro plano, um por vez, para não deixar `node.exe` órfão. No Windows, `python3` é um stub que trava: use `node` ou a ferramenta de edição.
- `pnpm format:check` rode da raiz, como o CI.
- **Shell do agente:** heredocs com crases ou aspas e `node -e` com crases quebram no Bash da ferramenta; para editar arquivos com crases use a ferramenta de edição ou um script `.cjs` escrito com ela. Não coloque o caractere NUL literal em arquivo de texto (use `String.fromCharCode(0)`), a ferramenta de edição o trata como binário.
- **Expurgo (spec 021):** `DELETE ... WHERE id IN (SELECT ... LIMIT ... FOR UPDATE SKIP LOCKED)` pode apagar mais que o lote (o planejador reexecuta a subconsulta); use o CTE `MATERIALIZED` como no repositório. O inventário de rotas (`rate-limit.test.ts`) agora também registra as rotas de contas.

## O que não vem pelo git (recriar em cada máquina)

- `.env` e `.env.test` em `backend/` (copiar dos `.example` e preencher), PostgreSQL e Redis nativos com o role e os bancos `soprei` e `soprei_test` (ver "Ambiente local" em `AGENTS.md`), Node 22 e 24, pnpm, um servidor SMTP local (Mailpit) para o cadastro e um túnel HTTPS se for testar a Meta.

## Pendências abertas (não bloqueiam o próximo passo)

- **Contas (017/020/021):** lista de senhas comuns (e a política de senha de 6 caracteres, risco aceito); auditoria global de contas (a 021 só loga, mede e avisa o titular por e-mail); quem conhece o e-mail alheio pode esgotar o teto de 10 erros da recuperação e bloquear a recuperação da vítima por até 24 h; sessões sem `gen` (anteriores à 021) só caem na primeira revogação; lista de senhas comuns e contador por IP + e-mail; prefixo `__Host-` do cookie; quem pré-cadastra o e-mail de uma vítima pode bloquear a confirmação dela por 24 h com o teto da 020 (risco aceito; o site poderia avisar "se não recebeu o e-mail, tente de novo mais tarde").
- **Frontend (018):** código não usado dos componentes copiados do beUI, CSP (exige tratar o script inline do tema), evento `storage` do tema entre abas, divisão de código do bundle (acima de 500 kB por causa do `motion`).
- **Autenticação (007/008):** limpeza de sessões expiradas no conjunto `usess`; `nbf` em massa ao suspender cliente; bloqueio por conta que permite negar acesso a um e-mail conhecido; 503 depois de rotação confirmada pode exigir novo login; auditoria imutável só por convenção (considerar gatilho/`REVOKE` na spec de retenção); `ALTER TYPE ... ADD VALUE` exige PostgreSQL >= 12.
- **Canal (011/013/015):** contatos por nome de usuário do WhatsApp (BSUID) são descartados (`missing_sender`); respostas gravadas e não enviadas e mensagens pendentes antigas não são retomadas sozinhas (`sentAt` aparece na API); confirmar que o túnel **acrescenta** ao `X-Forwarded-For`; `DELETE` do canal desassina a WABA inteira.
- **Antes de dados reais de clientes:** política de retenção e LGPD (Redis, jobs do BullMQ com texto e `contactRef`, auditoria), RLS do Postgres, base legal e termos de dados da Anthropic, decisão de hospedagem.
