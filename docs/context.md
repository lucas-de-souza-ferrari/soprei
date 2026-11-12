# Soprei — Contexto do Projeto

> Fonte de verdade para humanos e agentes. Atualize quando uma decisão mudar; decisões aqui não se revertem sem motivo concreto registrado na seção "Histórico".

## 1. Objetivo

Sistema de atendimento via IA. Cada empresa (negócio) tem seu próprio assistente, com persona e base de conhecimento próprias, atendendo os contatos finais daquele negócio.

O assistente não é um chatbot genérico: responde com base nos documentos da empresa e **nunca mistura dados entre empresas**.

> Esta seção foi herdada do protótipo `customer-service` (WhatsApp + RAG por empresa). Confirme ou ajuste o escopo do Soprei aqui.

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
- **Socket.IO** para WebSocket e **SSE** para fluxo só servidor → navegador (ver spec 009).

## 3. Decisões em aberto

Resolver cada uma por spec antes de implementar o que depende dela.

| Tema | Opções conhecidas | Observação |
| --- | --- | --- |
| Fila de jobs | **BullMQ sobre Redis (decidido na spec 011)** | Fila `channel-inbound`, worker no mesmo processo com concorrência 1; fila por empresa e vários workers só quando a latência medida pedir. |
| Provedor de LLM | Gemini, Claude, OpenAI | Seja qual for, fica atrás da interface `LLMProvider`. |
| Canal | **WhatsApp Cloud API oficial (decidido)** | Estado da conta Meta (informado pelo dono em 2026-10-27): empresa com verificação de negócio concluída, app Business publicado (live), já é Tech Provider, número de teste da Meta para desenvolver, e quer o fluxo de onboarding de várias empresas (Embedded Signup). A confirmar: moeda e forma de pagamento da conta de cobrança (BRL), onde roda o webhook. Desde 01/10/2026 só as 1 000 primeiras mensagens de serviço por número ao mês são grátis. |
| Hospedagem | VPS (protótipo: Hetzner) | — |

## 3.1. Modelo de IA em desenvolvimento

- Interface única `LlmProvider` (`src/application/ports/llm-provider.ts`; gerar resposta, e mais tarde gerar embedding). Hoje só `generate`, que devolve `Result<LlmReply, ExternalServiceError>`.
- Três implementações previstas: `mock` (respostas determinísticas, usada nos testes e no CI; **já existe**, em `src/infrastructure/external-apis/llm/`), um modelo barato ou gratuito para dev manual, e o modelo de produção (as duas últimas entram em spec própria).
- A escolha vem de `LLM_PROVIDER` (por ora só `mock`), validada na config, junto de `LLM_TIMEOUT_MS`.

## 4. Arquitetura (princípios)

- **Multi-tenancy por design:** toda entidade tem identificador de empresa; camada de acesso a dados exige esse identificador. Vazamento entre empresas é o pior bug possível para o negócio.
- **Webhook rápido:** responde 200 imediatamente e processa em background.
- **Sem polling:** tudo orientado a evento (webhook + fila).
- **Erros nunca deixam o usuário final em silêncio.**
- **LLM trocável** atrás de interface.

### Vocabulário do domínio (spec 022)

| Termo | Nome no código e no banco | O que é |
| --- | --- | --- |
| Empresa | `Company`, `CompanyId`, `companyId`, tabela `companies`, coluna `company_id` | Quem contrata/usa o Soprei. É o **tenant**: todo dado de negócio pertence a uma empresa. |
| Conta (pessoa) | `Account`, `AccountId`, tabela `accounts` | A pessoa que entra no site: e-mail e senha globais, confirmação de e-mail. |
| Vínculo | `Membership`, `MembershipId`, tabela `memberships` | A participação de uma conta numa empresa, com papel (`OWNER`, `ADMIN`, `AGENT`, `VIEWER`) e estado. Model de tenant. |
| Contato | `contact`, `contactRef` | Quem escreve no WhatsApp para a empresa. Não é usuário do sistema. |
| Administrador da plataforma | `PlatformAdmin` | Operador do Soprei, global, fora de qualquer empresa. |

<!-- vocabulario-antigo:inicio -->
Renomeado na spec 022: antes, a empresa se chamava `Client` e o vínculo `User`. As specs 001 a 021, a seção 6 e o histórico de decisões (seção 7) usam os nomes antigos, como foram escritos; a tabela antigo -> novo está no topo de `AGENTS.md`.
<!-- vocabulario-antigo:fim -->

### Padrão de referência

Seguimos o guia [Engenharia Backend Node.js + TypeScript](https://www.vivodecodigo.com.br/backend/engenharia-backend-nodejs-typescript-guia-definitivo) (inspirado em Clean Architecture). As regras resumidas estão no `CLAUDE.md`.

Desvios deliberados em relação ao guia:

- **Fastify** no lugar de Express: o que o guia faz com middleware, aqui vira hook/plugin do Fastify.
- **Sem `any`** no repositório genérico; o guia usa `any` no modelo Prisma e isso enfraquece a tipagem.
- **Isolamento entre empresas** não está no guia: aqui o `CompanyId` (branded type) é obrigatório em todo repositório.
- **Estratégia de testes** não está no guia: definida no `AGENTS.md`.
- **Itens do guia que o guia trata como opcionais** (JWT/refresh, RBAC, rate limiting, cache, métricas, WebSocket/SSE) entram desde já na base, cada um em sua spec (004 a 009). Cache sem decorators; rate limiting sobre `@fastify/rate-limit` em vez de limiter próprio.
- Exemplos do guia são incompletos em alguns pontos (refresh token em memória, service layer esqueleto); não copiar literalmente, usar como direção.

### Estrutura de pastas

```
src/
├── domain/          # entities, value-objects (CompanyId...), interfaces de repositório
├── application/     # services/use-cases e portas
│   ├── attendance/  # AttendanceService e schemas
│   ├── channel/     # canal de mensagens: entrada do webhook e processador dos jobs (spec 011)
│   ├── companies/   # CompanyService
│   └── ports/       # interfaces para o exterior: LlmProvider, MessageSender, InboundJobQueue
├── infrastructure/
│   ├── config/      # env validada com Zod (fail-fast)
│   ├── database/    # raiz: Prisma singleton, transação com retry, erros, barrel (index.ts)
│   │   ├── extensions/    # Prisma Client Extensions: tenant-scope, query-timing, schema-info
│   │   └── repositories/  # base de tenant, implementações de repositório, unit of work, cursor, mappers
│   ├── http/        # raiz: servidor Fastify, error handler central, testes de rota de ponta a ponta
│   │   ├── observability/ # request id, contexto, log de requisição, métricas HTTP
│   │   └── rate-limit/    # registerRateLimit e IP de origem
│   ├── logger/      # Pino com mixin de contexto e redact
│   ├── metrics/     # prom-client: Registry dedicado (spec 004)
│   ├── cache/       # client Redis singleton (ioredis) (cache em si: spec 006)
│   ├── queue/       # fila de entrada do canal (BullMQ), conexões Redis próprias (spec 011)
│   └── external-apis/  # llm/ (mock; real em spec própria) e whatsapp/ (adaptador HTTP da Cloud API)
├── presentation/    # controllers/rotas, hooks, validators Zod
│   ├── admin/       # rotas /admin/*
│   ├── system/      # /health, /health/ready, /metrics
│   ├── webhooks/    # webhook do WhatsApp (spec 011)
│   └── common/      # bearer auth hook, route pattern, perfil de rate limit
├── shared/          # errors (BaseError...), types (Brand, Result), request-context, utils
└── index.ts         # bootstrap
prisma/
└── schema.prisma
```

Convenções de pastas (fixadas na [spec 012](specs/012-reorganizacao-pastas.md); versão operacional no `AGENTS.md`):

1. Pasta por área quando passar de uns 10 arquivos ou juntar duas responsabilidades; não criar pasta para o futuro (as pastas da 011 nascem na 011).
2. Teste ao lado do arquivo que testa, na mesma subpasta; teste que atravessa várias partes fica na pasta pai.
3. Barrels só onde já existem (`database/index.ts`, `domain/index.ts`); imports de fora de uma camada usam o barrel quando ele exporta o símbolo.
4. Sem aliases de caminho (`@/...`): imports relativos.
5. Nomes de arquivo não mudam ao mover (sufixos `.service.ts`, `.repository.ts`, `.controller.ts`).

## 5. Roadmap (fatias)

**Como o roadmap funciona (revisado em 2026-10-27, decisão do dono):**

- **Specs sob demanda:** só a próxima spec é detalhada e aprovada. As demais ficam como esboço (uma linha aqui; os arquivos já escritos para 005 a 009 têm status `esboço` e **devem ser relidos contra o código real antes de aprovar**, como aconteceu com a 002 e a 003).
- **Fatia vertical cedo:** em vez de construir toda a base de engenharia antes do produto, entra logo depois da 004 uma fatia fina que prova o produto de ponta a ponta. Rate limit, cache, autenticação, RBAC e tempo real entram quando uma funcionalidade real pedir.
- **Revisão obrigatória pelo agente `reviewer`** antes do merge nas specs de segurança (autenticação, autorização, isolamento e RLS).
- A numeração dos arquivos de spec é só identificador; **a ordem de execução é a deste roadmap**.

**Concluídas**

1. 001 — Bootstrap (camadas, config, erros, Result, `/health`)
2. 002 — Infra local, Postgres, Redis, Prisma singleton
3. 003 — Base multi-tenant e isolamento
4. 004 — Observabilidade: logs com contexto por requisição e métricas
5. 005 — Rate limiting: limite por perfil e por IP em Redis, `TRUST_PROXY`, 429 padronizado
6. **Fatia vertical ([spec 010](specs/010-fatia-vertical-atendimento.md), concluída):** mensagem de entrada → conversa/mensagem do contato → `LLMProvider` com `mock` → resposta, com isolamento por empresa e fallback de erro. Decisões do dono (todas conforme a recomendação): simulador por API administrativa, processamento síncrono, persona em `Company`, `contactRef` livre, histórico de 20 mensagens e 12 000 caracteres, fallback constante, nunca logar conteúdo de mensagens, política de retenção de dados pessoais só antes de dados reais. Passa pelo `reviewer` antes do merge.
7. 012 — Reorganização de pastas: subpastas por área em `database`, `http`, `application` e `presentation`, sem mudança de comportamento
8. 011 — Canal WhatsApp (webhook assinado, fila BullMQ, envio pela Cloud API, número de teste da Meta, LLM `mock`); teste manual do dono com a Meta funcionou de ponta a ponta
9. 013 — Agrupamento de mensagens rápidas (janela de espera deslizante, lote respondido uma vez; mensagens gravadas no banco, `Message.answeredById`)
10. 014 — Provedor real de LLM: `AnthropicLlmProvider` (Claude Haiku 5.5) atrás do `LlmProvider`, `AbortSignal` no prazo, erro sem texto do contato, `llm_tokens_total`; teste manual com a chave real ainda por fazer (limite de gasto na conta antes)11. 015 — Onboarding de empresas no canal WhatsApp (spec B): **aprovada** (2026-10-30); **015a e 015b implementadas** (credenciais por empresa cifradas, `PUT/GET/DELETE`, `TOKEN_INVALID`, envio com o token da empresa e Embedded Signup). Decisão do dono (2026-10-30): o Soprei registra o número (`/register`) com **PIN aleatório de 6 dígitos** que ele gera e guarda cifrado como o token; uma WABA = uma empresa até haver spec própria ([spec](specs/015-onboarding-whatsapp.md)). Credenciais por empresa cifradas (AES-256-GCM), `PUT/GET/DELETE .../channel` e `POST .../channel/embedded-signup` (troca do `code` pela Graph) por `OWNER`/`ADMIN`, estado `TOKEN_INVALID`, envio com o token da empresa. O dono decidiu em 2026-10-30 que o Embedded Signup entra na 015 (divisão em 015a/015b só se o PR passar de ~2 000 linhas); cadastro público da empresa é spec própria depois. Passa pelo `reviewer`

12. 016 — Frontend base (site React/Vite/Tailwind em `frontend/`; backend movido para `backend/`).
13. 017 — Contas globais e empresas ([spec](specs/017-contas-e-empresas.md)): **concluída e mergeada**. Cadastro/login por e-mail e senha, empresas dentro da conta, criação como `OWNER`, sessão com cookie HttpOnly e confirmação de e-mail. Riscos aceitos e pendências na spec (recuperação de senha, expurgo de não confirmadas, senha de 6 caracteres).
14. 018 — Frontend com beUI e modo escuro ([spec](specs/018-frontend-beui-e-modo-escuro.md)): **concluída e mergeada** (CI verde em Node 22 e LTS). Pendências: código não usado dos componentes copiados, CSP, evento `storage` do tema e divisão de código do bundle.
15. 019 — E-mail por SMTP genérico ([spec](specs/019-smtp-generico.md)): **concluída e mergeada**. `EMAIL_PROVIDER_*`, TLS exigido em produção, `GMAIL_*` removido.
16. 020 — Código de confirmação de e-mail com 6 dígitos ([spec](specs/020-codigo-confirmacao-6-digitos.md)): **concluída e mergeada**. HMAC, 5 erros por código, teto de 25 erros por conta em 24 h, validade de 15 min, campo `code`.
17. 021 — Recuperação de senha e expurgo de contas não confirmadas ([spec](specs/021-recuperacao-de-senha.md)): **concluída e mergeada** (CI verde em Node 22 e LTS). Código de 6 dígitos por e-mail com HMAC de finalidade própria, 5 erros por código e teto de 10 por conta em 24 h; revogação de todas as sessões por geração no Redis; aviso de senha alterada; expurgo em segundo plano das contas não confirmadas e sem vínculo (padrão 7 dias).

**Próximas**

<!-- vocabulario-antigo:inicio -->
- **Spec 022 — renome do domínio** ([spec](specs/022-renome-do-dominio.md)): **concluída e mergeada** (CI verde em Node 22 e LTS; aprovada em 2026-11-03). `Client` -> `Company`, `User` (vínculo) -> `Membership`, `Account` fica; banco, API, sessões, fila, logs, site e documentação. Refatoração pura, com gate de restos.
<!-- vocabulario-antigo:fim -->
- **Spec 023 — conectar o WhatsApp pelo site** ([spec](specs/023-conectar-whatsapp-no-site.md)): **concluída e mergeada** (CI verde; aprovada em 2026-11-04; o Embedded Signup real com a Meta ainda não foi testado: depende do domínio no app da Meta). Área da empresa no site (`/painel/canal`, `/painel/persona`, `/painel/testar`): Embedded Signup da Meta com o SDK carregado sob demanda, estado, troca e desconexão do canal; persona editável pela própria empresa (permissão `persona:manage`); caixa "Testar o atendimento" sobre o simulador. Sem autorização nova: usa a ponte cookie -> rotas de tenant que já existia.
- **Spec 024 — painel mínimo de conversas** ([spec](specs/024-painel-de-conversas.md)): **concluída e mergeada** (CI verde). Lista e histórico só de leitura no site; contato mascarado no servidor (as duas rotas deixam de devolver `contactRef` e `externalId`); lista por última atividade; histórico com `order=desc`.
- **Spec 025 — convites por e-mail e gestão da equipe** ([spec](specs/025-convites-e-equipe.md)): **concluída e mergeada** (CI verde) (aprovada em 2026-11-04). Convite por link de uso único (256 bits no fragmento da URL, só o HMAC no banco), `/painel/equipe` (listar, convidar, reenviar, revogar, mudar papel, desativar e reativar) e a página `/convite` nos três casos de aceite; `OWNER` não é convidável; cotas anti-spam; expurgo do e-mail do convidado. Migration nova aditiva (`company_invitations`).
- **Spec 026 — conhecimento da IA e estoque** ([spec](specs/026-conhecimento-e-estoque.md)): **concluída e mergeada** (CI verde nos dois Node; E6 cortada). Documentos e produtos da empresa, busca textual do PostgreSQL em português, bloco de conhecimento no `systemPrompt`, estoque com ajuste atômico e livro imutável, exemplo e importação CSV. Falta o teste manual do dono com `LLM_PROVIDER=anthropic`.
- **Spec 027 — agendamento** ([spec](specs/027-agendamento.md)): **concluída e mergeada (2026-11-05; CI verde nas duas versões do Node; revisão do `reviewer` sem bloqueador, 3 sugestões aplicadas e 3 aceitas como limitações)** (E1 a E4 prontas; E5 parcial; E6 cortada). Agenda da empresa (serviços, recursos, horários da semana, reservas e bloqueios) com **dupla reserva impedida pelo banco** (`EXCLUDE USING gist` com `btree_gist`, criada pela própria migration), fuso por empresa (conversão só no servidor), painel `/painel/agenda` em lista por dia e a IA **só lê** os horários livres (marcar pelo WhatsApp com tool use é a spec 028). Permissões `schedule:read|manage|configure`. Lembretes proativos exigem template da Meta (fora de escopo).
- **Spec 029 — redesign do painel** ([spec](specs/029-redesign-painel.md)): **concluída e mergeada (2026-11-06; CI verde nas duas versões do Node; revisão do `reviewer` sem bloqueador; E1 a E4 prontas)**. Menu lateral fixo (E1; Dashboard Shell da Obsidian UI copiado, licença MIT confirmada pelo dono, com as dependências Radix e class-variance-authority autorizadas na D11), empresa sempre aberta com a última usada guardada na conta (E2, coluna `accounts.last_company_id`, passa pelo reviewer), bolhas do beUI em Conversas e Testar (E3) e calendário semana/mês na Agenda (E4). A 028 segue reservada ao tool use da agenda.
- **Spec 028 — a IA marca horários por tool use** ([spec](specs/028-ia-agenda-tool-use.md)): **aprovada em 2026-11-06; E1 (laço de ferramentas só de leitura, `listar_horarios`) concluída e mergeada (CI verde, revisão sem bloqueador); E2, E3 e E4 (escrita e painel) concluídas e mergeadas em 2026-11-06, CI verde nas duas versões do Node, sem o E0 por decisão do dono: a ativação, a chave global e a opção da empresa, continua condicionada ao E0, o teste manual do dono com a chave real**. Quatro ferramentas (listar, solicitar, cancelar e remarcar), só nas reservas do próprio contato; reserva da IA nasce `PENDING`; interruptor global `SCHEDULE_AI_ENABLED` e por empresa (ambos desligados por padrão); E0 é um teste manual do dono com a chave real que libera a escrita (E2 em diante). Passou pelo reviewer (sem bloqueador; importantes corrigidos). **E1 implementada em 2026-11-06 (só leitura: porta de ferramentas, laço no adaptador Anthropic, mock roteirizado, `listar_horarios`, `<meus_agendamentos>`, chave `SCHEDULE_AI_ENABLED`); E2 e E3 (escrita: migration `20261106100000_schedule_ai_booking`, `ContactSchedulingService`, cotas no Redis, guarda de afirmação, resumo determinístico) e E4 (painel: selo "Pela IA", filtro de origem, contagem, interruptores) implementadas em 2026-11-06; E0 (roteiro no Registro da spec) pendente do dono e obrigatório antes de ligar; E5 (teste manual) do dono.**
- **Spec 030 — wizard de primeiros passos** ([spec](specs/030-wizard-onboarding.md)): **aprovada em 2026-11-06**, a implementar. Seis passos puláveis e retomáveis (empresa, persona, documentos, serviços, estoque, testar o atendente), progresso derivado do servidor, rota `GET/PUT /admin/companies/:companyId/onboarding` (permissão `onboarding:manage`, OWNER e ADMIN) e coluna `companies.onboarding_dismissed_at`; cartão "Configuração" em Conversas. Passa pelo reviewer.
- **Spec 031 — planos e assinaturas (InfinitePay)** ([spec](specs/031-planos-e-assinaturas.md)): **aprovada em 2026-11-09**, a implementar **até a E2** (catálogo, estados, medição de uso e aplicação de cota e módulos, no modo C); a E3 (checkout InfinitePay) espera o passo zero E0. Três planos (Essencial, Profissional, Escala) mensais e anuais (20% de desconto), add-ons Agenda e Estoque, cota em respostas enviadas e em tokens. Lançamento no modo C (a empresa paga a Meta direto pelo próprio WABA); o modo S (Soprei paga a Meta, preços mais altos) exige linha de crédito da Meta (Solution Partner ou solução conjunta) e fica atrás de `SOPREI_PAYS_META_ENABLED` (desligado). Passa pelo reviewer (dinheiro e controle de acesso). Pendências do dono: nota fiscal, cláusula de reajuste nos termos de uso, retenção de dados dos pedidos e o caminho com a Meta.
- **Spec 034 — capacidade do canal** ([spec](specs/034-capacidade-do-canal.md)): **aprovada em 2026-11-11** (D1 a D5 como recomendadas), a implementar: E1 a E3 num PR, E4 e E5 em outro. Origem: auditoria do repositório (2026-11-11), que apontou o worker da fila com concorrência 1 no processo HTTP como o limite de vazão do sistema inteiro. Entrega ordem das mensagens por instante de recebimento, `QUEUE_CONCURRENCY`, handlers de erro fatal, prazo de desligamento, métricas da fila, `PROCESS_ROLE` e novo padrão do limite do webhook. A eficiência do turno (cache de leituras, prompt caching, retomada de pendentes, limpeza do Redis) fica para a 035, ainda não escrita.
- **Spec 036 — CI mais rápido** ([spec](specs/036-ci-mais-rapido.md)): **aprovada em 2026-11-11 (D1 a D6 como recomendadas) e implementada na branch; falta o push do dono e a medição no CI** (tempo abaixo de 10 min, 444 testes de navegador somando as fatias, contagens de unitários e integração iguais, cancelamento e a execução semanal disparada à mão). Uma só versão do Node nos PRs (`.nvmrc` = `24`) com execução semanal em `22` e `lts/*`, jobs paralelos (`static`, `tests`, `browser`), Playwright em 3 fatias com 1 worker cada, cache do navegador, `concurrency` e `--test-concurrency=1` mantido na integração. **Mudou a regra das duas versões do Node** (`AGENTS.md`, item 7 de "Trabalho em turnos"). A 035 está reservada para "eficiência do turno" (sem arquivo ainda).
- **Spec 037 — deploy com rollback e staging** ([spec](specs/037-deploy-e-staging.md)): **aprovada em 2026-11-11 (D1 a D12 como recomendadas; E3 adiada); E1 e E2 implementadas na branch `spec/037-deploy-e-staging` (aguardando CI, revisão do `reviewer` e os passos do dono no servidor).** Recorta da 033 a E4 (deploy) e a D7 (staging) para o servidor próprio já em produção (PM2, nginx): `deploy/deploy.sh` com migration antes da troca, espera de saúde e rollback automático do código (E1); staging no mesmo servidor com banco, Redis e e-mail próprios (E2); disparo por GitHub Actions opcional e adiável (E3). Passa pelo reviewer.
- **Spec 038 — notificações no painel: a IA pede atendimento humano** ([spec](specs/038-notificacoes-atendimento-humano.md)): **aprovada (2026-11-11, "Aprovo tudo", D1 a D10 como recomendadas) e implementada na branch `spec/030-notificacoes`** (escrita como 030 e renumerada ao integrar com a `main`). Model `Notification` (tenant, uma aberta por conversa), a IA sinaliza pela ferramenta `solicitar_atendimento_humano` no mecanismo da 028, sino com polling no painel, tela `/painel/notificacoes` e destaque na conversa. Revisão do `reviewer` feita (aprovada com ressalvas, ajustes aplicados); falta o CI.
- **Depois:** tempo real (009); retenção, LGPD e hospedagem (antes de empresas reais); resiliência do canal; cache (006) sob demanda.

- Cadastro público: o dono pediu senha com mínimo de seis caracteres, uma letra maiúscula e um número, confirmação na tela e controles de visibilidade. A política de senha legada permanece separada.

- Pendências da spec 017 (revisão de segurança, 2026-11-03): recuperação de senha e expurgo de contas não confirmadas (feitos na spec 021; o cadastro repetido de conta não confirmada substitui a senha e reenvia o código, no máximo a cada 60 s); senha de 6 caracteres é risco aceito pelo dono, a rever com lista de senhas comuns recusadas no cadastro e contador de falhas por IP + e-mail (hoje ~480 tentativas/dia por e-mail); prefixo `__Host-` do cookie; sugestões S-2, S-4, S-5, S-7 e S-8 do reviewer ainda não tratadas.
- Pendências da spec 008 (revisão): imutabilidade da auditoria só por convenção do repositório (considerar gatilho ou `REVOKE` na spec de retenção/LGPD, que também decide o expurgo); a migration `20261030120000_rbac_audit` usa `ALTER TYPE ... ADD VALUE`, que exige PostgreSQL >= 12.

- Pendências da spec 007 (revisão): teto do tamanho da fila de espera do hasher (`scrypt-password-hasher.ts`) e limpeza periódica de sessões expiradas no conjunto `usess` do Redis; incluir o IP na chave do bloqueio por conta se virar problema.
- Pendências antes de dados reais: política de retenção e LGPD (inclui limpeza do Redis e dos jobs), RLS do Postgres, varredura de mensagens pendentes antigas, suporte a BSUID (contato sem telefone), confirmar que o túnel/proxy acrescenta ao `X-Forwarded-For`.


**Sob demanda (esboço; entra quando o gatilho acontecer)**

| Item | Spec | Gatilho |
| --- | --- | --- |
| Autenticação JWT + refresh | 007 | **concluída** (aprovada em 2026-10-29 com todas as recomendações; revisada, CI verde e mergeada). Pré-requisito do onboarding de várias empresas (spec B); substitui a `ADMIN_API_KEY`, que foi removida |
| RBAC | 008 | **concluída** (aprovada em 2026-10-30 com todas as recomendações; revisada, CI verde e mergeada; quatro papéis, permissões por papel, usuários da empresa pela API, troca da própria senha, auditoria imutável e teto da fila do hasher). Detalhes em `AGENTS.md` ("Autorização por papéis (spec 008)") |
| Cache L1/L2 | 006 | quando medição mostrar leitura repetida custosa |
| Tempo real (SSE/WebSocket) | 009 | quando o painel precisar de eventos ao vivo |
| Row Level Security do Postgres | a escrever | **antes de dados reais de empresas** (decisão do dono); revisão pelo `reviewer` |

**Produto (esboço, depois da fatia vertical)**

- Provedor real de LLM atrás do `LLMProvider`
- Canal WhatsApp, em duas specs: (A) webhook de entrada com validação de assinatura, envio da resposta e mapeamento `phone_number_id` → empresa, com número de teste da Meta, fila e rate limit (spec 005 como pré-requisito); (B, spec 015, **aprovada**) onboarding de várias empresas com Embedded Signup, que exige autenticação (spec 007/008), tela de onboarding e tokens por empresa guardados cifrados
- Base de conhecimento (ingestão de documentos + busca)
- Painel admin (separado)
- Deploy

## 6. Estado atual

- **Spec 025 (convites e equipe): concluída e mergeada.** Backend: tabela de tenant `company_invitations` (FKs compostas, e-mail e hash só em `PENDING` por CHECK, único parcial por e-mail e empresa), `audit_events.invitation_id` e quatro ações `INVITATION_*`, `InvitationService` (criar, reenviar, revogar, `preview`, `accept`, `accept-new`), cotas por empresa, convidador e (no Redis) destinatário e conta convidadora, e-mail em segundo plano, expurgo no timer do expurgo de contas, métricas `company_invitations_total` e `company_invitation_emails_total`. Frontend: aba Equipe e página `/convite`. Sem variável de ambiente nova. Detalhes em `AGENTS.md` ("Convites por e-mail e equipe (spec 025)") e no "Registro da implementação" da spec.

- **Spec 023 (conectar o WhatsApp pelo site): concluída e mergeada.** Backend: `persona:manage`, `GET/PUT .../persona`, `GET .../channel/setup`, `permissions` em `GET /account/companies`, config `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` e `CHANNEL_MANUAL_CONNECT_ENABLED`, métrica `company_persona_updates_total{action}`. Frontend: `src/api.ts`, `src/company/` (Embedded Signup com máquina de estados pura, parser estrito do `postMessage` e SDK sob demanda). Detalhes e desvios no "Registro da implementação" da spec.

<!-- vocabulario-antigo:inicio -->
- **Spec 022 (renome do domínio): concluída e mergeada.** Banco (uma migration de renome, só metadado), schema, código, API, sessões (audiência e chaves `v3`), fila, logs, site e documentação passam de `Client`/`User` para `Company`/`Membership`; gate de restos em `backend/src/domain-vocabulary.test.ts`. Detalhes e desvios no "Registro da implementação" da spec.

- **Spec 001 (bootstrap): concluída e mergeada**, CI verde em Node 22 e LTS. Já existem: Fastify com `GET /health`, config validada com Zod (fail-fast), Pino, hierarquia de erros com error handler central, `Brand` e `Result`, ESLint + Prettier, Prisma 7 sem models e CI. Camadas `shared`, `infrastructure` e `presentation`; `domain` e `application` nascem quando houver conteúdo.
- Versões fixadas na 001: TypeScript 6.0.x (o `typescript-eslint` ainda não suporta o 7) e Prisma 7.10.x (a tag `latest` do CLI aponta para um RC).
- **Spec 002 (infra local e banco): concluída e mergeada**, CI verde em Node 22 e LTS. Postgres e Redis nativos (sem Docker; PostgreSQL 18.2 e Redis 8.0.1 na máquina do dono). Já existem: Prisma 7 com `@prisma/adapter-pg` (singleton, pool configurável, helper de transação com retry, `DatabaseError`, métricas do pool), client `ioredis` singleton, `GET /health/ready`, boot fail-fast e shutdown gracioso, testes unitários (`pnpm test`) separados dos de integração (`pnpm test:integration`, só contra `soprei_test` e Redis `/15`) e CI com services Postgres 18 e Redis 8.
- **Spec 003 (base multi-tenant): concluída e mergeada**, CI verde no PR. Já existem: models `Client` (raiz, soft delete, slug único e reservado) e `Conversation` (mínima) com a primeira migration; `src/domain/` (`ClientId`, entidades, `TenantRepository`, `ClientRepository`) e `src/application/` (`ClientService`); base de repositório de tenant, que exige `ClientId` e injeta o filtro; segunda barreira no Prisma Client (extension `tenant-scope` com `MODEL_SCOPES` e `TenantScopeError`); regras de ESLint que proíbem Prisma e SQL cru fora de `infrastructure/database/`; `ConflictError`; rotas `/admin/clients` protegidas por `ADMIN_API_KEY` (credencial temporária entre clientes, sem rate limit até a spec 005). A RLS do Postgres fica para spec separada depois da 009.
- A duplicidade de `ConflictError`/`TenantScopeError` que quebrava o `typecheck` foi corrigida na `main` pelo dono (commit `136af89`).
- **Spec 004 (observabilidade): concluída e mergeada**, CI verde. Já existem: contexto por requisição com `AsyncLocalStorage` (`src/shared/request-context/`), `x-request-id` reaproveitado ou UUID, logger com `mixin` de contexto e `redact` de segredos, log de requisição próprio com o padrão da rota, métricas `prom-client` num `Registry` dedicado (HTTP, queries do Prisma por model/operação via extensão aplicada depois da `tenant-scope`, pool de conexões, processo), `GET /metrics` só com `METRICS_TOKEN` (404 sem ele) e `bearerAuthHook` compartilhado com o admin. `clientId`/`userId` do contexto ficam vazios até a autenticação (spec 007). Dependência nova: `prom-client`.
- **Spec 005 (rate limiting): concluída e mergeada**, revisada pelo `reviewer` (um bloqueante e dois importantes corrigidos) e com CI verde. Já existem: `@fastify/rate-limit` como hook `onRequest` da instância raiz (roda antes da autenticação e de ler o corpo), perfis `public` (padrão de rota sem perfil), `admin` e `webhook`, sempre por perfil e por IP normalizado, com store Redis em conexão dedicada (fila offline desligada, prazo curto por comando) e fail-open com log e `rate_limit_store_errors_total`; `RateLimitError` com corpo `{ error: { code: 'RATE_LIMITED', retryAfter } }` e os headers `Retry-After` e `X-RateLimit-*`; `TRUST_PROXY` (só `false`, `true` fora de produção ou lista de IPs/CIDRs dos proxies; o inteiro não existe porque o Fastify 5.12.7 o trata como fail-closed); `RATE_LIMIT_ENABLED` (não pode ser `false` em produção). Rota nova declara o perfil (`rateLimitProfile('webhook')`...); o teste de inventário de rotas falha se esquecer. Dependência nova: `@fastify/rate-limit`.
- **Spec 012 (reorganização de pastas): concluída e mergeada**, CI verde. 39 arquivos movidos com `git mv`, sem mudança de lógica: 466 unitários e 148 de integração com os mesmos nomes. Estrutura e convenções (pasta por área, teste ao lado, sem barrels novos, sem aliases) estão em "Estrutura de pastas" e no `CLAUDE.md`.
- **Spec 011 (canal WhatsApp, parte A): implementada, não mergeada** (aguarda `reviewer`, CI e o teste manual do dono com o número de teste da Meta). Já existem: `GET`/`POST /webhooks/whatsapp` (opt-in por `WHATSAPP_ENABLED`; assinatura HMAC-SHA256 sobre o corpo cru, rate limit `webhook`, resposta 200 depois de enfileirar), fila BullMQ 6 `channel-inbound` com worker no mesmo processo (concorrência 1, encerramento gracioso antes de Redis e banco), `ChannelIntakeService` e `ChannelInboundProcessor` (`application/channel/`), `WhatsappCloudApiClient` (Graph API `v26.0`, `fetch` nativo) atrás da porta `MessageSender`, migration aditiva (`Client.whatsappPhoneNumberId` único, `Message.channelMessageId` e `sentAt`), `findByWhatsappPhoneNumberId` (o único ponto que resolve identificador externo em cliente), `markSent` e `listBefore`, métricas do webhook, do canal e da fila. Dependência nova: `bullmq` (usa o `ioredis` do projeto). Retenção do texto e do `contactRef` nos jobs do Redis (`QUEUE_KEEP_*`) entra na decisão de LGPD antes de dados reais.
- **Spec 013 (agrupamento de mensagens rápidas): implementada, não mergeada** (aguarda `reviewer`, CI e merge). No canal, o job `text` só grava a mensagem (`AttendanceService.acceptInboundMessage`, sem LLM) e agenda um job `flush` por contato (BullMQ, deduplicação com `replace` e `keepLastIfActive`: janela deslizante com teto, e o próximo `flush` guardado se o contato está sendo atendido); o `flush` (`respondToPending`) junta as pendentes num único turno `user`, chama o LLM fora de transação e grava uma resposta que marca o lote inteiro (`Message.answeredById`, chave estrangeira composta, migration aditiva). O simulador `/admin` continua síncrono, e avisos constantes seguem imediatos. Config `CHANNEL_BATCH_*`; métricas `attendance_batch_size` e `attendance_batches_total`. Sem dependência nova.
- **Spec 010 (fatia vertical): concluída e mergeada**, revisada pelo `reviewer` e com CI verde (unitários e integração, Node 22 e LTS). Já existem: migration aditiva (`Client.persona`, `Conversation.contactRef` e o model `Message`, de tenant, com chaves estrangeiras compostas por `clientId`); `LlmProvider` + `MockLlmProvider` (modo de falha, marcadores `[[mock:fail]]`, `[[mock:hang]]`, `[[mock:empty]]`, `[[mock:huge]]`, registro de entradas só para testes); `AttendanceService` (idempotência por `externalId`, histórico de 20 mensagens e 12 000 caracteres, fallback constante gravado com `isFallback`, LLM fora da transação, timeout por `withTimeout`/`TimeoutError`); rotas `POST /admin/clients/:clientId/messages`, `GET .../conversations`, `GET .../conversations/:conversationId/messages` e `persona` no `PATCH /admin/clients/:id`; métricas `llm_requests_total`, `llm_request_duration_seconds`, `attendance_fallbacks_total`; regra de nunca logar conteúdo de mensagem nem persona, com teste de captura de log. Retenção de dados pessoais (mensagens e `contactRef`) segue sem política: decidir antes de dados reais, junto com a RLS. Specs 005 a 009 como esboço (ver "Roadmap"). Próximo passo: escolher o provedor real de LLM (e, junto, decidir o canal) e escrever a spec seguinte. Lição do CI: testes que conferem ordem por tempo precisam de relógio injetável (`src/test-support/clock.ts`), nunca do relógio real.

- **Spec 007 (autenticação JWT): implementada, aguardando revisão e merge.** Já existem: models `User` (tenant, e-mail único por cliente) e `PlatformAdmin` (global); `/auth/login`, `/auth/platform/login`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all`, `/auth/me`; access token HS256 (`jose` atrás de `AccessTokenService`), refresh opaco com rotação atômica em Lua e detecção de reuso, hash `scrypt` com teto de 2 hashes simultâneos, bloqueio por conta, perfis de rate limit `login` e `refresh` fail-closed, hook `authenticate` com `requireUser`/`requirePlatform`, `ClientId` só do token (o `:clientId` do caminho é conferido e vira 404 se divergir), `pnpm auth:cli` para o primeiro usuário. `ADMIN_API_KEY` removida; `JWT_SECRET` obrigatória. Detalhes em `AGENTS.md` ("Autenticação (spec 007)").

- **Spec 008 (RBAC): implementada, aguardando revisão e merge.** Já existem: papéis `OWNER`, `ADMIN`, `AGENT`, `VIEWER` com mapa fixo papel -> permissão (`src/domain/permissions.ts`), hook `requirePermission` (401, 403 para `PlatformAdmin`, 404 de `:clientId` alheio antes de 403), `GET`/`POST /admin/clients/:clientId/users`, `PATCH .../users/:userId`, `POST .../users/:userId/password`, `GET .../audit-events`, `POST /auth/password`, hierarquia no service, regra do último `OWNER` com bloqueio da linha do cliente, auditoria na mesma transação (`AuditEvent`, FKs compostas), revogação das sessões do alvo depois do commit e teto de 32 na fila do hasher scrypt.

## 7. Histórico de decisões

- 2026-11-11: o dono aprovou a spec 037 (deploy com rollback e staging) com D1 a D12 como recomendadas: o código continua num diretório só por ambiente (`/var/www/soprei` e `/var/www/soprei-staging`), compilado em pastas de espera (`dist.next` e `frontend/releases/<sha>`) e trocado por renomeação, com o site servido por atalho (`frontend/dist`); o rollback **refaz o caminho** (Git, instalação, build, recarga), não guarda `dist.prev`; o staging nasce **vazio** (nunca dado de produção antes da spec 032), com Mailpit local com STARTTLS e autoridade privada, senha básica + `noindex` no nginx e **sem segundo app da Meta** por ora; `kill_timeout` do PM2 em 65 000 ms (5 s acima do `SHUTDOWN_TIMEOUT_MS` padrão); a produção só aceita o SHA que já passou pelo staging (`--allow-unstaged` em emergência); **a E3 (GitHub Actions) foi adiada** e o usuário dedicado `soprei` só vem junto com ela; `config:check` mínimo incluído. Migration nunca é revertida: a política é aditiva e compatível com a versão anterior (ver `docs/ops/deploy.md`).
- 2026-11-11: na integração da spec 038 (notificações) com a `main`, o dono decidiu que o sinal de atendimento humano usa o **mecanismo de ferramentas da 028** em vez de uma porta própria: um só mecanismo de ferramentas no `LlmProvider`; quando a IA pede humano o modelo é chamado mais uma vez para escrever a resposta. A spec, escrita como 030, foi renumerada para 038.
- 2026-11-11: o dono aprovou a spec 038 (escrita como 030; "Aprovo tudo", D1 a D10 como recomendadas): notificações no painel com a primeira, **atendimento humano solicitado**; motivo em lista fixa (sem texto livre); estado compartilhado pela empresa (`OPEN`/`RESOLVED`), uma aberta por conversa e teto de 500 por empresa; a IA **continua** respondendo (responder pelo painel e pausar a IA ficam para spec própria); sino com polling de 30 s (sem SSE); todos os papéis veem, OWNER, ADMIN e AGENT resolvem; sem e-mail nem notificação do sistema operacional; selo e faixa nas conversas; o simulador também gera.
- 2026-11-11: o dono aprovou a spec 036 (CI mais rápido) com as seis recomendações ("Aprovo tudo"): o CI dos PRs e da `main` passa a rodar **numa só versão do Node, a do `.nvmrc` (24, que também é a de produção)**, e as outras (22, piso de `engines`, e `lts/*`) rodam numa execução **semanal** que não bloqueia PR. Isso **substitui** a parte "Node 22 e LTS mais recente" da decisão de 2026-11-03 abaixo e a regra "CI verde nas duas versões". Também: jobs paralelos (`static`, `tests`, `browser`), Playwright com `fullyParallel`, 1 worker e 3 fatias, cache do navegador pela versão do Playwright, `concurrency` cancelando só em PR, e `--test-concurrency=1` da integração mantido.

- 2026-11-11: o dono aprovou a spec 034 (capacidade do canal) com as cinco recomendações: a ordem das mensagens de um contato passa a vir do **instante de recebimento no webhook** (`receivedAt`), não mais da fila de concorrência 1 (substitui a decisão 2 da spec 011 nesse ponto); `QUEUE_CONCURRENCY` padrão 10 e `DB_POOL_MAX` padrão 20; timers periódicos só nos papéis `worker` e `all`; limite do webhook padrão 6000 por 60 s; E1 a E3 num PR e E4 e E5 em outro. Documentação da Meta e da Anthropic conferida no mesmo dia (fontes na spec).
- 2026-11-05: spec 027 (agendamento) implementada em etapas por um agente: E1 (núcleo do backend: migration com `btree_gist`, `zoned-time`, `computeSlots`, reservas sob a restrição de exclusão, rotas e testes de concorrência), E2 (painel), E3 (a IA lê os horários livres, reaproveitando o desenho da 026) e E4 (exemplo); E5 só com o e2e que veio com a E2 e E6 cortada. O dono confirmou a disponibilidade do `btree_gist` 1.8 no PostgreSQL 18.2 local; o plano B (trava do recurso) não foi necessário. Desvios com motivo estão no Registro da implementação da spec (por exemplo, `today` no servidor e a tela de configuração escondida do menu).
- 2026-11-04: o dono aprovou a spec 026 ("Aprovo tudo", com as 15 recomendações): base de conhecimento da IA com **busca textual do PostgreSQL em português** (sem embeddings, sem extensão, sem dependência nova), documentos de texto por empresa recuperados por pergunta e entregues no `systemPrompt` como material de referência (o texto do contato segue só no turno `user`), com tetos por turno (4 trechos, 5 produtos, 4.000 caracteres), recuperação fail-open com prazo de 1,5 s, fontes (só rótulos) no simulador e extensão determinística do `mock`; controle de estoque simples (catálogo por empresa, ajuste atômico por `delta` com motivo fixo, livro de movimentos imutável, produto desativado em vez de apagado); permissões novas `knowledge:manage` e `inventory:manage` só para `OWNER` e `ADMIN`; entrega em etapas E1 a E6 (conhecimento, estoque, exemplo, CSV, histórico na tela, e2e) para poder parar em qualquer fronteira. Em 2026-11-04 está sendo implementada por etapas (E1 pronta) para a apresentação, ainda sem revisão do `reviewer` nem CI; o stemmer exigiu indexar o texto com e sem acentos (ver o Registro da implementação da spec).

- 2026-11-04: o dono aprovou a spec 025 ("aprovo a 25", com as 21 recomendações): convite por **link de uso único** (256 bits no fragmento, só o HMAC no banco, sem contador de erros), tabela de tenant com e-mail anulado ao fechar, `OWNER` não convidável, 409 para quem já é membro, validade de 7 dias, reenvio a cada 60 s (até 6 envios), cotas (20 pendentes e 30 envios por empresa, 20 por convidador, 50 por conta convidadora e 3 por destinatário entre empresas, estas duas no Redis e com estouro silencioso), aceite sem conta cria a conta já confirmada e substitui a senha de conta não confirmada (sem login automático), falha uniforme 400 `INVITATION_INVALID`, permissões `membership:*` reaproveitadas, perfil `login` nas rotas públicas, aba Equipe depois de Persona; sair da empresa e transferência de propriedade ficam fora.

- 2026-11-04: o dono aprovou a spec 024 ("Aprovo tudo", com as 10 recomendações): máscara do contato no servidor e rotas trocadas no lugar, ordem por última atividade (migration de índice), histórico abre nas mais recentes, sem prévia nem contagem, indicador de envio só no WhatsApp (2 min), id da conversa na URL, 404 uniforme, Conversas como primeira aba, páginas de 30 e 50.
- 2026-11-04: o dono aprovou a spec 023 ("Aprovo tudo", com as 11 recomendações): o site chama as rotas de tenant pela ponte do cookie que já existe (sem caminho de autorização novo), `appId`, `config_id` e versão da Graph chegam ao navegador por `GET /admin/companies/:companyId/channel/setup` (`WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` opcional), formulário manual só com `CHANNEL_MANUAL_CONNECT_ENABLED=true` (recusado em produção), permissão nova `persona:manage` (OWNER e ADMIN) sem auditoria por enquanto, caixa de teste incluída, `permissions` aditivo em `GET /account/companies`, URLs `/painel/canal|persona|testar` sem ids, SDK da Meta só na tela do canal depois do clique 1 (popup no clique 2) e App Review só para empresas que não sejam do dono e dos testadores. Correção feita na implementação: a troca do `code` voltou a usar o parâmetro OAuth da Meta com o nome que ela define (o renome da 022 o tinha trocado, o que quebraria a troca real).

- 2026-11-03: o dono aprovou a spec 022 ("Aprovo tudo", com as 11 recomendações): renome do domínio (`Client` -> `Company`, `User` -> `Membership`, `Account` fica), de verdade no banco, na API, nas sessões, na fila, nos logs, no site e na documentação, sem alias de compatibilidade; todo mundo entra de novo uma vez e a fila é esvaziada antes da troca. Renomeado na spec 022: as entradas abaixo usam os nomes de antes.

- 2026-11-03: o dono ajustou a decisão sobre testes locais: continuam dispensados por rotina (só o CI), mas o agente pode rodar localmente o teste que falhou no CI ou verificar uma correção. Motivo: três testes escritos sem execução falharam só no CI (código de 6 dígitos coincidindo com timestamp no log, `requestId` no corpo de erro e corrida na espera do `flush`); as lições estão no `docs/handoff.md`.
- 2026-11-03: o dono decidiu **dispensar os testes locais** para agilizar o desenvolvimento: `pnpm test` e `pnpm test:integration` passam a ser executados só no GitHub Actions (Node 22 e LTS mais recente); localmente ficam `typecheck`, `lint` e `format:check`. Os testes continuam sendo escritos e valendo como critério de aceite; o humano informa o resultado do CI depois do push, e spec só é dada como pronta com o CI verde. Efeito: regressões só aparecem depois do push, então o reviewer segue lendo o diff com atenção em specs de segurança.
- 2026-11-03: o dono aprovou a spec 019 (SMTP genérico por `EMAIL_PROVIDER_*`, sem retrocompatibilidade com `GMAIL_*`, TLS exigido em produção e texto puro só em loopback fora dela, remetente `Soprei <FROM>`, Mailpit no desenvolvimento).

- 2026-11-03: o dono aprovou a spec 020 ("Aprovo tudo", com as 8 recomendações): código de confirmação de e-mail com 6 dígitos, HMAC em vez de SHA-256, no máximo 5 erros por código (o código morre e o vencimento fica, então o reenvio continua esperando 60 s desde o envio), teto de 25 erros por conta em 24 h (sem código novo até a janela passar), validade de 15 min, formato inválido é 400 sem contar, campo do corpo `code` (quebra o contrato antigo `token`), códigos pendentes antigos invalidados pela migration. Decidiu também que os testes rodam só no CI do GitHub Actions, não localmente.
- 2026-11-03: o dono aprovou a spec 021 ("Aprovo tudo", com as 12 recomendações) e, no mesmo dia, **reverteu a decisão 5**: a senha da recuperação segue a política do cadastro público (6 caracteres, uma maiúscula e um número, um só schema), sem mudar o contrato do cadastro. O risco aceito da senha curta (017) continua; a defesa é o bloqueio por conta e o rate limit.
- 2026-11-03: o dono pediu que o frontend use os componentes do beUI (https://beui.dev/components/motion) e tenha modo escuro; a spec 018 foi aprovada (site e telas de conta, View Transition do tema ligada). Implementada na branch `spec/018-frontend-beui`: componentes copiados (MIT) em `frontend/src/components/motion/`, tema Claro/Escuro/Sistema próprio (sem `next-themes`), tokens em `style.css`. Dependências novas só `motion`, `clsx`, `tailwind-merge` e `lucide-react`.
- 2026-11-03: o dono autorizou implementar a 017 e escolheu permanência da sessão após recarregar (cookie HttpOnly) e confirmação real de e-mail pelo Gmail. A implementação usa SMTP TLS com senha de app configurada pelo dono; não envia e-mail real nos testes. Contas e vínculos são separados, e a migração preserva ids e recusa colisões sem resolução explícita.

- 2026-11-03: o dono substituiu o login de tenant com `clientSlug` por conta da pessoa com e-mail/senha e acesso às empresas após entrar. Confirmou que a própria pessoa poderá criar empresas e será dona delas. A 017 deve ser reescrita para essa fundação antes do painel; o desenho técnico e a migração ainda não estão aprovados.

- 2026-10-30: o dono aprovou a spec 016: workspace pnpm com `backend/` e `frontend/`, primeira entrega do frontend como site de apresentação, identidade do Soprei fornecida em SVG e referências Beautiful UI, beUI e ObsidianUI. Implementação na branch `spec/016-frontend-base`; hospedagem permanece fora do escopo.

- Stack Node 22+ + TypeScript + Fastify + Prisma + Pino definida pelo dono do projeto.
- 2026-10-27: o dono aprovou mudar o processo para specs sob demanda, fatia vertical cedo e `reviewer` obrigatório em specs de segurança. Motivo: as specs 002 e 003, escritas antes do código, precisaram ser reescritas, e a base completa (JWT, RBAC, cache, tempo real) estava sendo construída antes de existir produto.
- O protótipo `customer-service` usava TypeORM; o Soprei usa Prisma. As regras de arquitetura do protótipo (isolamento por cliente, webhook rápido, LLM trocável) foram mantidas.
- 2026-10-29: o dono aprovou a spec 007 com todas as recomendações da seção "Decisões" (scrypt do `node:crypto`, `jose`, login por `clientSlug` + e-mail, `PlatformAdmin` separado que só alcança o CRUD de clientes, `ADMIN_API_KEY` removida, primeiro usuário por comando local, refresh no corpo, Redis fora = 503, reuso estrito de refresh, bloqueio 5 falhas/15 min, papéis `OWNER`/`AGENT`, um PR, `:clientId` divergente = 404, `JWT_SECRET` obrigatória, access 15 min / refresh ocioso 7 dias / teto 30 dias).
- 2026-10-30: o dono aprovou a spec 008 com todas as recomendações da seção "Decisões para o dono" (quatro papéis com mapa fixo e hook por permissão; auditoria em tabela imutável escrita na mesma transação; revogação das sessões do alvo a cada mudança; troca da própria senha derruba todas as sessões, inclusive a atual; a senha inicial é definida por quem cria; última pessoa `OWNER` protegida com bloqueio do cliente; `ADMIN` gerencia só `AGENT`/`VIEWER`; teto da fila do hasher em commit próprio; `POST /auth/password` no perfil `login`; um PR).
<!-- vocabulario-antigo:fim -->
- 2026-11-05: spec 029 aprovada pelo dono ("Aprovo tudo"): D1 a D10 como recomendadas e **D11 pela alternativa (a)** (aceitar dependências novas para o shell, só as que o código copiado importasse, versão fixa, sem rodar o shadcn CLI, licença obrigatória). No passo zero da E1 as páginas da Obsidian UI não traziam licença (primeiro foi feito um shell próprio); o dono confirmou depois a licença MIT no repositório da Obsidian UI e o Dashboard Shell foi copiado, com as dependências autorizadas. A última empresa usada vive no servidor (`accounts.last_company_id`), nunca no navegador: o `localStorage` continua guardando só o tema.
