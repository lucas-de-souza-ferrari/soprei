# 032 — LGPD e retenção de dados

- **Status:** rascunho
- **Branch:** `spec/032-lgpd-e-retencao` (uma branch por etapa grande, se o dono preferir PRs menores; ver "Etapas")
- **Depende de:** 011 e 013 (fila e jobs com texto e `contactRef`), 015 (credencial do canal), 017, 020 e 021 (contas e expurgo), 024 (rótulo mascarado do contato), 025 (convites), 026 e 027 (conhecimento, agenda), 028 (a IA escreve na agenda), 031 (planos e pagamentos). Conversa com a **033** (backups, logs e hospedagem entram na retenção).
- **Observação de numeração:** conferido em `docs/specs/` em 2026-11-09: existem 001 a 031; esta é a **032** e a de produção é a **033**. A 031 está em implementação na branch `spec/031-planos-e-assinaturas`; esta spec **não altera** nada dela e, onde toca em `payment_orders` ou em exclusão de empresa, depende de a 031 estar mergeada.
- **Esta spec passa pelo `reviewer`** antes do merge (dado pessoal, exclusão de dados, rotas novas com permissão, SQL entre empresas nos expurgos).
- **Fatos externos** (lei, ANPD, termos da Anthropic, da Meta, da InfinitePay) **não foram lidos na fonte** por quem escreveu: tudo marcado **(S#)** é **suposição** a conferir no **E0**. **Nada aqui é parecer jurídico**: papéis, base legal e prazos são **recomendações técnicas** para o dono levar a um advogado (pendência jurídica **J**).

## Objetivo

Antes de empresas reais usarem o Soprei, saber **quais dados pessoais existem e onde**, **por quanto tempo ficam**, **quem os apaga e como**, e dar à empresa e ao titular os caminhos práticos (exportar, apagar, excluir conta e empresa). Também fechar a limitação já registrada na 011 (jobs do BullMQ com texto e `contactRef` ficam no Redis sem prazo) e produzir a **URL de instruções de exclusão de dados** que a Meta pede (o campo está vazio no app).

## Estado atual (lido no código e no schema)

- **Nada é apagado hoje, exceto:** contas nunca confirmadas (`UnverifiedAccountPurger`, 7 dias) e convites pendentes vencidos há 7 dias (`InvitationExpiryPurger`), ambos no `startPurgeTimer` (`application/auth/purge-timer.ts`, `ACCOUNT_PURGE_INTERVAL_MINUTES`, **só com `ACCOUNTS_ENABLED=true`**; `0` desliga os dois). Mensagens, conversas, agendamentos, auditoria, vínculos e contas ficam **para sempre**.
- **Empresa removida** (`CompanyRepository.remove`, só `PlatformAdmin` por `DELETE /admin/companies/:id`): soft delete (`deleted_at`, número do WhatsApp liberado, `ChannelConnection` apagada); **todos os outros dados da empresa continuam no banco**. Não há exclusão pela própria empresa nem exclusão de conta.
- **Redis:** jobs do canal (`channel-inbound`) têm `removeOnComplete: { age: QUEUE_KEEP_COMPLETED_SECONDS }` (3600) e `removeOnFail: { age: QUEUE_KEEP_FAILED_SECONDS }` (86400); o BullMQ só limpa por idade **quando outro job termina** e as chaves **não expiram** (`inbound-queue.ts`, linhas ~141 e ~181). O job `text` carrega texto e `contactRef`; o `flush` só ids e `contactRef`, e sai ao concluir (`removeOnComplete: true`), mas fica 24 h se falhar. Sem tráfego, o último job fica indefinidamente (limitação aceita na 011).
- **Log:** `REDACTED_KEYS` (`infrastructure/logger/logger.ts`) cobre segredos e `email`; **não** cobre `contactRef`, `content`, `text`, `persona`, `customerLabel` nem `phone` (a regra é "não pôr no log", sem rede de segurança). Métricas: nenhum label com id ou dado pessoal.
- **Dado pessoal que sai do sistema:** o texto do contato, o histórico, a persona, o conhecimento e a agenda vão à Anthropic (014, 026 a 028); a resposta vai à Meta (011); e-mail e códigos vão ao SMTP (017 a 021, 025); o pagamento vai à InfinitePay (031).
- **Contato no navegador:** desde a 024 as rotas de leitura **não devolvem** `contactRef` nem `externalId` (wamid, que carrega o telefone em base64), só `contactLabel` mascarado. Qualquer rota nova desta spec **mantém** essa regra.
- **Auditoria** (`audit_events`): só ids, papéis e ação, sem e-mail, sem texto livre, sem IP; aponta (FK composta `Restrict`) para `memberships` e `company_invitations`. Por isso **vínculo não pode ser apagado**; só anonimizado.

## Inventário de dados pessoais (o que o E1 documenta e testa)

| Onde | Dado | Categoria | Observação |
| --- | --- | --- | --- |
| `conversations.contact_ref` | telefone (`wa_id`) do contato final; texto livre no simulador | direto | chave de agrupamento; nunca em log nem label |
| `messages.content` | texto do contato e resposta da IA | direto, **pode ser sensível** (saúde, finanças: o contato escreve o que quiser) | maior volume e maior risco |
| `messages.external_id`, `channel_message_id` | `wamid` (telefone em base64) | direto | não sai da API desde a 024 |
| `appointments.customer_label`, `contact_ref`, `starts_at` | nome (até 60), telefone, horário | direto | sem campo de motivo (027) |
| `accounts.email`, `memberships.email`, `platform_admins.email` | e-mail de quem entra no site | direto | hashes de senha e de códigos não são dado pessoal legível, mas são segredo |
| `company_invitations.email` | e-mail do convidado | direto | só em convite `PENDING` (CHECK) |
| `companies.name`, `persona`, `slug` | dado da empresa; a persona é texto livre | eventual | a empresa pode colar nome de pessoa |
| `knowledge_documents`, `knowledge_chunks` | texto colado pela empresa | eventual | o aviso da 026 pede não pôr dado pessoal |
| `channel_connections` | token cifrado, `wabaId`, `phoneNumberId` | segredo e dado de empresa | cifrado (015) |
| `audit_events` | ids de vínculo, papel, ação | pseudonimizado | aponta para `memberships` |
| `subscriptions`, `payment_orders`, `usage_counters`, `payment_notices` (031) | valor, referência da transação, período, consumo | indireto, **fiscal** | retenção ditada por lei (J) |
| Redis `channel-inbound` | texto e `contactRef` (job `text`), `contactRef` (`notice` e `flush`) | direto | **sem TTL real** hoje |
| Redis sessões | ids de conta e vínculo, hash do refresh | indireto | TTL <= 30 dias |
| Redis contadores (`login-fail`, `invite-quota`, `sched-ai-quota`) | HMAC de e-mail ou contato | pseudonimizado | TTL <= 24 h |
| Redis rate limit | IP | direto | TTL <= janela do perfil |
| Logs do processo | ids, resultado, duração; **sem** conteúdo, telefone, e-mail | indireto | retenção do host (033) |
| Métricas | contagens | nenhum | sem labels pessoais |
| Backups (033) | **tudo** acima | direto | retenção e reaplicação de exclusões (E4) |
| Terceiros | Anthropic, Meta, SMTP, InfinitePay, hospedagem, Cloudflare | direto | ver "Provedores" |

## Papéis e base legal (recomendação; **pendência jurídica J1**)

- **Contato final** (quem escreve no WhatsApp): a **empresa que usa o Soprei é a controladora**; o **Soprei é operador** (trata por instrução dela) e usa **suboperadores** (Anthropic, Meta, hospedagem, SMTP).
- **Quem entra no site** (e-mail, senha, vínculos) e **o pagamento**: aqui o **Soprei é controlador** (conta, cobrança, segurança).
- Bases a sugerir ao advogado: execução de contrato e procedimentos preliminares (conta, cobrança), legítimo interesse (segurança, prevenção a abuso), obrigação legal (guarda fiscal), e, para o contato final, a base é **da empresa** (em geral execução de contrato ou legítimo interesse; consentimento só onde o advogado pedir). **Não há decisão tomada aqui.**
- Entregáveis jurídicos **do dono**: política de privacidade e termos (já em `melhive.com.br/privacidade` e `/termos`, texto a revisar), **aditivo de tratamento de dados** (operador) nos termos de uso, indicação do **encarregado** (contato público), registro das operações (RoPA, simples). A spec só **lista o que a política deve cobrir** (E7).

## Etapas (pequenas e cortáveis; E0 e E1 não têm risco, E2 e E3 são as que mais valem antes de dados reais)

| Etapa | O que entrega | Corta? |
| --- | --- | --- |
| **E0** | Passo zero: conferências externas e jurídicas (sem código) | não |
| **E1** | Inventário como código (`DATA_INVENTORY`), teste de exaustividade, rede de segurança no log | não |
| **E2** | Limpeza periódica dos jobs do Redis com prazo real | não |
| **E3** | Expurgo por retenção (mensagens, agendamentos) no timer existente, com `dry-run` | pode adiar os prazos, não o mecanismo |
| **E4** | Direitos do titular no painel: exportar e apagar o contato, registro de exclusões | sim (a empresa pode pedir ao dono por e-mail no começo) |
| **E5** | Excluir a própria conta e a própria empresa (carência e expurgo definitivo) | sim, mas é a base da exclusão de dados da Meta |
| **E6** | Página pública de instruções de exclusão e aviso de IA ao contato | a página não corta (campo da Meta); o aviso é decisão D8 |
| **E7** | Documentos: o que a política cobre, plano de incidente, registro de decisões | não |

### E0 — Passo zero (conferência; nada de código; **o dono faz, ou me passa os textos**)

- **S1 (Anthropic):** se a API comercial **não treina** com o conteúdo por padrão, quanto tempo retém entradas e saídas, se há **zero data retention** (ZDR) por contrato ou pedido, onde processa (EUA?), e a página de subprocessadores. Registrar a conclusão em `docs/context.md`.
- **S2 (Meta):** termos de dados do WhatsApp Business Platform e do **Tech Provider** (Soprei processa mensagens de empresas que têm WABA própria); o que o campo **"URL de instruções de exclusão de dados"** aceita (página de instruções **ou** callback assinado `signed_request`, esse último típico de app com Facebook Login) e se vale para apps só de WhatsApp; prazo que a Meta cobra para a exclusão.
- **S3 (InfinitePay):** quais dados do pagador ficam com ela e quais chegam ao Soprei (esperado: só referência e valor; o checkout é hospedado, 031).
- **S4 (SMTP e hospedagem, 033):** região, retenção de logs e contrato de tratamento de cada um.
- **S5 (lei):** prazo de comunicação de incidente à ANPD (a regulamentação de 2024 fala em **3 dias úteis**, suposição) e o que o advogado exige de transferência internacional (EUA, Europa) para Anthropic, Meta, Cloudflare e hospedagem.
- **S6 (fiscal):** por quanto tempo guardar registro de cobrança e nota fiscal (esperado: 5 anos, suposição).
- **J1 a J5 (advogado):** papéis, bases legais, aditivo de operador, texto da política e dos termos, necessidade de relatório de impacto (RIPD) para IA com dado possivelmente sensível. **Sem parecer aqui.**

### E1 — Inventário como código

- `domain/data-inventory.ts` (ou `shared/`): `DATA_INVENTORY: Record<ModelName, { personal: 'none'|'indirect'|'direct', fields: readonly string[], retention: RetentionRule, erasure: ErasureRule }>`, **exaustivo pelo compilador** como o `MODEL_SCOPES` (model novo sem entrada não compila). `docs/lgpd/inventario-de-dados.md` espelha a tabela acima (conteúdo textual do dono/advogado; o código só tem o essencial).
- **Rede de segurança no log:** `REDACTED_KEYS` ganha `contactRef`, `customerLabel`, `content`, `persona`, `phone`, `from` e `to` (nomes de campo que **nunca** devem existir num objeto de log; o redact é a segunda barreira, a regra continua sendo não pôr).
- **Varredura de logs nos testes de fluxo:** já existe a captura com sentinela (`log-capture.ts`); esta etapa a **estende** aos fluxos novos (E2 a E5).

### E2 — Limpeza periódica dos jobs do Redis (fecha a limitação da 011)

- Novo `InboundQueueJanitor` (porta em `application/ports/`, adaptador em `infrastructure/queue/`) que, a cada `QUEUE_CLEAN_INTERVAL_MINUTES` (padrão 15), remove da fila `channel-inbound` os jobs **concluídos** mais velhos que `QUEUE_KEEP_COMPLETED_SECONDS` e os **falhos** mais velhos que `QUEUE_KEEP_FAILED_SECONDS` (API de limpeza por idade do BullMQ 6, **suposição S7**: o implementer confere o nome e o limite por chamada), em lotes, sem sobreposição, sem tocar em job **ativo, esperando ou atrasado** (o `flush` agendado é "atrasado" e **nunca** pode ser removido).
- `QUEUE_KEEP_FAILED_SECONDS` passa a ter **teto** na config (padrão 86400, máximo 604800) e a regra vira "retenção **máxima** de verdade", não "mínima".
- Roda **junto** do timer da E3 (mesmo `startPurgeTimer`), mas **independe** de `ACCOUNTS_ENABLED`: depende só de `WHATSAPP_ENABLED`.
- Métricas: `queue_janitor_runs_total{result}` e `queue_janitor_removed_total{state}`.

### E3 — Expurgo por retenção (no timer existente)

Um `RetentionPurger` por alvo, mesmo desenho dos dois que já existem: SQL cru **só** em `infrastructure/database/` (o único tipo de código que atravessa empresas, como o `PrismaInvitationExpiryRepository`), CTE `MATERIALIZED` com `FOR UPDATE SKIP LOCKED`, **predicado repetido** no `DELETE`/`UPDATE`, lotes de 100 e até 10 por execução, primeira execução ~30 s depois do boot, sem sobreposição, `unref`, parado e esperado no `closeInfrastructure`.

- **`startPurgeTimer`** passa a ser habilitado por `ACCOUNTS_ENABLED || RETENTION_ENABLED` e **cada** purger respeita a própria condição (hoje o `enabled` é só `ACCOUNTS_ENABLED`; o `index.ts` só precisa de ajuste de ligação, sem mudar a assinatura do timer). `ACCOUNT_PURGE_INTERVAL_MINUTES=0` continua desligando **todos**.
- **Alvo 1, conversas e mensagens:** apagar conversas com `updated_at` (última atividade, 024) anterior a `RETENTION_MESSAGES_DAYS` e **todas** as suas mensagens, numa transação por lote. As FKs compostas `(reply_to_id, company_id)` e `(answered_by_id, company_id)` são `NO ACTION`: um **único** `DELETE` por lote das mensagens das conversas escolhidas as satisfaz (verificação no teste de integração; se o Postgres reclamar, zerar as duas colunas na mesma transação antes). Conversa com mensagem **pendente** (sem resposta) **não** é apagada.
- **Alvo 2, agendamentos:** `UPDATE` que zera `customer_label` e `contact_ref` (**anonimiza, não apaga**) de agendamentos com `ends_at` anterior a `RETENTION_APPOINTMENT_PII_DAYS` e estado final (`CANCELLED`, `COMPLETED`, `NO_SHOW`; **não** toca em `PENDING`/`CONFIRMED` futuros). A linha continua (estatística, sem dado pessoal). O `EXCLUDE` e os CHECKs da 027 **não** podem ser violados: o teste prova.
- **Alvo 3 (decisão D5), vínculo e conta inativos:** **fora** desta etapa (não há `last_login_at`); fica como pendência.
- **Alvo 4 (apenas se o dono quiser, D4), auditoria:** **não** é expurgada por tempo (só tem ids). Sai com a empresa no E5.
- **Modo seguro:** `RETENTION_DRY_RUN=true` (padrão **em desenvolvimento**) só **conta e loga** quantos seriam apagados, sem apagar; em produção o dono liga o apagamento de verdade depois de ver os números. Métricas `retention_purge_runs_total{target,result}`, `retention_purged_total{target}` (contagens; nunca id, telefone ou e-mail); log só com contagens.
- **Config (recomendação; o dono decide em D3):** `RETENTION_ENABLED` (`true`/`false` literais), `RETENTION_MESSAGES_DAYS` (padrão 365; 30 a 3650), `RETENTION_APPOINTMENT_PII_DAYS` (padrão 365; 30 a 3650), `RETENTION_DRY_RUN`. **Com `NODE_ENV=production`, `RETENTION_ENABLED=false` é recusado** (mesmo padrão de `RATE_LIMIT_ENABLED`), para o esquecimento não virar guarda eterna. O `.env.example` documenta tudo.
- **Migrations:** índices parciais ou compostos para achar os candidatos sem varrer a tabela (`conversations (updated_at)` já existe em `(company_id, updated_at, id)`, **sem** `company_id` na frente o purger não o usa: avaliar índice só em `updated_at`); aditivas, nunca apagam dado na hora de aplicar.

### E4 — Direitos do titular no painel (exportar e apagar o contato)

A empresa é a controladora; o Soprei dá a **ferramenta**. Permissão nova `privacy:manage` (**OWNER e ADMIN**, mapa fixo em `domain/permissions.ts`), perfil `admin`, `requirePermission('privacy:manage', { companyParam })` (401, 403 plataforma, 404, 403).

- `POST /admin/companies/:companyId/privacy/contacts/lookup` `{ phone }` -> `{ matches: [{ conversationId, contactLabel, channel, messageCount, lastActivityAt }] }`. O telefone digitado é normalizado (só dígitos) e **comparado no servidor**; nunca é devolvido nem logado. Variante do nono dígito brasileiro tratada na comparação (suposição S8; o `wa_id` pode vir com ou sem o 9).
- `GET /admin/companies/:companyId/privacy/conversations/:conversationId/export` -> JSON para download (`Content-Disposition: attachment`, `Cache-Control: no-store`): conversa (rótulo mascarado), mensagens (`role`, `content`, `createdAt`, `sentAt`, `isFallback`) e agendamentos do mesmo `contactRef` (`localDate`, `localStart`, nome do serviço, `customerLabel`, estado). **Sem** `contactRef`, `externalId`, `channelMessageId` nem ids de vínculo. Teto de 5.000 mensagens por exportação (mais que isso: 413 com `code` fixo; exportar por faixa fica fora). Log só com ids, contagens e resultado.
- `DELETE /admin/companies/:companyId/privacy/conversations/:conversationId` (corpo `{ confirm: true }`, 204, idempotente): apaga mensagens e conversa (como o alvo 1), anonimiza agendamentos desse `contactRef` (como o alvo 2), tenta remover da fila os jobs `flush` desse contato (pela chave `flushKey`, que já não carrega o telefone) e grava o **registro de exclusão** abaixo.
- **Registro de exclusões** (`erasure_ledger`, model de **tenant**, FK composta): `id`, `companyId`, `kind` (`CONTACT`), `subjectHmac` (HMAC-SHA256 do `contactRef` com chave derivada do `JWT_SECRET` e rótulo próprio, como a 020/021/025), `createdAt`. **Sem** telefone, sem texto. Serve para **reaplicar a exclusão depois de restaurar um backup** (ver "Backups"): o runbook da 033 roda `pnpm privacy:replay`, que apaga o que reaparecer. Expurgo do próprio registro depois de `RETENTION_ERASURE_LEDGER_DAYS` (padrão 60, maior que a retenção dos backups).
- **Mensagem que chegar depois** do apagamento cria uma conversa nova (o contato continua podendo escrever; apagar não bloqueia). Job `text` já aceito e ainda não processado também pode recriar a conversa (janela de segundos, limitação aceita e documentada).
- **Frontend (aba "Privacidade", só com `privacy:manage`):** campo de telefone, resultado mascarado, "Exportar" e "Apagar dados deste contato" (`ConfirmDialog` com o texto do que será apagado). Nada em `localStorage`, URL, título ou log do navegador; telefone só em memória e limpo ao enviar. Mensagens de erro por `status` e `error.code`. Contraste testado (`contrast.test.ts`).
- Pedido do titular que chega **ao Soprei** em vez de à empresa: o Soprei **encaminha** à empresa (operador) e não age sozinho sobre dado de contato final (J1).

### E5 — Excluir a própria conta e a própria empresa

- **Empresa** (`DELETE /admin/companies/:companyId` pela própria empresa, **só `OWNER`**, confirmação por senha da conta e pelo slug digitado; 202): marca `deleted_at` (já existe), **suspende o canal** (desassina o app da WABA em melhor esforço e apaga `ChannelConnection`, como o `DELETE .../channel`), revoga o que for preciso e **agenda o expurgo definitivo** para `RETENTION_COMPANY_GRACE_DAYS` depois (padrão 30; **restaurável** pelo dono da plataforma nesse prazo). Hoje só o `PlatformAdmin` remove; a rota nova **reusa** `CompanyRepository.remove`.
- **Expurgo definitivo** (`CompanyHardPurger`, no mesmo timer): depois da carência apaga, **em ordem de dependência** (a mesma lista de `test-support/tenant-fixtures.ts`: mensagens e conversas, agendamentos, regras, serviços, recursos, configurações, movimentos e produtos, trechos e documentos, convites, auditoria, vínculos) **e anonimiza** a linha `companies` (`name` vira texto fixo, `persona` nula, `slug` **continua reservado**, `whatsappPhoneNumberId` já livre). **Não apaga** `subscriptions`, `payment_orders` e afins (fiscal, S6): só desassocia dado pessoal. **Decisão D6:** ordem e o que fica; qualquer FK `Restrict` que bloqueie é tratada no teste, nunca com `CASCADE` novo.
- **Conta** (`DELETE /account`, corpo `{ password }`, 204; cookie da conta; perfil `login`, fail-closed): recusa com 409 `LAST_OWNER_OF_COMPANY` se a conta é a **única `OWNER` ativa** de empresa que ainda tem outros membros (precisa transferir ou excluir a empresa antes); recusa se há **assinatura paga ativa** (cancelar antes; reembolso é decisão do dono, J). Depois **anonimiza** (não apaga: `memberships` e a auditoria a referenciam): `accounts.email` vira `removida-<uuid>@excluido.invalid` (único), `password_hash` vira valor inválido fixo, `status = DISABLED`, `last_company_id`, códigos e hashes nulos; `memberships.email` e `password_hash` idem e `DISABLED`; revoga **todas** as sessões (`revokeAll`, fail-closed em 503). E-mail de aviso "conta excluída" antes de anonimizar (sem código nem link).
- **Frontend:** em "Conta" (a tela da conta, fora de uma empresa) "Excluir minha conta" e, em Configuração da empresa (só `OWNER`), "Excluir esta empresa", ambos com `ConfirmDialog` e texto da carência. Detalhe fino da tela depende de a 029 estar estável.

### E6 — Instruções de exclusão (Meta) e aviso ao contato final

- **Página pública** `/exclusao-de-dados` (rota do frontend, sem login, estática, no mesmo site do app): texto do **dono/advogado** com o procedimento (1. o titular pede à **empresa** com quem conversou; 2. a empresa usa a aba Privacidade; 3. quem usa o site pode excluir a conta e a empresa; 4. contato do encarregado/e-mail do Soprei para pedidos que não chegam à empresa; 5. prazos). A spec entrega a **estrutura e o teste**; o texto final é do dono. Se o dono preferir hospedá-la em `melhive.com.br`, a spec só fornece o rascunho e a URL entra no campo da Meta (D7).
- Rotas públicas estáticas **não** chamam a API; o e2e prova que a página abre deslogada (claro e escuro, celular e computador) e que não grava nada no navegador.
- **Aviso de IA ao contato (decisão D8, cortável):** a **primeira resposta** de uma conversa **nova** (e só ela) leva, **depois** do texto da IA e fora do LLM, uma frase constante: "Você está falando com um atendimento automatizado de <empresa>. Seus dados são tratados conforme <link de privacidade>." (nome da empresa sanitizado como no e-mail da 025; link vindo de `PRIVACY_URL`, opcional; sem a variável a frase não leva link). Chave `CONTACT_NOTICE_ENABLED` (padrão `false`; ligar é decisão do dono por empresa ou global). O texto entra na mesma mensagem gravada (marcador próprio para não duplicar), nunca no `systemPrompt`. **Alternativa:** mensagem separada (custa uma mensagem a mais da Meta, 031). **Recomendação:** frase no fim da primeira resposta.

### E7 — Documentos

- `docs/lgpd/politica-deve-cobrir.md`: lista do que a política de privacidade e os termos **devem conter** (lista, não texto): quem é controlador e operador; dados por categoria (contato final, quem entra no site, pagamento); finalidades; bases (J1); **suboperadores** (Anthropic, Meta, InfinitePay, SMTP, hospedagem, Cloudflare) e **transferência internacional**; **retenção** (a tabela aprovada em D3); direitos do titular e o canal (E4 a E6); segurança em resumo; **encarregado e contato**; cookies (só o de sessão, `HttpOnly`; o `localStorage` guarda só o tema); incidentes; alteração da política.
- `docs/lgpd/plano-de-incidente.md` (checklist, **não** automação): (1) conter (revogar sessões `revokeAll`, trocar segredos, suspender canal); (2) avaliar o que vazou e de quem (inventário acima); (3) registrar linha do tempo; (4) decidir se há risco relevante; (5) avisar a **ANPD** e os **titulares** no prazo (S5, confirmar com o advogado) e as **empresas controladoras** sem demora (o operador avisa o controlador); (6) corrigir e documentar; (7) revisão posterior. Contatos e responsáveis **a preencher pelo dono**.
- `docs/context.md` ganha as decisões D1 a D9 depois de o dono responder.

## Provedores a conferir (E0) e o que a spec garante do lado do código

- **Anthropic:** o que vai (persona, histórico recente, texto, trechos de conhecimento e de agenda) já é limitado por teto; nada novo. Conferir ZDR e treinamento (S1).
- **Meta:** o app é Tech Provider; a exclusão de dados do **WABA** (token, número) já é a `DELETE .../channel`; o conteúdo na infraestrutura da Meta é **da Meta/da empresa**, fora do alcance do Soprei.
- **E-mail:** o texto dos e-mails já não leva senha; códigos ficam no provedor SMTP conforme a retenção dele (033).
- **InfinitePay:** o Soprei só guarda referência (031).

## Backups e minimização de log (regra; a mecânica é da 033)

- Backup do PostgreSQL com retenção **máxima de 35 dias** (recomendação) e **criptografado**; apagar no banco **não** apaga o backup até ele vencer. A regra é: **ao restaurar, reaplicar as exclusões** do `erasure_ledger` e dos expurgos (`pnpm privacy:replay`, E4) **antes** de reabrir o serviço. O prazo do backup entra na política como "até 35 dias depois".
- **Logs** com dado pessoal são bug; retenção sugerida de **30 dias** no destino (033). Métricas sem dado pessoal.

## Critérios de aceite

Cada item tem teste automatizado (unitário, ou de integração com Postgres/Redis `/15` e prefixo único).

**E1**
- [ ] `DATA_INVENTORY` tem entrada para **todos** os models do Prisma (o teste lê os nomes do Prisma e falha se faltar); model novo sem entrada quebra o `typecheck`.
- [ ] Um objeto de log com `contactRef`, `customerLabel`, `content`, `persona`, `phone`, `from` ou `to` sai com `[Redacted]` (teste do logger).
- [ ] O gate `domain-vocabulary` continua verde (sem a palavra antiga da empresa nos textos novos).

**E2**
- [ ] Com 3 jobs concluídos (um velho, dois novos) e 2 falhos (um velho), o `janitor` remove só os velhos de cada estado e **não** toca em ativo, esperando nem **atrasado** (o `flush` agendado sobrevive), com Redis real `/15` e prefixo único.
- [ ] Execuções não se sobrepõem; o `stop()` espera a execução ativa; Redis fora = log de erro com `describeRedisError`, métrica `result=error`, **sem** derrubar o processo.
- [ ] Após a limpeza, uma varredura do prefixo da fila **não encontra** o texto sentinela do job `text` nem o `contactRef` de jobs velhos.
- [ ] `QUEUE_KEEP_FAILED_SECONDS` acima do teto é recusado no boot.

**E3**
- [ ] Com duas empresas e conversas velhas e novas, o purger apaga só as velhas **das duas** e nunca as novas nem as pendentes; as mensagens das conversas apagadas somem (`DELETE` único, FKs `NO ACTION` satisfeitas); o isolamento é provado por contagens por `company_id`.
- [ ] Concorrência: dois purgers simultâneos (`SKIP LOCKED`) não apagam além do lote nem se bloqueiam; uma conversa que **recebe mensagem nova durante** o expurgo (o predicado é repetido no `DELETE`) **não** é apagada.
- [ ] Agendamento final antigo tem `customer_label` e `contact_ref` nulos e a linha continua; `PENDING`/`CONFIRMED` futuro e recente **não** mudam; a restrição `appointments_no_overlap` e os CHECKs continuam valendo.
- [ ] `RETENTION_DRY_RUN=true` não altera nenhuma linha e registra as contagens (métrica e log, sem dado pessoal); `RETENTION_ENABLED=false` com `NODE_ENV=production` é recusado no boot.
- [ ] `ACCOUNT_PURGE_INTERVAL_MINUTES=0` desliga todos os purgers; `ACCOUNTS_ENABLED=false` com `RETENTION_ENABLED=true` **ainda** executa o expurgo de mensagens e **não** o de contas.
- [ ] O `closeInfrastructure` espera a execução ativa (como a 021).

**E4**
- [ ] Matriz de papéis (`OWNER`, `ADMIN` permitidos; `AGENT`, `VIEWER`, `PlatformAdmin` 403; `:companyId` alheio 404 **antes** da permissão), nas três rotas, e entradas no inventário de rotas (`rate-limit.test.ts`) e na varredura do `site-bridge.integration.test.ts`.
- [ ] Isolamento A x B: o `lookup` e o `export` com `conversationId` da empresa B pela empresa A dão o mesmo 404; o `DELETE` não apaga nada de B.
- [ ] O `lookup` acha a conversa pelo telefone digitado (com e sem `+`, espaços, hífen) e **nenhuma** resposta, log, métrica ou erro contém o telefone, o `contactRef`, o `externalId` nem o `wamid` (sentinelas).
- [ ] O `export` traz mensagens, agendamentos do mesmo contato (e **não** os de outro contato), respeita o teto (413 `code` fixo) e vai com `Cache-Control: no-store` e `Content-Disposition: attachment`.
- [ ] O `DELETE` apaga mensagens e conversa, anonimiza os agendamentos do contato, grava **uma** linha em `erasure_ledger` com `subjectHmac` (sem telefone), é idempotente (repetir = 204, sem duplicar o registro) e remove o `flush` pendente do contato (Redis real).
- [ ] `pnpm privacy:replay` (CLI local, como o `auth:cli`; **não** roda contra o banco do dono em teste) apaga de novo, num banco restaurado de fixture, a conversa que o ledger lista e nada além dela.
- [ ] Frontend: permissão só mostra a aba (a barreira é o backend); fluxo de exportar e de apagar com confirmação; telefone limpo da memória ao enviar; nada no `localStorage`/`sessionStorage`/URL/título; e2e com API falsa.

**E5**
- [ ] `DELETE /admin/companies/:companyId` só por `OWNER`, com senha e slug corretos; senha ou slug errados = 400/401 **sem** efeito; empresa alheia = 404.
- [ ] Depois da carência (relógio injetado) o `CompanyHardPurger` apaga **todas** as tabelas de tenant da empresa e **só** dela (empresa B intacta, contagens por tabela), anonimiza a linha `companies`, mantém o `slug` reservado e **não** toca em `payment_orders`; antes da carência nada some e o `PlatformAdmin` consegue restaurar.
- [ ] Nenhuma FK `Restrict` bloqueia o expurgo (a ordem cobre todos os models: o teste usa `DATA_INVENTORY` para garantir que nenhum model de tenant ficou de fora).
- [ ] `DELETE /account`: senha errada = 401 uniforme sem efeito; `OWNER` único de empresa com outros membros = 409 `LAST_OWNER_OF_COMPANY`; assinatura paga ativa = 409; sucesso anonimiza conta e vínculos (e-mail liberado para novo cadastro), derruba todas as sessões (503 se o Redis das sessões falha, **sem** anonimizar antes de revogar com sucesso ou com compensação explícita) e a auditoria continua apontando para o vínculo anonimizado.
- [ ] O e-mail de aviso não contém código, senha nem link (mailer falso).

**E6**
- [ ] `/exclusao-de-dados` abre sem sessão e sem chamar a API, nos dois temas e em 360 e 1280 px, com os pares de contraste em `contrast.test.ts`.
- [ ] Com `CONTACT_NOTICE_ENABLED=true`, só a **primeira** resposta de uma conversa nova leva a frase (nome da empresa sanitizado; o `systemPrompt` e o texto enviado ao provedor **não** a contêm, provado com o servidor falso da Anthropic); a segunda resposta não; reenvio/retentativa não duplica; com a chave desligada nada muda.

**E7**
- [ ] `docs/lgpd/*.md` existem, são citados em `docs/context.md` e o `format:check` passa.

## Casos de borda e erros

- Purger apagando enquanto o contato escreve: o predicado repetido no `DELETE` e a janela `updated_at` evitam apagar conversa que acabou de receber mensagem; a conversa só some depois de inativa por `RETENTION_MESSAGES_DAYS`.
- Primeira ativação do expurgo em produção com muito dado velho: lotes de 100, 10 por execução, `dry-run` antes; sem mudança de schema destrutiva na migration.
- Exclusão de contato com mensagem **pendente**: apaga mesmo assim (pedido expresso do titular); o `flush` pendente é removido; resposta já enviada pela Meta **não** se desfaz.
- Telefone digitado inválido (menos de 8 ou mais de 15 dígitos): 400 sem eco do valor.
- Redis fora na exclusão do contato: o banco é apagado e a remoção do `flush` vira log de erro (melhor esforço); o job processará e encontrará a conversa nova ou nenhuma mensagem pendente.
- Exclusão de conta de pessoa que é `OWNER` de uma empresa **só dela**: permitido **depois** de excluir a empresa (409 antes).
- Reuso de e-mail após anonimização: o e-mail original volta a ser livre; a conta nova **não** herda nada.
- Backup restaurado com dado já apagado: o `privacy:replay` e os purgers (que rodam no boot em ~30 s) o apagam; **o runbook proíbe reabrir o tráfego antes do replay** (033).

## Isolamento entre empresas

As rotas das etapas E4 e E5 usam `requirePermission` com `companyParam` e o `CompanyId` **só** da identidade (nunca do corpo, query ou cabeçalho); todo método de repositório novo recebe `CompanyId` primeiro e põe `companyId` no `where` (a `tenant-scope` recusa o contrário); `erasure_ledger` entra em `MODEL_SCOPES` como `tenant` com FK composta. **Os purgers (E3 e o `CompanyHardPurger`) atravessam empresas por natureza**, como os da 021 e 025: SQL cru confinado a `infrastructure/database/`, predicado repetido, e testes com **duas empresas** provando que só se apaga o que venceu e só o que é dele. O `lookup` por telefone busca **dentro** da empresa da identidade; nunca há busca global por telefone. Teste: o `lookup` e o `export` com dados do mesmo telefone em duas empresas só enxergam o da própria.

## Fora de escopo

- **Parecer jurídico**, texto final da política e dos termos, aditivo de operador, RIPD e registro de operações (J, do dono).
- Retenção **configurável por empresa** e por categoria na tela (hoje é global e por ambiente; fica para spec própria se uma empresa exigir).
- Expurgo de contas ou vínculos por **inatividade** (falta `last_login_at`); expurgo de `audit_events` por tempo; imutabilidade da auditoria por gatilho/`REVOKE`.
- Bloquear (opt-out) um contato, lista de supressão e comando "pare" no WhatsApp.
- Exportação de **todos** os dados de uma empresa (portabilidade em massa) e exportação por faixa de datas.
- Callback assinado da Meta (`signed_request`) para exclusão automática (só se a E0 mostrar que o campo exige).
- Criptografia de mensagens em repouso na aplicação (a proteção é a do disco/backup, 033) e **RLS** do Postgres.
- Consentimento granular, gestão de cookies (só há o cookie de sessão) e aceite de termos com versão (pode virar spec pequena: `accounts.terms_accepted_at` e `terms_version`).
- Remoção de dados nos **suboperadores** (Meta, Anthropic, SMTP): fora do controle do código.
- Varredura de mensagens pendentes antigas e retomada de respostas não enviadas (pendência da 011/013).

## Decisões (o dono decide; recomendação em linguagem simples)

- **D1 Quem manda no prazo.** *Recomendação:* o Soprei define um prazo padrão **igual para todos** e a empresa pode pedir exclusão antes pela aba Privacidade; prazo por empresa fica para depois. *Alternativa:* campo de retenção por empresa já agora (mais código, mais testes).
- **D2 Papéis (J1).** *Recomendação:* empresa = controladora, Soprei = operador, e o Soprei é controlador só de conta e cobrança. Falta o advogado confirmar e redigir o aditivo.
- **D3 Prazos.** *Recomendação:* **mensagens e conversas: 12 meses** depois da última atividade; **nome e telefone em agendamento: 12 meses** depois do fim do horário (a linha fica sem dado pessoal); **jobs concluídos no Redis: 1 hora, falhos: 24 horas, com limpeza de verdade**; **contas não confirmadas: 7 dias** (já existe); **convites pendentes: e-mail some 7 dias depois do vencimento** (já existe); **empresa excluída: 30 dias de carência e depois apagar tudo** (a linha da empresa e a cobrança ficam); **cobrança e pagamento: 5 anos** (a confirmar, S6); **auditoria: acompanha a empresa**; **backups: 35 dias**; **logs: 30 dias**. *Alternativas:* 6 meses (menos risco, menos histórico para a empresa) ou 24 meses (mais histórico, mais exposição). Quanto menor, menos dano em vazamento; quanto maior, mais valor para a empresa.
- **D4 Auditoria.** *Recomendação:* não expurgar por tempo (só tem ids) e apagar junto com a empresa. *Alternativa:* guardar 24 meses mesmo depois da exclusão da empresa, por segurança (precisa justificar).
- **D5 Contas inativas.** *Recomendação:* deixar para depois (sem dado de último acesso). *Alternativa:* medir último login e expurgar após 24 meses.
- **D6 O que sobra de uma empresa excluída.** *Recomendação:* a linha anonimizada (id e `slug` reservado) e a cobrança. *Alternativa:* liberar o `slug` (risco de alguém assumir o nome e receber webhooks antigos).
- **D7 Onde fica a página de exclusão.** *Recomendação:* dentro do app (`/exclusao-de-dados`), com link também a partir de `melhive.com.br/privacidade`. *Alternativa:* só em `melhive.com.br` (menos código, mas o texto some da vista do produto).
- **D8 Aviso de IA ao contato.** *Recomendação:* ligar, com a frase no fim da **primeira** resposta (custo zero); mostra transparência e protege a empresa. *Alternativas:* mensagem separada (1 mensagem Meta a mais por conversa nova) ou deixar a cargo da persona de cada empresa.
- **D9 Exclusão pela empresa vs pelo dono.** *Recomendação:* a empresa (`OWNER`) exclui sozinha com carência; o dono da plataforma restaura no prazo. *Alternativa:* só o dono exclui, por pedido por e-mail (mais simples, mais trabalho manual).

## Riscos

- **Apagar errado.** Mitigações: `dry-run`, predicado repetido, lotes pequenos, testes com duas empresas, carência de 30 dias para empresa.
- **Backups guardam o que já foi apagado.** Mitigação: retenção máxima de 35 dias, `erasure_ledger` e o `replay` obrigatório no runbook.
- **O `lookup` por telefone é uma busca por dado pessoal.** Mitigação: só dentro da empresa, só `OWNER`/`ADMIN`, nada devolvido além do rótulo mascarado, sem log.
- **Dado sensível em mensagens** (o contato conta qualquer coisa à IA): reduz-se com prazo curto e com o aviso; o enquadramento legal (J) e o RIPD são do advogado.
- **Suposições S1 a S8** podem mudar prazos e o desenho da E6; por isso a E0 vem antes do código.

## Decisões e dependências novas

Nenhuma dependência nova prevista (SQL cru dos purgers, BullMQ e `node:crypto` já existem). Migrations aditivas: `erasure_ledger`, índices dos purgers e, se a 031 permitir, a coluna de agendamento do expurgo da empresa (`companies.purge_after`, **aditiva e anulável**). Nova variável de ambiente: `RETENTION_ENABLED`, `RETENTION_DRY_RUN`, `RETENTION_MESSAGES_DAYS`, `RETENTION_APPOINTMENT_PII_DAYS`, `RETENTION_COMPANY_GRACE_DAYS`, `RETENTION_ERASURE_LEDGER_DAYS`, `QUEUE_CLEAN_INTERVAL_MINUTES`, `CONTACT_NOTICE_ENABLED`, `PRIVACY_URL` (tudo em `.env.example`, validado no módulo de config). Permissão nova `privacy:manage`. Métricas novas: `queue_janitor_*`, `retention_*`. Registrar D1 a D9 em `docs/context.md` depois da resposta do dono.
