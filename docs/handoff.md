# Passagem de turno entre agentes

> Atualize no fim de cada sessão (ver "Trabalho em turnos entre agentes" em `AGENTS.md`). Curto e factual; o histórico de decisões fica em `docs/context.md` e nas specs.

**Última atualização:** 2026-10-28, por Claude Code (Sonnet 5.5).

## Onde estamos

- **Concluídas e mergeadas:** specs 001 a 005, 010, 011, 012 e 013 (ver "Roadmap" em `docs/context.md`). O canal WhatsApp funciona de ponta a ponta com o número de teste da Meta e com token permanente de usuário do sistema; o atendimento ainda responde com o `LlmProvider` `mock`.
- **Branch em andamento:** `spec/014-provedor-llm-real` (spec 014 implementada, aguardando `reviewer`, push, PR e CI; o agente não dá push). Os docs da `docs/agent-handoff` entraram no primeiro commit dela.
- **Verde na última verificação (branch da 014):** `pnpm typecheck`, `lint`, `format:check`, 718 testes unitários e 241 de integração, em Node 22.23.2 e 24.18.0; `rm -rf dist && pnpm build` e smoke do processo compilado com `LLM_PROVIDER=mock` e com `anthropic` apontando para um servidor falso. CI ainda não rodou.
- **Estabilidade da 014:** suítes novas e alteradas repetidas de 4 a 5 vezes em cada Node, sem falha (`anthropic-llm.provider.test.ts`, `anthropic-attendance.test.ts`, `attendance-llm.service.test.ts`, config, métricas, `attendance.integration.test.ts`).

## Próximo passo sugerido

1. **Spec 014 (provedor real de LLM, Claude Haiku 5.5):** implementada (ver o "Registro da implementação" na spec). Falta: o `reviewer` (de preferência outro agente; foco em vazamento de dado pessoal em erro, chave, cancelamento e o caminho do atendimento), push e PR pelo humano, CI verde, o **teste manual com a chave real** (criar a chave e **definir limite de gasto mensal** na conta da Anthropic; roteiro em `AGENTS.md`, "Provedor de LLM real") e a conferência da base legal e dos termos de dados (LGPD, decisão 7 da spec) antes de clientes reais. O dono marca a spec como `concluída` depois do merge.
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
- Sem `ADMIN_API_KEY` no `.env`, as rotas `/admin` respondem 401.
- Provedor Anthropic: nunca logue nem copie `error.message`, corpo ou o objeto de erro do SDK (podem ecoar persona, histórico e texto do contato); só `{ provider, status, errorType, retryable }`. O SDK 1.3.0 manda a chave em `Authorization: Bearer`. O tokenizador do Haiku 5.5 conta cerca de 30% mais tokens que o do 4.5.
- Provedor Anthropic: `redirect: 'error'` no fetch do SDK (nunca reenviar o corpo a outro host) e `ANTHROPIC_CUSTOM_HEADERS` escondido do SDK; `LLM_MAX_OUTPUT_TOKENS` conta o pensamento adaptivo (suba o teto com esforço `medium` ou `high`). SDK fixo em 1.3.0.
- Testes que comparam o `systemPrompt` precisam esperar persona mais a instrução de estilo (`ATTENDANCE_STYLE_INSTRUCTION`).

## O que não vem pelo git (recriar em cada máquina)

- `.env` e `.env.test` (copiar dos `.example` e preencher senha e tokens), PostgreSQL e Redis nativos com o role e os bancos `soprei` e `soprei_test` (ver "Ambiente local" em `AGENTS.md`), Node 22 e 24, pnpm, e um túnel HTTPS se for testar a Meta.

## Pendências abertas (não bloqueiam o próximo passo)

- Suporte a contatos que usam nome de usuário do WhatsApp (BSUID, sem telefone): hoje a mensagem é descartada com métrica `missing_sender`.
- Confirmar que o túnel usado acrescenta ao `X-Forwarded-For` em vez de repassar o cabeçalho do cliente.
- Respostas gravadas e não enviadas (token expirado, falha do Graph) não são reenviadas sozinhas; `sentAt` aparece na API administrativa.
