# 032 — LGPD e retenção de dados

- **Status:** em implementação (E1 concluída, textos vigentes; E7 implementada e revisada na branch `spec/032-e7-excluir-conta`, falta CI e merge; E2 a E6 e E8 em diante não feitas; status normalizado em 2026-11-23, spec 042). Antes: aprovada (2026-11-12, pelo dono: "Aprovo todas", **D1 a D15 como recomendadas**; revisada no mesmo dia contra a `main` em `efa2e89`). Os textos dos Anexos A a C continuam rascunho até a revisão do advogado (D2).
- **Branch:** uma por etapa, `spec/032-e<N>-<nome>` (cada etapa é um PR próprio; ver "Etapas")
- **Depende de:** 011, 013 e 034 (fila e jobs com texto e `contactRef`), 015 (credencial do canal), 017, 020 e 021 (contas e expurgo), 024 (rótulo mascarado do contato), 025 (convites), 026 e 027 (conhecimento, agenda), 028 (a IA escreve na agenda), 031 (planos e pagamentos), 037 (deploy, cópias antes de migration), 038 (`Notification`), 039 (mensagem `HUMAN`, job `echo`, pausa da IA). Conversa com a **033** (backup externo, restauração e monitoramento continuam lá).
- **Observação de numeração:** conferido em `docs/specs/` em 2026-11-12: existem 001 a 034 e 036 a 039 (a 035 está reservada para "eficiência do turno", sem arquivo). Esta continua sendo a **032**.
- **Esta spec passa pelo `reviewer`** antes do merge de **cada** etapa com código (dado pessoal, exclusão de dados, rotas novas com permissão, página pública, SQL que atravessa empresas nos expurgos, coluna nova em `accounts`).
- **Fatos externos** (lei, ANPD, termos da Anthropic, da Meta, da InfinitePay, da Hetzner, do Google) **não foram lidos na fonte** por quem escreveu: tudo marcado **(S#)** é **suposição** a conferir no **E0**. **Nada aqui é parecer jurídico.** Os textos dos Anexos A, B e C são **rascunhos técnicos** escritos a partir do que o sistema faz de verdade; **um advogado revisa antes de valerem** (pendência jurídica **J**).

## Objetivo

O Soprei já está em produção (`https://www.soprei.com`). Antes de empresas reais, e para o app da Meta ir a Live e passar no App Review, é preciso: (1) **páginas públicas** de política de privacidade, termos de uso e instruções de exclusão de dados, com texto que descreve o sistema real; (2) **aceite dos termos** com a versão gravada; (3) **prazo real** para os dados no Redis e no banco; (4) os caminhos práticos para **exportar e apagar** os dados de um contato e para **excluir a própria conta e a própria empresa**.

## Comportamento esperado

### Estado atual (conferido no código em 2026-11-12, `main` em `efa2e89`)

- **Models do Prisma (26, todos em `MODEL_SCOPES`, `infrastructure/database/extensions/tenant-scope.ts`):** de tenant, `Conversation`, `Message`, `Membership`, `AuditEvent`, `ChannelConnection`, `CompanyInvitation`, `KnowledgeDocument`, `KnowledgeChunk`, `Product`, `StockMovement`, `ScheduleSettings`, `ScheduleResource`, `ScheduleService`, `AvailabilityRule`, `Appointment`, `Notification`; globais, `Company`, `PlatformAdmin`, `Account`, `Plan`, `PlanPrice`, `Subscription`, `PaymentOrder`, `UsageCounter`, `PaymentNotice`.
- **O que é apagado hoje:** só contas nunca confirmadas (`UnverifiedAccountPurger`, `ACCOUNT_UNVERIFIED_RETENTION_DAYS`, padrão 7) e o e-mail de convites pendentes vencidos há 7 dias (`InvitationExpiryPurger`). Os dois rodam no **mesmo** `startPurgeTimer` (`application/auth/purge-timer.ts`, ligado em `src/index.ts`), que só existe com `ACCOUNTS_ENABLED=true` (`ACCOUNT_PURGE_INTERVAL_MINUTES=0` desliga os dois). O mesmo `startPurgeTimer` é reutilizado, com instâncias **próprias**, pela reconciliação de pagamentos (`BILLING_RECONCILE_INTERVAL_MINUTES`) e pelos avisos de cobrança (`BILLING_NOTICE_INTERVAL_MINUTES`) da 031; o `closeInfrastructure` para e espera os três. Mensagens (inclusive `HUMAN`), conversas, notificações, agendamentos, auditoria, vínculos e contas ficam **para sempre**. A `PROCESS_ROLE` da 034 (E4) **não existe**: todos os timers rodam no único processo.
- **Empresa removida** (`PrismaCompanyRepository.remove`, só `PlatformAdmin` por `DELETE /admin/companies/:id`): soft delete (`deleted_at`, `whatsapp_phone_number_id` anulado, `ChannelConnection` apagada); **todo o resto continua no banco**. Não há rota de restauração, nem exclusão pela própria empresa, nem exclusão de conta. **Atenção:** o caminho `DELETE /admin/companies/:id` já é do `PlatformAdmin`, então a exclusão pela empresa **não** pode usar o mesmo método e caminho (ver E8).
- **Redis, fila `channel-inbound`** (`infrastructure/queue/inbound-queue.ts`, linhas ~143 a ~205): jobs `text`, `notice` e `echo` (039) entram com `removeOnComplete: { age: QUEUE_KEEP_COMPLETED_SECONDS }` (padrão 3600) e `removeOnFail: { age: QUEUE_KEEP_FAILED_SECONDS }` (padrão 86400; **teto atual de 30 dias** em `env.schema.ts`); o `flush` sai ao concluir (`removeOnComplete: true`) e fica `QUEUE_KEEP_FAILED_SECONDS` se falhar. O BullMQ só limpa por idade **quando outro job termina** e as chaves **não expiram**: sem tráfego, o último job fica indefinidamente (limitação aceita na 011). Conteúdo: `text` e `echo` levam o **texto** e o `contactRef`; `notice` e `flush` levam o `contactRef`. O **id** dos jobs `text`, `notice` e `echo` é `<companyId>_<externalId codificado>` (`inboundJobId`): o `wamid`, que carrega o telefone em base64, aparece **no nome da chave**. O id de deduplicação do `flush` (`flushKey`) usa SHA-256 **sem chave** do `contactRef`: pseudonimização fraca (telefone tem pouca entropia e o hash é invertível por força bruta).
- **Log:** `REDACTED_KEYS` (`infrastructure/logger/logger.ts`) cobre segredos, `email`, credenciais do canal e do checkout e tokens de convite; **não** cobre `contactRef`, `content`, `text`, `persona`, `customerLabel`, `phone`, `from`, `to` (a regra é "não pôr no log", sem rede de segurança). Também não cobre `ANTHROPIC_API_KEY` nem `METRICS_TOKEN` pelo nome (o `apiKey` genérico não pega o nome em maiúsculas). Métricas: nenhum label com id ou dado pessoal.
- **Contato no navegador:** as rotas de leitura de conversas (`attendance.controller.ts`), de notificações (`notifications.controller.ts`) e da agenda (`schedule.controller.ts`) **não devolvem** `contactRef`, `externalId` nem `channelMessageId`; o contato sai como `contactLabel` mascarado (`describeContact`, 024). Qualquer rota nova desta spec **mantém** essa regra.
- **IP:** a aplicação só usa o IP no rate limit (`infrastructure/http/rate-limit/`; chave no Redis com TTL da janela do perfil). Não grava IP nem user-agent no banco.
- **Fora da aplicação, no servidor (não está no repositório, logo não conferido):** o nginx grava log de acesso com IP, caminho **e query string** (no padrão do nginx). Isso inclui o `hub.verify_token` do handshake do WhatsApp e o caminho do webhook da InfinitePay, que leva `orderId` e **token** (`/webhooks/infinitepay/:orderId/:token`, 031). O PM2 grava o `stdout` do Pino em arquivo; o `deploy/ecosystem.config.cjs` **não** configura rotação, e não se sabe se o `pm2-logrotate` está instalado.
- **Cópias do banco:** (a) antes de migration, `/usr/local/sbin/soprei-predeploy-backup` (exemplo em `deploy/backup/soprei-predeploy-backup.example`): `pg_dump -Fc` **sem criptografia**, em `/var/backups/soprei-predeploy/`, guarda as **3 últimas, sem limite de idade** (se os deploys com migration forem raros, uma cópia pode ter meses); (b) backup diário em `/root/backups` por `soprei-backup.sh`, que **não está no repositório**: retenção, horário e criptografia **não conferidos**. Nenhuma cópia fora do servidor (033).
- **Site:** não há página de privacidade, termos nem exclusão; o `App.tsx` (página inicial) tem rodapé sem esses links. O nginx (`deploy/nginx/production.conf.example`) serve `try_files $uri /index.html` (toda rota desconhecida cai no SPA). O `style.css` importa as fontes **do Google Fonts** (`fonts.googleapis.com`): todo visitante envia o IP ao Google. O SDK do Facebook só é carregado na tela do canal, depois do clique (023). O `localStorage` guarda só `soprei-theme`; o cookie é só `soprei_session` (`HttpOnly`, `SameSite=Strict`, até 30 dias).
- **Cadastro:** `POST /auth/register` (`{ email, password }`, `strict`) e `POST /auth/invitations/accept-new` (`{ token, password }`) não registram aceite de termos. `accounts` não tem coluna para isso.

### Inventário de dados pessoais (o E3 o transforma em código e o E10 em documento)

| Onde | Dado | Categoria | Observação |
| --- | --- | --- | --- |
| `conversations.contact_ref` | telefone (`wa_id`) do contato; texto livre no simulador | direto | chave de agrupamento; nunca em log, label nem navegador |
| `conversations.ai_paused_until`, `ai_ignore_before` (039) | instantes da pausa da IA por contato | indireto | mostra quando a equipe atendeu pelo celular; some com a conversa |
| `messages.content` (`USER`, `ASSISTANT`, `HUMAN`) | texto do contato, resposta da IA e texto que a **equipe** enviou pelo aplicativo WhatsApp Business (039) | direto, **pode ser sensível** (saúde, finanças) | maior volume e maior risco; mídia do eco vira texto fixo, a mídia nunca é baixada |
| `messages.external_id`, `channel_message_id` | `wamid` (telefone em base64) | direto | não sai da API desde a 024 |
| `notifications` (038) | ids de conversa, mensagem e vínculo, motivo em enum | indireto | sem texto; FK `NO ACTION` para conversa e mensagem |
| `appointments.customer_label`, `contact_ref`, `starts_at` | nome (até 60), telefone, horário | direto | sem campo de motivo (027) |
| `accounts.email`, `memberships.email`, `platform_admins.email` | e-mail de quem entra no site | direto | hashes de senha e de códigos são segredo, não dado legível |
| `accounts.terms_*` (E2, novo) | versão e data do aceite | indireto | sem IP nem user-agent |
| `company_invitations.email` | e-mail do convidado | direto | só em convite `PENDING` (CHECK) |
| `companies.name`, `persona`, `slug` | dado da empresa; persona é texto livre | eventual | a empresa pode colar nome de pessoa |
| `knowledge_documents`, `knowledge_chunks`, `products`, `schedule_services` | texto e nomes cadastrados pela empresa | eventual | o aviso da 026 pede não pôr dado pessoal |
| `channel_connections` | token e PIN cifrados, `wabaId` | segredo e dado da empresa | cifrado (015) |
| `audit_events` | ids de vínculo, papel, ação | pseudonimizado | aponta (`Restrict`) para `memberships` e `company_invitations` |
| `stock_movements`, `knowledge_documents.created_by_membership_id`, `appointments.created_by_membership_id` | id de quem agiu | pseudonimizado | aponta (`Restrict`) para `memberships` |
| `subscriptions`, `payment_orders`, `usage_counters`, `payment_notices` (031) | valor, referência da transação, período, consumo | indireto, **fiscal** | ligado à conta; retenção por lei (S6, J) |
| Redis `channel-inbound` | texto e `contactRef` (`text`, `echo`); `contactRef` (`notice`, `flush`); `wamid` no id do job | direto | **sem prazo real** hoje (E4) |
| Redis sessões e geração da conta | ids de conta e vínculo, hash do refresh | indireto | TTL até 30 dias (31 na geração) |
| Redis contadores (`login-fail`, `invite-quota`, `sched-ai-quota`) | HMAC de e-mail ou contato | pseudonimizado | TTL até 24 h |
| Redis rate limit | IP | direto | TTL até a janela do perfil |
| Log do processo (PM2) | ids, resultado, duração; **sem** conteúdo, telefone, e-mail | indireto | rotação não conferida (D13) |
| Log de acesso do nginx | IP, caminho, query, user-agent; **inclui o token do webhook da InfinitePay e o `hub.verify_token`** | direto e segredo | fora do repositório (D13) |
| Cópias do banco (antes de migration e diária) | **tudo** acima | direto | sem criptografia; sem limite de idade na pré-migration (D8) |
| Terceiros | Anthropic, Meta (WhatsApp e o SDK na tela do canal), InfinitePay, provedor de SMTP, Hetzner, Cloudflare (só DNS), Google Fonts | direto | ver "Provedores" |

### Papéis e base legal (recomendação; pendência jurídica J1)

- **Contato** (quem escreve no WhatsApp): a **empresa que usa o Soprei é a controladora**; o **Soprei é operador** e usa **suboperadores** (Anthropic, Meta, hospedagem, SMTP). O mesmo vale para o texto que a equipe envia pelo aplicativo (039).
- **Quem entra no site** (e-mail, senha, vínculos, aceite) e **o pagamento**: o **Soprei é controlador**.
- Bases a levar ao advogado: execução de contrato (conta, cobrança), legítimo interesse (segurança, prevenção a abuso), obrigação legal (guarda fiscal); para o contato, a base é **da empresa**. **Nenhuma decisão é tomada aqui.**
- Entregáveis do dono e do advogado: revisão dos Anexos A, B e C, **aditivo de tratamento de dados** (operador), indicação do **encarregado**, RIPD (se o advogado pedir) e registro das operações (E10).

### Etapas (cada uma é um PR; a ordem é a pedida pelo dono em 2026-11-12)

| Bloco | Etapa | O que entrega | Migration | Corta? |
| --- | --- | --- | --- | --- |
| 0 | **E0** | Conferências externas e jurídicas (sem código; o dono) | não | não |
| 1, destrava a Meta | **E1** | Páginas públicas `/privacidade`, `/termos`, `/exclusao-de-dados` com os textos versionados (Anexos A a C) | não | não |
| 1 | **E2** | Aceite dos termos no cadastro e no convite, versão gravada, nova aceitação quando a versão muda | sim (aditiva) | não |
| 2, antes de volume real | **E3** | Inventário como código (`DATA_INVENTORY`) e rede de segurança no log | não | não |
| 2 | **E4** | Limpeza periódica dos jobs do Redis com prazo real | não | não |
| 2 | **E5** | Expurgo por retenção (conversas e mensagens, agendamentos) com `dry-run`; idade máxima das cópias pré-migration | sim (índice) | pode adiar os prazos, não o mecanismo |
| 3, direitos | **E6** | Exportar e apagar os dados de um contato, registro de exclusões, `privacy:replay` | sim (tabela) | sim (no começo a empresa pede por e-mail) |
| 3 | **E7** | Excluir a própria conta | não | sim |
| 3 | **E8** | Excluir a própria empresa (carência, restauração, expurgo definitivo) | sim (coluna) | sim |
| extra | **E9** | Aviso de IA na primeira resposta ao contato | não | sim (D14) |
| extra | **E10** | Documentos operacionais: inventário, plano de incidente, registro das operações | não | não |

E1 e E2 não dependem do E0 para o código, mas a **publicação** depende das decisões D1 e D2. E3 vem antes de E4 a E8 porque o teste de exaustividade do inventário é usado por eles.

#### E0 — Passo zero (conferência; nada de código; o dono faz ou passa os textos)

- **S1 (Anthropic):** se a API comercial **não treina** com o conteúdo por padrão, quanto tempo retém entradas e saídas, se há retenção zero (ZDR) por contrato, onde processa, lista de subprocessadores.
- **S2 (Meta):** (a) se a URL de política de privacidade é **obrigatória** para o modo Live e a de termos é **opcional**; (b) o que o campo **"URL de instruções de exclusão de dados"** aceita (página de instruções **ou** callback `signed_request`) e se vale para app só de WhatsApp; (c) **se o verificador da Meta executa JavaScript** ao validar as URLs (se não executar, uma rota só do SPA aparece vazia; ver D1); (d) prazo que a Meta cobra para a exclusão; (e) termos do WhatsApp Business Platform e do Tech Provider.
- **S3 (InfinitePay):** quais dados do pagador ficam com ela e quais chegam ao Soprei (esperado: referência, valor, forma de pagamento; o checkout é hospedado, 031) e o efeito de `CHECKOUT_SEND_CUSTOMER_EMAIL`.
- **S4 (SMTP e hospedagem):** **respondido pelo dono em 2026-11-12:** o SMTP de produção é o **Gmail**; o servidor é o da Hetzner em **Helsinque, Finlândia** (`hel1`, pelo nome do servidor). Falta conferir: se a conta do Gmail é Google Workspace (com termos de tratamento de dados para empresa) ou pessoal (os termos do Gmail pessoal não preveem envio por um serviço para terceiros: considerar Workspace ou um provedor transacional antes de empresas reais), a retenção do Google e o acordo de tratamento de dados (DPA) da Hetzner.
- **S5 (lei):** prazo de comunicação de incidente à ANPD (fala-se em **3 dias úteis** pela regulamentação de 2024: suposição) e o que o advogado exige para transferência internacional (EUA, Europa).
- **S6 (fiscal):** por quanto tempo guardar registro de cobrança (esperado 5 anos: suposição).
- **S7 (BullMQ):** nome e limites da API de limpeza por idade da versão instalada (o implementer confere no código do pacote).
- **S8 (WhatsApp):** o `wa_id` brasileiro pode vir com ou sem o nono dígito (a 039 já tratou `wa_id` de 12 dígitos no eco): a busca por telefone precisa das duas formas.
- **S9 (Google Fonts):** se o advogado considera o envio do IP ao Google aceitável com aviso, ou se exige auto-hospedagem (D5).
- **J1 a J5 (advogado):** papéis, bases legais, aditivo de operador, revisão dos Anexos A, B e C (cláusulas de responsabilidade, reembolso, reajuste, foro), necessidade de RIPD.
- **Campos que só o dono tem** (marcados `[PREENCHER: ...]` nos anexos): razão social, CNPJ, endereço, nome e e-mail do encarregado, e-mail de contato de privacidade, foro (o país do data center e o provedor de SMTP já foram respondidos, S4).

#### E1 — Páginas públicas e textos versionados

**Endereços** (recomendação D1): `https://www.soprei.com/privacidade`, `/termos` e `/exclusao-de-dados`, **sem login**. As mesmas URLs vão nos campos do app da Meta: "URL da Política de Privacidade", "URL dos Termos de Serviço" e "URL de instruções de exclusão de dados de usuários".

**Onde ficam os textos:** três arquivos versionados no repositório, `frontend/src/legal/privacidade.md`, `termos.md` e `exclusao-de-dados.md`, com o conteúdo dos Anexos A, B e C. Cada arquivo começa com um cabeçalho entre linhas `---`:

```
---
titulo: Política de Privacidade
versao: 1
atualizado-em: 2026-11-12
situacao: rascunho
---
```

- `versao`: inteiro, sobe **só** em mudança relevante (a que exige novo aceite, D4). Correção de redação muda só `atualizado-em`.
- `atualizado-em`: `AAAA-MM-DD`; a página mostra "Última atualização: 12/11/2026" (montado a partir do texto, **sem conversão de fuso**) e "Versão 1".
- `situacao`: `rascunho` ou `vigente`. Com `rascunho`, a página mostra uma faixa fixa: "Texto preliminar, em revisão. Pode mudar." **Um teste falha se um arquivo `vigente` ainda contiver `[PREENCHER` ou `[CONFERIR`**; em `rascunho` os marcadores aparecem destacados na página.
- Formato do texto: um **subconjunto fixo de Markdown** (`#`, `##`, `###`, parágrafos, listas com `-`, `**negrito**`, links `[texto](url)` só com `https://`, `mailto:` ou caminho que começa com `/`, e tabelas simples). Interpretado por uma função pura própria (`frontend/src/legal/legal-markdown.ts`), **sem dependência nova** e **sem HTML cru**: todo `<`, `>`, `&` e aspas é escapado; sintaxe fora do subconjunto sai como texto; link com outro esquema (`javascript:`, `data:`) vira texto.

**Como a página é servida** (recomendação D1): **HTML estático gerado no build**, legível **sem JavaScript**. Um plugin pequeno no `frontend/vite.config.ts` (sem dependência) lê os três arquivos, usa a mesma função de interpretação e grava `dist/privacidade.html`, `dist/termos.html` e `dist/exclusao-de-dados.html` com o CSS do site, o mesmo script de tema do `index.html` (lê só `soprei-theme`) e nenhum outro script. Em desenvolvimento, o plugin serve as mesmas páginas. O nginx passa a tentar `$uri.html` antes do SPA: `try_files $uri $uri.html /index.html;` (o implementer atualiza `deploy/nginx/production.conf.example` e `staging.conf.example`; **no servidor, o dono aplica**). As páginas **não chamam a API**, não gravam nada no navegador e não carregam o SDK do Facebook.

**Links para as páginas:** rodapé da página inicial (`App.tsx`), telas de conta (`/entrar`, `/criar-conta`, `/recuperar-senha`, `/convite`), o texto da caixa de aceite (E2) e o menu do painel ("Privacidade e termos", link simples).

**Fontes (D5):** recomendação de copiar os arquivos `woff2` das fontes DM Sans e Manrope (licença OFL) para `frontend/public/fonts/`, com `@font-face` local, e retirar o `@import` do Google Fonts. Assim a política não precisa declarar o Google. O aviso de licença vai para o `NOTICE.md` do frontend.

**Passos do dono (fora do código):** aplicar o `try_files` no nginx de produção e de staging; preencher os campos `[PREENCHER]`; levar os textos ao advogado; mudar `situacao` para `vigente` quando ele aprovar (um PR); preencher os três campos no app da Meta.

#### E2 — Aceite dos termos

- **Versão vigente no servidor:** `CURRENT_TERMS_VERSION` (inteiro) em `backend/src/domain/legal.ts`. Um teste do backend lê o cabeçalho de `frontend/src/legal/termos.md` e falha se `versao` for diferente (o mesmo tipo de teste que já lê arquivos de fora do backend, como `ci-workflow.test.ts`).
- **Migration aditiva** `accounts.terms_version smallint NULL` e `accounts.terms_accepted_at timestamptz NULL`, com CHECK "os dois nulos ou os dois preenchidos" e `terms_version >= 1`. Compatível com a versão anterior do código: o `INSERT` cru do cadastro (`PrismaAccountRepository.register`) não cita as colunas e grava nulo nas duas, o que o CHECK aceita.
- **Cadastro:** `POST /auth/register` passa a exigir `{ email, password, acceptedTermsVersion }` (`strict`). Sem o campo: 400 de validação (antes de qualquer consulta; não depende de a conta existir). Versão diferente da vigente: 409 `TERMS_OUTDATED` (o site recarrega o texto), também **antes** de qualquer consulta, então nada é enumerado. Conta nova grava a versão e `now()` no mesmo `INSERT`; cadastro repetido de conta **não confirmada** atualiza a versão e a data no mesmo `UPDATE` que já substitui a senha; conta **confirmada** não muda nada e recebe o mesmo 202 de sempre.
- **Convite:** `POST /auth/invitations/accept-new` exige `{ token, password, acceptedTermsVersion }`; a falha de versão é 409 `TERMS_OUTDATED` **antes** da conferência do token (não revela nada do convite). A conta criada (ou a não confirmada que é confirmada e tem a senha substituída) grava a versão na mesma transação. O `accept` (conta já existente e logada) não muda: a conta passa pela regra das contas antigas abaixo.
- **Contas antigas e mudança de versão** (recomendação D4): `GET /auth/session` passa a devolver `terms: { acceptedVersion: number | null, currentVersion: number }`. Se `acceptedVersion` é nulo ou menor, o site mostra, depois do login e **antes** de montar o painel, uma tela "Atualizamos os Termos de Uso" com links para os termos e a política, a caixa de aceite e "Sair". Nada do painel é carregado nem chamado antes do aceite. `POST /account/terms/accept` (`{ version }`, `strict`, cookie da conta, `Origin` + `X-Soprei-App: web`, perfil `admin`, 204, idempotente) grava a versão e a data **só para a frente** (`WHERE terms_version IS NULL OR terms_version < $1`); versão diferente da vigente é 409 `TERMS_OUTDATED`. O servidor **não** bloqueia as outras rotas por falta de aceite (só o site), para não mudar a autorização de todas as rotas de uma vez (alternativa na D4).
- **Site:** caixa "Li e aceito os [Termos de Uso](/termos) e estou ciente da [Política de Privacidade](/privacidade)" em `/criar-conta` e no formulário de conta nova do `/convite`; o botão fica desabilitado sem a caixa marcada; o site envia a versão que ele mostrou (lida do mesmo arquivo `termos.md` no build). Nada disso vai ao `localStorage`, URL ou título.
- **O que não se grava:** IP, user-agent e o texto aceito (o texto está no Git, pela versão). `PlatformAdmin` não aceita termos por esta rota.
- **Métrica:** `account_terms_acceptances_total{source}` (`register`, `invite`, `update`). Log só com o resultado e a versão; nunca e-mail.

#### E3 — Inventário como código e rede de segurança no log

- `backend/src/domain/data-inventory.ts`: `DATA_INVENTORY` com uma entrada por model, tipado como `Record<keyof typeof MODEL_SCOPES, InventoryEntry>` (`personal: 'none' | 'indirect' | 'direct'`, `fields`, `retention`, `erasure`), então **model novo sem entrada não compila** (o `MODEL_SCOPES` já é exaustivo pelo Prisma). Como o `domain` não importa da `infrastructure`, o tipo das chaves é uma lista de nomes no próprio `domain` e um teste da `infrastructure` confere que as duas listas são iguais.
- `REDACTED_KEYS` ganha `contactRef`, `customerLabel`, `content`, `text`, `persona`, `phone`, `from`, `to`, `ANTHROPIC_API_KEY` e `METRICS_TOKEN`. Antes, o implementer procura logs que usem esses nomes para outra coisa (por exemplo `{ from, to }` de transição de estado) e **renomeia o campo do log**, nunca tira o nome da lista.
- A captura de log com sentinela (`log-capture.ts`) é usada em todos os fluxos novos das etapas E4 a E8.

#### E4 — Limpeza periódica dos jobs do Redis (fecha a limitação da 011)

- `InboundQueueJanitor` (porta em `application/ports/`, adaptador em `infrastructure/queue/`) remove da fila `channel-inbound` os jobs **concluídos** mais velhos que `QUEUE_KEEP_COMPLETED_SECONDS` e os **falhos** mais velhos que `QUEUE_KEEP_FAILED_SECONDS`, em lotes (API de limpeza por idade do BullMQ, S7), **sem** tocar em job ativo, esperando ou atrasado (o `flush` agendado é "atrasado" e nunca pode ser removido). Vale para `text`, `notice`, `echo` e `flush`.
- **Timer próprio** (o padrão da 031): `startPurgeTimer` com `QUEUE_CLEAN_INTERVAL_MINUTES` (padrão 15; `0` desliga só ele), ligado só com `WHATSAPP_ENABLED=true`, independente de `ACCOUNTS_ENABLED`, parado e esperado no `closeInfrastructure`. Quando a `PROCESS_ROLE` da 034 existir, roda só nos papéis que têm o worker.
- `QUEUE_KEEP_FAILED_SECONDS` passa a ter **teto de 7 dias** (604800) e `QUEUE_KEEP_COMPLETED_SECONDS` teto de 1 dia; a regra passa a ser retenção **máxima**. Um `.env` de produção com valor acima do teto é recusado pelo `config:check` **antes** da migration (deploy sai com 2, nada trocado): o dono confere o `.env` antes.
- Métricas: `queue_janitor_runs_total{result}` e `queue_janitor_removed_total{state}`. Erro do Redis só por `describeRedisError`.

#### E5 — Expurgo por retenção

Mesmo desenho dos expurgos da 021 e da 025: SQL cru **só** em `infrastructure/database/`, CTE `MATERIALIZED` com `FOR UPDATE SKIP LOCKED`, **predicado repetido** no `DELETE`/`UPDATE`, lotes de 100 e até 10 por execução, sem sobreposição, `unref`. **Timer próprio** `RETENTION_INTERVAL_MINUTES` (padrão 60; `0` desliga só ele), ligado com `RETENTION_ENABLED=true`, independente de `ACCOUNTS_ENABLED`.

- **Alvo 1, conversas:** apaga as conversas com `updated_at` (última atividade, 024; a mensagem `HUMAN` também a atualiza) anterior a `RETENTION_MESSAGES_DAYS`, numa transação por lote, nesta ordem: as `notifications` dessas conversas (FK `NO ACTION` para conversa e mensagem), as mensagens (um único `DELETE` por lote: as FKs `(reply_to_id, company_id)` e `(answered_by_id, company_id)` são `NO ACTION` e são conferidas no fim da instrução; o teste prova) e as conversas. A pausa (`ai_paused_until`, `ai_ignore_before`) some junto. **Mudança em relação ao rascunho anterior:** conversa com mensagem pendente **também** é apagada; com o mínimo de 30 dias de retenção, não existe resposta em andamento para uma conversa parada há tanto tempo, e a exceção deixaria dado guardado para sempre.
- **Alvo 2, agendamentos:** `UPDATE` que anula `customer_label` e `contact_ref` dos agendamentos com `ends_at` anterior a `RETENTION_APPOINTMENT_PII_DAYS` e estado `CANCELLED`, `COMPLETED` ou `NO_SHOW` (nunca `PENDING`/`CONFIRMED`). A linha continua. Os CHECKs da 027 aceitam os dois nulos (conferido na migration `20261105100000_schedule_appointments`) e o `EXCLUDE` só olha `PENDING`/`CONFIRMED`.
- **Fora desta etapa:** vínculos e contas inativos (D10; não há `last_login_at`); auditoria (D9; sai com a empresa na E8); `subscriptions` e afins (fiscal).
- **Modo seguro:** `RETENTION_DRY_RUN=true` só conta e loga quantos seriam apagados. **Padrão `true`** em todos os ambientes; o dono desliga em produção depois de ver os números. Com `NODE_ENV=production`, `RETENTION_ENABLED=false` é recusado (mesmo padrão de `RATE_LIMIT_ENABLED`). Métricas `retention_purge_runs_total{target,result}` e `retention_purged_total{target}`; log só com contagens.
- **Config (D8):** `RETENTION_ENABLED`, `RETENTION_DRY_RUN`, `RETENTION_INTERVAL_MINUTES`, `RETENTION_MESSAGES_DAYS` (padrão 365; 30 a 3650), `RETENTION_APPOINTMENT_PII_DAYS` (padrão 365; 30 a 3650), todas em `.env.example`.
- **Migration:** índice só em `conversations (updated_at, id)` para achar candidatas sem varrer a tabela (o índice existente começa por `company_id`). Aditiva; não apaga nada ao aplicar.
- **Cópias pré-migration:** o exemplo `deploy/backup/soprei-predeploy-backup.example` passa a apagar também as cópias com mais de `D8` dias (recomendado 35), além de manter no máximo 3. **No servidor, o dono reinstala o script.** O backup diário (`soprei-backup.sh`, fora do repositório) segue a mesma regra por decisão do dono (D8) e a 033.

#### E6 — Direitos do contato no painel (exportar e apagar)

A empresa é a controladora; o Soprei dá a **ferramenta**. Permissão nova `privacy:manage` (**OWNER e ADMIN**, no mapa fixo de `domain/permissions.ts`), perfil `admin`, `requirePermission('privacy:manage', { companyParam: 'companyId' })` (401, 403 plataforma, 404, 403).

- `POST /admin/companies/:companyId/privacy/contacts/lookup` `{ phone }` -> `{ matches: [{ conversationId, contactLabel, channel, messageCount, lastActivityAt }] }`. O telefone é normalizado (só dígitos, 8 a 15) e **comparado no servidor**, com e sem o nono dígito (S8); nunca é devolvido nem logado. A busca é **sempre dentro da empresa da identidade**.
- `GET /admin/companies/:companyId/privacy/conversations/:conversationId/export` -> JSON (`Content-Disposition: attachment`, `Cache-Control: no-store`): conversa (rótulo mascarado), mensagens (`role` com `USER` "Contato", `ASSISTANT` "Assistente", `HUMAN` "Equipe (pelo celular)"; `content`, `createdAt`, `sentAt`, `isFallback`) e agendamentos com o mesmo `contactRef` (`localDate`, `localStart`, nome do serviço, `customerLabel`, estado). **Sem** `contactRef`, `externalId`, `channelMessageId`, ids de vínculo nem estado da pausa. Teto de 5.000 mensagens (acima: 413 `EXPORT_TOO_LARGE`).
- `POST /admin/companies/:companyId/privacy/conversations/:conversationId/erase` (`{ confirm: true }`, `strict`, 204, idempotente): na mesma transação apaga as notificações, as mensagens (inclusive `HUMAN`) e a conversa, anonimiza os agendamentos desse `contactRef` (como o alvo 2, em qualquer estado, exceto `PENDING`/`CONFIRMED` **futuros**, que perdem o `customer_label` e o `contact_ref` mas continuam bloqueando o horário) e grava o registro de exclusão. Depois do commit, remove da fila o `flush` desse contato (pela deduplicação de `flushKey`); Redis fora vira log de erro (melhor esforço).
- **Registro de exclusões** (`ErasureRecord`, tabela `erasure_records`, model de **tenant**, FK composta para `companies`): `id`, `companyId`, `kind` (`CONTACT`), `subjectHmac` (HMAC-SHA256 do `contactRef` com chave derivada do `JWT_SECRET` e rótulo `soprei:erasure:v1`), `createdAt`. Sem telefone nem texto. Serve para **reaplicar a exclusão depois de restaurar uma cópia**: `pnpm privacy:replay` (CLI local, como o `auth:cli`) calcula o HMAC dos `contact_ref` de cada empresa e apaga/anonimiza o que reaparecer. Expurgo do próprio registro depois de `RETENTION_ERASURE_LEDGER_DAYS` (padrão 60, maior que a idade máxima das cópias).
- **Depois de apagar:** mensagem nova do contato cria uma conversa nova, **sem pausa** (a IA volta a responder até a equipe responder de novo pelo celular). Job `text` ou `echo` já aceito e ainda não processado pode recriar a conversa (segundos); jobs concluídos ainda guardam o texto no Redis até a limpeza da E4 (até `QUEUE_KEEP_COMPLETED_SECONDS`). As duas limitações vão para o texto da página de exclusão.
- **Site (aba "Privacidade", só com `privacy:manage`):** campo de telefone, resultado mascarado, "Exportar" e "Apagar dados deste contato" (`ConfirmDialog` dizendo o que some). Telefone só em memória, limpo ao enviar; nada em `localStorage`, URL, título ou `console`; mensagens por `status` e `error.code`; pares de contraste em `contrast.test.ts`.
- Pedido de contato que chega **ao Soprei**: o Soprei **encaminha** à empresa (operador) e não age sozinho sobre dado de contato (J1).

#### E7 — Excluir a própria conta

- `POST /account/delete` (`{ password }`, `strict`, cookie da conta, `Origin` + `X-Soprei-App`, perfil `login`, fail-closed, 204; só com `ACCOUNTS_ENABLED`). Senha errada: a mesma 401 do login, contando no bloqueio por conta.
- Recusas: 409 `COMPANY_OWNERSHIP` se a conta é a **única `OWNER` ativa** de alguma empresa não removida (transferir ou excluir a empresa antes); 409 `SUBSCRIPTION_ACTIVE` se há período pago em vigor sem `cancelAtPeriodEnd` (D15).
- Efeito: revoga **todas** as sessões (`revokeAll`, 503 sem nada alterado se o Redis falhar); na transação, **anonimiza** (não apaga: auditoria e outros registros apontam para os vínculos): `accounts.email` vira `removida-<uuid>@excluido.invalid`, `password_hash` vira valor inválido fixo, `status = DISABLED`, `last_company_id`, códigos e contadores nulos/zerados; `memberships` da conta com o mesmo e-mail anonimizado e `DISABLED`; o aceite dos termos fica (sem dado pessoal). Revoga de novo depois do commit. O e-mail "Conta excluída" (sem código nem link) vai para o endereço lido **antes** da transação, em segundo plano.
- O e-mail original fica livre para um cadastro novo, que não herda nada. `subscriptions` e `payment_orders` ficam ligados à conta anonimizada (fiscal).
- Site: "Excluir minha conta" na tela de empresas da conta, com `ConfirmDialog`.

#### E8 — Excluir a própria empresa

- Permissão nova `company:delete` (**só OWNER**). Rota `POST /admin/companies/:companyId/deletion` (`{ password, slug }`, `strict`, perfil `admin`, 202; só com `ACCOUNTS_ENABLED`): senha da conta do cookie e slug digitado conferidos (errado = 400 `CONFIRMATION_MISMATCH` sem efeito). **Não** usa `DELETE /admin/companies/:companyId`, que é a rota do `PlatformAdmin`.
- Efeito: reusa `CompanyRepository.remove` (soft delete, número liberado, `ChannelConnection` apagada), desassina o app da WABA em melhor esforço (como o `DELETE .../channel`), grava `companies.purge_after = now + RETENTION_COMPANY_GRACE_DAYS` (padrão 30; coluna nova, aditiva e anulável). O `DELETE` do `PlatformAdmin` passa a gravar o mesmo `purge_after`.
- **Restauração** dentro da carência: `POST /admin/companies/:id/restore` (só `PlatformAdmin`): limpa `deleted_at` e `purge_after`; o canal precisa ser reconectado.
- **Expurgo definitivo** (`CompanyHardPurger`, no timer da E5): depois de `purge_after`, apaga em lotes as mensagens (e antes as notificações), depois numa transação final, na ordem de `test-support/tenant-fixtures.ts`: notificações restantes, auditoria, convites, agendamentos, regras, serviços, recursos, configurações da agenda, movimentos e produtos, trechos e documentos, conexão do canal, vínculos, conversas; **anonimiza** a linha `companies` (`name` fixo "Empresa removida", `persona` nula, `slug` **continua reservado**); anula `accounts.last_company_id` que aponte para ela. **Não apaga** `subscriptions` e afins.
- Site: "Excluir esta empresa" (só OWNER) com `ConfirmDialog`, texto da carência e digitação do slug.

#### E9 — Aviso de IA ao contato (decisão D14; cortável)

A **primeira resposta da IA** de uma conversa nova leva, **depois** do texto do modelo e fora do LLM, uma frase constante: "Você está falando com o atendimento automatizado de <empresa>. Saiba como tratamos seus dados: <APP_ORIGIN>/privacidade". Nome da empresa sanitizado como no e-mail da 025; sem `APP_ORIGIN`, a frase vai sem link. Chave `CONTACT_NOTICE_ENABLED` (padrão `false`). O texto entra na mesma mensagem gravada e enviada (marcador próprio contra duplicar em retentativa), nunca no `systemPrompt` nem no histórico enviado ao modelo. Mensagem `HUMAN` anterior não conta como "primeira resposta da IA".

#### E10 — Documentos operacionais (sem código)

- `docs/lgpd/inventario-de-dados.md` (espelho da tabela acima, com os prazos aprovados), `docs/lgpd/plano-de-incidente.md` (checklist: conter com `revokeAll`, troca de segredos e suspensão do canal; avaliar pelo inventário; linha do tempo; decidir risco relevante; avisar ANPD e titulares no prazo do S5 e as **empresas controladoras** sem demora; corrigir; revisar; contatos a preencher pelo dono) e `docs/lgpd/registro-de-operacoes.md` (registro simples das operações de tratamento, J).
- `docs/context.md` ganha as decisões D1 a D15 depois da resposta do dono.

### Provedores (o que o código garante)

- **Anthropic:** recebe persona, histórico recente (até 20 mensagens e 12.000 caracteres), o texto do contato, trechos de conhecimento, produtos e horários livres; **não** recebe o telefone do contato (os montadores de prompt não usam `contactRef`; o contato pode digitar o próprio número no texto). Retenção e treinamento: S1.
- **Meta:** recebe a resposta enviada e, no Embedded Signup, o navegador de quem conecta fala com o SDK do Facebook. O conteúdo na infraestrutura da Meta e no aplicativo do celular (039) está fora do alcance do Soprei.
- **SMTP:** códigos de confirmação e de recuperação, convites, avisos de cobrança e de senha alterada; sem senha.
- **InfinitePay:** o pagador digita os dados de pagamento na página dela; o Soprei guarda referência, valor, estado e forma de pagamento; o e-mail da conta só vai com `CHECKOUT_SEND_CUSTOMER_EMAIL=true`.
- **Hetzner:** hospeda servidor, banco, Redis e cópias. **Cloudflare:** só DNS (sem proxy), não vê o conteúdo. **Google Fonts:** IP do visitante, enquanto D5 não for aplicada.

## Critérios de aceite

Cada item tem teste automatizado (unitário, e2e do site, ou integração com Postgres `soprei_test` e Redis `/15` com prefixo único), salvo os marcados **[manual]**.

**E1**
- [x] `legal-markdown.ts`: cabeçalhos, listas, negrito, tabela e links permitidos viram a estrutura esperada; `<script>`, `<img onerror>`, `javascript:` e `data:` saem como texto escapado (teste com sentinelas).
- [x] O cabeçalho de cada arquivo é validado (`versao` inteiro >= 1, `atualizado-em` data real, `situacao` em `rascunho|vigente`); arquivo inválido quebra o build.
- [x] Arquivo `vigente` com `[PREENCHER` ou `[CONFERIR` falha no teste; em `rascunho` a página mostra a faixa "Texto preliminar".
- [x] O build gera `privacidade.html`, `termos.html` e `exclusao-de-dados.html` com o texto **no HTML** (o e2e abre as três com JavaScript desligado e encontra o título e a data "Última atualização: dd/mm/aaaa").
- [x] As três páginas abrem sem sessão, não fazem nenhuma requisição a `/api`, não gravam nada em `localStorage` além do tema nem em `sessionStorage`, em 360 e 1280 px, claro e escuro, sem rolagem horizontal; pares de contraste novos em `contrast.test.ts`.
- [x] Os links existem no rodapé da página inicial, nas telas de conta e no menu do painel.
- [x] Se D5 aprovada: nenhuma requisição a `fonts.googleapis.com` ou `fonts.gstatic.com` em nenhuma página (e2e).
- [ ] **[manual]** Dono: `try_files` aplicado no nginx; `curl -s https://www.soprei.com/privacidade` devolve o texto; as três URLs aceitas no app da Meta.

**E2**
- [ ] A migration aplica em schema temporário com linhas antigas (aceite nulo) e o CHECK recusa só um dos dois preenchido.
- [ ] `CURRENT_TERMS_VERSION` igual ao `versao` de `termos.md` (teste falha se divergirem).
- [ ] Cadastro sem `acceptedTermsVersion` = 400; com versão antiga = 409 `TERMS_OUTDATED`; nos dois casos nenhuma consulta ao banco e nenhum e-mail (repositório e mailer falsos).
- [ ] Conta nova grava versão e data; cadastro repetido de conta não confirmada atualiza as duas; conta confirmada não muda (Postgres real) e a resposta é idêntica nos três casos.
- [ ] `accept-new` com versão antiga = 409 sem tocar no convite; com a versão certa grava o aceite na mesma transação.
- [ ] `GET /auth/session` traz `terms`; `POST /account/terms/accept` grava, é idempotente, nunca diminui a versão, recusa versão diferente (409) e exige cookie, `Origin` e `X-Soprei-App`.
- [ ] Site: botão desabilitado sem a caixa; conta com aceite antigo vê a tela de aceite e **nenhuma** chamada do painel acontece antes de aceitar (e2e com API falsa).
- [ ] Log e métrica sem e-mail (captura de log com sentinela).

**E3**
- [ ] `DATA_INVENTORY` cobre todos os models de `MODEL_SCOPES` (teste); model novo sem entrada quebra o `typecheck`.
- [ ] Objeto de log com cada nome novo de `REDACTED_KEYS`, na raiz e um nível abaixo, sai `[Redacted]`.
- [ ] O gate `domain-vocabulary` continua verde.

**E4**
- [ ] Com jobs `text` e `echo` concluídos velhos e novos, um falho velho e um `flush` atrasado, o `janitor` remove só os velhos e não toca em ativo, esperando nem atrasado (Redis real `/15`, prefixo único).
- [ ] Depois da limpeza, uma varredura do prefixo da fila não encontra o texto sentinela, o `contactRef` nem o `wamid` dos jobs velhos.
- [ ] Sem sobreposição; `stop()` espera a execução ativa; Redis fora = log com `describeRedisError` e `result=error`, sem derrubar o processo.
- [ ] `QUEUE_KEEP_FAILED_SECONDS` acima de 604800 e `QUEUE_KEEP_COMPLETED_SECONDS` acima de 86400 são recusados no boot e no `config:check`.

**E5**
- [ ] Duas empresas, conversas velhas e novas (com mensagens `USER`, `ASSISTANT` e `HUMAN`, uma notificação aberta e uma conversa com pausa): o purger apaga só as velhas das duas, com as mensagens e as notificações, e nunca as novas; contagens por `company_id` provam o isolamento.
- [ ] Conversa que recebe mensagem durante o expurgo não é apagada (predicado repetido); dois purgers simultâneos não se bloqueiam nem passam do lote.
- [ ] Agendamento final antigo fica com `customer_label` e `contact_ref` nulos; `PENDING`/`CONFIRMED` não mudam; `appointments_no_overlap` e os CHECKs continuam valendo.
- [ ] `RETENTION_DRY_RUN=true` não altera nenhuma linha e registra as contagens; `RETENTION_ENABLED=false` com `NODE_ENV=production` é recusado; `RETENTION_INTERVAL_MINUTES=0` não agenda; `ACCOUNTS_ENABLED=false` não impede o expurgo de mensagens.
- [ ] O `closeInfrastructure` espera a execução ativa.
- [ ] O exemplo de cópia pré-migration apaga cópias mais velhas que o limite (teste de comportamento do script com relógio de arquivo, como os de `deploy-script.behavior.test.ts`).

**E6**
- [ ] Matriz de papéis nas três rotas (OWNER e ADMIN sim; AGENT, VIEWER e `PlatformAdmin` 403; `:companyId` alheio 404 antes da permissão); rotas no inventário (`rate-limit.test.ts`) e na varredura do `site-bridge.integration.test.ts`.
- [ ] Isolamento: o mesmo telefone em duas empresas; `lookup`, `export` e `erase` de A nunca veem nem alteram B; `conversationId` de B por A = 404.
- [ ] `lookup` acha com e sem `+`, espaços, hífen e nono dígito; nenhuma resposta, log, métrica ou erro contém o telefone, o `contactRef` ou o `wamid` (sentinelas).
- [ ] `export` traz as mensagens `HUMAN` com o rótulo da equipe e os agendamentos só do contato; respeita o teto (413); cabeçalhos `no-store` e `attachment`.
- [ ] `erase` apaga notificações, mensagens e conversa, anonimiza os agendamentos, grava **um** `erasure_records` sem telefone, é idempotente e remove o `flush` pendente (Redis real).
- [ ] `privacy:replay` apaga de novo, num banco de fixture "restaurado", só a conversa listada no registro.
- [ ] Site: aba só com a permissão; telefone limpo da memória ao enviar; nada em storage, URL ou título; e2e com API falsa.

**E7**
- [ ] Senha errada = 401 uniforme sem efeito; única OWNER = 409 `COMPANY_OWNERSHIP`; período pago sem cancelamento = 409 `SUBSCRIPTION_ACTIVE`.
- [ ] Redis das sessões fora = 503 e **nada** anonimizado; sucesso anonimiza conta e vínculos, derruba as sessões, libera o e-mail para cadastro novo e a auditoria continua apontando para o vínculo anonimizado.
- [ ] O e-mail de aviso não contém código, senha nem link (mailer falso).

**E8**
- [ ] Só OWNER; senha ou slug errado = 400 sem efeito; empresa alheia = 404; `PlatformAdmin` restaura dentro da carência.
- [ ] Depois de `purge_after` (relógio injetado), todas as tabelas de tenant da empresa ficam vazias e as da empresa B intactas (contagem por tabela, usando `DATA_INVENTORY` para não esquecer nenhum model); a linha `companies` fica anonimizada com o slug reservado; `payment_orders` não muda; nenhuma FK `Restrict` bloqueia.

**E9**
- [ ] Com `CONTACT_NOTICE_ENABLED=true`, só a primeira resposta da IA de uma conversa nova leva a frase; retentativa não duplica; o pedido ao provedor não a contém (servidor falso da Anthropic); desligado, nada muda.

**E10**
- [ ] `docs/lgpd/*.md` existem e o `format:check` passa.

## Casos de borda e erros

- **Mudança da versão dos termos entre abrir o cadastro e enviar:** 409 `TERMS_OUTDATED`; o site recarrega o texto e pede o aceite de novo.
- **Página pública com marcador esquecido:** em `vigente` o build/teste falha; em `rascunho` aparece destacado.
- **Verificador da Meta sem JavaScript:** coberto pelo HTML estático (D1); se o dono escolher a rota do SPA, o risco é a Meta recusar a URL.
- **Expurgo e contato escrevendo:** o predicado repetido evita apagar conversa que acabou de receber mensagem.
- **Primeira ativação com muito dado velho:** lotes pequenos e `dry-run` antes.
- **Exclusão de contato com resposta já enviada:** o que está no WhatsApp do contato e no aplicativo da empresa não se desfaz.
- **Apagar contato em pausa (039):** a pausa some; a IA volta a responder até o próximo eco.
- **Telefone inválido (menos de 8 ou mais de 15 dígitos):** 400 sem eco do valor.
- **Redis fora na exclusão do contato:** o banco é apagado; a remoção do `flush` vira log de erro; o `flush` acha zero pendentes.
- **Cópia restaurada com dado já apagado:** `privacy:replay` e os expurgos (que rodam ~30 s depois do boot) o apagam; **o runbook proíbe reabrir o tráfego antes do replay** (033).
- **Troca do `JWT_SECRET`:** o HMAC do registro de exclusões deixa de bater; o runbook de rotação manda rodar o `replay` **antes** de trocar (risco registrado).
- **`.env` de produção com `QUEUE_KEEP_*` acima do novo teto:** o deploy para no `config:check` sem trocar nada.
- **Staging:** continua **proibido** receber dado de produção, inteiro ou parcial (037); anonimização para staging fica fora.

### Riscos

- **Apagar errado:** `dry-run` como padrão, predicado repetido, lotes, testes com duas empresas, carência de 30 dias para empresa.
- **Cópias guardam o que foi apagado:** idade máxima, registro de exclusões e `replay` obrigatório.
- **A busca por telefone é busca por dado pessoal:** só dentro da empresa, só OWNER/ADMIN, nada devolvido além do rótulo, sem log.
- **Dado sensível nas mensagens:** prazo menor e aviso (D14); enquadramento e RIPD com o advogado.
- **Texto publicado vira promessa pública:** por isso a faixa de rascunho e a revisão jurídica (D2).

## Isolamento entre empresas

As rotas de E6 e E8 usam `requirePermission` com `companyParam` e o `CompanyId` **só** da identidade; todo método novo de repositório de tenant recebe `CompanyId` primeiro e põe `companyId` no `where` (a `tenant-scope` recusa o contrário); `ErasureRecord` entra em `MODEL_SCOPES` como `tenant` com FK composta. **Os expurgos (E5, `CompanyHardPurger`) e o `privacy:replay` atravessam empresas por natureza**, como os da 021 e 025: SQL cru confinado a `infrastructure/database/`, predicado repetido e testes com duas empresas provando que só some o que venceu e só o que é dela. A busca por telefone é sempre dentro da empresa da identidade; nunca há busca global por telefone. E1, E2 e E7 não tocam em dado de tenant (E7 só anonimiza os vínculos **da própria conta**, por `account_id`; teste: vínculo de outra conta na mesma empresa não muda).

## Fora de escopo

- **Parecer jurídico** e a redação final dos textos (o advogado revisa os anexos); aditivo de operador, RIPD.
- Retenção configurável **por empresa** na tela.
- Expurgo de contas e vínculos por inatividade; expurgo de `audit_events` por tempo; imutabilidade da auditoria por gatilho ou `REVOKE`.
- Bloquear um contato (opt-out), lista de supressão, comando "pare" no WhatsApp.
- Exportação de **todos** os dados de uma empresa e exportação por faixa de datas.
- Callback assinado da Meta (`signed_request`), só se o E0 mostrar que é exigido.
- Criptografia de mensagens em repouso na aplicação e **RLS** do Postgres.
- Banner de cookies e consentimento granular (só há o cookie de sessão e o tema).
- Gravar IP ou user-agent do aceite; histórico de todas as versões aceitas (D3).
- Bloquear no **servidor** as rotas para quem não aceitou a versão nova (D4, alternativa).
- Remoção de dados nos suboperadores e no aplicativo WhatsApp Business do celular.
- Importação do histórico da coexistência (039, D6).
- Backup externo, restauração e configuração do nginx e do PM2 no servidor (033 e passos do dono; esta spec só define a regra e atualiza os exemplos).
- Dump anonimizado de produção para o staging.
- Varredura de mensagens pendentes antigas e retomada de respostas não enviadas (035).

## Decisões e dependências novas

**Sem dependência nova** (Markdown interpretado por função própria; plugin do Vite escrito no `vite.config.ts`; BullMQ, SQL cru e `node:crypto` já existem; fontes copiadas com licença OFL, sem pacote). **Migrations aditivas:** `accounts.terms_version` e `terms_accepted_at` (E2), índice em `conversations (updated_at, id)` (E5), `erasure_records` (E6), `companies.purge_after` (E8). **Variáveis novas:** `QUEUE_CLEAN_INTERVAL_MINUTES`, `RETENTION_ENABLED`, `RETENTION_DRY_RUN`, `RETENTION_INTERVAL_MINUTES`, `RETENTION_MESSAGES_DAYS`, `RETENTION_APPOINTMENT_PII_DAYS`, `RETENTION_COMPANY_GRACE_DAYS`, `RETENTION_ERASURE_LEDGER_DAYS`, `CONTACT_NOTICE_ENABLED` (todas em `.env.example` e no módulo de config). **Permissões novas:** `privacy:manage` (OWNER, ADMIN) e `company:delete` (OWNER). **Métricas novas:** `account_terms_acceptances_total`, `queue_janitor_*`, `retention_*`.

### Decisões (o dono decide; recomendação em linguagem simples)

**Aprovadas em 2026-11-12:** o dono aprovou **todas as recomendações** (D1 a D15) como escritas abaixo; as alternativas ficam só como registro.

- **D1 Como publicar as páginas.** *Recomendação:* páginas dentro do próprio site (`/privacidade`, `/termos`, `/exclusao-de-dados`), geradas como HTML pronto no build, que abrem mesmo sem JavaScript; exige uma linha a mais no nginx (`$uri.html`). *Alternativa:* rotas comuns do site (sem mexer no nginx), com o risco de o verificador da Meta não enxergar o texto (S2c).
- **D2 Publicar antes da revisão do advogado?** *Recomendação:* publicar **já** a política e as instruções de exclusão como "texto preliminar" (descrevem o que o sistema faz e destravam a Meta), e publicar os **termos** e ligar a caixa de aceite (E2) só depois da revisão, porque os termos têm cláusulas de responsabilidade e pagamento. *Alternativa:* esperar a revisão dos três antes de publicar qualquer coisa (mais seguro, atrasa a Meta).
  - **Alterada pelo dono em 2026-11-12:** sem conseguir contratar advogado, o dono revisou e aprovou os três textos ("Aprovo os textos") e decidiu publicá-los já como `vigente`, termos incluídos, aceitando o risco de não haver revisão jurídica. Cláusulas redigidas pelo agente como recomendação técnica: arrependimento de 7 dias na primeira contratação, reajuste com aviso de 30 dias, limitação de responsabilidade "na medida permitida pela lei", seção de operador nos termos (no lugar do aditivo), mudança dos termos por aviso de 30 dias até a E2 e foro de Guaratinguetá/SP com a ressalva do consumidor. Obrigações manuais do dono que os textos prometem: atender pedidos em até 15 dias, refazer exclusões ao restaurar cópia, reembolsar na InfinitePay em até 7 dias e manter os logs em até 30 dias (`pm2-logrotate`).
- **D3 Como guardar o aceite.** *Recomendação:* duas colunas na conta (versão e data do último aceite), sem IP. *Alternativa:* uma tabela com o histórico de todos os aceites (mais prova, mais código); ou guardar também o IP (mais prova, mais dado pessoal).
- **D4 Quando a versão dos termos muda.** *Recomendação:* quem já tem conta vê uma tela obrigatória no próximo acesso e só entra no painel depois de aceitar; mudança só de redação não pede novo aceite (só muda a data). *Alternativas:* aviso por e-mail com 30 dias e "continuar usando é aceitar" (sem bloqueio); ou o servidor também recusar as rotas até o aceite (mais forte, mexe em todas as rotas).
- **D5 Fontes do Google.** *Recomendação:* copiar as fontes para dentro do site, assim nenhum visitante manda o IP ao Google e a política fica mais simples. *Alternativa:* manter o Google Fonts e declarar na política (S9).
- **D6 Papéis (J1).** *Recomendação:* empresa = controladora dos dados dos contatos; Soprei = operador; Soprei controlador só de conta e cobrança. Falta o advogado confirmar e redigir o aditivo.
- **D7 Quem manda no prazo.** *Recomendação:* um prazo padrão igual para todos; a empresa pode apagar antes pela aba Privacidade. *Alternativa:* prazo escolhido por empresa já agora.
- **D8 Prazos.** *Recomendação:* conversas e mensagens (inclusive as da equipe pelo celular): **12 meses** sem atividade; nome e telefone em agendamento: **12 meses** depois do horário; jobs no Redis: **1 hora** concluídos e **24 horas** falhos, com limpeza de verdade; contas não confirmadas: **7 dias** (já existe); e-mail de convite: **7 dias** depois do vencimento (já existe); empresa excluída: **30 dias** de carência; cobrança: **5 anos** (S6); auditoria: acompanha a empresa; **cópias do banco (pré-migration e diária): 35 dias no máximo**; logs do processo e do nginx: **30 dias**. *Alternativas:* 6 meses (menos risco, menos histórico) ou 24 meses (mais histórico, mais exposição).
- **D9 Auditoria.** *Recomendação:* não apagar por tempo (só tem ids); sai junto com a empresa. *Alternativa:* guardar 24 meses mesmo depois da empresa excluída.
- **D10 Contas inativas.** *Recomendação:* deixar para depois (não medimos o último acesso). *Alternativa:* medir o último login e apagar depois de 24 meses.
- **D11 O que sobra da empresa excluída.** *Recomendação:* a linha com nome trocado e o `slug` reservado, mais a cobrança. *Alternativa:* liberar o `slug` (alguém pode pegar o nome).
- **D12 Quem exclui a empresa.** *Recomendação:* o OWNER exclui sozinho, com 30 dias para voltar atrás pelo dono da plataforma; a remoção feita pelo dono da plataforma também passa a ter o expurgo definitivo depois da carência. *Alternativa:* só o dono da plataforma exclui, por pedido por e-mail.
- **D13 Logs do servidor.** *Recomendação:* no nginx, registrar as rotas `/webhooks/` **sem** a query e sem o caminho completo do webhook de pagamento (que leva um token), e guardar os logs do nginx e do PM2 por 30 dias com rotação (passo do dono no servidor; o exemplo do nginx no repositório é atualizado na E1). *Alternativa:* desligar o log de acesso de `/webhooks/` (menos rastro para investigar problemas).
- **D14 Aviso de IA ao contato.** *Recomendação:* ligar, com a frase no fim da primeira resposta da IA (sem custo extra). *Alternativas:* mensagem separada (uma mensagem da Meta a mais por conversa) ou deixar para a persona de cada empresa.
- **D15 Excluir conta com plano pago.** *Recomendação:* só depois de cancelar a renovação; o período restante é perdido (reembolso é cláusula dos termos, J). *Alternativa:* exigir esperar o fim do período pago.

## Registro da implementação

### E1 — Páginas públicas e textos versionados (2026-11-12, Claude Code, Opus 5.5, implementer; branch `spec/032-e1-paginas-legais`)

- **Arquivos:** `frontend/src/legal/` (`privacidade.md`, `termos.md`, `exclusao-de-dados.md`, `legal-markdown.ts`, `legal-page.ts`, `LegalLinks.tsx`, `legal.test.ts`), plugin `soprei-legal-pages` em `frontend/vite.config.ts`, estilos `.legal-*` e `@font-face` em `frontend/src/style.css`, `frontend/public/fonts/` (4 `woff2` e as duas licenças OFL), `frontend/NOTICE.md` (novo), `frontend/e2e/legal.spec.ts`, pares em `frontend/src/theme/contrast.test.ts`, links em `App.tsx` (rodapé), `AccountApp.tsx` (moldura das telas de conta: `/entrar`, `/criar-conta`, `/recuperar-senha`, `/convite` e as outras sem o painel) e `company/AppShell.tsx` (rodapé do menu, "Privacidade e termos"), `deploy/nginx/production.conf.example` e `staging.conf.example`. **Nada no backend.**
- **Textos:** os três seguem `situacao: rascunho`, `versao: 1`, `atualizado-em: 2026-11-12`. `[PREENCHER: ...]` e `[CONFERIR: ...]` mantidos (destacados na página). `[DEPENDE: D#]` resolvido pelas decisões aprovadas (D5: a linha do Google Fonts saiu e entrou "as fontes são servidas pelo próprio Soprei"; D8: 12 meses, 1 h/24 h, 30 dias, 5 anos, 35 dias; carência de 5 dias da 031). `[ATUALIZAR: E#]` virou frase verdadeira **hoje**: retenção automática (E4, E5) "em implantação" e, até lá, exclusão a pedido; direitos do contato (E6) "a empresa nos encaminha o pedido e nós fazemos a exclusão"; conta e empresa (E7, E8) a pedido pelo `[PREENCHER: e-mail de privacidade]`; o aceite dos termos (E2) aparece como "quando você aceitar os Termos de Uso pelo site". Onde o prazo depende do servidor do dono (rotação de logs, limpeza das cópias), o texto ganhou `[CONFERIR: ...]` para não virar `vigente` sem o dono confirmar. A crase de código do Anexo A (`soprei_session`) saiu porque o subconjunto não tem código em linha.
- **Desvio pequeno:** o interpretador aceita também **listas numeradas** (`1. `), porque o Anexo C usa passos numerados; tudo o mais segue o subconjunto da spec (imagem `![x](url)` sai como `!` seguido de link comum, se a URL for permitida).
- **Como a página é gerada:** `parseLegalDocument` valida o cabeçalho (campos exatos, `versao` inteiro de 1 a 9999, data real, `situacao`) e **recusa `vigente` com `[PREENCHER` ou `[CONFERIR`**; o plugin chama a mesma função no build (`generateBundle`, `enforce: 'post'`: lê o CSS com hash e o script de tema do `index.html` já gerado e emite os três `.html`), então texto inválido **quebra o build**. Em desenvolvimento, um middleware responde `/privacidade`, `/termos`, `/exclusao-de-dados` (e com `.html`), relendo o arquivo a cada pedido e usando `/src/style.css` como folha de estilo. A página tem só o script de tema (extraído do `index.html`, exatamente um `<script>` sem atributo), não chama a API, não grava nada e não carrega o SDK do Facebook.
- **Fontes (D5):** `woff2` variáveis baixados do Google Fonts (`fonts.gstatic.com`, DM Sans `v17` e Manrope `v23`, subconjuntos latin e latin-ext, endereços tirados da folha de estilo oficial) e licenças do repositório `google/fonts`; hashes em `frontend/NOTICE.md`.
- **nginx (exemplos; o dono aplica):** `try_files $uri $uri.html /index.html;` e, pela D13, `map $request_uri` + `log_format` próprios (nomes distintos em produção e staging, que podem dividir o mesmo nginx) que registram o caminho **sem query** e trocam `/webhooks/infinitepay/...` por `/webhooks/infinitepay/[oculto]`, também no bloco da porta 80. Sem referer no formato. Não validado com `nginx -t` (não há nginx nesta máquina).
- **Verificado (Node 24.18.0):** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` (gera `dist/privacidade.html`, `termos.html`, `exclusao-de-dados.html` e `dist/fonts/`); `src/legal/legal.test.ts` (43 testes), `src/theme/contrast.test.ts` (12) e `src/App.test.tsx` (2); `e2e/legal.spec.ts` (17 passaram, 9 pulados de propósito no projeto `mobile`, que repetiria as larguras fixadas no teste). O e2e roda contra o servidor de desenvolvimento (o mesmo `renderLegalPage`); o HTML do build foi conferido à mão no `vite preview` a 360 px no tema escuro (sem rolagem horizontal; tabela com rolagem própria).
- **Não verificado:** suíte completa de unitários e de Playwright (fica para o CI); `nginx -t` dos exemplos; o verificador da Meta (S2c); aparência a 1280 px no navegador além do teste automatizado.
- **Correções da revisão (2026-11-12, mesmo dia):** (1) os textos deixaram de prometer o que só existirá nas etapas E4 a E8 (reaplicar exclusões depois de restaurar cópia, apagar conversa recriada no meio da exclusão, anonimizar conta, limpar jobs): hoje toda exclusão é **manual** pelo dono, e as frases que dependem de etapa futura levam `[CONFERIR: E4]` a `[CONFERIR: E8]`; o aceite leva `[CONFERIR: E2]` na política e nos termos. (2) **D2 implementada:** `LEGAL_PAGES[].publishDraft` (política e exclusão `true`, termos `false`) e `isPublished`; o build (`buildLegalPages`) **não gera `termos.html`** enquanto `termos.md` estiver em `rascunho`, a navegação das páginas não aponta para ele, e o plugin define `import.meta.env.SOPREI_LEGAL_PUBLISHED` (endereços publicados, lidos dos textos) que `LegalLinks.tsx` usa: sem os termos vigentes, não há link "Termos de Uso" e o rótulo do grupo e do menu do painel é "Privacidade" (com eles, "Privacidade e termos"). Fora do Vite (testes no Node) vale o conservador (sem termos). O servidor de desenvolvimento continua servindo `/termos` para revisão. (3) Os exemplos do nginx avisam que o `error.log` ainda pode guardar o token do webhook e o `hub.verify_token` e entram na rotação de 30 dias. (4) O teste unitário chama `buildLegalPages` com os textos do repositório (política e exclusão com "Última atualização:", sem `termos.html` em rascunho) e com termos vigentes simulados. (5) `PENDING_MARKER` passou a pegar `[PREENCHER`, `[CONFERIR`, `[DEPENDE` e `[ATUALIZAR`, sem distinção de maiúsculas e com espaço depois do colchete. Verificado de novo: typecheck, lint, format:check, build (gera só `privacidade.html` e `exclusao-de-dados.html`; o bundle traz `"/privacidade,/exclusao-de-dados"`), `legal.test.ts` (47), `App.test.tsx` (2) e `e2e/legal.spec.ts` (17 passaram, 9 pulados). O `ci.yml` não mudou.
- **Pendências do dono:** aplicar o `try_files` e o log da D13 no nginx de produção e de staging (e a rotação de 30 dias); preencher os `[PREENCHER]`; levar os três textos ao advogado e resolver os `[CONFERIR]`; trocar `situacao` para `vigente` num PR; preencher no app da Meta a política e a exclusão de dados; **o campo "Termos de Serviço" fica vazio até `termos.md` ficar `vigente`** (D2: até lá `/termos` não existe no build). Enquanto E7 e E8 não existem, a exclusão de conta e de empresa pedida por e-mail é feita **à mão** pelo dono.

### E7 — Excluir a própria conta (2026-11-27, Claude Code, Opus 5.5, implementer; branch `spec/032-e7-excluir-conta`)

- **Reaproveita o núcleo da spec 045 (E6):** `AccountAnonymizer` faz as recusas, o `revokeAll` antes e depois, a transação (empresas -> conta -> assinatura), a anonimização de conta e vínculos, a revogação das sessões Bearer de cada vínculo e o aviso "conta excluída" (só para conta confirmada) ao endereço lido antes. Sem migration e sem SQL novo.
- **Backend:** `AccountService.deleteAccount(cookie, senha)`: lê a sessão do cookie (conta ativa e confirmada, senão 401), confere a senha pelo **mesmo** caminho do login (`credentials`: bloqueio por conta, a mesma 401 `Credenciais inválidas`, 429 quando bloqueado; o sucesso zera o contador) e chama o núcleo, sem trilha da plataforma. Rota `POST /account/delete` `{ password }` (`strict`, `Origin` e `X-Soprei-App: web` pelo hook do plugin, perfil `login`, fail-closed), 204 com o cookie limpo; 401, 409 e 503 mantêm o cookie. Sem o núcleo ligado, 404. O núcleo passou a ser criado no `index.ts` antes do `AccountService` (com `ACCOUNTS_ENABLED` e o mailer). Métrica `account_deleted_total` e log `conta excluída pela própria pessoa` (só `accountId`), logo depois do commit.
- **Site:** na tela de empresas, a seção "Excluir conta" e o botão "Excluir minha conta" abrem `DeleteAccountDialog` (`<dialog>` nativo, texto do que some e do que fica, campo "Sua senha atual" com foco, Esc fecha menos durante o envio). A senha some da memória ao fechar e depois de cada envio. Mensagens só por `status` e `error.code` (`deleteAccountMessage`). No sucesso, a tela sai da conta e mostra "Sua conta foi excluída".
- **Desvios declarados:** (1) a recusa 409 `ORDER_PENDING` (pedido de pagamento ainda pagável) também vale aqui, porque o núcleo é o mesmo e o motivo é o mesmo da decisão do dono de 2026-11-26 (um pagamento que chegasse depois cairia numa conta que ninguém acessa); (2) a spec pede `ConfirmDialog`, mas ele não tem campo; o diálogo novo segue o mesmo padrão (`<dialog>`, Esc, botão destrutivo); (3) "o aceite dos termos fica" não se aplica ainda (a E2 não existe).
- **Testes:** `account-delete.test.ts` (5: sucesso sem trilha da plataforma, senha errada com bloqueio que vale também para o login, sem cookie e conta desativada, as três recusas sem efeito, 404 sem o núcleo), `account.controller.test.ts` (+1: origem, corpo estrito, 401 sem cookie, cookie mantido nas recusas e limpo no sucesso, senha e cookie fora do log), `rate-limit.test.ts` (rota no inventário com perfil `login`), `metrics.test.ts`, a integração nova `account-delete.integration.test.ts` (Postgres e Redis reais: senha errada igual ao login, `COMPANY_OWNERSHIP`, `SUBSCRIPTION_ACTIVE`, Redis fora = 503 sem nada anonimizado, sucesso com conta e vínculos anonimizados, auditoria apontando para o vínculo, vínculo de outra conta intacto, sessões fora, aviso ao endereço antigo, e-mail livre para cadastro novo que não herda nada, privacidade) e o Playwright `frontend/e2e/account-delete.spec.ts` (desktop e celular, claro e escuro).
- **Verificado localmente (Windows):** `typecheck`, `lint`, `format:check`; `account-delete.test.ts` (5), `account.controller.test.ts` (6), `rate-limit.test.ts` (10); unitários do site (258); Playwright `account-delete` (4), `accounts` e `open-company` (24). **Não rodado:** a integração (só no CI).
- **Fica para depois:** a coluna `anonymized_at` (marcador explícito; hoje o reconhecimento é pelo domínio reservado) e a revogação de convites pendentes para o endereço antigo, ambas lembradas na revisão da 045 E6. **Passo do dono:** trocar em `frontend/src/legal/exclusao-de-dados.md` (texto `vigente`) a instrução de excluir a conta por e-mail pela do site ("em Empresas, use 'Excluir minha conta'"), com a versão nova do texto.
- **Revisão da E7 (2026-11-27, `reviewer`): nenhum Bloqueante; um Importante e dois Menores, todos corrigidos na branch.**
  1. **(Importante)** Se a revogação final falhasse depois do commit, a rota respondia 503 com a conta já excluída e o aviso já enviado, e a repetição pelo site dizia "Senha incorreta" (o cookie já não vale). Agora `deleteAccount` responde o sucesso quando a falha vem depois do commit (o núcleo já registra a falha no log; o operador refaz a revogação pela remoção do admin, 045 E6). E o diálogo, num 401, consulta `GET /auth/session`: sessão encerrada (cookie vencido, por exemplo) volta ao login com "Sua sessão terminou", em vez de "Senha incorreta". Testes: dois unitários (falha depois e antes do commit) e um Playwright.
  2. **(Menor)** Comentário errado na integração (o 503 não derrubava as sessões): removido junto com o login desnecessário.
  3. **(Menor)** A integração do 503 passou a conferir também os vínculos (e-mail e estado intactos) e o cookie ainda válido.

## Anexo A — Rascunho da Política de Privacidade (`frontend/src/legal/privacidade.md`)

> Rascunho técnico, não é parecer jurídico. Revisão do advogado obrigatória antes de `situacao: vigente`. Marcadores: `[PREENCHER: ...]` (dado que só o dono tem), `[CONFERIR: S#]` (fato externo a confirmar no E0), `[DEPENDE: D#]` (valor que depende de decisão), `[ATUALIZAR: E#]` (muda quando a etapa entrar no ar).

```markdown
---
titulo: Política de Privacidade
versao: 1
atualizado-em: 2026-11-12
situacao: rascunho
---

# Política de Privacidade do Soprei

Esta política explica quais dados pessoais o Soprei trata, para quê, com quem compartilha, por quanto tempo guarda e como você pode exercer seus direitos.

## 1. Quem somos

O Soprei é um serviço de atendimento automatizado pelo WhatsApp com inteligência artificial, oferecido por [PREENCHER: razão social], CNPJ [PREENCHER: CNPJ], com sede em [PREENCHER: endereço].

Encarregado pelo tratamento de dados pessoais: [PREENCHER: nome do encarregado], pelo e-mail [PREENCHER: e-mail de privacidade].

## 2. A quem esta política se aplica

- **Visitantes** do site www.soprei.com.
- **Usuários**: pessoas que criam uma conta no site para usar o Soprei em nome de uma empresa (donos, administradores e equipe).
- **Contatos**: pessoas que conversam pelo WhatsApp com uma empresa que usa o Soprei.

## 3. Nosso papel

- Para os dados de **usuários** e de **pagamento**, o Soprei decide como os dados são tratados (é o **controlador**).
- Para os dados de **contatos**, quem decide é a **empresa** com quem o contato conversa (ela é a **controladora**). O Soprei trata esses dados por conta e conforme as instruções dela (é o **operador**). Se você é contato, procure primeiro a empresa com quem conversou. [CONFERIR: J1]

## 4. Que dados tratamos

### Visitantes
- Endereço IP, usado por pouco tempo para limitar abusos (excesso de requisições) e registrado nos logs de acesso do servidor.
- A preferência de tema (claro ou escuro), guardada só no seu navegador.

### Usuários
- E-mail e senha (guardamos apenas uma versão protegida da senha, que não permite recuperá-la).
- Códigos de confirmação de e-mail e de recuperação de senha (guardamos só uma versão protegida, válida por 15 minutos).
- As empresas de que você participa, seu papel em cada uma e a última empresa que você abriu.
- A versão dos Termos de Uso que você aceitou e a data do aceite.
- Registros de ações administrativas (por exemplo, quem convidou ou mudou o papel de alguém), sem texto livre e sem e-mail.
- Os dados que você cadastra para a sua empresa: nome, instruções da assistente (persona), documentos da base de conhecimento, produtos e estoque, serviços e horários da agenda.

### Contatos
- O número de telefone do WhatsApp.
- As mensagens de texto trocadas com a empresa: as que você escreve, as respostas automáticas e as mensagens que a equipe da empresa envia pelo aplicativo WhatsApp Business quando o número dela está ligado ao Soprei.
- Quando você envia áudio, imagem, vídeo ou documento, o Soprei **não** baixa nem guarda o arquivo; responde com um aviso fixo.
- Agendamentos feitos com a empresa: serviço, data e horário e, se informado, o seu nome.
- Pedidos de atendimento humano registrados pela assistente (só o motivo, de uma lista fixa).

As mensagens podem conter qualquer informação que o contato decidir escrever, inclusive dados sensíveis. Recomendamos não enviar dados de saúde, documentos ou senhas por esse canal.

### Pagamento
- Plano contratado, valores, datas, situação dos pedidos, a referência da transação e a forma de pagamento (Pix ou cartão). Os dados do cartão e do Pix são digitados na página da InfinitePay e **não** chegam ao Soprei.

## 5. Para que usamos os dados

- Criar e proteger sua conta, confirmar seu e-mail e permitir a recuperação de senha.
- Prestar o atendimento automatizado em nome da empresa: receber a mensagem do contato, gerar a resposta com inteligência artificial e enviá-la pelo WhatsApp.
- Mostrar à equipe da empresa as conversas, os agendamentos e os pedidos de atendimento humano.
- Cobrar a assinatura e avisar sobre vencimentos, uso do plano e pagamentos.
- Prevenir abuso, fraude e acessos indevidos (limites de tentativas e de requisições).
- Cumprir obrigações legais, como a guarda de registros de cobrança.

Bases legais: [CONFERIR: J1 — execução de contrato, legítimo interesse, cumprimento de obrigação legal; para contatos, a base é definida pela empresa controladora].

O Soprei **não** vende dados pessoais, **não** usa os dados para publicidade e **não** treina modelos de inteligência artificial com as conversas.

## 6. Inteligência artificial

As respostas automáticas são geradas por um modelo de linguagem da Anthropic (Claude). Para isso, enviamos ao provedor as instruções da empresa, o trecho recente da conversa, a mensagem do contato e, quando úteis, trechos da base de conhecimento, produtos e horários livres da agenda. O número de telefone do contato **não** é enviado ao provedor (salvo se o próprio contato o escrever na mensagem).

As respostas podem conter erros. A empresa pode pedir que a assistente encaminhe a conversa para uma pessoa e pode assumir a conversa pelo aplicativo WhatsApp Business. [CONFERIR: J — art. 20 da LGPD, revisão de decisões automatizadas]

## 7. Com quem compartilhamos

Só com os fornecedores necessários para o serviço funcionar:

| Fornecedor | Para quê | Onde |
| --- | --- | --- |
| Anthropic | gerar as respostas automáticas | Estados Unidos [CONFERIR: S1] |
| Meta (WhatsApp Business Platform) | receber e enviar as mensagens do WhatsApp; conectar o número da empresa | [CONFERIR: S2] |
| InfinitePay | processar os pagamentos | Brasil [CONFERIR: S3] |
| Google (Gmail) | enviar códigos, convites e avisos por e-mail | Estados Unidos e outros países [CONFERIR: S4] |
| Hetzner | hospedar o servidor, o banco de dados e as cópias de segurança | Finlândia (Helsinque) [CONFERIR: S4] |
| Cloudflare | resolver o endereço do site (DNS); não recebe o conteúdo do site | [CONFERIR: S4] |

[DEPENDE: D5 — se as fontes continuarem vindo do Google, incluir: "Google (Google Fonts): fornecer as fontes do site; recebe o IP do visitante".]

Na tela de conexão do WhatsApp, quando um usuário clica para conectar o número, o site carrega o programa do Facebook, que passa a se comunicar diretamente com a Meta.

Também podemos compartilhar dados quando a lei ou uma ordem de autoridade competente exigir.

## 8. Transferência internacional

Alguns fornecedores processam dados fora do Brasil, como indicado acima. [CONFERIR: S5 e J — mecanismo legal da transferência]

## 9. Por quanto tempo guardamos

[ATUALIZAR: E4 e E5 — enquanto o expurgo automático não estiver no ar, conversas e agendamentos não são apagados automaticamente.]

| Dado | Prazo |
| --- | --- |
| Conversas e mensagens | apagadas [DEPENDE: D8 — 12 meses] depois da última mensagem |
| Nome e telefone em agendamentos | removidos [DEPENDE: D8 — 12 meses] depois do horário; o registro do horário continua, sem dado pessoal |
| Mensagens em processamento | até [DEPENDE: D8 — 1 hora] depois de processadas (até 24 horas em caso de falha) |
| Conta não confirmada | apagada 7 dias depois do cadastro |
| E-mail de convite não aceito | apagado 7 dias depois de o convite vencer |
| Conta excluída | e-mail e senha removidos na hora; o restante fica sem identificação |
| Empresa excluída | dados apagados [DEPENDE: D8 — 30 dias] depois do pedido |
| Registros de cobrança | [DEPENDE: D8 e S6 — 5 anos] |
| Logs técnicos | [DEPENDE: D8 e D13 — 30 dias]; não contêm o texto das mensagens nem telefones |
| Cópias de segurança | até [DEPENDE: D8 — 35 dias]; ao restaurar uma cópia, as exclusões feitas depois dela são aplicadas de novo |

## 10. Cookies e armazenamento no navegador

- Um único cookie, `soprei_session`, para manter você conectado (válido por até 30 dias; não pode ser lido por scripts da página).
- No armazenamento do navegador, só a sua preferência de tema.
- Não usamos cookies de publicidade nem de análise de audiência.

## 11. Segurança

Senhas e códigos são guardados apenas em forma protegida; as credenciais do WhatsApp de cada empresa são cifradas; cada empresa só acessa os próprios dados; o conteúdo das mensagens e os telefones não são gravados nos logs técnicos; o acesso ao site é feito por conexão segura (HTTPS). Nenhum sistema é totalmente imune a falhas; em caso de incidente com risco relevante, avisaremos a Autoridade Nacional de Proteção de Dados (ANPD), as empresas afetadas e os titulares, conforme a lei. [CONFERIR: S5]

## 12. Seus direitos

A LGPD garante, entre outros, os direitos de confirmar se tratamos seus dados, acessá-los, corrigi-los, pedir a eliminação, a portabilidade e informações sobre o compartilhamento.

- **Contatos:** procure a empresa com quem você conversou; ela tem uma ferramenta no Soprei para exportar e apagar seus dados [ATUALIZAR: E6]. Se não conseguir falar com ela, escreva para [PREENCHER: e-mail de privacidade] e encaminharemos o pedido.
- **Usuários:** você pode excluir sua conta no próprio site [ATUALIZAR: E7] ou pedir pelo e-mail [PREENCHER: e-mail de privacidade].
- Veja também as [instruções de exclusão de dados](/exclusao-de-dados).

Você também pode apresentar reclamação à ANPD.

## 13. Menores de idade

O site e as contas são destinados a maiores de 18 anos que agem em nome de empresas. [CONFERIR: J — contatos menores de idade]

## 14. Mudanças nesta política

Quando esta política mudar, a data de "Última atualização" no topo da página será alterada. Mudanças relevantes também serão avisadas aos usuários no site.
```

## Anexo B — Rascunho dos Termos de Uso (`frontend/src/legal/termos.md`)

> Rascunho técnico, não é parecer jurídico. As cláusulas de responsabilidade, reembolso, reajuste e foro são do advogado (J). Marcadores como no Anexo A.

```markdown
---
titulo: Termos de Uso
versao: 1
atualizado-em: 2026-11-12
situacao: rascunho
---

# Termos de Uso do Soprei

Ao criar uma conta ou usar o Soprei, você aceita estes Termos de Uso e declara ter lido a [Política de Privacidade](/privacidade).

## 1. Quem oferece o serviço

O Soprei é oferecido por [PREENCHER: razão social], CNPJ [PREENCHER: CNPJ], com sede em [PREENCHER: endereço]. Contato: [PREENCHER: e-mail de contato].

## 2. O que é o Soprei

Um serviço que responde automaticamente, com inteligência artificial, às mensagens que as pessoas enviam a uma empresa pelo WhatsApp, com painel para acompanhar conversas e, conforme o plano, base de conhecimento, estoque e agenda.

## 3. Conta

- Para usar o Soprei é preciso criar uma conta com e-mail válido e senha, e ter 18 anos ou mais.
- Você é responsável por manter sua senha em segredo e pelas ações feitas com a sua conta.
- Quem cria uma empresa no Soprei declara ter poderes para agir em nome dela e pode convidar outras pessoas, com papéis diferentes.

## 4. Responsabilidades da empresa

A empresa que usa o Soprei:

- é a responsável (controladora) pelos dados pessoais dos seus contatos e por ter base legal para tratá-los;
- informa aos seus contatos que o atendimento é feito com apoio de inteligência artificial [DEPENDE: D14];
- é responsável pelo conteúdo que cadastra (instruções da assistente, documentos, produtos, serviços) e não deve incluir senhas, documentos pessoais ou dados de saúde;
- cumpre as políticas do WhatsApp Business e da Meta, inclusive sobre quem pode receber mensagens [CONFERIR: S2];
- confere as respostas da assistente quando necessário e atende pessoalmente os casos que a assistente encaminhar.

## 5. Inteligência artificial

As respostas são geradas automaticamente e podem conter erros ou informações incompletas. O Soprei não garante que a assistente dará a resposta correta em todos os casos. A assistente não confirma agendamentos por conta própria, salvo se a empresa ligar essa opção.

## 6. WhatsApp e custos da Meta

Para atender pelo WhatsApp, a empresa conecta o próprio número pela plataforma oficial da Meta. **Os custos cobrados pela Meta pelas mensagens são pagos pela empresa diretamente à Meta** e não estão incluídos no plano do Soprei, salvo indicação diferente na tela de assinatura. O Soprei não controla a disponibilidade, as regras nem os preços da Meta.

## 7. Planos, pagamento e cancelamento

- Os planos, preços, limites de uso e módulos estão na tela de Assinatura. Os pagamentos são processados pela InfinitePay.
- Quando o limite de uso do plano acaba, as respostas automáticas param até a renovação ou a troca de plano.
- Sem pagamento, há um período de carência de [DEPENDE: configuração vigente — 5 dias]; depois dele, o acesso fica só para leitura.
- Você pode cancelar a renovação a qualquer momento; o plano continua até o fim do período pago.
- Reembolso: [CONFERIR: J — política de reembolso e direito de arrependimento].
- Reajuste de preços: [CONFERIR: J — cláusula de reajuste, aviso prévio].

## 8. Uso proibido

Não é permitido usar o Soprei para enviar spam, conteúdo ilegal, discriminatório ou enganoso, para se passar por outra pessoa, para coletar dados de terceiros sem base legal, para tentar acessar dados de outras empresas ou para atrapalhar o funcionamento do serviço.

## 9. Suspensão e encerramento

Podemos suspender ou encerrar o acesso em caso de violação destes termos, de risco à segurança ou de ordem legal, avisando sempre que possível. Você pode excluir sua conta e sua empresa [ATUALIZAR: E7 e E8]; o que acontece com os dados está na Política de Privacidade.

## 10. Disponibilidade

Fazemos o possível para manter o serviço no ar, mas não garantimos funcionamento ininterrupto. Pode haver interrupções para manutenção ou por falhas de fornecedores (como a Meta ou o provedor de inteligência artificial).

## 11. Proteção de dados

O Soprei trata os dados dos contatos da empresa como operador, conforme a [Política de Privacidade](/privacidade) e o [CONFERIR: J — aditivo de tratamento de dados].

## 12. Propriedade intelectual

O software, a marca e o site do Soprei pertencem a [PREENCHER: razão social]. Os dados e o conteúdo cadastrados pela empresa continuam sendo dela.

## 13. Limitação de responsabilidade

[CONFERIR: J — texto do advogado.]

## 14. Mudanças nos termos

Quando estes termos mudarem de forma relevante, a versão sobe e pediremos um novo aceite no próximo acesso ao site. Correções de redação só alteram a data de "Última atualização".

## 15. Lei e foro

Estes termos seguem a lei brasileira. Fica eleito o foro de [PREENCHER: foro]. [CONFERIR: J — Código de Defesa do Consumidor]
```

## Anexo C — Rascunho das instruções de exclusão de dados (`frontend/src/legal/exclusao-de-dados.md`)

```markdown
---
titulo: Instruções de exclusão de dados
versao: 1
atualizado-em: 2026-11-12
situacao: rascunho
---

# Como pedir a exclusão dos seus dados

## Se você conversou com uma empresa pelo WhatsApp

A empresa com quem você conversou é a responsável pelos seus dados.

1. Peça a exclusão diretamente à empresa (pelo próprio WhatsApp ou pelos canais dela).
2. A empresa apaga, no Soprei, as suas mensagens e retira seu nome e telefone dos agendamentos. [ATUALIZAR: E6 — até lá: "A empresa nos encaminha o pedido e nós fazemos a exclusão."]
3. Se não conseguir falar com a empresa, escreva para [PREENCHER: e-mail de privacidade] com o nome da empresa e o número de telefone usado. Encaminharemos o pedido à empresa.

Observações:
- A exclusão não apaga as mensagens que já estão no seu celular nem no aparelho da empresa.
- Se você voltar a escrever para a empresa depois da exclusão, uma nova conversa começa.
- Mensagens recebidas nos segundos anteriores ao pedido podem ser processadas e apagadas logo em seguida pela rotina automática.

## Se você tem uma conta no site do Soprei

- **Excluir a conta:** [ATUALIZAR: E7 — "no site, em Empresas, use 'Excluir minha conta'"; até lá: escreva para [PREENCHER: e-mail de privacidade] a partir do e-mail da conta]. Seu e-mail e sua senha são removidos na hora.
- **Excluir uma empresa:** [ATUALIZAR: E8 — "o dono da empresa usa 'Excluir esta empresa'. Os dados ficam [DEPENDE: D8 — 30 dias] em carência e depois são apagados"; até lá: pedido por e-mail].
- Se você for o único dono de uma empresa com outras pessoas, transfira a empresa ou exclua-a antes de excluir a conta.

## Prazos

Atendemos os pedidos em até [CONFERIR: S2d e J — prazo] dias. Cópias de segurança são apagadas em até [DEPENDE: D8 — 35 dias]; se uma cópia precisar ser restaurada, as exclusões feitas depois dela são aplicadas de novo antes de o serviço voltar.

Registros de cobrança são mantidos pelo prazo exigido por lei [DEPENDE: S6].

## Contato

Encarregado de dados: [PREENCHER: nome], [PREENCHER: e-mail de privacidade]. Veja também a [Política de Privacidade](/privacidade).
```
