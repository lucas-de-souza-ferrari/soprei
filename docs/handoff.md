# Passagem de turno entre agentes

> Atualize no fim de cada sessão (ver "Trabalho em turnos entre agentes" em `AGENTS.md`). Curto e factual; o histórico de decisões fica em `docs/context.md` e nas specs.

**Última atualização:** 2026-10-28, por Claude Code (Sonnet 5.5).

## Onde estamos

- **Concluídas e mergeadas:** specs 001 a 005, 010, 011, 012 e 013 (ver "Roadmap" em `docs/context.md`). O canal WhatsApp funciona de ponta a ponta com o número de teste da Meta e com token permanente de usuário do sistema; o atendimento ainda responde com o `LlmProvider` `mock`.
- **Branch em andamento:** `docs/agent-handoff` (esta mudança: `AGENTS.md` como fonte única de regras, `CLAUDE.md` importando-o, roteiros em `docs/agents/`, este arquivo). Só docs; precisa de push e PR do humano.
- **Verde na última verificação (main com a 013):** `pnpm typecheck`, `lint`, `format:check`, 645 testes unitários e 241 de integração, em Node 22.23.2 e 24.18.0, e CI verde.

## Próximo passo sugerido

1. **Spec 014 (provedor real de LLM, Claude Haiku 5.5)** está em rascunho em `docs/specs/014-provedor-llm-real.md`, aguardando as decisões do dono (provedor, esforço, limite de saída, instrução de estilo, base legal LGPD). Depois de aprovada: implementer, reviewer e teste manual com a chave real (definir limite de gasto na conta da Anthropic).
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

## O que não vem pelo git (recriar em cada máquina)

- `.env` e `.env.test` (copiar dos `.example` e preencher senha e tokens), PostgreSQL e Redis nativos com o role e os bancos `soprei` e `soprei_test` (ver "Ambiente local" em `AGENTS.md`), Node 22 e 24, pnpm, e um túnel HTTPS se for testar a Meta.

## Pendências abertas (não bloqueiam o próximo passo)

- Suporte a contatos que usam nome de usuário do WhatsApp (BSUID, sem telefone): hoje a mensagem é descartada com métrica `missing_sender`.
- Confirmar que o túnel usado acrescenta ao `X-Forwarded-For` em vez de repassar o cabeçalho do cliente.
- Respostas gravadas e não enviadas (token expirado, falha do Graph) não são reenviadas sozinhas; `sentAt` aparece na API administrativa.
