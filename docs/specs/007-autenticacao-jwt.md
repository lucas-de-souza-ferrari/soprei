# 007 — Autenticação com JWT e refresh token (substitui a `ADMIN_API_KEY`)

- **Status:** aprovada (2026-10-29, com todas as recomendações da seção "Decisões"; reescrita do esboço contra o código de `main` em `0c519fe`; passa pelo `reviewer` antes do merge, por ser spec de segurança: autenticação, segredos, endpoint público e isolamento)
- **Branch:** `spec/007-autenticacao-jwt`
- **Depende de:** 003 (isolamento), 004 (contexto e `redact`), 005 (perfis de rate limit). Prepara a 008 (RBAC) e a spec B (onboarding de vários clientes no canal).

## Objetivo

Hoje todas as rotas `/admin/*` usam uma única chave estática (`ADMIN_API_KEY`) que vale para **todos** os clientes. Esta spec troca essa chave por **identidade de verdade**: usuários de um cliente e administradores da plataforma fazem login, recebem um access token curto e um refresh token com rotação, e toda rota protegida sabe **quem** é e **a qual cliente** pertence, sempre a partir do token assinado. É pré-requisito do onboarding de vários clientes no canal WhatsApp (spec B).

## Estado de partida (herdado do código real)

- Rotas `/admin/clients` (CRUD de `Client`) e `/admin/clients/:clientId/{messages,conversations,conversations/:id/messages}` usam `adminAuthHook(apiKey)` (`src/presentation/admin/admin-auth.hook.ts`), que é o `bearerAuthHook` (token estático, comparado em tempo constante) com log da recusa. O `apiKey` entra por `AdminRoutesParams` em `buildServer` e vem de `config.ADMIN_API_KEY` (`src/index.ts`); em produção a config exige 32 caracteres no mínimo.
- O `:clientId` das rotas de atendimento vem **do caminho** e é só validado como `ClientId` (`clientScopeParamsSchema`); o controller chama `setClientId(clientId)` com esse valor. Não há nenhum usuário, e `userId` do contexto (`setUserId`) nunca é preenchido.
- `bearerAuthHook` também protege `GET /metrics` (`METRICS_TOKEN`); **esse uso não muda**.
- O limiter da 005 é um hook `onRequest` da **instância raiz**, roda antes de qualquer autenticação e de ler o corpo, chave `<perfil>:<ip>`, perfis `public`, `admin`, `webhook` (`RATE_LIMIT_PROFILES` em `src/shared/rate-limit/profiles.ts`), e é **fail-open** em todos (`skipOnError`). A 005 deixou os perfis de login e refresh com fail-closed para esta spec.
- `MODEL_SCOPES` (`tenant-scope.ts`) classifica `Client` (global), `Conversation` e `Message` (tenant). Repositório de tenant: `ClientId` como primeiro parâmetro, só `findFirst/findMany/create/updateMany/deleteMany/count`. `Client.slug` é único e identifica o cliente para sempre.
- O logger tem `redact` para `authorization`, `cookie`, `password`, `refreshToken`, `accessToken`, `token`, `apiKey` (raiz e um nível abaixo). O contexto (`AsyncLocalStorage`) já tem `setClientId` e `setUserId`.
- Webhook do WhatsApp (`/webhooks/whatsapp`) autentica por assinatura HMAC e `hub.verify_token`; **não muda**. `/health`, `/health/ready` ficam abertas; `/metrics` fica com `METRICS_TOKEN`.
- O Redis é obrigatório no boot (fail-fast). Não há dependência de JWT nem de hash de senha no `package.json`.

## Comportamento esperado

### Quem existe: duas espécies de identidade

1. **`User` (de tenant):** pessoa de **um** cliente (dono, atendente). Tem `clientId` obrigatório. Acessa só as rotas `/admin/clients/:clientId/...` do **seu** cliente.
2. **`PlatformAdmin` (global):** operador da plataforma (o dono do Soprei). **Não pertence a cliente algum**, então não é um `User` com `clientId` nulo: um model de tenant com `clientId` opcional quebraria a regra "toda entidade de tenant tem `clientId`". Acessa só `/admin/clients` (criar, listar, alterar, remover clientes). **Não lê conversas nem mensagens de cliente** (decisão 5).

Papéis em `User.role`: `OWNER` e `AGENT` (enum `UserRole`). **Nesta spec o papel é só carregado** (no token, no contexto e em `GET /auth/me`) e **todos os usuários ativos do cliente têm o mesmo acesso**; a 008 define permissões, acrescenta `ADMIN`/`VIEWER` e faz valer a diferença.

### Modelos (migration aditiva)

```prisma
enum UserRole   { OWNER AGENT        @@map("user_role") }
enum UserStatus { ACTIVE DISABLED    @@map("user_status") }

/// (TENANT) Pessoa de um cliente. E-mail único POR cliente. `passwordHash` nunca vai a log, resposta nem métrica.
model User {
  id           String     @id @default(uuid(7)) @db.Uuid
  clientId     String     @map("client_id") @db.Uuid
  email        String                          // normalizado: trim + minúsculas, até 254 caracteres
  passwordHash String     @map("password_hash")
  role         UserRole   @default(AGENT)
  status       UserStatus @default(ACTIVE)
  createdAt    DateTime   @default(now()) @map("created_at")
  updatedAt    DateTime   @updatedAt @map("updated_at")
  client       Client     @relation(fields: [clientId], references: [id], onDelete: Restrict)

  @@unique([clientId, email])
  @@index([clientId, createdAt, id])
  @@map("users")
}

/// (GLOBAL) Operador da plataforma. E-mail único global.
model PlatformAdmin {
  id           String     @id @default(uuid(7)) @db.Uuid
  email        String     @unique
  passwordHash String     @map("password_hash")
  status       UserStatus @default(ACTIVE)
  createdAt    DateTime   @default(now()) @map("created_at")
  updatedAt    DateTime   @updatedAt @map("updated_at")

  @@map("platform_admins")
}
```

- `MODEL_SCOPES`: `User: 'tenant'`, `PlatformAdmin: 'global'` (o compilador e o teste de cobertura exigem). `Client` ganha a relação `users User[]`.
- Sem `@@unique([id, clientId])` em `User` por ora: nenhum model aponta para `User` (sessões ficam no Redis). A 008 o acrescenta se a auditoria virar tabela.
- Entidades em `src/domain/entities/` (`User`, `PlatformAdmin`) **sem** `passwordHash`; o hash só sai em um tipo próprio (`UserCredentials`) devolvido pela busca de login. `UserId` e `PlatformAdminId` são branded types criados por factory que valida UUID. Rotas nunca devolvem o hash.
- Repositórios (interfaces em `src/domain/repositories/`): `UserRepository` (`TenantRepository<User, NewUser, UserUpdate>` mais `findCredentialsByEmail(clientId, email): Promise<UserCredentials | null>`) e `PlatformAdminRepository` (`findCredentialsByEmail(email)`, `findById`, `create`, `updatePassword`). `User` com o e-mail repetido **no mesmo** cliente: `ConflictError`; em dois clientes, sem conflito.

### Senha

- **Hash: `scrypt` do `node:crypto`**, parâmetros OWASP (N = 2^17, r = 8, p = 1, sal aleatório de 16 bytes, chave de 32 bytes, `maxmem` 256 MiB), guardado como `scrypt$N$r$p$<sal b64>$<hash b64>` (os parâmetros vão no próprio valor, o que permite aumentar o custo depois). Comparação com `timingSafeEqual`. Sem dependência nova (decisão 1). Porta `PasswordHasher` em `src/application/ports/`; implementação em `src/infrastructure/auth/`.
- **Limite de hashes simultâneos** (constante, 2): cada hash usa ~128 MiB e o `scrypt` assíncrono ocupa o pool de threads do libuv; sem teto, uma enxurrada de logins esgotaria memória e travaria o resto do processo. Quem passa do teto espera na fila; o rate limit por IP e o bloqueio por conta limitam o tamanho dela. O custo é injetável para os testes não pagarem 128 MiB por teste.
- **Política (Zod):** 12 a 128 caracteres (o teto limita o custo de hash por requisição), normalizada em NFKC antes do hash, sem NUL, **sem regras de composição** (NIST SP 800-63B). Lista de senhas vazadas fica fora de escopo.
- E-mail: `z.email()`, `trim`, minúsculas, até 254 caracteres.

### Tokens

- **Access token:** JWT **HS256** de 15 min (`AUTH_ACCESS_TTL_SECONDS`), assinado com `JWT_SECRET`, cabeçalho `typ: at+jwt`, claims `iss`, `aud`, `iat`, `exp`, `sub` (id do usuário ou do admin), `kind` (`user` ou `platform`), `cid` (só em `user`), `role` (só em `user`) e `sid` (id da sessão = família do refresh). A verificação **fixa** o algoritmo (`algorithms: ['HS256']`, nunca o que o token declarar), confere `iss`, `aud`, `typ`, claims obrigatórias e `clockTolerance` pequena (`AUTH_CLOCK_TOLERANCE_SECONDS`, padrão 5). Biblioteca: `jose` (decisão 2), só dentro de `src/infrastructure/auth/` atrás de uma porta (`AccessTokenService`); o ESLint proíbe importá-la de fora (como já é com BullMQ).
- **Refresh token:** opaco, `randomBytes(48)` em base64url, entregue **uma vez**, no corpo da resposta (decisão 8). Formato entregue: `<escopo>.<sessionId>.<segredo>`, onde `<escopo>` é o `ClientId` (ou `platform`) e `<sessionId>` é um UUID. **Os dois primeiros campos não são segredo nem autoridade**: servem só para achar a chave no Redis (as chaves derivam do `ClientId`); o que vale é o hash do `<segredo>` guardado. Adulterar o escopo só faz a chave não existir (401, sem efeito em outro cliente).
- **Só o hash (SHA-256) do segredo fica no Redis**, nunca o valor.
- **Estrutura no Redis** (conexão dedicada, ver "Redis"; prefixo `AUTH_REDIS_PREFIX`, padrão `soprei:auth:`; `<e>` = `ClientId` ou `platform`):
  - `<e>:sess:<sessionId>` (hash: `userId`, `current` = hash do refresh vigente, `revoked`): TTL = o menor entre `AUTH_REFRESH_TTL_SECONDS` (ocioso, padrão 7 dias, renovado a cada rotação) e o que resta de `AUTH_SESSION_MAX_SECONDS` (teto absoluto desde o login, padrão 30 dias);
  - `<e>:used:<sessionId>` (lista dos **últimos 50** hashes já usados, `LPUSH` + `LTRIM`, mesmo TTL);
  - `<e>:usess:<userId>` (conjunto das sessões do usuário, para "sair de todos"; TTL = teto absoluto);
  - `<e>:rsid:<sessionId>` (marca "sessão revogada", TTL = TTL do access token): corta o access token ainda válido;
  - `<e>:nbf:<userId>` (instante a partir do qual os access tokens valem, TTL = TTL do access token): corta todos os access tokens do usuário (logout-all, desativação, troca de senha).
- **Rotação com detecção de reuso (script Lua atômico, que recebe todas as chaves em `KEYS`):** apresentado o refresh, calcula-se o hash do segredo e:
  1. sessão inexistente ou revogada: **inválido** (401);
  2. hash == `current`: empurra o `current` antigo para `used`, grava o novo hash como `current`, renova o TTL: **ok**, emite novo par;
  3. hash está em `used`: **reuso**, marca a sessão `revoked`, grava `rsid` e devolve 401; as duas pontas (ladrão e dono) perdem a sessão;
  4. qualquer outro valor: **inválido**, **sem** revogar. Isto é deliberado: o `sessionId` aparece no `sid` do access token, então quem o conhece poderia, com um segredo inventado, derrubar a sessão alheia se "hash desconhecido" revogasse.
  Duas chamadas simultâneas com o mesmo refresh (cliente que repete a requisição) contam como reuso e encerram a sessão: sem janela de tolerância (decisão 10).
- **Revogação:** `POST /auth/logout` (corpo `{ refreshToken }`, sem exigir access token válido: o refresh é a credencial; idempotente, 204 mesmo se desconhecido) revoga a sessão. `POST /auth/logout-all` (autenticada) revoga todas as sessões do usuário e grava `nbf`. Desativar usuário e trocar senha (via CLI, ver abaixo) usam a mesma operação do `SessionStore` (`revokeAllSessions`); a 008 a chamará ao desativar usuário pela API.
- **`authenticate` (cada requisição):** valida a assinatura e as claims e consulta o Redis (`MGET` de `rsid` e `nbf`): token com `iat` anterior ao `nbf` ou com sessão revogada é recusado. **Redis fora = 503, fail-closed** (decisão 9): não se aceita token sem poder checar a revogação. Usuário desativado ou cliente suspenso: `login` e `refresh` recusam (consultam o banco); um access token já emitido vale até expirar (no máximo 15 min), salvo desativação explícita (que grava `nbf`). Cliente suspenso **não** grava `nbf` de cada usuário nesta spec (limitação documentada).

### Rotas novas (`src/presentation/auth/`)

| Rota | Quem | Corpo / resposta |
| --- | --- | --- |
| `POST /auth/login` | público, perfil `login` | `{ clientSlug, email, password }` → `200 { accessToken, refreshToken, tokenType: "Bearer", expiresIn }` |
| `POST /auth/platform/login` | público, perfil `login` | `{ email, password }` → idem |
| `POST /auth/refresh` | refresh token, perfil `refresh` | `{ refreshToken }` → novo par |
| `POST /auth/logout` | refresh token, perfil `refresh` | `{ refreshToken }` → 204 |
| `POST /auth/logout-all` | access token, perfil `admin` | → 204 |
| `GET /auth/me` | access token, perfil `admin` | `user`: `{ kind, id, email, role, client: { id, name, slug } }`; `platform`: `{ kind, id, email }` |

Respostas com tokens levam `Cache-Control: no-store`. Todas as entradas validadas com Zod (`clientSlug` com `CLIENT_SLUG_PATTERN`).

### Login sem enumeração de contas

- O cliente é localizado pelo `clientSlug` (`ClientRepository.findBySlug`, já existente) e o usuário por `findCredentialsByEmail(clientId, email)`: **nunca há consulta de usuário sem `ClientId`**, então não é preciso abrir exceção na barreira de tenant.
- Slug inexistente, cliente removido ou suspenso, e-mail inexistente, usuário desativado e senha errada devolvem **a mesma** resposta (`401`, código `UNAUTHORIZED`, mensagem fixa "Credenciais inválidas") e executam **o mesmo trabalho**: quando não há hash para comparar, o `PasswordHasher.verify` roda contra um hash fictício com os mesmos parâmetros. O teste prova pelas chamadas ao hasher (não por cronômetro).
- **Bloqueio por conta:** contador no Redis com a chave derivada da identidade do pedido (`<prefixo>login-fail:<sha256(slug \0 email)>`; é uma exceção declarada à regra "chave deriva do `ClientId`", como os perfis por IP da 005, porque vale antes de existir `ClientId` e **também para contas inexistentes**, o que evita enumeração). `AUTH_LOGIN_MAX_FAILURES` (padrão 5) falhas em `AUTH_LOGIN_LOCK_SECONDS` (padrão 900) bloqueiam novas tentativas pelo restante da janela com `429 RATE_LIMITED` e `Retry-After`, **antes** de gastar um hash. Sucesso zera o contador. Aceita-se que um atacante possa bloquear uma conta por 15 min (custo menor que permitir adivinhação); o limite por IP e o `Retry-After` curto reduzem o dano.

### Rate limit (perfis novos; chave continua `<perfil>:<ip>`)

- `login` (`/auth/login`, `/auth/platform/login`): `RATE_LIMIT_LOGIN_MAX` 10 por `RATE_LIMIT_LOGIN_WINDOW_SECONDS` 900.
- `refresh` (`/auth/refresh`, `/auth/logout`): `RATE_LIMIT_REFRESH_MAX` 60 por `RATE_LIMIT_REFRESH_WINDOW_SECONDS` 900 (vários aparelhos atrás do mesmo IP).
- `/auth/logout-all` e `/auth/me` ficam no perfil `admin`.
- **Fail-closed para `login` e `refresh`:** com o Redis do limiter fora, essas duas rotas respondem 503 e **não** verificam senha nem emitem token (hoje todos os perfis são fail-open por `skipOnError`). O implementer verifica na versão instalada do `@fastify/rate-limit` se dá para escolher o modo por perfil; se não der, o hook da raiz trata esses dois perfis com um contador atômico próprio (mesmo script `INCR`+`PEXPIRE`, sempre com TTL). O número de cada perfil vem da config e o nome continua sendo só o do perfil na rota (`rateLimitProfile('login')`); o teste de inventário de rotas da 005 cobre as rotas novas. `RATE_LIMIT_PROFILES` ganha `login` e `refresh`; o limiter continua **antes** da autenticação e por IP (cota por cliente autenticado fica fora de escopo, ver abaixo).

### Redis (conexão dedicada)

`createAuthRedis` (`src/infrastructure/auth/`) no molde do `createRateLimitRedis`: fila offline desligada, prazo curto por comando (`AUTH_REDIS_TIMEOUT_MS`, padrão 500), fechada no `shutdown`. Falha vira `ServiceUnavailableError` (503, novo na hierarquia, operacional, `SERVICE_UNAVAILABLE`), nunca 500 nem aceitação. Erros do ioredis só saem no log por `describeRedisError` (carregam `command.args` com chaves e ids). Porta `SessionStore` em `src/application/ports/`.

### Rotas existentes que mudam de autenticação

| Rota | Antes | Depois |
| --- | --- | --- |
| `POST/GET /admin/clients`, `GET/PATCH/DELETE /admin/clients/:id` | `ADMIN_API_KEY` | **`PlatformAdmin`** (access token `kind: platform`); `User` recebe 403 |
| `POST /admin/clients/:clientId/messages` | `ADMIN_API_KEY` | **`User`** com `cid == :clientId`; `PlatformAdmin` recebe 403 |
| `GET /admin/clients/:clientId/conversations` | idem | idem |
| `GET /admin/clients/:clientId/conversations/:conversationId/messages` | idem | idem |
| `GET`/`POST /webhooks/whatsapp` | assinatura / verify token | **sem mudança** |
| `GET /health`, `GET /health/ready` | aberta | **sem mudança** |
| `GET /metrics` | `METRICS_TOKEN` | **sem mudança** |
| `/auth/*` | não existia | novas (tabela acima) |

- **`ADMIN_API_KEY` é removida** (decisão 6): sai da config (`env.schema.ts`, inclusive a exigência em produção), do `.env.example`, de `AdminRoutesParams`/`buildServer`/`index.ts` e `admin-auth.hook.ts` é apagado (`bearerAuthHook` fica, é o do `/metrics`). Quem ainda a tiver no `.env` não quebra o boot (variável desconhecida é ignorada), mas ela deixa de ter efeito; isso entra no registro da implementação, no `.env.example` e no handoff.
- **`ClientId` sempre do token.** Um hook `authenticate` (em `src/presentation/common/`) preenche `request.auth` (`{ kind: 'user', userId, clientId, role, sessionId }` ou `{ kind: 'platform', adminId, sessionId }`, tipado por `declare module 'fastify'`) e chama `setUserId` e, para `user`, `setClientId`. Os hooks `requireUser()` e `requirePlatform()` (o RBAC mínimo desta spec; a 008 constrói `requirePermissions`/`requireRoles` sobre eles) recusam a espécie errada com 403. Nas rotas `/admin/clients/:clientId/...`, `requireUser()` mais a conferência `params.clientId === auth.clientId`: divergência vira **404 `NOT_FOUND`** (idêntico a cliente inexistente, para não revelar quais ids existem; decisão 14) e o log registra só o padrão da rota. **O service sempre recebe `auth.clientId`**; o `:clientId` do caminho existe só por compatibilidade de URL e é descartado depois da conferência.
- O contexto de log passa a ter `userId` e `clientId` de **toda** requisição autenticada; o log de recusa de `/admin` ("acesso administrativo recusado") vira o log de recusa do `authenticate` (padrão da rota, motivo categorizado: `missing`, `malformed`, `invalid`, `expired`, `revoked`; nunca o token). A resposta ao cliente é sempre a mesma 401 com `WWW-Authenticate: Bearer`, sem dizer o motivo.

### Criação do primeiro usuário (sem expor segredo)

Não há rota HTTP para criar usuário ou administrador nesta spec (a CRUD de usuários é da 008; a criação de clientes pela API já existe para o `PlatformAdmin`). O início é um **comando local, rodado pelo dono**, como já é com roles e bancos:

- `pnpm auth:cli create-platform-admin --email <e-mail>` e `pnpm auth:cli create-user --client <slug> --email <e-mail> --role OWNER|AGENT` e `pnpm auth:cli reset-password (--platform-admin | --client <slug>) --email <e-mail>` (este revoga todas as sessões). O código fica em `src/infrastructure/auth/cli/` (usa repositórios e `PasswordHasher`; lê `DATABASE_URL`/`REDIS_URL` pela config).
- **A senha nunca vem por argumento nem por variável de ambiente.** O comando a pede no terminal sem eco (ou lê a primeira linha do `stdin` se não for terminal, para automação) e confirma digitando duas vezes. Argumento com `--password` é recusado. Nada é impresso além de "criado: id".
- Um agente **não** roda o comando contra o banco do dono; os testes o exercitam contra `soprei_test`.
- Fluxo do dono para o primeiro cliente: `create-platform-admin` -> `POST /auth/platform/login` -> `POST /admin/clients` -> `create-user --client <slug> --role OWNER` -> `POST /auth/login`. A criação de usuário por HTTP (convite, troca de papel) é da 008; a troca da **própria** senha por API e a recuperação por e-mail ficam fora (use `reset-password`).

### Config nova (validada em `src/infrastructure/config/`, documentada em `.env.example` e `.env.test.example`)

| Variável | Regra |
| --- | --- |
| `JWT_SECRET` | **obrigatória em todos os ambientes**, mínimo 32 caracteres; nunca em log (entra no `redact`) |
| `JWT_ISSUER`, `JWT_AUDIENCE` | texto não vazio; padrão `soprei` e `soprei-api` |
| `AUTH_ACCESS_TTL_SECONDS` | 60 a 3600; padrão 900 |
| `AUTH_REFRESH_TTL_SECONDS` | 3600 a 2 592 000; padrão 604 800 (ocioso) |
| `AUTH_SESSION_MAX_SECONDS` | padrão 2 592 000; precisa ser maior ou igual a `AUTH_REFRESH_TTL_SECONDS` (regra cruzada) |
| `AUTH_CLOCK_TOLERANCE_SECONDS` | 0 a 60; padrão 5 |
| `AUTH_LOGIN_MAX_FAILURES` / `AUTH_LOGIN_LOCK_SECONDS` | 1 a 20 / 60 a 86 400; padrões 5 e 900 |
| `AUTH_REDIS_TIMEOUT_MS` | 1 a 10 000; padrão 500 |
| `AUTH_REDIS_PREFIX` | padrão `soprei:auth:`; os testes passam um prefixo único |
| `RATE_LIMIT_LOGIN_MAX` / `_WINDOW_SECONDS`, `RATE_LIMIT_REFRESH_MAX` / `_WINDOW_SECONDS` | mesmas regras dos demais perfis; padrões 10/900 e 60/900 |
| `ADMIN_API_KEY` | **removida** |

`JWT_SECRET` do `.env` do dono precisa ser criada antes de subir (gerar 48 bytes aleatórios). Rotação de segredo (aceitar o anterior por um tempo) fica fora de escopo; trocar o segredo invalida todos os access tokens (os refresh continuam, pois não dependem dele).

### Métricas (registry da 004; conjuntos fixos de labels, nenhum id, e-mail ou IP)

`auth_logins_total{kind,result}` (`kind`: `user`, `platform`; `result`: `ok`, `invalid`, `locked`), `auth_refresh_total{result}` (`ok`, `invalid`, `reuse`, `unavailable`), `auth_token_rejections_total{reason}` (`missing`, `malformed`, `invalid`, `expired`, `revoked`, `unavailable`), `auth_logouts_total{scope}` (`session`, `all`).

### Logs e privacidade

- **Nunca em log, erro, métrica nem resposta** (além do que a rota devolve ao dono do dado): senha, hash de senha, access e refresh token, `JWT_SECRET`, e-mail e o segredo do refresh. Entram no `redact`: `passwordHash`, `newPassword`, `currentPassword`, `JWT_SECRET`, `email`. O `redact` é rede de segurança; a regra é **não pôr** esses valores em objeto de log. Erros de validação do Zod de `/auth/*` não ecoam o valor recebido.
- Eventos de auditoria (info/warn, só ids): login ok (`userId`/`adminId`, `clientId`, `sessionId`), login recusado (resultado, sem identidade), refresh com reuso detectado (`warn`, sessão e usuário), logout, logout-all, bloqueio por conta (sem e-mail). Falha de hash ou de Redis: log `error` com `describeRedisError`/`describeError`.
- A mensagem de qualquer 401 de `/auth/*` e do `authenticate` é constante.

## Critérios de aceite

Cada item tem teste automatizado. Unitários com `SessionStore` em memória e hasher de custo baixo; integração em Redis `/15` (prefixo único por teste, só se remove o que o teste criou) e `soprei_test`.

**Modelos e isolamento**
- [ ] Migration cria `users` e `platform_admins`; `MODEL_SCOPES` classifica `User` (tenant) e `PlatformAdmin` (global) e o teste de cobertura passa.
- [ ] Teste de isolamento do `UserRepository` (no molde de `conversation.repository.integration.test.ts`): o cliente A não encontra, lista, conta, atualiza nem remove usuário do cliente B (`NotFoundError`); `findCredentialsByEmail(A, emailDeB)` devolve `null`; **o mesmo e-mail existe nos dois clientes sem conflito** e repetir no mesmo cliente é `ConflictError`; consulta de `User` sem `clientId` lança `TenantScopeError`.
- [ ] Teste: o `passwordHash` nunca aparece em entidade, resposta HTTP, log nem erro.

**Senha**
- [ ] Teste: `hash` e `verify` conferem; sal diferente por hash; formato `scrypt$N$r$p$...` com os parâmetros esperados; hash malformado ou parâmetros fora do aceito falham como "inválido", sem lançar.
- [ ] Teste: política (menos de 12, mais de 128, NUL) recusa; NFKC aplicado; sem regra de composição.
- [ ] Teste: o teto de hashes simultâneos é respeitado (nunca mais que 2 em execução).

**Login**
- [ ] Teste: login válido de `User` e de `PlatformAdmin` devolve `accessToken`, `refreshToken`, `tokenType`, `expiresIn` e `Cache-Control: no-store`.
- [ ] Teste: slug inexistente, cliente removido, cliente suspenso, e-mail inexistente, usuário desativado e senha errada devolvem **o mesmo** 401 (status, código, mensagem e corpo idênticos) e **todos** chamam o `verify` do hasher exatamente uma vez (hash fictício quando não há usuário).
- [ ] Teste: o mesmo e-mail de dois clientes entra cada um no seu cliente e o token traz o `cid` certo.
- [ ] Teste: após `AUTH_LOGIN_MAX_FAILURES` falhas, a tentativa seguinte (mesmo com a senha certa) devolve 429 com `Retry-After` **sem** chamar o hasher; vale também para e-mail inexistente; sucesso antes do limite zera o contador; o contador expira.
- [ ] Teste: 429 por IP ao exceder `RATE_LIMIT_LOGIN_MAX` em `/auth/login` e `/auth/platform/login`; `RATE_LIMIT_REFRESH_MAX` em `/auth/refresh` e `/auth/logout`.
- [ ] Teste: com o Redis do limiter e com o Redis de auth fora, `POST /auth/login` e `POST /auth/refresh` respondem 503, **não** verificam senha e **não** emitem token (usa `ToggleProxy`).

**Access token**
- [ ] Teste: token expirado, de outro `iss`/`aud`, com `typ` errado, com algoritmo trocado (`none`, HS384) ou assinatura inválida, sem `kind`/`sub`, ou com `Bearer` malformado: 401 igual, com `WWW-Authenticate: Bearer`, sem revelar o motivo; a categoria vai só à métrica.
- [ ] Teste: `clockTolerance` aceita token expirado há menos que a tolerância e recusa além dela.
- [ ] Teste: `authenticate` preenche `userId` e `clientId` no contexto (o log da requisição os traz) e `request.auth` tem o tipo certo.
- [ ] Teste: sessão revogada ou `iat` anterior ao `nbf` derruba o access token **ainda dentro do prazo**; com o Redis fora, 503 e a rota não executa.
- [ ] Teste de config: `JWT_SECRET` ausente ou com menos de 32 caracteres impede o boot; `AUTH_SESSION_MAX_SECONDS` menor que `AUTH_REFRESH_TTL_SECONDS` falha; valores fora de faixa falham; `ADMIN_API_KEY` no ambiente é ignorada.

**Refresh, rotação e reuso**
- [ ] Teste: `refresh` devolve par novo e o refresh antigo deixa de funcionar.
- [ ] Teste: reuso do refresh antigo (em `used`) revoga a sessão: o refresh mais novo também falha e o access token da sessão é recusado (`rsid`); métrica `reuse`.
- [ ] Teste: segredo inventado com `sessionId` válido é 401 **sem** revogar a sessão (o refresh legítimo continua funcionando).
- [ ] Teste: refresh com `<escopo>` adulterado (ClientId de outro cliente) é 401 e **não** altera nenhuma sessão do outro cliente.
- [ ] Teste (integração, Redis real): duas chamadas simultâneas com o mesmo refresh: no máximo uma rotação (script atômico) e a outra é reuso.
- [ ] Teste: refresh de usuário desativado, de cliente suspenso ou removido falha; o papel do novo access token é o atual do banco.
- [ ] Teste: TTL ocioso e teto absoluto respeitados (relógio injetável ou TTLs curtos por config); toda chave criada tem TTL.
- [ ] Teste: o Redis guarda **apenas o hash**: após login e refresh, nenhuma chave nem valor com o prefixo contém o refresh token entregue nem o segredo.
- [ ] Teste: todas as chaves de auth começam por `<prefixo><ClientId|platform>:`; nenhuma chave de usuário tem outro formato.

**Logout e revogação**
- [ ] Teste: `logout` com o refresh revoga a sessão (refresh e access dessa sessão falham), é idempotente (204 para refresh desconhecido) e não afeta outras sessões do mesmo usuário.
- [ ] Teste: `logout-all` revoga todas as sessões e todos os access tokens do usuário (`nbf`), sem afetar outro usuário nem outro cliente.

**Rotas existentes e isolamento nas rotas**
- [ ] Teste: sem token, token inválido ou expirado: 401 em todas as rotas `/admin/*` e `/auth/me`.
- [ ] Teste: token de `User` em `/admin/clients` (CRUD de clientes): 403; token de `PlatformAdmin` em `/admin/clients/:clientId/{messages,conversations,...}`: 403.
- [ ] Teste de isolamento de ponta a ponta com dois clientes: usuário do cliente A com `:clientId` do cliente B recebe 404 idêntico ao de cliente inexistente, nenhum dado do B é tocado (nada gravado em `Message`/`Conversation` do B, nada lido) e o log não traz o texto das mensagens; usuário do A com o `:clientId` do A funciona, e o `ClientId` repassado ao service é o do token.
- [ ] Teste: `GET /auth/me` devolve a identidade do token (`user` e `platform`), nunca o hash.
- [ ] Teste: o inventário de rotas da 005 passa (perfis `login`/`refresh` declarados) e um novo inventário falha se uma rota `/admin/*` não declarar `requireUser()` ou `requirePlatform()`.
- [ ] Teste: webhook do WhatsApp, `/health`, `/health/ready` e `/metrics` seguem funcionando sem token de usuário (suítes da 004, 005 e 011 verdes, sem enfraquecer asserções); as suítes de `/admin` migradas continuam cobrindo os mesmos cenários com tokens emitidos por um helper de teste.
- [ ] Teste: não existe mais `ADMIN_API_KEY` na config, em `buildServer` nem em `adminAuthHook`.

**CLI**
- [ ] Teste (contra `soprei_test`): `create-platform-admin`, `create-user` e `reset-password` gravam hash (nunca a senha), recusam `--password`, recusam senha fora da política e e-mail repetido no mesmo cliente, `reset-password` revoga as sessões, e nada além do id é impresso; senha não aparece em saída nem em log.

**Privacidade**
- [ ] Teste de captura de log (`src/test-support/log-capture.ts`) em login válido, login inválido, bloqueio, refresh, reuso, logout, 401 e erro de Redis: uma senha, um e-mail, um access token, um refresh token e o `JWT_SECRET` **secretos** de teste não aparecem em nenhuma linha de log, em `message`/`context` de erro, em label de métrica nem em corpo de resposta de erro.
- [ ] Teste: `/metrics` expõe os contadores `auth_*` com os labels fixos e nenhum id, e-mail ou IP.

**Geral**
- [ ] `typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes em Node 22 e 24; suítes novas repetidas várias vezes em cada Node (testes de TTL e de simultaneidade são sensíveis a tempo: relógio injetável e sondagem com prazo, nunca sleep fixo); CI verde; revisão do `reviewer`.

## Casos de borda e erros

- **Redis de auth fora:** `login`, `refresh`, `logout`, `logout-all` e `authenticate` respondem 503 (`SERVICE_UNAVAILABLE`), sem aceitar nem emitir nada; `/health/ready` já reporta Redis. O webhook do WhatsApp e `/metrics` não dependem desta conexão.
- **Banco fora:** `login`/`refresh` propagam o `DatabaseError` (500) pelo handler central; nenhum token é emitido.
- **Cliente suspenso ou removido, usuário desativado:** `login` e `refresh` recusam como credencial inválida; access token existente vale até expirar (no máximo 15 min) ou até um `nbf` explícito.
- **Mesmo refresh duas vezes por engano (retentativa de rede do cliente):** tratado como reuso e encerra a sessão; o cliente refaz login. Limitação aceita (decisão 10).
- **Token com `cid` de cliente removido depois:** `authenticate` não consulta o banco; o `:clientId` ainda confere, e o service devolve `NotFoundError` para cliente removido.
- **Troca do `JWT_SECRET`:** todos os access tokens caem; refresh continua e gera novos.
- **Papel desconhecido em token antigo:** `authenticate` aceita só `OWNER`/`AGENT`; outro valor é 401 (a 008 define a política de papéis futuros).
- **Relógio dessincronizado:** `clockTolerance` pequena; prazos de sessão são TTLs do Redis (o relógio do Redis decide), não data comparada no processo.
- **E-mail com maiúsculas, espaços ou formas Unicode diferentes:** normalizado antes de comparar e gravar.
- **Corpo inválido em `/auth/*`:** 400 do Zod, sem ecoar o valor; não conta como "falha de login" para o bloqueio, mas conta no limite por IP.

## Isolamento entre clientes

- **O `ClientId` vem só do token assinado** (claim `cid`, de `User`). Nunca de cabeçalho, corpo ou URL: o `:clientId` da URL é **conferido** contra o token e depois descartado; o service recebe `auth.clientId`. O refresh carrega o `ClientId` no próprio formato apenas como dica de chave no Redis, sem autoridade (ver "Tokens").
- **Dados:** `User` é model de tenant (barreiras 1, 2 e 3 da 003): repositório com `ClientId` como primeiro parâmetro, `tenant-scope` recusa consulta sem `clientId`, lint proíbe Prisma fora de `infrastructure/database`. E-mail único **por cliente**. `PlatformAdmin` é global, sem `clientId`, e só alcança `/admin/clients` (CRUD de clientes), não dados de atendimento.
- **Redis:** toda chave de usuário deriva do `ClientId` (`<prefixo><ClientId>:...`), de administrador de `platform:...`. Exceção declarada: o contador de falhas de login usa o hash de `slug + e-mail` (antes de existir `ClientId`, e para contas inexistentes).
- **Provas:** os testes de isolamento do repositório, das chaves do Redis, do refresh adulterado, de `logout-all` e do teste de ponta a ponta com dois clientes (todos nos critérios acima).
- **RLS do Postgres** continua sendo spec própria antes de dados reais; esta spec não a antecipa.

## Fora de escopo

- **RBAC completo (008):** permissões, `requirePermissions`/`requireRoles`, papéis `ADMIN`/`VIEWER`, CRUD de usuários por HTTP, convite, troca de papel, "último OWNER não pode sair", auditoria de mudança de papel, desativar usuário pela API.
- **Tempo real (009):** autenticação do SSE/WebSocket e salas por cliente.
- **Spec B (onboarding, Embedded Signup, token do WhatsApp por cliente cifrado):** usa a autenticação daqui.
- SSO/OAuth, 2FA/MFA, recuperação de senha por e-mail e troca da própria senha por API (use `reset-password` do CLI até a 008 ou uma spec de contas), verificação de e-mail, lista de senhas vazadas, cookie `HttpOnly`/CSRF e painel web, chaves de API por cliente (para integração máquina a máquina), rotação de `JWT_SECRET` com chave anterior, assinatura assimétrica (RS256/EdDSA, `kid`), reemissão do hash com custo novo no login, janela de tolerância para refresh repetido, cota de requisições **por cliente** autenticado (o limiter continua por IP e antes da autenticação), `nbf` em massa quando o cliente é suspenso, política de retenção/LGPD de dados de usuário.

## Decisões (propostas; o dono decide)

1. **Hash de senha.** (a) **`scrypt` do `node:crypto` [recomendado]**: sem dependência nova nem módulo nativo (o `argon2` precisa de binário pré-compilado ou compilação e do aval de scripts de build do pnpm, o que é risco no Windows, no CI e em Node 22 e 24), padrão OWASP aceito (N = 2^17, r = 8, p = 1), parâmetros dentro do hash. (b) `argon2id` com o pacote `argon2`: é a primeira recomendação da OWASP, mas é dependência nativa; o esboço o previa. (c) `bcrypt`: mais fraco (72 bytes, sem custo de memória). Trocar depois é possível pelo prefixo do formato.
2. **Biblioteca de JWT.** (a) **`jose` [recomendado]**: sem dependências, API pequena, fixa algoritmo, `iss`, `aud`, `typ` e `clockTolerance`; fica atrás de uma porta. (b) `@fastify/jwt` (usa `fast-jwt`): acopla o formato ao plugin do Fastify e à camada de apresentação. (c) à mão com `node:crypto`: não, é terreno de erro clássico.
3. **Como o login acha o usuário.** (a) **`clientSlug` + e-mail + senha, e-mail único por cliente [recomendado]**: o `User` é model de tenant puro, nunca há consulta sem `ClientId`, a mesma pessoa pode estar em dois clientes. Custo: a tela de login precisa do slug do cliente. (b) E-mail único global e login só com e-mail: login mais simples, mas exige consulta global de `User` (uma exceção na barreira de tenant) e impede a mesma pessoa em dois clientes.
4. **Administrador da plataforma.** (a) **Model global `PlatformAdmin` separado [recomendado]**: não quebra "toda entidade de tenant tem `clientId`" e o escopo dele é só o CRUD de clientes. (b) `User` com `clientId` nulo: mistura as duas espécies e enfraquece a barreira. (c) Manter a `ADMIN_API_KEY` só para `/admin/clients`: não resolve a credencial estática compartilhada.
5. **O que o administrador da plataforma alcança.** (a) **Só o CRUD de clientes; conversas e mensagens só pelo usuário do próprio cliente [recomendado]**: conteúdo de mensagem é dado pessoal e este é o papel de maior risco de vazamento (a 008 já o tratava como spec própria). Custo: para testar o simulador o dono cria um `User` do cliente de teste (um comando). (b) Também lê e escreve em qualquer cliente: equivale ao comportamento de hoje, com cada acesso auditado; mais prático, pior para LGPD.
6. **Destino da `ADMIN_API_KEY`.** (a) **Remover nesta spec [recomendado]**: é exatamente a credencial entre clientes que a 007/008 devem substituir, e o primeiro usuário nasce por comando local, sem precisar dela. (b) Mantê-la só como bootstrap atrás de uma flag: deixa uma credencial poderosa viva. (c) Manter até a 008: a mesma chave continuaria dando acesso total a tudo.
7. **Primeiro usuário.** (a) **Comando local `pnpm auth:cli`, senha pedida no terminal sem eco e nunca por argumento ou variável [recomendado]**. (b) Variáveis `BOOTSTRAP_ADMIN_EMAIL/PASSWORD` no boot: a senha ficaria no `.env` e em processos. (c) Rota HTTP aberta "primeiro acesso": superfície de ataque.
8. **Onde vai o refresh token.** (a) **Corpo da resposta [recomendado]**, por ser API pura e ainda não haver painel. (b) Cookie `HttpOnly` + `SameSite`: melhor para painel web, mas traz CSRF e escolhas de domínio que dependem de como o painel será feito; vira spec do painel.
9. **Redis fora e o `authenticate`.** (a) **Fail-closed (503) [recomendado]**: não se aceita token sem poder checar a revogação; o sistema já exige Redis no boot. (b) Valida só a assinatura (o esboço): tokens revogados voltariam a valer por até 15 min durante a queda.
10. **Refresh repetido (retentativa do cliente).** (a) **Reuso estrito: derruba a sessão [recomendado]**, o mais seguro e simples; o cliente refaz o login. (b) Janela de tolerância de alguns segundos devolvendo o mesmo resultado: menos atrito, mas abre uma brecha para o ladrão e complica o script.
11. **Bloqueio de conta.** 5 falhas em 15 min bloqueiam por 15 min (também para contas inexistentes, com 429); mais o limite por IP (10 tentativas de login em 15 min). Quer outros números? Aceita que um atacante bloqueie uma conta por 15 min?
12. **Papéis desta spec.** (a) **`OWNER` e `AGENT` no banco e no token, sem diferença de acesso até a 008 [recomendado]**: a 008 acrescenta `ADMIN` e `VIEWER` sem renomear nada. (b) Um papel só: a 008 teria de migrar dados. (c) Os quatro papéis já: antecipa decisão da 008.
13. **Um PR ou dois.** (a) **Um PR [recomendado]**, com commits na ordem: modelos e migration -> hasher, tokens e `SessionStore` -> login, refresh, logout e rotas `/auth` -> `authenticate` e migração das rotas `/admin` com remoção da `ADMIN_API_KEY` -> CLI -> documentação; assim nunca coexistem as duas credenciais por tempo longo. (b) Dividir em 007 (núcleo `/auth` mais `authenticate`, convivendo com a chave) e 007b (migrar `/admin`, remover a chave, CLI): PRs menores, mas a chave estática fica viva até a segunda.
14. **Cliente da URL diferente do cliente do token.** (a) **404, igual a cliente inexistente [recomendado]**: não revela quais ids existem. (b) 403: mais explícito para o desenvolvedor, mas distingue existente de inexistente.
15. **`JWT_SECRET` obrigatória em todos os ambientes [recomendado]** (inclusive desenvolvimento e testes, que usam um valor de teste no `.env.test.example`), para que ninguém suba com autenticação sem segredo. Alternativa: só em produção, com segredo aleatório por boot em desenvolvimento (derruba sessões a cada reinício).
16. **Prazos.** Access 15 min, refresh ocioso 7 dias, teto da sessão 30 dias [recomendado]. Quer outros valores?

## Decisões e dependências novas

- **Dependência nova: `jose`** (decisão 2; versão fixa, estável, publicada há mais de dois dias, compatibilidade com Node 22 e 24 conferida pelo implementer, como foi com o SDK da 014). Motivo: assinar e verificar JWT com algoritmo fixo e checagem de `iss`/`aud`/`typ`/`exp` sem escrever criptografia à mão. Fica atrás de `AccessTokenService`; o ESLint (`eslint.config.js`) proíbe importá-la fora de `src/infrastructure/auth/`.
- **Sem dependência para o hash** (decisão 1: `node:crypto`). Se o dono escolher `argon2`, é dependência nativa a justificar e validar em Node 22 e 24 no CI.
- **Arquitetura em camadas (o ESLint impõe):** `domain/` ganha `User`, `PlatformAdmin`, `UserId`, `PlatformAdminId` e as interfaces `UserRepository`/`PlatformAdminRepository`, sem importar de nenhuma outra camada; `application/auth/` (`AuthService`: login, refresh, logout, `me`) e as portas `PasswordHasher`, `AccessTokenService`, `SessionStore` em `application/ports/`; `infrastructure/auth/` (hasher scrypt, `jose`, `SessionStore` no Redis com o script Lua, `createAuthRedis`, `cli/`); `infrastructure/database/repositories/` (repositórios Prisma); `presentation/auth/` (rotas e validators Zod) e `presentation/common/` (`authenticate`, `requireUser`, `requirePlatform`). `application` e `presentation` não importam `infrastructure/database` nem `jose`. Pastas novas só as necessárias (`application/auth/`, `infrastructure/auth/`, `presentation/auth/`); sem barrel novo, sem alias de caminho. O `ClientId` é passado explicitamente aos repositórios.
- **Erros:** `UnauthorizedError` (401, mensagem constante), `ForbiddenError` (403), `NotFoundError` (404), `RateLimitError` (429) e **novo `ServiceUnavailableError`** (503, operacional, `SERVICE_UNAVAILABLE`, em `app.errors.ts` com teste no `errors.test.ts`; atualizar a lista do `AGENTS.md`). `AuthService` devolve `Result` com razão discriminada (`invalid_credentials`, `locked`, `invalid_refresh`, `reuse_detected`, `unavailable`) para as falhas **esperadas**; a camada de apresentação as traduz em erros da hierarquia. Nunca `throw new Error` genérico.
- **Redact do logger:** acrescentar `passwordHash`, `newPassword`, `currentPassword`, `JWT_SECRET` e `email` a `REDACTED_KEYS`.
- **Documentação a atualizar na implementação (não nesta fase de rascunho):** `AGENTS.md` (nova seção "Autenticação (spec 007)", remoção de `ADMIN_API_KEY` das regras e de "Rotas `/admin/*` usam `ADMIN_API_KEY`", nota da exceção de chaves do 005 e do contador de login, comandos `pnpm auth:cli`, `ServiceUnavailableError`), `docs/context.md` (roadmap e estado), `.env.example` e `.env.test.example`, `docs/handoff.md` (o `.env` do dono precisa de `JWT_SECRET`; `ADMIN_API_KEY` não vale mais; como criar o primeiro usuário).
- **Fontes a reconferir pelo implementer antes de fixar valores** (a pesquisa do rascunho foi feita sem acesso à rede e os itens abaixo vêm do conhecimento prévio; nenhum foi verificado nesta sessão): OWASP Password Storage Cheat Sheet (parâmetros do scrypt e do argon2id), NIST SP 800-63B (política de senha), RFC 9068 (`typ: at+jwt`), RFC 6750 (`WWW-Authenticate: Bearer`), documentação do `jose` (`jwtVerify`, `algorithms`, `typ`, `clockTolerance`), documentação do `crypto.scrypt` do Node (`maxmem`) e do `@fastify/rate-limit` 11.x (modo de falha por rota).
- Por ser autenticação, segredos, endpoint público e isolamento, **passa pelo agente `reviewer` antes do merge** (de preferência outro agente/modelo que o do implementer). Pontos que o `reviewer` deve olhar: fixação do algoritmo, rotação e reuso atômicos (script Lua), vazamento entre clientes nas chaves e no `:clientId`, enumeração e tempo na resposta de login, fail-closed, `redact`, remoção completa da `ADMIN_API_KEY`.
- **Validação em níveis (handoff, experimento em curso):** typecheck e teste do arquivo a cada passo, lint e suíte da área antes de cada commit, bateria completa e repetições só no final; registrar quantas falhas só apareceram na validação final.
