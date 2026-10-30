# 008 — Autorização por papéis, usuários do cliente pela API e auditoria (RBAC)

- **Status:** aprovada (2026-10-30, com todas as recomendações da seção "Decisões para o dono"; reescrita do esboço contra o código de `main` em 02310cc; **segurança: passa pelo `reviewer` antes do merge**, de preferência outro agente/modelo)
- **Branch:** `spec/008-rbac`
- **Depende de:** 003 (isolamento), 005 (perfis de rate limit), 007 (identidade, `authenticate`, `requireUser`, `SessionStore`)

## Objetivo

Hoje todo `User` ativo de um cliente tem o mesmo acesso (a 007 só **carrega** `OWNER`/`AGENT`) e só dá para criar usuário pelo CLI do dono. Esta spec faz o papel **valer**: permissões por papel verificadas em hook, gestão de usuários do próprio cliente pela API (criar, listar, mudar papel, desativar, redefinir senha), troca da própria senha, a regra do último `OWNER` e uma trilha de auditoria. É pré-requisito do painel e da spec B (onboarding), em que o cliente passa a administrar a própria equipe.

## Estado de partida (herdado do código real)

- `UserRole` = `OWNER | AGENT` (`src/domain/entities/user.ts`; enum Postgres `user_role`); `User` tem `status` `ACTIVE | DISABLED`. O papel vai no access token (claim `role`) e em `request.auth` (`UserIdentity.role`). `jose-access-token.service.ts` aceita só os papéis conhecidos; outro valor é 401 (a 007 deixou a política de papéis futuros para esta spec).
- Hooks em `src/presentation/common/auth.hooks.ts`: `authenticateHook` (preenche `request.auth`), `requireUser({ clientParam })` (403 para `PlatformAdmin`; `:clientId` divergente do `cid` = 404 idêntico a cliente inexistente), `requirePlatform()`, `userAuth(request)`. Hooks marcam `REQUIRED_AUTH_KIND` para o teste de inventário de `rate-limit.test.ts`, que falha se uma rota `/admin/*` não declarar `requireUser()` ou `requirePlatform()` e o perfil.
- `UserRepository` (`TenantRepository` mais `findCredentialsByEmail` e `updatePassword`); `UserUpdate` já aceita `role` e `status`. `User` **não** tem `@@unique([id, clientId])` (a 007 deixou para esta spec se a auditoria virar tabela).
- `SessionStore.revokeAllSessions(scope, subjectId)` (grava `nbf` e `rsid` de cada sessão) já existe e é a operação que a 007 reservou para "desativar usuário pela API"; `authenticate` não consulta o banco, então desativação e troca de papel só valem de imediato se a sessão for revogada.
- Rotas `/admin/clients/:clientId/{messages,conversations,conversations/:id/messages}` usam `requireUser({ clientParam: 'clientId' })` sem distinção de papel; `/admin/clients` (CRUD de `Client`, inclusive `persona` e `whatsappPhoneNumberId`) é só `PlatformAdmin`. `GET /auth/me`, `logout-all` valem para qualquer identidade. `pnpm auth:cli` cria `OWNER|AGENT` e redefine senha.
- O contador de falhas de login (`loginLockState`/`recordLoginFailure`/`resetLoginFailures`) aceita qualquer chave opaca; pode ser reutilizado.

## Comportamento esperado

### Papéis e permissões (lista fixa em código, decisão 1)

- `USER_ROLES` ganha `ADMIN` e `VIEWER`: `OWNER`, `ADMIN`, `AGENT`, `VIEWER`. Migration **aditiva** (`ALTER TYPE user_role ADD VALUE`); nada de migration antiga é reescrita. O padrão de criação continua `AGENT`.
- `src/domain/permissions.ts` (puro, sem dependência): união `Permission` e mapa estático `ROLE_PERMISSIONS`, mais `hasPermission(role, permission)`. Papel desconhecido (valor fora de `USER_ROLES`, ex.: token adulterado que passasse) nunca concede nada. O token continua carregando só o papel; permissões são derivadas no servidor.

| Permissão | Ação | OWNER | ADMIN | AGENT | VIEWER |
| --- | --- | :-: | :-: | :-: | :-: |
| `conversation:read` | `GET .../conversations` e `.../messages` | x | x | x | x |
| `conversation:simulate` | `POST .../messages` (simulador) | x | x | x | |
| `user:read` | `GET .../users` | x | x | | |
| `user:manage` | criar, mudar papel/estado, redefinir senha de outro | x | x | | |
| `audit:read` | `GET .../audit-events` | x | x | | |

- **Hierarquia dentro de `user:manage`** (função pura `canManageRole` no domínio, aplicada **no service**, defesa em profundidade além do hook): `OWNER` gerencia qualquer papel (inclusive criar e promover `OWNER`); `ADMIN` só gerencia usuários `AGENT` e `VIEWER` e só atribui esses dois papéis. `ADMIN` não toca em `OWNER` nem em outro `ADMIN`. **Ninguém altera o próprio papel nem o próprio estado** (nem `OWNER`); a própria senha só pela rota de troca abaixo.
- Persona e `whatsappPhoneNumberId` seguem em `PATCH /admin/clients/:id` (só `PlatformAdmin`); configuração do cliente pelo próprio cliente fica para a spec B.

### Hook `requirePermission`

`requirePermission(permission, { clientParam }?)` em `auth.hooks.ts`, **construído sobre `requireUser`** (mesmas checagens e mesma marca `REQUIRED_AUTH_KIND = 'user'`, então o inventário o reconhece): ordem 401 (sem identidade) -> 403 (`PlatformAdmin`) -> 404 (`:clientId` divergente do token; vem **antes** da permissão, para não revelar a existência de um cliente a quem não é dele) -> 403 (`ForbiddenError`, mensagem constante) se `!hasPermission(auth.role, permission)`. O `ClientId` continua vindo **só** do token (`userAuth(request).clientId`). Nenhum hook `requireRoles` (decisão 1: papéis não aparecem em rota, só permissões). Negação incrementa `authz_denials_total{permission}` (conjunto fixo) e loga `warn` com `route` (padrão), `permission`, `role`, ids; nunca e-mail.

### Classificação das rotas atuais e novas (tudo em `/admin/clients/:clientId/...`, `clientParam: 'clientId'`, perfil `admin`)

| Rota | Permissão |
| --- | --- |
| `GET /conversations`, `GET /conversations/:id/messages` | `conversation:read` |
| `POST /messages` (simulador) | `conversation:simulate` |
| `GET /users` | `user:read` |
| `POST /users` | `user:manage` |
| `PATCH /users/:userId` (`{ role?, status? }`, ao menos um campo) | `user:manage` |
| `POST /users/:userId/password` (`{ newPassword }`) | `user:manage` |
| `GET /audit-events` | `audit:read` |
| `POST /auth/password` (`{ currentPassword, newPassword }`; perfil `login`, fail-closed) | qualquer `User` autenticado (`requireUser()`) |
| `/admin/clients` (CRUD de `Client`), `/auth/*`, webhook, `/health`, `/metrics` | **sem mudança** |

O teste de inventário passa a exigir também que toda rota `requireUser`/`requirePermission` de tenant em `/admin/clients/:clientId/...` declare `requirePermission` (nenhuma rota de tenant sem permissão explícita; exceção declarada: `POST /auth/password`).

### Gestão de usuários (`UserAdminService`, `src/application/users/`)

Os métodos recebem a identidade do ator (`UserIdentity`: `clientId`, `userId`, `role`) e o **service** reaplica permissão e hierarquia (o hook sozinho não expressa "ADMIN não toca em OWNER").

- **Criar** `POST /users` `{ email, password, role }`: e-mail normalizado como no login (NFKC, `trim`, minúsculas, até 254), senha pela mesma política da 007 (12 a 128, NFKC, sem NUL), hash `scrypt`. E-mail repetido **no mesmo** cliente: `ConflictError` 409. Devolve `{ id, email, role, status, createdAt }`, nunca o hash. A senha inicial é definida por quem cria e combinada fora da API (sem e-mail de convite: fora de escopo, decisão 5).
- **Listar** `GET /users`: paginação por cursor (como as conversas), `{ items: [{ id, email, role, status, createdAt }], nextCursor }`, só do cliente do token.
- **Mudar papel / desativar / reativar** `PATCH /users/:userId`: respeita a hierarquia (a **origem** e o **destino** do papel precisam ser gerenciáveis pelo ator) e "ninguém altera a si mesmo". Papel e estado iguais ao atual: sem efeito e **sem** auditoria, 200.
- **Redefinir a senha de outro** `POST /users/:userId/password`: mesma hierarquia; grava o hash e revoga as sessões do alvo.
- **Última pessoa `OWNER`:** nenhuma operação pode deixar o cliente sem ao menos um `OWNER` **ativo** (rebaixar ou desativar o último = `ConflictError` 409, código `LAST_OWNER`). A checagem e a escrita acontecem **na mesma transação**, com o cliente travado (`SELECT ... FOR UPDATE` na linha de `clients`, SQL controlado dentro de `infrastructure/database/`, no molde do `message.repository`), porque dois `OWNER` podendo se rebaixar ao mesmo tempo passariam cada um pela checagem sozinha. Porta `UserAdminUnitOfWork` (como `AttendanceUnitOfWork`): o `application` não importa `infrastructure/database`.
- **Troca da própria senha** `POST /auth/password`: confere `currentPassword` (um `verify`; contador de falhas reutilizando `loginLockState`/`recordLoginFailure` com chave `HMAC(['pw', clientId, userId])`, mesmo segredo derivado, 429 com `Retry-After` antes de gastar hash), grava o novo hash e **revoga todas as sessões do usuário, inclusive a atual** (`revokeAllSessions`, sem método novo na porta): responde 204 e a pessoa faz login de novo (decisão 4). Senha nova igual à atual é aceita (sem regra de composição, como na 007).
- **Convivência com `pnpm auth:cli`:** o CLI continua sendo o caminho de recuperação do dono (criar o primeiro `OWNER`, `reset-password` quando todos perderam a senha) e passa a aceitar os quatro papéis. Ele **não** grava auditoria nem aplica hierarquia (é operação local do dono da máquina, não da API); cada comando já imprime só o id.

### Efeito imediato sobre sessões e tokens (decisão 3)

Depois de gravar no banco, mudança de papel, desativação e redefinição de senha de outro chamam `sessions.revokeAllSessions(clientId, targetUserId)`: o `nbf` derruba os access tokens ainda válidos e cada sessão cai (refresh incluso); o alvo faz login e recebe o papel novo. Reativar não precisa revogar. A troca do papel também vale na hora para quem **sobe** de papel (refaz login). Ordem: **banco primeiro, revogação depois, ambas dentro do mesmo pedido**; se o Redis falhar após o commit, a API responde 503 (`ServiceUnavailableError`) com a mudança já gravada e a auditoria feita; repetir o pedido é idempotente e refaz a revogação (um `PATCH` igual ao estado atual **ainda** chama a revogação: ver critério). `authenticate` continua sem consultar o banco por requisição (a 007 manteve o custo fora do caminho quente).

### Auditoria (tabela de tenant, decisão 2)

```prisma
enum AuditAction { USER_CREATED USER_ROLE_CHANGED USER_DISABLED USER_ENABLED USER_PASSWORD_RESET USER_PASSWORD_CHANGED  @@map("audit_action") }

/// (TENANT) Trilha imutável. Sem texto livre, sem e-mail, sem IP: só ids e valores de enum.
model AuditEvent {
  id           String      @id @default(uuid(7)) @db.Uuid
  clientId     String      @map("client_id") @db.Uuid
  action       AuditAction
  actorUserId  String      @map("actor_user_id") @db.Uuid
  targetUserId String      @map("target_user_id") @db.Uuid
  fromRole     UserRole?   @map("from_role")
  toRole       UserRole?   @map("to_role")
  createdAt    DateTime    @default(now()) @map("created_at")
  client       Client      @relation(fields: [clientId], references: [id], onDelete: Restrict)
  actor        User        @relation("AuditActor",  fields: [actorUserId, clientId],  references: [id, clientId], onDelete: Restrict)
  target       User        @relation("AuditTarget", fields: [targetUserId, clientId], references: [id, clientId], onDelete: Restrict)

  @@index([clientId, createdAt, id])
  @@map("audit_events")
}
```

- `User` ganha `@@unique([id, clientId])` (FK composta: auditoria de um cliente não aponta para usuário de outro, no próprio banco, como na 010). `MODEL_SCOPES`: `AuditEvent: 'tenant'`. Repositório `AuditRepository` (`ClientId` primeiro; só `create` e `list`; sem `update`/`delete`, a trilha é imutável pela API). `User` nunca é apagado fisicamente (não há `DELETE` de usuário; `Restrict` garante).
- O evento é gravado **na mesma transação** da mudança (`UserAdminUnitOfWork`): sem mudança sem trilha, nem trilha sem mudança. Além da linha, um log Pino `info` (`audit`, `action`, `clientId`, `actorUserId`, `targetUserId`, `fromRole`, `toRole`): só ids e enum, **nunca** e-mail, senha, hash nem token.
- `GET /audit-events`: cursor, mais recentes primeiro, `{ id, action, actorUserId, targetUserId, fromRole, toRole, createdAt }`. Autoprotegida pelo `clientId` do token.
- **Retenção:** sem expurgo nesta spec (guardar é o objetivo da trilha); entra na política de retenção/LGPD já pendente antes de dados reais (os ids de pessoa são dado pessoal indireto).

### Rate limit, erros, validação, config

- Rotas novas no perfil `admin` (e `POST /auth/password` no `login`, fail-closed: o Redis do limiter fora = 503, sem verificar senha). Corpo e parâmetros com Zod; `:userId` UUID inválido = 404 uniforme (não 400); erros de validação não ecoam o valor (senha, e-mail). Erros da hierarquia: `ForbiddenError` 403 (sem permissão ou hierarquia), `NotFoundError` 404 (usuário de outro cliente ou inexistente, **idêntico**), `ConflictError` 409 (e-mail repetido, `LAST_OWNER`), `ServiceUnavailableError` 503.
- **Sem variável de ambiente nova.** Sem dependência nova.
- Métrica nova: `authz_denials_total{permission}`; `user_admin_actions_total{action}` (valores do `AuditAction`). Nenhum id, e-mail ou IP em label.
- `redact` e privacidade herdados da 007 (`newPassword`, `currentPassword`, `passwordHash`, `email` já cobertos).

## Critérios de aceite

Unitários com `buildTestAuth` e repositórios em memória; integração em `soprei_test` e Redis `/15` (prefixo único).

**Permissões e hooks**
- [x] Teste (snapshot): o mapa `ROLE_PERMISSIONS` entrega a cada papel exatamente a matriz acima; `hasPermission` com papel fora de `USER_ROLES` devolve `false`; token de papel desconhecido continua 401.
- [x] Teste: para cada rota de tenant, cada papel recebe o status esperado pela matriz (200/201/204 ou 403), em tabela (`VIEWER` lê conversas mas leva 403 no simulador; `AGENT` leva 403 em `/users` e `/audit-events`).
- [x] Teste: sem token 401; `PlatformAdmin` 403 em todas as rotas de tenant; `:clientId` de outro cliente 404 **igual** ao de cliente inexistente mesmo para quem teria a permissão e também para quem não a tem (404 antes de 403); `authz_denials_total` conta a negação sem id nem e-mail.
- [x] Teste: o inventário de rotas falha se uma rota de tenant não declarar `requirePermission` (ou `POST /auth/password`) e perfil.

**Gestão de usuários e hierarquia**
- [x] Teste: `OWNER` cria usuário de qualquer papel; `ADMIN` cria `AGENT`/`VIEWER` e recebe 403 ao criar `ADMIN` ou `OWNER`; e-mail repetido no mesmo cliente 409; o mesmo e-mail em dois clientes funciona; a resposta nunca traz hash; senha fora da política 400 sem ecoar o valor.
- [x] Teste: `ADMIN` não altera nem desativa nem redefine a senha de `OWNER` ou de outro `ADMIN` (403) e não promove ninguém a `ADMIN`/`OWNER`; `OWNER` faz tudo isso.
- [x] Teste: ninguém altera o próprio papel nem o próprio estado (403), nem o `OWNER` único; **auto-promoção** (`AGENT`/`ADMIN` pedindo `OWNER` para si) é 403 e o banco permanece intacto.
- [x] Teste: rebaixar ou desativar o último `OWNER` ativo é 409 `LAST_OWNER` e nada muda; com dois `OWNER`, um pode rebaixar o outro; um `OWNER` desativado não conta como `OWNER` ativo. _(ver desvio 2 do Registro: o 409 `LAST_OWNER` é provado no service com a contagem de OWNER ativos simulada; pela API, a hierarquia e a regra de "ninguém altera a si mesmo" barram antes)_
- [x] Teste (integração, Postgres real): dois `OWNER` se rebaixando **simultaneamente** (duas conexões): exatamente um pedido tem sucesso, o cliente termina com um `OWNER` ativo.
- [x] Teste: `PATCH` com papel e estado iguais ao atual não gera evento de auditoria; `PATCH` sem campos é 400.
- [x] Teste: `GET /users` lista só os usuários do cliente do token, paginado por cursor, sem hash.

**Sessões e tokens**
- [x] Teste: após mudar o papel, desativar ou redefinir a senha de um usuário, o **access token ainda válido** dele é recusado (401, `nbf`/`rsid`), o refresh falha e o login com o papel novo funciona; usuário desativado não loga; outras pessoas e outros clientes não são afetados.
- [x] Teste: com o Redis de auth fora **depois** do commit, a API responde 503, a mudança e a auditoria ficam gravadas e repetir o `PATCH` (já aplicado) refaz a revogação.
- [x] Teste: `POST /auth/password` com senha atual errada é 401 e conta no contador (429 com `Retry-After` antes de gastar hash após `AUTH_LOGIN_MAX_FAILURES`); com a certa, troca o hash, devolve 204, derruba **todas** as sessões da pessoa (access e refresh) e o login com a senha nova funciona; sem Redis do limiter, 503 sem verificar senha.

**Auditoria**
- [x] Teste: cada operação gera um `AuditEvent` com ator, alvo, ação e papéis (`USER_ROLE_CHANGED` com `fromRole` e `toRole`) **na mesma transação**: falha da escrita da trilha desfaz a mudança do usuário e vice-versa.
- [x] Teste: o log `audit` traz só ids e enum; captura de log (`src/test-support/log-capture.ts`) prova que e-mail, senha, hash, access e refresh token **secretos** de teste não aparecem em log, erro, métrica nem corpo de erro em todas as rotas novas.
- [x] Teste: `AuditRepository` não expõe `update`/`delete`; a FK composta impede, no banco, um evento do cliente A apontar para usuário do B.

**Isolamento**
- [x] Teste de isolamento do `UserRepository` (novos métodos) e do `AuditRepository` no molde de `user.repository.integration.test.ts`: o cliente A não lista, conta, atualiza nem lê usuário ou evento do B (`NotFoundError`); consulta sem `clientId` lança `TenantScopeError`; `MODEL_SCOPES` classifica `AuditEvent` (tenant) e o teste de cobertura passa.
- [x] Teste de ponta a ponta com dois clientes (`infrastructure/http/`): `OWNER` do A, com o `:clientId` do B ou o `userId`/`auditId` de um usuário do B, recebe 404 idêntico ao de inexistente, nada do B é lido nem alterado, e o `ClientId` repassado aos services é o do token.

**CLI e config**
- [x] Teste: `pnpm auth:cli create-user --role ADMIN|VIEWER` funciona (contra `soprei_test`); config sem variável nova; migration só aditiva (enum e `audit_events`).

**Geral**
- [ ] **(parte do dono/revisor)** `typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes em Node 22 e 24: **feito pelo implementer** (ver o Registro da implementação); faltam a revisão do `reviewer`, o CI e o merge. Documentação atualizada (`AGENTS.md`, `docs/context.md`, `docs/handoff.md`): feita.

## Casos de borda e erros

- **Token emitido antes desta spec** (papel `OWNER`/`AGENT`): continua válido; o mapa os cobre.
- **Papel desconhecido no token:** 401 como hoje (não 403/500; o esboço previa 403, mas o token com papel fora da lista não é um token nosso).
- **Usuário do alvo some ou é de outro cliente:** 404 uniforme.
- **Dois pedidos simultâneos que se contradizem** (promover e desativar o mesmo usuário): serializados pelo mesmo bloqueio de cliente; o resultado final respeita a regra do último `OWNER`.
- **Cliente suspenso:** a 007 já o trata no login/refresh; `/admin` de `User` de cliente suspenso segue como hoje (access token vale até expirar, limitação da 007 inalterada).
- **Redis fora:** como na 007, 503 fail-closed em `authenticate`; nas rotas de gestão que mudam sessões, ver "Efeito imediato".
- **Banco fora:** `DatabaseError` 500 do handler central; nada é emitido nem revogado.

## Isolamento entre clientes

O `ClientId` vem **só** do token (`userAuth(request).clientId`); o `:clientId` do caminho é conferido e descartado (007). `User` e `AuditEvent` são models de tenant (repositório com `ClientId` primeiro, `tenant-scope`, lint). FKs compostas `(actorUserId, clientId)` e `(targetUserId, clientId)` impedem trilha cruzada no banco. O `FOR UPDATE` da regra do último `OWNER` é SQL controlado, filtrando por `clientId`, dentro de `infrastructure/database/`. Chaves do Redis seguem `<prefixo><ClientId>:...` (revogação por `revokeAllSessions(clientId, userId)`; o contador de troca de senha usa HMAC, exceção declarada como a do login). Provas: critérios de isolamento acima.

## Fora de escopo

- **Papel de super-admin da plataforma lendo dados de cliente:** continua vetado (decisão 5 da 007); `PlatformAdmin` só alcança `/admin/clients`.
- **Permissões customizáveis por cliente, papéis em tabela, ABAC/permissão por objeto:** só se o produto pedir (decisão 1).
- **Convite por e-mail, recuperação de senha por e-mail, verificação de e-mail, alterar o próprio e-mail, "obrigar troca de senha no primeiro login", SSO/OAuth, 2FA/MFA:** spec de contas.
- **Remoção física de usuário (LGPD):** a spec de retenção; aqui só se desativa.
- **Edição de persona e `whatsappPhoneNumberId` pelo próprio cliente, onboarding:** spec B.
- **Tempo real (SSE/Socket.IO):** spec 009 (ela herdará `requirePermission` e as salas por `ClientId`).
- **Expurgo/retenção da auditoria, exportação, auditoria de leitura, auditoria dos comandos do CLI.**
- **Pendências da 007 que a 008 NÃO resolve:** teto da fila do hasher scrypt e limpeza de sessões expiradas em `usess` (ver decisão 8); bloqueio por conta que permite negar acesso a um e-mail conhecido e o 503 depois de rotação confirmada seguem como limitações aceitas, **não tocadas**. A 008 só **usa** `revokeAllSessions` (que lê o `usess`, então a limpeza segue relevante, mas sem mudança de comportamento) e reutiliza o contador de falhas só para o novo `POST /auth/password`.
- **Suspender cliente gravando `nbf` em massa:** continua pendência da 007.

## Decisões para o dono

1. **Modelo de permissões.** (a) **Quatro papéis (`OWNER`, `ADMIN`, `AGENT`, `VIEWER`) com mapa fixo papel -> permissão em código, hook por permissão, sem `requireRoles` [recomendado]:** o mais simples que atende, versionado e testado por snapshot, mudar o mapa vale na hora sem reemitir tokens. (b) Tabelas `Role`/`Permission` por cliente: flexível, mas é spec própria (migração, cache, UI) sem demanda. (c) Manter só `OWNER`/`AGENT`: não atende "somente leitura". Matriz da tabela acima: confirma quem pode o quê (em especial `AGENT` poder usar o simulador e `ADMIN` não tocar em `OWNER`/`ADMIN`)?
2. **Auditoria.** (a) **Tabela `AuditEvent` imutável por cliente, escrita na mesma transação, com `GET /audit-events` [recomendado]:** sem texto livre nem e-mail, só ids e enum; a retenção entra na política de LGPD. (b) Só log Pino (como no esboço): barato, mas some com a rotação de log e não é consultável pelo cliente. (c) Adiar a auditoria: a gestão de usuários sairia sem trilha; não recomendo, é o motivo de mexer em papéis.
3. **Efeito imediato.** (a) **Revogar as sessões do alvo (`nbf` + `rsid`) a cada mudança de papel, desativação e redefinição de senha [recomendado]:** reaproveita `revokeAllSessions`, sem consulta ao banco por requisição; custo: quem muda de papel precisa logar de novo. (b) Checar papel e estado no banco a cada requisição: efeito imediato sem relogar, mas um acesso ao banco por requisição e mais superfície. (c) Aceitar a janela de 15 min (papel antigo valendo até o token expirar): simples, mas um `ADMIN` rebaixado ou um usuário desativado continuaria agindo; não recomendo.
4. **Troca da própria senha revoga todas as sessões, inclusive a atual (204, refaz login) [recomendado]** (sem método novo no `SessionStore`). Alternativa: manter a sessão atual e derrubar só as outras, com método novo na porta e emissão de tokens novos na resposta.
5. **Senha inicial de usuário criado pela API.** (a) **Quem cria define a senha e combina fora da API [recomendado]:** sem e-mail de convite hoje; a pessoa a troca por `POST /auth/password`. Risco: quem cria conhece a senha inicial até a troca (aceito). (b) Esperar uma spec de convite/e-mail antes de ter criação por API: o cliente não administraria a equipe até lá.
6. **Última pessoa `OWNER`.** (a) **Impossível rebaixar ou desativar o último `OWNER` ativo, serializado por bloqueio do cliente no banco [recomendado].** (b) Só checar sem bloqueio: duas operações simultâneas furam a regra. Resgate se o cliente ficar sem `OWNER` mesmo assim: `pnpm auth:cli` (dono da máquina).
7. **`ADMIN` e a hierarquia.** (a) **`ADMIN` gerencia só `AGENT`/`VIEWER`; só `OWNER` cria/promove/rebaixa `OWNER` e `ADMIN` [recomendado].** (b) `ADMIN` igual a `OWNER` salvo o último `OWNER`: mais simples, mas um `ADMIN` comprometido assumiria o cliente.
8. **Hasher.** Criar usuário, redefinir e trocar senha acrescentam chamadas autenticadas ao `scrypt` (hoje só login e CLI). O perfil `admin` (600 por minuto) deixa passar muita coisa para uma fila de hashes sem teto (pendência da 007). (a) **Incluir nesta spec só o teto da fila do hasher [recomendado se o dono quiser fechar a pendência agora; é pequeno e fica num commit próprio].** (b) Deixar para spec própria e aceitar o risco com usuários autenticados e rate limit por IP. Qual?
9. **`POST /auth/password` no perfil `login` (fail-closed, 10 por 15 min por IP) [recomendado]** e `POST /users` e redefinição no `admin`. Alternativa: perfil novo.
10. **Um PR [recomendado]**, commits: domínio (papéis, permissões, hierarquia) -> migration e repositórios -> `requirePermission` e reclassificação das rotas atuais -> `UserAdminService` e rotas de usuários -> troca da própria senha -> auditoria -> CLI e documentação. Alternativa: dois PRs (008a permissões e reclassificação; 008b usuários, senha e auditoria).

## Decisões e dependências novas

- Sem dependência nova nem variável de ambiente.
- **Camadas (o ESLint impõe):** `domain/` ganha `permissions.ts`, `AuditEvent`, `AuditRepository` e `UserAdminUnitOfWork` (porta em `application/ports/`); `application/users/` (`UserAdminService`); `infrastructure/database/repositories/` (`audit.repository.ts`, unit of work com o bloqueio do cliente); `presentation/admin/` (`users.controller.ts`, `audit.controller.ts`), `presentation/auth/` (`POST /auth/password`) e `presentation/common/auth.hooks.ts` (`requirePermission`). Pastas novas só `application/users/`. Sem barrel novo, sem alias.
- **Erros:** `LAST_OWNER` como `ConflictError` com `code` próprio; nenhum `throw new Error` genérico.
- **Documentação a atualizar na implementação:** `AGENTS.md` (seção "Autenticação": papéis, matriz, `requirePermission`, rotas de usuários, auditoria, `authz_denials_total`, `POST /auth/password`; "Acesso a dados": `AuditEvent` e o bloqueio do cliente), `docs/context.md` (roadmap), `docs/handoff.md`.
- **Fontes:** sem API externa. OWASP Authorization Cheat Sheet e NIST SP 800-63B (para a política de senha, já usada na 007), a serem reconferidas pelo implementer.
- Por ser autorização e isolamento, **passa pelo agente `reviewer` antes do merge.** Pontos a olhar: ordem 401/403/404 do hook, hierarquia no service (não só no hook), auto-alteração, regra do último `OWNER` sob concorrência, revogação de sessões após cada mudança (e a falha de Redis depois do commit), FKs compostas da auditoria, privacidade de log e métrica, inventário de rotas.
- **Validação em níveis** (experimento do handoff): typecheck e teste do arquivo a cada passo, lint e suíte da área antes de cada commit, bateria completa e repetições só no final; registrar quantas falhas só apareceram na validação final.

## Registro da implementação

Implementada na branch `spec/008-rbac` (um PR) com todas as recomendações da seção "Decisões para o dono". A spec **não** está marcada como `concluída`: faltam a revisão do `reviewer`, o CI verde e o merge (do dono).

**Commits (ordem):** (1) teto da fila do hasher scrypt (decisão 8, commit próprio); (2) papéis, mapa de permissões, hierarquia, migration e repositórios de auditoria; (3) `requirePermission` e as rotas de conversa por permissão; (4) `UserAdminService` e as rotas de usuários; (5) `POST /auth/password`; (6) `GET /audit-events`; (7) CLI com os quatro papéis, documentação e o teste da migration aditiva (mais três commits pequenos de correção do próprio teste da migration).

**Pastas finais (só `application/users/` é nova):** `src/domain/` (`permissions.ts`, `entities/audit-event.ts`, `repositories/audit.repository.ts`; `USER_ROLES` com os quatro papéis; `UserRepository` ganhou `findCredentialsById` e `countActiveOwners`), `src/application/users/user-admin.service.ts`, `src/application/ports/user-admin-unit-of-work.ts`, `src/infrastructure/database/repositories/` (`audit.repository.ts`, `user-admin-unit-of-work.ts`, cursor decrescente em `cursor.ts`), `src/infrastructure/auth/create-auth.ts` (monta o `UserAdminService`), `src/presentation/admin/` (`users.controller.ts`, `users.validators.ts`, `audit.controller.ts`, `list-options.ts`), `src/presentation/auth/` (`POST /auth/password`), `src/presentation/common/auth.hooks.ts` (`requirePermission`, `REQUIRED_PERMISSION`), migration `prisma/migrations/20261030120000_rbac_audit/` (só `ALTER TYPE ... ADD VALUE`, `CREATE TYPE`, índice único `users(id, client_id)` e `audit_events` com FKs compostas; `prisma migrate diff` não acusa diferença entre migrations e schema).

**Desvios e decisões de implementação (com motivo):**

1. **Papel e estado do ator relidos do banco, dentro da transação** (a spec só pedia reaplicar permissão e hierarquia no service). Motivo: se a revogação de sessões falha (503 depois do commit), o token antigo de quem foi rebaixado ou desativado ainda vale até 15 min; com a releitura ele não age com o papel antigo. Custo: uma consulta a mais por escrita.
2. **Consequência: o `LAST_OWNER` é uma invariante de defesa.** Pela API o ator precisa ser `OWNER` ativo (relido do banco) e não pode ser o alvo, então sempre há outro `OWNER` ativo (contagem >= 2) quando a regra seria testada; o perdedor de uma corrida entre dois `OWNER` que se rebaixam recebe **403** (papel relido), não 409. A regra continua implementada (checagem e escrita na mesma transação, depois do bloqueio do cliente) e testada no service com a contagem simulada (`user-admin.service.test.ts`), e a corrida real está em `user-admin.integration.test.ts` (12 rodadas de rebaixamento mútuo, 6 de desativação mútua, mais uma de promover e desativar o mesmo usuário; retirado o `FOR UPDATE`, os testes falham). O critério "rebaixar o último `OWNER` é 409 `LAST_OWNER`" está marcado `[x]` com essa ressalva.
3. **`ConflictError` aceita `options.code`** (a spec pedia "`ConflictError` com code próprio"); `LAST_OWNER` é `ConflictError` 409 com esse código.
4. **`FOR UPDATE` na linha de `clients`**, como na spec, filtrando também `deleted_at IS NULL`; cliente inexistente é `NotFoundError`.
5. **O hash da senha é feito antes da transação** (criar, redefinir, trocar): o bloqueio do cliente não espera o scrypt. Para criar, há ainda um cheque barato pelo papel do token antes do hash (não gasta hash para quem não pode).
6. **`PATCH` idempotente e revogação:** o pedido repetido (já aplicado) sem mudança **ainda** revoga as sessões quando traz `role` ou `status: DISABLED` (para refazer a revogação que parou no Redis); reativar (`status: ACTIVE`) nunca revoga.
7. **`buildServer` recebe `userAdmin`** (parâmetro de topo) em vez de `admin.users`: ele serve tanto às rotas `/admin/.../users` e `.../audit-events` quanto a `POST /auth/password`.
8. **Troca da própria senha** mora no `UserAdminService` (precisa da unidade de trabalho para gravar a senha e a auditoria juntas); `loginLockKey` foi exportada do `auth.service.ts` e reutilizada com `['pw', clientId, userId]`.
9. **Teto da fila do hasher:** `MAX_QUEUED_HASHES = 32`; acima disso `ServiceUnavailableError` na hora (no login vira "indisponível"/503 e não conta como falha de senha). Sem variável nova.
10. **Teste de papel desconhecido:** o `jose-access-token.service` já recusava papel fora de `USER_ROLES` (agora são quatro); o teste novo confirma 401 (`invalid`).
11. **Inventário de rotas:** a regra "toda rota de tenant declara `requirePermission`" tem teste negativo (rota só com `requireUser` e permissão desconhecida são reprovadas).
12. **Sem dependência nova, sem variável de ambiente nova, `.env.example` inalterado.**

**Critérios com teste passando:** todos, exceto o item "Geral" (revisão do `reviewer`, CI e merge, que são do dono). Mapa dos testes: matriz, hierarquia e `authz_denials_total` em `domain/permissions.test.ts`, `presentation/admin/rbac.controller.test.ts` e `presentation/admin/users.controller.test.ts`; hierarquia exaustiva, bloqueio do cliente e `LAST_OWNER` em `application/users/user-admin.service.test.ts`; concorrência e atomicidade com Postgres real em `infrastructure/database/user-admin.integration.test.ts`; isolamento de `UserRepository`/`AuditRepository` e FKs compostas em `infrastructure/database/repositories/*.integration.test.ts`; troca da própria senha em `presentation/auth/password.controller.test.ts`; ponta a ponta com dois clientes, Redis real, limiter fail-closed e privacidade em `infrastructure/http/rbac.integration.test.ts`; inventário em `infrastructure/http/rate-limit/rate-limit.test.ts`; migration aditiva em `infrastructure/database/migrations.test.ts`; CLI em `infrastructure/auth/cli/auth-cli.integration.test.ts`; teto do hasher em `infrastructure/auth/scrypt-password-hasher.test.ts` e `application/auth/auth.service.test.ts`.

**Fontes consultadas:** código do repositório (specs 003, 005, 007, 010), documentação do PostgreSQL sobre `SELECT ... FOR UPDATE` e `ALTER TYPE ... ADD VALUE` (conhecimento prévio; sem acesso a rede nesta sessão), OWASP Authorization Cheat Sheet (negar por padrão, checar permissão no servidor em todo pedido, validar no service além do hook) e NIST SP 800-63B (política de senha, já usada na 007), ambos de conhecimento prévio e a reconferir pelo `reviewer`.

**Validação (nível 4, uma execução por vez):** em Node 24.18.0 e 22.23.2, `pnpm typecheck`, `lint`, `format:check`, `test` (964 unitários) e `test:integration` (308), `rm -rf dist && pnpm build` e smoke do processo compilado (`/health/ready` 200, login com corpo vazio 400, `/admin/clients`, `.../users`, `.../audit-events` e `POST /auth/password` sem token 401, nenhuma linha de erro no log), tudo verde. Suítes novas e alteradas repetidas 5 vezes em cada Node (11 arquivos unitários, 186 testes; 6 de integração, 51 testes), sem falha. **Falhas que só apareceram na validação final: 0.** As que apareceram durante o trabalho foram pegas nos níveis 1 e 2: repositório em memória lançando de forma síncrona (teste com `assert.rejects`), probes em rota que não estava registrada, comparação de 404 entre classes diferentes, regras de lint nos testes novos e, no teste da migration, uma regex estragada por `sed` (o `ON DELETE RESTRICT` casava com `DELETE`; o erro foi commitado duas vezes antes do conserto, por encadear `git commit` ao teste: três commits de correção, sem efeito no código de produção).
