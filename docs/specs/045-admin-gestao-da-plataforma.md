# 045 — Admin da plataforma: quem é dono e gestão completa (CRUD) de contas, empresas, vínculos, assinatura e canal

- **Status:** aprovada (pelo dono em 2026-11-25: D1 a D17 como recomendadas, "aprovo tudo"); E1 implementada na branch `spec/045-e1-pessoas` (aguarda CI e `reviewer`); E2 a E6 por fazer, na ordem
- **Branch:** `spec/045-admin-gestao` (esta spec); cada etapa em branch própria a partir da `main` (`spec/045-e1-pessoas`, `spec/045-e2-contas`, ...)
- **Depende de:** 044 (admin, sessão com segundo fator, `PlatformAuditEvent`, leitura agregada), 008 (papéis, regra do último `OWNER`, trava da empresa), 017/020/021 (contas, confirmação, recuperação de senha, `revokeAll`), 025 (convites), 015/023/039 (canal), 031/040 (assinatura), 032 (E7 excluir conta e E8 excluir empresa, ainda não implementadas: esta spec cruza com as duas).
- **Spec de segurança:** cada etapa passa pelo `reviewer` antes do merge. Ela abre as **primeiras escritas da plataforma sobre contas, vínculos, assinatura e canal**, muda o contrato do convite (convidador que não é vínculo) e amplia as decisões D1 e D7 da 044.
- **Pedido do dono (2026-11-25, olhando o detalhe de uma empresa no admin em produção):** (1) "aqui na visão geral da empresa não consigo saber de quem é a empresa"; (2) "eu quero que o admin também consiga editar os dados das contas, empresas, canal, etc"; (3) complemento: "deve ter o crud completo".

## Objetivo

O admin da plataforma passa a (a) mostrar quem é dono e quem faz parte de cada empresa, com ligação para a conta, e (b) criar, ler, editar e remover contas, empresas, vínculos, assinatura e canal, cada operação com regra, motivo, trilha na mesma transação e, nas de impacto, confirmação reforçada. Onde a operação literal é perigosa (o admin digitar senha, ver ou colar token, trocar e-mail sem prova), a spec entrega o mesmo resultado por um caminho seguro e marca a escolha como decisão do dono.

## Estado atual (conferido no código em 2026-11-25, `main` em `f633298`)

- **Por que o dono não aparece:** o detalhe da empresa (`PlatformMonitorService.companyDetail`) mostra os vínculos só como **contagens** por papel e estado, e o "titular" (`holder`) vem da **assinatura** (`companies.subscription_id -> subscriptions.account_id`, em `platform-read-model.ts`). Com `BILLING_ENABLED=false` (ou empresa ainda não adotada) o titular é sempre `null`. Não há lista de pessoas nem ligação para a conta.
- **Conta (`Account`, global):** `email`, `status` (`ACTIVE`/`DISABLED`), `emailVerifiedAt`, códigos de confirmação e de recuperação; **não tem nome**. `DISABLED` já barra o login e cada uso do cookie (`AccountService.credentials` e `session`), mas nenhuma rota muda esse estado. `AccountSessionStore.revokeAll(accountId)` existe (021). O detalhe `GET /platform/accounts/:accountId` sempre devolve o e-mail completo e grava `ACCOUNT_EMAIL_VIEWED`; o app só o chama no botão "Mostrar e-mail".
- **Escritas da plataforma hoje:** só `POST /platform/companies/:companyId/suspend|reactivate` (motivo, trava, trilha). Pelo Bearer da plataforma (login com senha e, com o admin ligado, o código TOTP) continuam `POST /admin/companies` (cria, aceita `status`), `PATCH /admin/companies/:id` (só `name`) e `DELETE /admin/companies/:id` (soft delete), **sem** `PlatformAuditEvent`.
- **Trilha da empresa (`AuditEvent`, tenant):** `actor_membership_id` é `NOT NULL` com FK composta para `memberships`. A plataforma **não consegue** gravar nela; hoje toda ação da plataforma vai só para `PlatformAuditEvent` (global: `adminId`, `action`, `subjectCompanyId`, `subjectAccountId`, `reason`).
- **Convite (`CompanyInvitation`, tenant, 025):** `invited_by_membership_id` `NOT NULL` (FK composta), CHECK `role <> 'OWNER'`; o aceite reconfere que o convidador continua ativo e com `membership:manage`. A plataforma não consegue convidar.
- **Vínculo (`Membership`):** nunca é apagado (`Restrict`, a trilha aponta para ele); "sair" é `DISABLED`. A regra do último `OWNER` e a trava da empresa ficam em `MembershipAdminService` / `MembershipAdminUnitOfWork.lockCompany`; a hierarquia (`canManageRole`) é de vínculo para vínculo.
- **Assinatura (`Subscription`, global, uma por conta):** nenhuma escrita fora do checkout (`CheckoutService`, `PrismaCheckoutRepository.grantPaidOrder`, com a trava `FOR NO KEY UPDATE` da linha da assinatura). A renovação **não é automática**: a pessoa paga um link; o pedido `RENEWAL` usa o plano, o ciclo e os módulos atuais (ou a troca agendada).
- **Canal:** `ChannelConnectionService.disconnect(actor: MembershipIdentity)` apaga a conexão, limpa `Company.whatsappPhoneNumberId`, grava `CHANNEL_DISCONNECTED` na trilha da empresa e, em melhor esforço, desassina o app da WABA inteira. Conectar exige prova de posse (token do nosso app, número na WABA), só pela empresa.
- **Spec 032 (aprovada, não implementada nessas partes):** E7 define "excluir a própria conta" como **anonimização** (e-mail `removida-<uuid>@excluido.invalid`, senha inválida, `DISABLED`, vínculos anonimizados e desativados, recusas `COMPANY_OWNERSHIP` e `SUBSCRIPTION_ACTIVE`); E8 define a exclusão da empresa com carência de 30 dias, `purge_after`, **restauração pelo `PlatformAdmin`** e expurgo definitivo.

## O que muda nas decisões da spec 044

- **D1 (só suspender e reativar; "qualquer ação nova é spec própria, com regra e auditoria"):** esta é a spec própria. Passam a existir as ações da matriz abaixo, **cada uma** com regra, motivo, trilha na mesma transação e teste. A regra de fundo da D1 continua: nenhuma escrita da plataforma sem `PlatformAuditEvent`, e nenhuma escrita fora de `/platform/*` (D12 abaixo fecha o Bearer de `/admin/companies`).
- **D7 (e-mail mascarado nas listas, completo só no detalhe da conta, cada leitura auditada):** **mantida no princípio, com uma mudança de contrato.** O detalhe da empresa passa a listar as pessoas com o e-mail **mascarado** e a ligação para a conta; o e-mail completo sai **só** de uma rota própria (`GET /platform/accounts/:accountId/email`), que grava `ACCOUNT_EMAIL_VIEWED`. O detalhe da conta deixa de trazer o e-mail completo (vem mascarado, sem gravar nada), para que abrir uma conta a partir da empresa não conte como leitura do e-mail. Novidade de dado pessoal: o admin **digita** um e-mail ao convidar (E3); ele fica no convite só enquanto pendente, como no convite da 025.
- **D8 (a plataforma não lê nem altera conteúdo da empresa):** **mantida** (D17). Persona, conhecimento, estoque, agenda e conversas continuam fora do admin; nome da empresa, vínculos, assinatura e canal são dados de **operação** do SaaS, não conteúdo.
- **D9 (trilha da plataforma):** ampliada: ações novas no enum e colunas novas, anuláveis e tipadas (sem texto livre): `subject_membership_id`, `subject_invitation_id`, `from_role`, `to_role`, `plan_code`, `days`, `module_schedule`, `module_inventory`.

## Matriz do CRUD (o pedido do dono)

| Entidade | Criar | Ler | Editar | Remover |
| --- | --- | --- | --- | --- |
| **Conta** | Pelo **convite** para uma empresa (E3): a conta nasce quando a pessoa abre o link do e-mail e define a própria senha (D4) | Lista e detalhe mascarados; e-mail completo só pela rota auditada (E1) | Desativar/reativar, encerrar sessões, enviar código de recuperação de senha, reenviar código de confirmação (E2). **E-mail:** não editável pelo admin; caminho seguro na D5. **Senha:** nunca vista nem definida (D6). **Nome:** a conta não tem nome | **Anonimizar** (efeitos da 032 E7), com recusas e confirmação reforçada (E6, D16) |
| **Empresa** | Nome + slug + e-mail de quem será o `OWNER`, que recebe um convite de titular (E3) | Já existe (044); ganha pessoas e dono (E1) e as removidas (E3) | Renomear (E3). Suspender/reativar já existem. **Slug:** não editável (D10) | Soft delete com restauração pelo admin (E3, D11) |
| **Vínculo (pessoa na empresa)** | Convite da plataforma, qualquer papel, inclusive `OWNER` (E3, D8) | Lista de pessoas da empresa (E1) e empresas da conta (já existe) | Mudar papel (inclui transferir a propriedade), desativar/reativar, com a regra do último `OWNER` (E3) | **Desativar** (vínculo nunca é apagado: a trilha aponta para ele); convites pendentes: revogar (E3) |
| **Assinatura e módulos** (só com `BILLING_ENABLED`) | Iniciar teste gratuito para conta sem assinatura (E4) | Já existe (044) | Conceder dias, liberar/retirar módulos, trocar plano sem cobrança, cancelar no fim do período e desfazer (E4, D13) | **Encerrar agora** (a linha e os pedidos ficam: guarda fiscal de 5 anos, 032) (E4, D14) |
| **Canal** (só com `WHATSAPP_ENABLED`) | **Só a empresa** conecta (prova de posse da Meta); o admin não vê nem cola token (D15) | Já existe (044) | Não há edição segura de número/WABA/token pelo admin: o equivalente é desconectar e o `OWNER` reconectar (D15) | Desconectar (inclusive liberar número `LEGACY` preso) (E5) |

## Comportamento esperado

### Regras comuns a toda escrita (todas as etapas)

1. **Rotas** só em `/platform/*`, registradas dentro do plugin da E1 da 044 (cookie com segundo fator; Bearer ignorado), com `requirePlatform()` e perfil `admin` (o inventário de `rate-limit.test.ts` já exige). Escrita = `POST`, com `Origin = ADMIN_ORIGIN` e `X-Soprei-App: admin` (403 sem eles, nada gravado). Corpo Zod `strict`. Id malformado, inexistente ou de outra empresa = **404 uniforme**.
2. **Motivo obrigatório** em toda escrita: `reason` do enum que já existe (`PAYMENT`, `ABUSE`, `OWNER_REQUEST`, `OTHER`). Fora da lista = 400.
3. **Confirmação reforçada (D2)** nas ações de impacto (marcadas com **[código]** abaixo): o corpo leva `code`, um código TOTP **novo** do admin, conferido por `claimTotpStep` (o mesmo passo não vale duas vezes, nem o já usado no login). Código errado = 400 `CONFIRMATION_INVALID` sem efeito e conta no bloqueio por conta do login da plataforma (`['p', e-mail]`); estourado, 429 com `Retry-After` antes de conferir. Remover empresa exige também o `slug` digitado.
4. **Uma transação por ação**, nesta ordem: trava (linha de `companies` com `lockCompanyRow`, a mesma da 008/044; linha de `accounts` ou de `subscriptions` com `FOR NO KEY UPDATE` quando a ação é da conta ou da assinatura; sempre empresa antes de conta antes de assinatura, como no aceite da 025), releitura do estado, regra, escrita e `PlatformAuditEvent`. Sem trilha gravada, nada muda.
5. **Idempotente:** pedir o estado em que a coisa já está responde 204 **sem** novo evento (como suspender).
6. **Sessões depois do commit:** quando a ação tira acesso (desativar conta, desativar vínculo, mudar papel), revoga as sessões afetadas **depois** do commit (`AccountSessionStore.revokeAll` e, para vínculos, `revokeAllSessions(companyId, membershipId)` das sessões Bearer, como a 008). Redis fora = 503 com a mudança e a trilha já gravadas (regra da 008); repetir o pedido refaz a revogação. O cookie da conta já relê conta e vínculo a cada requisição.
7. **E-mails** (convite, código de recuperação, código de confirmação, aviso de conta excluída) saem em segundo plano **depois** do commit, com os textos e assuntos fixos que já existem; falha de SMTP só em métrica e log.
8. **Privacidade:** log só com `adminId`, ids, ação e motivo; nada de e-mail, nome de empresa, senha, código, token ou PIN. Métrica `platform_actions_total{action}` com os valores novos (conjunto fixo). A trilha não guarda texto livre nem e-mail.
9. **Migrations aditivas** (valores de enum e colunas anuláveis). A única exceção é a do convite (E3, D8), que relaxa restrições e leva a linha `-- breaking-approved: <motivo>` exigida pelo `deploy.sh`.
10. **App `admin/`:** toda ação abre um `<dialog>` que diz em português o efeito ("A pessoa perde o acesso a todas as empresas na hora"), com o motivo numa lista, o campo do código nas ações **[código]** e, na remoção da empresa, o slug digitado; botão ocupado durante o envio; erros por `status` e `error.code`; depois do sucesso a tela relê o detalhe. Contratos novos em `admin/src/contracts.ts` e nas fixturas.
11. **Acesso a dados:** escritas pelos repositórios e unidades de trabalho, com `CompanyId` como primeiro parâmetro nos models de tenant e `companyId` no `where` (`tenant-scope`); nenhum SQL cru novo fora de `infrastructure/database/` e, dentro dela, só as travas que já existem e as leituras novas de `platform-read-model.ts`.

### E1 — Quem é dono e quem faz parte (só leitura; maior valor, menor risco)

- **`GET /platform/companies/:companyId`** ganha `people`: até 50 vínculos da empresa, `OWNER` primeiro, depois por papel e por `createdAt`: `{ membershipId, accountId | null, emailMasked, role, status, createdAt, account: { status, verified } | null }` (`accountId` nulo = vínculo antigo da CLI, sem conta; aí o e-mail mascarado vem do vínculo). Mais `peopleTotal` e `pendingInvitations` (contagem). `holder` continua (titular da assinatura). O e-mail mascarado é montado **no banco**, com a mesma expressão da lista de contas (primeira letra e domínio).
- **`GET /platform/companies`** ganha `owner: { accountId | null, emailMasked } | null` (o `OWNER` ativo mais antigo) e `owners` (quantos `OWNER` ativos), para achar empresa sem dono ou com dono desativado. Busca `q` continua só em nome e slug.
- **Contas (mudança de contrato, D3):** `GET /platform/accounts/:accountId` devolve `emailMasked` (não mais `email`) e **não grava nada**; novo `GET /platform/accounts/:accountId/email` devolve `{ email }` e grava `ACCOUNT_EMAIL_VIEWED` **antes** de responder (sem registro, o e-mail não sai), como hoje.
- **Leitura:** as consultas novas ficam em `platform-read-model.ts`, filtradas por `company_id` (detalhe) ou agregadas por empresa (lista, `LATERAL` com `company_id = co.id`), com `statement_timeout` de 3 s. O teste de colunas do módulo passa a aceitar `memberships.email` e `accounts.email` **só** dentro da expressão de máscara (e `accounts.email` sem máscara só na leitura da rota auditada).
- **App:** no detalhe da empresa, seção **Pessoas** (papel, estado, e-mail mascarado, "conta desativada"/"e-mail não confirmado", botão "Abrir conta"), o dono em destaque no topo ("Dono: l***@exemplo.com") e um aviso "Empresa sem dono ativo" quando `owners = 0`. "Abrir conta" carrega o detalhe mascarado; "Mostrar e-mail" chama a rota auditada. Na lista de empresas, coluna "Dono".
- **Sem migration.**

### E2 — Contas: editar com segurança

- `POST /platform/accounts/:accountId/disable` **[código]** e `.../enable`, `{ reason, code? }`: grava `status`, trilha `ACCOUNT_DISABLED`/`ACCOUNT_ENABLED`. Desativar **recusa** com 409 `LAST_OWNER` se a conta é a única `OWNER` ativa de alguma empresa **ativa e não removida** (D7): o admin suspende a empresa ou transfere a propriedade antes. Depois do commit, `revokeAll(accountId)` e a revogação das sessões Bearer de cada vínculo da conta. Reativar não restaura sessões nem mexe nos vínculos.
- `POST /platform/accounts/:accountId/sessions/revoke` `{ reason }`: só `revokeAll` + as Bearer dos vínculos; trilha `ACCOUNT_SESSIONS_REVOKED` (gravada antes da revogação; a revogação em si não é transacional).
- `POST /platform/accounts/:accountId/password-reset` `{ reason }` (D6): o servidor lê o e-mail pelo id e chama o mesmo caminho da 021 (`issueResetCode` + envio em segundo plano), com **as mesmas travas** (só conta confirmada e ativa, 60 s entre pedidos, teto de 10 erros em 24 h). Responde sempre 202; trilha `ACCOUNT_PASSWORD_RESET_SENT` em todo pedido aceito pela validação (o resultado `issued`/`ignored` vai só à métrica da 021). A pessoa define a senha nova pelo `/recuperar-senha`; o admin nunca vê código nem senha.
- `POST /platform/accounts/:accountId/verification/resend` `{ reason }`: só para conta **não confirmada**; reemite o código de 6 dígitos da 020 pelo id da conta (mesmo intervalo de 60 s e teto de 25 erros, sem pedir a senha da pessoa); 202; trilha `ACCOUNT_VERIFICATION_SENT`. Conta já confirmada = 409 `ALREADY_VERIFIED`. O admin **não** marca e-mail como confirmado (pularia a prova de posse).
- **Migration:** valores `ACCOUNT_DISABLED`, `ACCOUNT_ENABLED`, `ACCOUNT_SESSIONS_REVOKED`, `ACCOUNT_PASSWORD_RESET_SENT`, `ACCOUNT_VERIFICATION_SENT` em `platform_audit_action`.
- **App:** no detalhe da conta, "Desativar conta"/"Reativar conta", "Encerrar sessões", "Enviar código de recuperação de senha" (só conta confirmada e ativa) e "Reenviar código de confirmação" (só não confirmada).

### E3 — Empresas, vínculos e convites

- **Convite da plataforma (D8):** migration em `company_invitations`: `invited_by_membership_id` passa a anulável; coluna nova `invited_by_admin_id` (FK `platform_admins`, `RESTRICT`); CHECK "exatamente um dos dois"; o CHECK do papel vira `role <> 'OWNER' OR invited_by_admin_id IS NOT NULL` (só a plataforma convida `OWNER`). A migration leva `-- breaking-approved: relaxa NOT NULL e CHECK do convite (convidador da plataforma); a versão anterior continua gravando o convidador de vínculo`. O aceite (`accept` e `accept-new`, 025) reconfere o convidador: se for admin, ele precisa estar `ACTIVE`; o resto do aceite não muda (mesmo e-mail no `accept`; `accept-new` cria a conta já confirmada, porque o link no e-mail prova a posse, e substitui a senha de conta não confirmada). Rotas:
  - `POST /platform/companies/:companyId/invitations` `{ email, role, reason }` (qualquer papel): mesmas regras da 025 (409 `MEMBER_ALREADY_EXISTS`, 409 `INVITATION_ALREADY_PENDING`, 20 pendentes e 30 envios por empresa em 24 h contados sob a trava, 3 e-mails por destinatário por dia no Redis), com a cota do convidador trocada por **50 por admin por dia** (chave por HMAC do `adminId`). O `create` não consulta `accounts` (sem enumeração). Trilha `INVITATION_CREATED_BY_PLATFORM` com `subject_invitation_id` e `to_role`. Empresa suspensa ou removida = 409 `COMPANY_INACTIVE`.
  - `GET /platform/companies/:companyId/invitations`: pendentes, com `emailMasked`, papel, validade e envios (nunca o e-mail inteiro nem o token).
  - `POST .../invitations/:invitationId/resend` e `.../revoke` `{ reason }`: mesmas regras da 025 (reenvio a cada 60 s, até 6 envios), para **qualquer** convite pendente da empresa; trilha `INVITATION_RESENT_BY_PLATFORM` / `INVITATION_REVOKED_BY_PLATFORM`.
- **Vínculos** (o `:membershipId` é procurado **com** o `companyId` do caminho; de outra empresa = 404):
  - `POST /platform/companies/:companyId/memberships/:membershipId/role` `{ role, reason, code? }` (**[código]** quando o papel de origem ou de destino é `OWNER`): sem a hierarquia de vínculo (a plataforma está acima dela), mas com a regra do **último `OWNER`** na mesma transação, com a empresa travada (409 `LAST_OWNER`). Promover a `OWNER` exige vínculo `ACTIVE` e conta `ACTIVE` e confirmada (409 `MEMBER_NOT_ELIGIBLE`). **Transferir a propriedade** = promover a outra pessoa e depois rebaixar a antiga (duas ações, a regra do último `OWNER` protege o meio). Trilha `MEMBERSHIP_ROLE_CHANGED_BY_PLATFORM` com `subject_membership_id`, `from_role`, `to_role`. Revoga as sessões Bearer do vínculo depois do commit.
  - `POST .../memberships/:membershipId/disable` e `.../enable` `{ reason }`: "remover a pessoa da empresa" = desativar (o vínculo nunca é apagado). Último `OWNER` ativo = 409 `LAST_OWNER`. Reativar exige a conta `ACTIVE`. Trilha `MEMBERSHIP_DISABLED_BY_PLATFORM` / `MEMBERSHIP_ENABLED_BY_PLATFORM`.
- **Empresas:**
  - `POST /platform/companies` `{ name, slug, ownerEmail, reason }`: cria a empresa `ACTIVE` e, na **mesma** transação, o convite de `OWNER` para `ownerEmail` (D4). Slug repetido (inclusive de empresa removida, que fica reservado) = 409 `SLUG_TAKEN`. A empresa nasce sem assinatura; com a cobrança ligada, ela é **adotada** pela assinatura do `OWNER` quando ele aceitar (regra da 031; a adoção não confere `maxCompanies`, ver "Casos de borda"). Trilha `COMPANY_CREATED` e `INVITATION_CREATED_BY_PLATFORM`.
  - `POST /platform/companies/:companyId/rename` `{ name, reason }` (1 a 120 caracteres, as regras de `CompanyService`): trilha `COMPANY_RENAMED` (sem o nome antigo nem o novo).
  - `POST /platform/companies/:companyId/remove` **[código]** `{ reason, slug, code }`: `slug` diferente = 400 `CONFIRMATION_MISMATCH`. Reusa o soft delete (`CompanyRepository.delete`: `deletedAt`, número liberado, conexão do canal apagada) e, depois do commit e em melhor esforço, desassina o app da WABA (como o `DELETE .../channel`). Convites pendentes da empresa são revogados na mesma transação. Trilha `COMPANY_REMOVED`. Os vínculos deixam de entrar na requisição seguinte (a empresa some de `listMemberships`).
  - `POST /platform/companies/:companyId/restore` **[código]** `{ reason, code }`: limpa `deletedAt` (o canal precisa ser reconectado pelo `OWNER`); trilha `COMPANY_RESTORED`. Sem expurgo definitivo nesta spec (D11: fica com a 032 E8, que acrescenta `purge_after`).
  - `GET /platform/companies?status=removed` lista as removidas e o detalhe de uma removida passa a responder (com `removedAt`), para poder restaurar; as contagens do overview continuam sem elas.
  - **Bearer de `/admin/companies` (D12):** com `PLATFORM_ADMIN_ENABLED=true`, `POST`, `PATCH` e `DELETE /admin/companies[/:id]` respondem 403 `USE_PLATFORM_ADMIN` (a leitura continua); com o admin desligado, nada muda.
  - **Slug:** não editável (D10).
- **Migration:** a do convite, mais os valores `COMPANY_CREATED`, `COMPANY_RENAMED`, `COMPANY_REMOVED`, `COMPANY_RESTORED`, `INVITATION_CREATED_BY_PLATFORM`, `INVITATION_RESENT_BY_PLATFORM`, `INVITATION_REVOKED_BY_PLATFORM`, `MEMBERSHIP_ROLE_CHANGED_BY_PLATFORM`, `MEMBERSHIP_DISABLED_BY_PLATFORM`, `MEMBERSHIP_ENABLED_BY_PLATFORM` e as colunas `subject_membership_id` (FK `memberships`, `RESTRICT`), `subject_invitation_id` (FK `company_invitations`, `RESTRICT`), `from_role` e `to_role` (`membership_role`) em `platform_audit_events`. `TestTenants.cleanup` apaga a trilha da plataforma que aponta para vínculos e convites antes de apagá-los.
- **App:** "Nova empresa" na lista; no detalhe, "Renomear", "Remover empresa" (com slug digitado e código), "Restaurar" (removidas); na seção Pessoas, "Convidar pessoa" (e-mail e papel, só em memória, limpo ao enviar), "Mudar papel", "Desativar"/"Reativar" e a lista de convites pendentes com "Reenviar" e "Revogar".

### E4 — Assinatura e módulos (só com `BILLING_ENABLED=true`; desligada, as rotas respondem 409 `BILLING_DISABLED`)

Todas em `/platform/accounts/:accountId/subscription/...` (a assinatura é da conta), com a trava da conta e depois a da assinatura, e as regras do domínio (`resolveAccess`, `effectiveQuotas`, `subscriptionWindows`). **Pedido de pagamento `PENDING` da assinatura** = 409 `ORDER_PENDING` (o admin espera o pedido vencer ou ser pago: um pedido pago depois de uma mudança do admin cairia em `renewal_stale`/`upgrade_stale` e em revisão manual).

- `.../trial` `{ reason }` (**criar**): só se a conta **não** tem assinatura; cria o teste gratuito como a 031 (Essencial, Agenda e Estoque, `BILLING_TRIAL_*`) e adota as empresas em que a conta é `OWNER` sem assinatura. Trilha `SUBSCRIPTION_TRIAL_STARTED`.
- `.../extend` `{ days: 1..90, reason }`: soma `days` ao fim do período (ou do teste, se `TRIAL`), a partir de `max(agora, fim atual)`; assinatura vencida ou em carência volta a `ACTIVE` (teste continua `TRIAL`); o uso já contado na janela fica. Trilha `SUBSCRIPTION_EXTENDED` com `days`.
- `.../modules` `{ agenda, stock, reason }`: liga ou desliga Agenda e Estoque na hora, sem cobrança; a **renovação seguinte cobra o que estiver ligado** (D13); a tela de Assinatura da pessoa já mostra o preço antes de ela pagar. Trilha `SUBSCRIPTION_MODULES_CHANGED` com `module_schedule` e `module_inventory`.
- `.../plan` `{ planCode, reason }`: troca o plano na hora, mesmo ciclo, sem cobrança, com a trava de empresas (409 `PLAN_DOWNGRADE_BLOCKED`, contando as não adotadas); apaga a troca agendada (`pendingChange`). Mesma regra da renovação (D13). Trilha `SUBSCRIPTION_PLAN_CHANGED` com `plan_code`.
- `.../cancel` e `.../reactivate` `{ reason }`: `cancelAtPeriodEnd` ligado ou desligado (as mesmas regras de `plan-change` da 031: sem assinatura paga em vigor = 409 `PLAN_CHANGE_UNAVAILABLE`). Trilha `SUBSCRIPTION_CANCELLED` / `SUBSCRIPTION_REACTIVATED`.
- `.../end` **[código]** `{ reason, code }` (**remover**, D14): `status = EXPIRED`, `currentPeriodEnd = agora`, `cancelAtPeriodEnd = true`, sem carência; o atendimento das empresas da conta para (gate e cota). A linha, os pedidos, o uso e os avisos **ficam** (guarda fiscal). Trilha `SUBSCRIPTION_ENDED`.
- Nada de estorno nem de pedido em nome da pessoa: dinheiro só passa pelo checkout dela.
- **Migration:** os valores `SUBSCRIPTION_*` e as colunas `plan_code` (`plan_code`), `days` (`smallint`), `module_schedule` e `module_inventory` (`boolean`) em `platform_audit_events`.
- **App:** no detalhe da conta (e no da empresa, apontando para a conta titular), "Conceder dias", "Módulos", "Trocar plano", "Cancelar no fim do período"/"Desfazer cancelamento", "Iniciar teste" e "Encerrar agora".

### E5 — Canal (só com `WHATSAPP_ENABLED=true`)

- `POST /platform/companies/:companyId/channel/disconnect` **[código]** `{ reason, code }`: o mesmo efeito do `DELETE .../channel` da empresa (conexão apagada, inclusive o PIN cifrado; `whatsappPhoneNumberId` limpo; desassinar o app da WABA em melhor esforço depois do commit), na transação com a trava da empresa e a trilha `CHANNEL_DISCONNECTED_BY_PLATFORM` (não grava na trilha da empresa, D9). Vale também para empresa `LEGACY` (número sem conexão): só limpa o número, liberando-o para a empresa certa. Sem conexão nem número = 204 sem evento. `ChannelConnectionService.disconnect` passa a receber o ator como união (vínculo ou plataforma), sem mudar o caminho da empresa.
- As mensagens pendentes ficam pendentes; mensagens novas para o número caem em `unknown_number` até alguém reconectar.
- **Criar e editar não existem no admin (D15):** o `OWNER` reconecta pelo site (Embedded Signup, com prova de posse). O admin não vê, não digita e não recebe token, PIN nem `code` da Meta.
- **Migration:** valor `CHANNEL_DISCONNECTED_BY_PLATFORM`.
- **App:** no detalhe da empresa, "Desconectar WhatsApp", com o aviso de que a WABA inteira é desassinada e de que o `OWNER` precisa reconectar.

### E6 — Remover conta (anonimizar)

- `POST /platform/accounts/:accountId/anonymize` **[código]** `{ reason, code, confirm: 'EXCLUIR' }` (D16): recusa 409 `COMPANY_OWNERSHIP` se a conta é a única `OWNER` ativa de alguma empresa não removida, e 409 `SUBSCRIPTION_ACTIVE` se há período pago em vigor sem `cancelAtPeriodEnd` (o admin usa antes a E3 ou a E4). Efeito = o da 032 E7: `revokeAll` antes (503 sem nada alterado se o Redis falhar), transação que anonimiza conta e vínculos (`removida-<uuid>@excluido.invalid`, senha inválida fixa, `DISABLED`, `last_company_id`, códigos e contadores zerados), trilha `ACCOUNT_ANONYMIZED` (a linha da conta continua existindo, então `subject_account_id` não vira nulo), `revokeAll` de novo depois do commit, e o e-mail "Conta excluída" para o endereço lido **antes** da transação. `subscriptions` e `payment_orders` ficam ligados à conta anonimizada.
- O núcleo fica num serviço único (`AccountAnonymizer`, `application/auth/`) que a 032 E7 reaproveita para a exclusão pela própria pessoa.
- **Migration:** valor `ACCOUNT_ANONYMIZED`.
- **App:** "Excluir conta (anonimizar)", com o texto do que some e do que fica, o código e a palavra `EXCLUIR` digitada.

## Critérios de aceite

Comuns (provados em cada etapa para as rotas dela):

- [ ] Toda rota nova de `/platform/*` aparece no inventário com `requirePlatform()` e perfil `admin`; Bearer de vínculo, Bearer de plataforma e cookie da conta recebem 401/403 e nada é gravado.
- [ ] Toda escrita nova sem `Origin = ADMIN_ORIGIN` ou sem `X-Soprei-App: admin` é 403 e nada é gravado; corpo com campo a mais ou `reason` fora da lista é 400.
- [ ] Toda escrita que muda estado grava exatamente um `PlatformAuditEvent` com a ação, o `adminId`, o sujeito e o motivo, **na mesma transação** (teste com falha forçada na gravação da trilha: o estado não muda); repetir o pedido no mesmo estado responde 204 sem novo evento.
- [ ] Ação **[código]** sem `code`, com código errado ou com o código já usado no login é 400 `CONFIRMATION_INVALID` sem efeito; depois de `AUTH_LOGIN_MAX_FAILURES` erros, 429 com `Retry-After` (inclusive no login da plataforma).
- [ ] Teste de privacidade das rotas novas (log capturado, `/metrics`, corpos de erro): nenhum e-mail, nome de empresa, código, senha, token ou PIN; a trilha não tem e-mail.
- [ ] Admin (Playwright, API falsa, desktop e celular, claro e escuro): cada ação da etapa abre o diálogo, exige motivo (e código e slug quando pedidos), envia o corpo esperado e relê a tela; 360 px sem rolagem horizontal; nada em `localStorage`/`sessionStorage`.

E1:

- [ ] O detalhe da empresa A lista as pessoas de A (com o `OWNER` primeiro e o e-mail mascarado) e nunca as de B; a lista de empresas traz o dono de cada uma e `owners = 0` para empresa sem dono ativo (integração com duas empresas, Postgres real). _Teste escrito em `platform-admin.integration.test.ts`; não rodou localmente (sem `.env.test` nesta máquina): marcar depois do CI verde._
- [x] Com `BILLING_ENABLED=false`, o dono aparece (o pedido do dono: o titular deixa de depender da assinatura).
- [x] `GET /platform/accounts/:accountId` traz só `emailMasked` e não grava nada; `GET .../email` grava um `ACCOUNT_EMAIL_VIEWED` antes de responder e, com a gravação falhando, não devolve o e-mail.
- [x] O teste de colunas de `platform-read-model.ts` aceita `email` só dentro da expressão de máscara (e na leitura da rota auditada) e continua recusando as colunas de conteúdo.

E2:

- [ ] Desativar conta: status gravado, trilha, `revokeAll` e sessões Bearer dos vínculos revogadas depois do commit; o cookie dela recebe 401 na requisição seguinte; conta única `OWNER` ativa de empresa ativa = 409 `LAST_OWNER` sem efeito; com a empresa suspensa, desativa.
- [ ] Redis fora na revogação = 503 com a conta já desativada e a trilha gravada; repetir refaz só a revogação.
- [ ] Código de recuperação pelo admin: 202 sempre; conta confirmada e ativa recebe o e-mail (mailer falso) e o código funciona em `POST /auth/password-reset/confirm`; um segundo pedido em menos de 60 s não envia; conta não confirmada ou desativada não recebe nada.
- [ ] Reenviar confirmação: só conta não confirmada (409 `ALREADY_VERIFIED` na confirmada); o código enviado confirma pelo `POST /auth/verify-email`.

E3:

- [ ] Migration do convite: convite com os dois convidadores ou nenhum é recusado pelo banco; `OWNER` com convidador vínculo é recusado; `OWNER` com convidador admin é aceito; convites antigos continuam válidos (teste em schema temporário, como o da 025).
- [ ] Convite da plataforma aceito por conta existente (mesmo e-mail) e por pessoa nova (`accept-new`) cria o vínculo com o papel pedido; admin desativado entre o convite e o aceite fecha o convite como `REVOKED` (falha uniforme).
- [ ] Mudar papel: rebaixar o último `OWNER` ativo = 409 `LAST_OWNER`; promover B e depois rebaixar A transfere a propriedade; duas transferências concorrentes nunca deixam a empresa sem `OWNER` ativo (Postgres real); `:membershipId` de outra empresa = 404 e nada muda.
- [ ] Criar empresa grava empresa e convite de `OWNER` na mesma transação (falha no convite = nenhuma empresa); slug repetido, inclusive de removida, = 409 `SLUG_TAKEN`.
- [ ] Remover empresa: slug errado = 400 sem efeito; certo = soft delete, número liberado, conexão apagada, convites pendentes revogados, desassinatura em melhor esforço (falha da Meta não desfaz nada); os membros perdem o acesso na requisição seguinte; restaurar devolve a empresa sem canal.
- [ ] Com `PLATFORM_ADMIN_ENABLED=true`, `POST`/`PATCH`/`DELETE /admin/companies` com Bearer da plataforma = 403 `USE_PLATFORM_ADMIN`; com ele desligado, o comportamento de hoje.

E4:

- [ ] Cobrança desligada = 409 `BILLING_DISABLED` em todas as rotas de assinatura, sem efeito.
- [ ] Conceder dias numa assinatura vencida além da carência devolve `access: ok` até o novo fim; numa em teste, estende o teste; o uso já contado não zera.
- [ ] Liberar Agenda faz `GET /admin/companies/:id/entitlements` da empresa da conta liberar o módulo na hora; a cotação da renovação (`GET /account/billing/quote`) passa a incluir o módulo.
- [ ] Trocar para um plano que não comporta as empresas = 409 `PLAN_DOWNGRADE_BLOCKED`; com pedido `PENDING` = 409 `ORDER_PENDING`; nada muda em nenhum dos dois.
- [ ] Encerrar agora: o atendimento da empresa fica bloqueado (o provedor não é chamado), a linha e os pedidos continuam no banco.
- [ ] Iniciar teste em conta que já tem assinatura = 409 `SUBSCRIPTION_EXISTS`.

E5:

- [ ] Desconectar: conexão e número removidos, trilha da plataforma gravada, nada na trilha da empresa; o webhook do número passa a `unknown_number`; empresa `LEGACY` tem só o número limpo; a desassinatura que falha não desfaz nada; nenhuma resposta, log ou métrica traz token, PIN ou WABA inteira.

E6:

- [ ] Anonimizar: recusas `COMPANY_OWNERSHIP` e `SUBSCRIPTION_ACTIVE` sem efeito; caso aceito, e-mail e vínculos anonimizados, sessões revogadas, o e-mail original livre para um cadastro novo que não herda nada, aviso enviado ao endereço antigo; Redis fora antes da transação = 503 sem nada alterado.

Fecho de cada etapa:

- [ ] `pnpm typecheck`, `pnpm lint` e `pnpm format:check` verdes; CI verde (`static`, `tests`, `browser`).

## Casos de borda e erros

- **Dois admins (ou duas abas) agindo na mesma empresa ou conta:** a trava serializa; o segundo relê o estado e recebe 204 sem evento (mesmo estado) ou o erro da regra (`LAST_OWNER`, `ORDER_PENDING`).
- **Admin agindo ao mesmo tempo que a empresa:** a gestão de vínculos da empresa e a da plataforma travam a mesma linha de `companies`, então a regra do último `OWNER` vale entre os dois lados.
- **Código TOTP já usado no login:** recusado; o admin espera o próximo (até 30 s). O diálogo diz isso.
- **Empresa sem dono** (criada pelo admin e convite ainda não aceito, ou vínculo `OWNER` desativado): aparece com o aviso; as ações seguem possíveis; a regra do último `OWNER` só protege empresa que tem `OWNER` ativo.
- **Convite de `OWNER` vencido ou revogado** numa empresa criada pelo admin: a empresa fica sem dono até um convite novo; o admin pode remover a empresa.
- **Adoção sem conferir `maxCompanies`:** a empresa criada pelo admin e aceita por um `OWNER` com assinatura é adotada mesmo que passe do limite do plano (como a adoção que já existe). Efeito: o downgrade dele fica bloqueado até ele remover empresas. É concessão consciente do admin; o diálogo de "Nova empresa" avisa.
- **Conta desativada que é `OWNER` de empresa suspensa:** desativa (a regra só olha empresa ativa); se a empresa for reativada depois, ela fica sem dono ativo e o aviso aparece.
- **Vínculo antigo sem conta** (criado pela CLI): aparece com o e-mail do vínculo mascarado e sem "Abrir conta"; mudar papel e desativar funcionam; promover a `OWNER` exige conta (409 `MEMBER_NOT_ELIGIBLE`).
- **Recuperação de senha de conta desativada:** o pedido responde 202 e nada sai (regra da 021); o admin reativa antes, se for o caso.
- **Desconectar com a Meta fora do ar:** a desassinatura falha em silêncio (log `warn` só com o `companyId`); a WABA continua mandando eventos, que caem em `unknown_number`.
- **Remover empresa com mensagens em processamento:** o turno em andamento termina; nada novo é enviado (o número já não leva a ela).
- **Restaurar empresa cujo número foi conectado por outra:** a restauração não traz número de volta; o `OWNER` reconecta e, se o número estiver em uso, recebe o 409 `CHANNEL_NUMBER_IN_USE` de sempre.
- **Assinatura alterada pelo admin com a pessoa na tela de Assinatura:** a tela relê a cotação do servidor antes de pagar; um pedido criado antes da mudança cai nas travas `renewal_stale`/`upgrade_stale` da 031 (por isso a recusa com `ORDER_PENDING`).
- **Rollback do deploy depois da migration do convite:** a versão anterior não sabe ler convite com convidador admin; o aceite de um desses convites, nesse intervalo, dá a falha uniforme `INVITATION_INVALID` (a pessoa tenta de novo depois). Nenhum outro convite é afetado.

## Isolamento entre empresas

- **Quem entra:** só a sessão de cookie do `PlatformAdmin` com segundo fator; as rotas de tenant (`/admin/companies/:companyId/...`) continuam recusando `kind: 'platform'`.
- **Escrita com a empresa do caminho:** a plataforma escolhe a empresa pelo `:companyId` (por desenho, é a única identidade que alcança várias), mas toda leitura e escrita de model de tenant passa pelo repositório com esse `CompanyId` como primeiro parâmetro e `companyId` no `where`. Vínculo e convite são procurados **pelo par** (`companyId`, id): o de outra empresa é 404 e nada muda (teste com duas empresas em cada rota que recebe `:membershipId` ou `:invitationId`).
- **Ações da conta:** atingem os vínculos da conta em várias empresas (é o efeito pedido, ex.: desativar a conta); o teste prova que só os vínculos **daquela** conta mudam e que os de outra conta nas mesmas empresas ficam intactos.
- **Leitura que cruza empresas:** só em `platform-read-model.ts` (D6 da 044), agora também com as pessoas; o teste de colunas continua recusando conteúdo.
- **Trilha:** `PlatformAuditEvent` é global e aponta para empresa, conta, vínculo e convite por ids; nada dela aparece para a empresa (D9).

## Política de Privacidade e Termos (a conferir pelo dono)

- **E-mail mascarado das pessoas no detalhe da empresa (E1):** é o mesmo uso que o dono confirmou para a D7 em 2026-11-24 (seção 5 da política: criar e proteger a conta, cobrar e prestar suporte). Não muda o texto.
- **O admin convida pessoas e cria empresas em nome de alguém (E3):** o e-mail digitado vira um convite, como o convite da 025 (a política já trata o convite). A conferir: se a seção 5 cobre o dono "criar a conta a pedido" (provável: execução do contrato).
- **Desativar conta, encerrar assinatura e remover empresa por abuso ou falta de pagamento (E2 a E4):** é tema dos **Termos** (suspensão e encerramento), não da política; conferir se os termos vigentes dizem que o Soprei pode suspender ou encerrar o acesso e como avisa.
- **Anonimizar conta pelo admin (E6):** atende ao pedido de exclusão do titular (prazo de 15 dias da política) e ao encerramento por violação dos termos; conferir que a política descreve o que fica (registros de cobrança por 5 anos, já previsto na 032).
- **Trilha da plataforma (`platform_audit_events`):** guarda só ids, ações e motivos, mas não tem prazo de guarda definido; entra na lista de retenção da 032 (E5) como pendência.

## Fora de escopo

- Ler ou alterar persona, conhecimento, estoque, agenda, conversas e mensagens; "entrar como" a empresa (D17).
- Trocar o e-mail de uma conta (D5) e definir ou ver senha (D6).
- Expurgo definitivo de empresa removida e o `purge_after` (032 E8); exclusão da conta pela própria pessoa (032 E7, que reaproveita o `AccountAnonymizer` da E6).
- Estorno, pagamento ou pedido em nome da pessoa; pacote extra (031 E6); preço especial ou desconto.
- Conectar o canal pelo admin, editar número, WABA ou token, "marcar para reconectar" sem desconectar (D15).
- Mostrar à empresa o que a plataforma fez (D9); avisar por e-mail a pessoa afetada além dos e-mails que já existem.
- Papéis entre administradores da plataforma (todos os admins podem tudo), aprovação em dupla, desfazer automático.
- Criar ou remover administrador da plataforma pelo admin (continua só pela CLI no servidor).

## Decisões e dependências novas

**Nenhuma dependência nova.** O dono decide (em cada uma, a recomendada vem primeiro):

- **D1 — Etapas e ordem.** Recomendado: **seis PRs na ordem E1 (ver o dono e as pessoas) -> E2 (contas) -> E3 (empresas, vínculos e convites) -> E4 (assinatura) -> E5 (canal) -> E6 (remover conta)**, cada um com o `reviewer`; dá para parar em qualquer fronteira. Alternativa: E1 e E2 agora e o resto em outra spec, depois de ver o uso.
- **D2 — Confirmação das ações de impacto.** Recomendado: **diálogo com motivo em todas e, nas de impacto (desativar ou anonimizar conta, mudar papel envolvendo `OWNER`, remover ou restaurar empresa, encerrar assinatura, desconectar canal), um código novo do autenticador**, mais o slug digitado na remoção da empresa. Protege contra sessão esquecida aberta e clique errado. Alternativa: só o diálogo (mais rápido, mas quem pegar a sessão aberta faz tudo).
- **D3 — Como o dono aparece na empresa.** Recomendado: **e-mail mascarado na empresa, com "Abrir conta"; o e-mail completo só pela rota auditada nova (`GET .../email`)**, e o detalhe da conta passa a vir mascarado. Alternativa: mostrar o e-mail completo do dono direto no detalhe da empresa, gravando uma leitura auditada a cada abertura (mais prático, muito mais leituras de e-mail na trilha).
- **D4 — Criar conta.** Recomendado: **só por convite**: o admin informa o e-mail e o papel numa empresa; a conta nasce quando a pessoa abre o link do e-mail e define a própria senha (o link prova que o e-mail é dela). Alternativa: o admin cria a conta solta e o sistema manda um link de "definir senha" (mecanismo novo, e uma conta sem empresa não serve para nada).
- **D5 — Trocar o e-mail de uma conta.** Recomendado: **o admin não troca**. Risco em português simples: quem convence o admin a trocar o e-mail para um endereço seu fica com a conta e as empresas da vítima, e a confirmação no e-mail novo não ajuda, porque o e-mail novo é o do golpista. Caminho seguro que entrega o mesmo resultado: convidar o e-mail novo para as empresas, transferir a propriedade e desativar (ou anonimizar) a conta antiga. Alternativa: spec própria de troca de e-mail iniciada pela própria pessoa, com código no e-mail novo, aviso no antigo e prazo para cancelar.
- **D6 — Senha.** Recomendado: **o admin nunca vê nem define senha; ele dispara o código de recuperação da 021**, com as mesmas travas. Alternativa: o admin define uma senha temporária e a passa à pessoa (o admin conheceria a senha, e ela trafegaria por fora do sistema: não recomendado).
- **D7 — Desativar a conta que é a única dona de uma empresa ativa.** Recomendado: **recusar (409)** até o admin suspender a empresa ou transferir a propriedade. Alternativa: permitir com aviso no diálogo (a empresa fica ativa e sem ninguém que a administre).
- **D8 — Como a plataforma convida.** Recomendado: **reaproveitar o convite da 025** com um convidador "admin" (migration que relaxa duas restrições, com a marca `breaking-approved`) e permitir convidar `OWNER` só pela plataforma. Reaproveita o link, o e-mail, as cotas e o aceite já revisados. Alternativa: tabela global própria de convites da plataforma (sem mexer na 025, mas duplica o fluxo de aceite).
- **D9 — A empresa vê o que a plataforma fez?** Recomendado: **não, por ora: tudo fica na trilha da plataforma.** Alternativa: a trilha da empresa ganha um ator "Equipe do Soprei" (migration em `audit_events`, ator anulável e CHECK por ação), mais transparente para quem contrata.
- **D10 — Slug.** Recomendado: **não editável** (identifica a empresa no login antigo, na CLI e fica reservado depois da remoção). Alternativa: editável, guardando os slugs antigos reservados numa tabela de histórico.
- **D11 — Remover empresa.** Recomendado: **soft delete com restauração pelo admin agora; o expurgo definitivo e a carência de 30 dias ficam com a 032 E8.** Alternativa: esperar a 032 E8 e fazer as duas juntas (a remoção pelo admin só chega depois).
- **D12 — Escritas pelo Bearer em `/admin/companies`.** Recomendado: **fechar (403) com o admin ligado**, para não existir caminho sem motivo e sem trilha (como foi feito com o `status` na revisão da 044). Alternativa: manter e gravar a trilha também ali.
- **D13 — Módulo ou plano liberado pelo admin, na renovação.** Recomendado: **a liberação vale como a assinatura nova: a renovação cobra o que estiver ligado**; a pessoa vê o preço na tela antes de pagar (a renovação não é automática). Alternativa: a liberação vale só até o fim do período e volta ao anterior na renovação (mais justo para quem ganhou o módulo de cortesia, mais regra e conflito com a troca agendada pela própria pessoa).
- **D14 — "Remover" assinatura.** Recomendado: **"Encerrar agora"** (vencida, sem carência; a linha e os pedidos ficam pela guarda fiscal). Apagar a linha não é possível (pedidos, uso e avisos apontam para ela). Alternativa: só permitir "cancelar no fim do período".
- **D15 — Canal.** Recomendado: **o admin só desconecta (e libera número `LEGACY` preso); conectar e editar continuam só com o `OWNER`, pela prova de posse da Meta.** Risco do caminho literal: colar token de terceiro ou trocar o número de uma empresa poria mensagens de uma empresa na outra. Alternativa: além de desconectar, "marcar para reconectar" (estado `TOKEN_INVALID` sem apagar nada).
- **D16 — Remover conta.** Recomendado: **anonimizar como a 032 E7, implementando aqui o serviço único que a 032 E7 reaproveita.** Alternativa: esperar a 032 E7 e só então ligar a ação no admin.
- **D17 — Conteúdo da empresa (persona, conhecimento, estoque, agenda, conversas).** Recomendado: **continua fora do admin (D8 da 044)**; o suporte pede à empresa. Alternativa: spec própria, com consentimento da empresa e trilha visível a ela.

## Registro da implementação

(vazio até a aprovação)

- **2026-11-25, aprovação:** o dono aprovou D1 a D17 como recomendadas ("aprovo tudo"). Antes, confirmou o entendimento de que o dono da empresa vem dos vínculos (`OWNER`), não da assinatura (quem paga), e de que a transferência da titularidade é a E3. Pendente do dono, sem bloquear a E1: conferir a Política de Privacidade nos pontos listados nesta spec (prazo de guarda da trilha da plataforma na lista de retenção da 032).
- **2026-11-25, E1 (branch `spec/045-e1-pessoas`, Claude Code, implementer).** Só leitura; **sem migration** (confirmado: nenhuma tabela, coluna ou valor de enum novo).
  - **Backend:** porta `PlatformReadModel` (`application/ports/platform-read-model.ts`) com `PlatformCompanyPerson`, `PlatformCompanyOwner`, `PLATFORM_PEOPLE_LIMIT = 50`, `people`/`peopleTotal`/`owners`/`pendingInvitations` no detalhe, `owner`/`owners` na linha da lista, `emailMasked` no detalhe da conta e o método novo `accountEmail`. Em `platform-read-model.ts`: `PERSON_EMAIL_MASKED` (máscara da conta, ou do vínculo quando não há conta) e `activeOwnersFrom(company)` (a única definição de "dono ativo"), usados pela lista (`LEFT JOIN LATERAL ... company_id = co.id ... LIMIT 1` e contagem) e pelo detalhe (pessoas ordenadas por `CASE` de papel, `created_at`, id; convites `PENDING` com `expires_at > agora`); toda consulta nova do detalhe filtra `company_id` pelo parâmetro. `PlatformMonitorService.accountDetail(accountId)` não grava nada; `accountEmail(identity, accountId)` grava `ACCOUNT_EMAIL_VIEWED` (e a métrica `account_email_viewed`) antes de devolver. Rota nova `GET /platform/accounts/:accountId/email` (`PlatformAccountEmailResponse`), com `requirePlatform()` e perfil `admin` (inventário de `rate-limit.test.ts` atualizado).
  - **App `admin/`:** contratos (`personSchema`, `owner`/`owners`, `accountEmailSchema`; todo `emailMasked` conferido por formato), tela nova `AccountDetailScreen` (a conta vira `View` com `from`; a lista de contas guarda os filtros no `View`, como a de empresas), seção Pessoas e dono em destaque no detalhe da empresa, aviso "Empresa sem dono ativo", coluna Dono e selo "Sem dono ativo" na lista (também na tela Canal, que reaproveita as linhas).
  - **Decisões de implementação (dentro da spec):** (1) **dono ativo** = vínculo `OWNER` `ACTIVE` com a conta `ACTIVE` ou sem conta (vínculo da CLI): é o que o caso de borda "conta desativada que é `OWNER` de empresa suspensa... fica sem dono ativo e o aviso aparece" pede; (2) o detalhe também devolve `owners` (a spec o cita só na lista, mas o aviso do detalhe depende dele e a regra precisa ser a do servidor); (3) `peopleTotal` sai da soma das contagens por papel e estado que o detalhe já lê; (4) `pendingInvitations` conta só os ainda dentro da validade (um `PENDING` vencido espera o job de expiração da 025 e não é convite utilizável); (5) no app, o papel `OWNER` passa a se chamar **"Dono"** (antes "Titular"), e o titular da assinatura aparece como "Titular da assinatura", para não repetir a confusão do pedido; (6) o card "Equipe" (contagens por papel) virou "Pessoas" (lista, total, convites pendentes e titular da assinatura).
  - **Testes:** `platform-monitor.service.test.ts` (pessoas e dono repassados, dono com a cobrança desligada, detalhe da conta sem gravar, `accountEmail` com trilha e métrica, 404 sem gravar, trilha falhando = e-mail não sai, nenhum e-mail no log), `platform-monitor.controller.test.ts` (rota nova no 404 sem admin, 401 sem cookie e com Bearer de plataforma ou de vínculo sem leitura nem gravação, `no-store`, detalhe mascarado sem evento e `.../email` com um evento), `platform-read-model.columns.test.ts` (e-mail só dentro da máscara; um único `a.email` sem máscara, dentro de `accountEmail`; leituras de vínculos e convites com `company_id`), `rate-limit.test.ts` (inventário), `platform-admin.integration.test.ts` (Postgres real: pessoas de A sem as de B, ordem dono, administrador desativado da CLI e atendente mais antiga, conta desativada e não confirmada, convite vencido fora da contagem, empresa E cujo único dono tem a conta desativada = `owners 0`, lista com dono e `owners`, nenhum evento ao ler, e-mail completo só em `.../email`, nenhum e-mail inteiro de pessoa em resposta ou log), `admin/src/contracts.test.ts` e Playwright (`admin/e2e/admin.spec.ts`: conta mascarada e "Mostrar e-mail"; empresa com dono, Pessoas, "Abrir conta" sem ler o e-mail, empresa sem dono ativo, 360 px sem rolagem lateral, nada no armazenamento).
  - **Validação local (Node 26.13.1, o único instalado nesta máquina; o CI usa o 24 do `.nvmrc`):** `pnpm typecheck`, `pnpm lint` e `pnpm format:check` da raiz verdes; unitários tocados verdes (`platform-monitor.service.test.ts` 13/13, `platform-monitor.controller.test.ts` 7/7, `platform-read-model.columns.test.ts` 8/8, `rate-limit.test.ts` 10/10, `admin` 32/32); Playwright do admin 64/64 nos quatro projetos (porta 5187) e as duas suítes novas repetidas 4 vezes (32/32). **Não rodou localmente:** `platform-admin.integration.test.ts` e o resto da integração (não há `backend/.env.test` nesta máquina), o `pnpm test` inteiro e o `build`/smoke do processo compilado; ficam com o CI.
  - **Critérios comuns:** a rota nova está no inventário com `requirePlatform()` e perfil `admin` e recusa sem o cookie (401, nada lido nem gravado) e a privacidade dela está nos testes acima; os critérios de escrita (origem, motivo, código, trilha na transação) não se aplicam à E1 (nenhuma escrita nova), então seguem sem marca até as etapas que os exercitam.
