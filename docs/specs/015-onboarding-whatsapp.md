# 015 — Onboarding de clientes no canal WhatsApp (credenciais por cliente e Embedded Signup)

- **Status:** concluída (015a e 015b na `main`; status normalizado em 2026-11-23, spec 042). Antes: aprovada; **015a e 015b (Embedded Signup) implementadas** (2026-10-30; a 015b depois da decisão do dono sobre o `/register`, ver "Decididas pelo dono"). Aprovada em 2026-10-30 ( com todas as recomendações da seção "Decisões para o dono"; "spec B" do canal WhatsApp; o dono decidiu em 2026-10-30 que o Embedded Signup entra nesta spec; passa pelo `reviewer` antes do merge)
- **Branch:** `spec/015-onboarding-whatsapp`
- **Depende de:** 011 (canal), 013 (agrupamento), 007 (autenticação), 008 (papéis, permissões, auditoria)
- **Segurança:** guarda segredo de terceiros, toca isolamento e endpoint de administração: **passa pelo `reviewer` antes do merge** (foco: criptografia e uso do token, isolamento entre clientes, posse do número).

## Objetivo

Hoje há um app Meta, um `WHATSAPP_ACCESS_TOKEN` global e o `Client.whatsappPhoneNumberId` gravado à mão pelo `PlatformAdmin`. Para atender vários clientes, cada um precisa ter **a própria credencial do canal**, guardada cifrada, e poder **conectar (pelo Embedded Signup da Meta ou colando um token), trocar o token e desconectar o próprio número pela API**, sem o dono mexer no banco ou no `.env`. O frontend com o botão do Embedded Signup é de outro projeto; esta spec entrega o **contrato do backend** que ele usa. O envio passa a usar o token **do cliente do job**, nunca um global.

## Estado de partida (lido no código, 2026-10-30)

- `Client.whatsappPhoneNumberId` (`String?`, `@unique`) é o **único** ponto que leva de um identificador externo ao cliente (`ClientRepository.findByWhatsappPhoneNumberId`, cliente removido não aparece). Só se grava por `PATCH /admin/clients/:id` (`PlatformAdmin`, `ClientService.update`).
- `WhatsappCloudApiClient` (`src/infrastructure/external-apis/whatsapp/`) é criado **uma vez** em `src/index.ts` com `whatsappChannelConfig(config).accessToken`; `MessageSender.sendText({ phoneNumberId, to, text })` não recebe token.
- `ChannelInboundProcessor.resolvePhoneNumber` lê o cliente no banco pelo `clientId` do job, descarta se suspenso ou se o número mudou (`NonRetryableJobError`) e classifica o erro de envio: Meta `190` (token inválido) é **permanente** (`isRetryableGraphFailure`), vira log `error` e texto padrão tentado uma vez (que falha pelo mesmo motivo). Nada registra que o canal do cliente está quebrado.
- Webhook: um `WHATSAPP_APP_SECRET` valida a assinatura de todos os `POST` antes de ler o JSON; o `ClientId` nasce só da resolução `phone_number_id` -> cliente.
- Permissões (`src/domain/permissions.ts`): `conversation:*`, `user:*`, `audit:read`. `AuditEvent` exige `actorUserId` **e** `targetUserId` (usuários) e só tem ações `USER_*`.

## Fatos sobre a Meta (a conferir pelo implementer na documentação oficial antes de fixar valores)

**Não consegui consultar a documentação nesta sessão** (sem acesso à web); o que segue vem de conhecimento prévio e de informação do dono (2026-10-27: verificação de negócio concluída, app Business publicado, Tech Provider). O implementer reconfere cada item e registra a fonte e a data no "Registro da implementação". Páginas a conferir: Embedded Signup (`developers.facebook.com/docs/whatsapp/embedded-signup`), Cloud API (`.../docs/whatsapp/cloud-api`), webhooks e `subscribed_apps` (`.../cloud-api/guides/set-up-webhooks`), `debug_token` (`.../docs/facebook-login/guides/access-tokens/debugging`), códigos de erro (`.../cloud-api/support/error-codes`).

- **Posse do número:** um token só enxerga os números das WABAs a que tem acesso. `GET /{waba_id}/phone_numbers` com o token do cliente lista os `phone_number_id` dessa WABA; se o número pedido não está na lista, o token **não prova** posse. É a prova usada aqui.
- **`debug_token`:** `GET /debug_token?input_token=<token>` autenticado com o token de app (`app_id|app_secret`) devolve `is_valid`, `app_id`, `scopes`, `granular_scopes` (com os `target_ids`, onde aparecem as WABAs) e `expires_at` (0 = não expira). Serve para recusar token de **outro app** (o webhook só chega para o nosso app, então um token de outro app deixaria o cliente "conectado" e mudo) e token sem `whatsapp_business_messaging` / `whatsapp_business_management`.
- **Receber mensagens exige o app assinado na WABA:** `POST /{waba_id}/subscribed_apps` (com o token do cliente) liga o webhook do app àquela WABA; `DELETE` desliga.
- **Embedded Signup:** o navegador abre o fluxo com `FB.login` (`config_id` do Facebook Login for Business, `response_type: 'code'`); ao fim a Meta entrega ao navegador um `code` de **uso único e vida curta (cerca de 30 s, conforme a documentação reconferida em 2026-10-30)** e, por evento `message` `WA_EMBEDDED_SIGNUP` (`FINISH`), `phone_number_id`, `waba_id` e `business_id` (em outros tipos de término, como `FINISH_ONLY_WABA`, o `phone_number_id` **pode faltar**: o frontend só chama o endpoint quando tem os três; o servidor nunca confia nos ids do navegador e os revalida na Graph com o token obtido). Usar o Embedded Signup **v4** (v2 e v3 serão descontinuados em 2026-10-15). O servidor troca o `code` por token no endpoint OAuth do Graph (`/oauth/access_token`, com `client_id`, `client_secret` e `code`; no fluxo por popup do JS SDK normalmente **sem** `redirect_uri`, a confirmar), assina o app na WABA e, **se a documentação atual exigir**, registra o número (`/register`, PIN). Pré-requisitos no painel Meta, que o dono confirmou já existirem (2026-10-30): verificação de negócio, app publicado e Tech Provider, acesso avançado a `whatsapp_business_management` e `whatsapp_business_messaging`, `config_id` e domínio autorizado. Os dados do evento chegam **pelo navegador**, portanto são **não confiáveis** até revalidados na Graph com o token obtido. Confirmar também a validade do token de negócio resultante (`debug_token`: `expires_at`).

## Comportamento esperado

### Modelo e estados

Um model novo, **de tenant**, `ChannelConnection` (tabela `channel_connections`), **um por cliente** (múltiplos números por cliente ficam fora, ver "Fora de escopo"):

| Campo | Regra |
| --- | --- |
| `id`, `clientId` | `clientId` **único** e chave estrangeira para `clients` (`Restrict`); classificado como `tenant` em `MODEL_SCOPES` |
| `wabaId` | texto de dígitos (1 a 32); **não** é único (uma WABA pode ter números de clientes diferentes, p.ex. agência) |
| `tokenCiphertext` | token de acesso cifrado (formato abaixo), nunca em claro no banco |
| `tokenVersion` | inteiro, +1 a cada token gravado; serve à marca `TOKEN_INVALID` otimista |
| `status` | `CONNECTED` ou `TOKEN_INVALID` |
| `tokenExpiresAt` | `DateTime?`, informativo (vem do `debug_token`; nulo = não expira) |
| `createdAt`, `updatedAt`, `tokenInvalidAt` | datas |

O **número** continua só em `Client.whatsappPhoneNumberId` (`@unique` global: um número pertence a um cliente, e a resolução do webhook segue sendo a mesma). Não se duplica o número na tabela nova; a invariante "existe `ChannelConnection` => `Client.whatsappPhoneNumberId` não é nulo" é mantida pelas operações abaixo, **na mesma transação**, e tem teste.

Estado do canal exposto ao cliente (`state`): `NOT_CONNECTED` (sem número e sem conexão), `CONNECTED`, `TOKEN_INVALID`, `LEGACY` (cliente com número gravado antes da 015 e **sem** `ChannelConnection`: usa o token global de transição, ver "Migração"). Desconectar **apaga** a linha (com o texto cifrado) e limpa o número; `NOT_CONNECTED` é a ausência.

### Cifra de credenciais (`node:crypto`, sem dependência nova)

- **AES-256-GCM**, IV aleatório de 12 bytes por cifra, tag de 16 bytes. Formato do texto gravado: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url).
- **AAD** (dados autenticados) = `clientId` + `|` + `keyId`: o texto cifrado de um cliente **não decifra** se copiado para a linha de outro (barreira extra de isolamento). Não inclui o número (poderia ser trocado sem recifrar).
- **Chaves:** `CHANNEL_CREDENTIALS_KEYS` (lista `keyId:<32 bytes em base64url>` separada por vírgula, `keyId` = `^[A-Za-z0-9_-]{1,16}$`, sem repetição) e `CHANNEL_CREDENTIALS_ACTIVE_KEY_ID` (a que cifra; as outras só decifram, para **rotação**: entra a chave nova como ativa, a antiga fica na lista até todo texto ser regravado). Obrigatórias **só com `WHATSAPP_ENABLED=true`**; chave que não decodifica para exatamente 32 bytes, `keyId` ativo ausente da lista ou duplicata derrubam o boot (config validada num único módulo). Gerar: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
- Porta `CredentialCipher` (`application/ports/`: `encrypt(clientId, plain): string`, `decrypt(clientId, stored): SecretString`), implementação em `src/infrastructure/security/` (pasta nova). O `plain` e a chave **nunca** vão a log, erro, métrica nem resposta. `SecretString` é um invólucro (`reveal()`, `toString`/`toJSON`/`inspect` devolvem `[redacted]`) usado em todo o caminho do token em memória, para um `logger.info({ token })` distraído não vazar.
- Falha ao decifrar (formato inválido, chave ausente, tag que não confere) lança `CredentialDecryptionError` (erro novo, mensagem fixa, `context` só `{ reason }` com `malformed`/`unknown_key`/`tampered`), **sem** o texto cifrado. No envio isso é **permanente** (`NonRetryableJobError`; não vira `TOKEN_INVALID`, a falha é nossa) e conta em `channel_credential_errors_total{reason}`.
- Rotação em massa (regravar todo texto com a chave nova) **não** é feita aqui: salvar de novo (PUT) já recifra com a chave ativa; um comando de recifra fica para a primeira rotação real (ver "Fora de escopo").

### Rotas (`presentation/admin/channel.controller.ts`; perfil de rate limit `admin`; só existem com `WHATSAPP_ENABLED=true`, como o webhook)

Todas em `/admin/clients/:clientId/channel`, com `requirePermission(..., { clientParam: 'clientId' })` (ordem 401 -> 403 -> 404 de `:clientId` alheio -> 403 de permissão; o service sempre recebe `request.auth.clientId`). **`PlatformAdmin` recebe 403** (decisão 5 da 007: a plataforma não opera dentro do tenant nem vê o segredo dele).

- `GET .../channel` (`channel:read`) -> `{ state, phoneNumberId, wabaId, tokenExpiresAt, connectedAt, tokenInvalidAt }` (campos ausentes como `null`). **Nunca** o token, o texto cifrado nem a chave.
- `PUT .../channel` (`channel:manage`), corpo Zod **estrito** `{ phoneNumberId, wabaId, accessToken }` (`phoneNumberId`/`wabaId` 1 a 32 dígitos; `accessToken` 20 a 1024 caracteres sem espaço nem controle). Conecta **ou** troca o token (idempotente; é também o jeito de reconectar depois de `TOKEN_INVALID`). Passos, todos antes de gravar:
  1. `debug_token`: `is_valid`, `app_id` = `WHATSAPP_APP_ID`, escopos `whatsapp_business_messaging` e `whatsapp_business_management`, e `wabaId` entre os `target_ids` (se a Meta não os devolver, a checagem 2 continua obrigatória);
  2. `GET /{wabaId}/phone_numbers` com o token do cliente: `phoneNumberId` precisa estar na lista (**prova de posse**);
  3. `POST /{wabaId}/subscribed_apps` com o token do cliente (sem isso o webhook não chega).

  Depois, **uma transação** (com `lockClient`, que serializa PUTs do mesmo cliente): cifra, faz upsert da conexão (`tokenVersion + 1`, `status = CONNECTED`, `tokenInvalidAt = null`), grava `Client.whatsappPhoneNumberId` e o evento de auditoria. Resposta 200 com o mesmo corpo do `GET`. Número já usado por **outro** cliente: 409 `CHANNEL_NUMBER_IN_USE` (mensagem fixa, não diz quem). Trocar de número no mesmo cliente é um PUT com outro `phoneNumberId` (o número antigo é liberado; os jobs já enfileirados para ele são descartados pelo processador, regra da 011).
- `POST .../channel/embedded-signup` (`channel:manage`), **Embedded Signup**: ver a subseção seguinte. Mesmo resultado, mesmas validações e mesma gravação do `PUT`; só muda de onde vem o token.
- `DELETE .../channel` (`channel:manage`) -> 204, idempotente (sem conexão também é 204). Numa transação: apaga a `ChannelConnection` (some o texto cifrado), limpa `Client.whatsappPhoneNumberId` e audita. **Depois** do commit, melhor esforço e sem o token ficar em lugar nenhum: `DELETE /{wabaId}/subscribed_apps` (falha só loga e conta). Cliente `LEGACY` também pode desconectar (só limpa o número).
- Autorização: `channel:read` e `channel:manage` ao `OWNER` e ao `ADMIN` (matriz abaixo). O token é credencial do negócio do cliente: `AGENT` e `VIEWER` não veem nem o estado.

| Permissão | OWNER | ADMIN | AGENT | VIEWER |
| --- | :---: | :---: | :---: | :---: |
| `channel:read` (`GET .../channel`) | x | x | | |
| `channel:manage` (`PUT`, `POST .../embedded-signup`, `DELETE .../channel`) | x | x | | |

- Erros: corpo inválido 400 sem ecoar o valor; `accessToken` inválido, de outro app, sem escopo ou número fora da WABA: 400 com `code` fixo (`CHANNEL_TOKEN_REJECTED`, `CHANNEL_WRONG_APP`, `CHANNEL_MISSING_SCOPE`, `CHANNEL_NUMBER_NOT_IN_WABA`; `ValidationError` ganha `options.code` se preciso, como o `ConflictError`) e mensagem constante; Meta fora do ar, 5xx, 429 ou prazo: 502 (`ExternalServiceError`) **sem** gravar nada; conflito 409; sem permissão 403.
- **`PATCH /admin/clients/:id` deixa de aceitar `whatsappPhoneNumberId`** (corpo com o campo = 400): duas portas para o número divergiriam. `persona`, `name` e `status` seguem iguais.

### Embedded Signup: `POST /admin/clients/:clientId/channel/embedded-signup`

**O que o frontend faz (só o contrato; a tela é de outro projeto):** (1) o `OWNER`/`ADMIN` já está logado (Bearer); (2) abre `FB.login` com o `config_id` e `response_type: 'code'`; (3) guarda o `code` da resposta e `waba_id` e `phone_number_id` do evento `WA_EMBEDDED_SIGNUP` `FINISH`; (4) envia os três ao endpoint **logo** (o `code` vale cerca de 30 s e só uma vez); (5) trata a resposta (corpo do `GET .../channel`) e os erros abaixo, **sem** guardar nem reenviar o `code` (um novo fluxo gera outro).

- **Corpo (Zod estrito):** `{ code, wabaId, phoneNumberId }`; `code` 1 a 512 caracteres sem espaço nem controle; `wabaId`/`phoneNumberId` 1 a 32 dígitos. Resposta 200 igual à do `GET .../channel`; mesmos 400/409/502 do `PUT`, mais `400 CHANNEL_CODE_INVALID` (code inválido, expirado, já usado ou de outro app; mensagem constante, sem distinguir).
- **Passos no servidor:** (a) troca o `code` por token pelo `ChannelProvisioner.exchangeCode` (`WHATSAPP_APP_ID` e `WHATSAPP_APP_SECRET`; preferir `POST` com corpo `application/x-www-form-urlencoded` ou cabeçalho, para segredo e `code` não irem na URL, a confirmar na documentação); (b) **o mesmo fluxo do `PUT` com o token obtido**: `debug_token` (`app_id` igual a `WHATSAPP_APP_ID`, escopos, `wabaId` entre os `target_ids`), lista de números da WABA com o token (`phoneNumberId` precisa constar), `subscribed_apps`; (c) a mesma transação do `PUT` (cifra, upsert, número, auditoria `CHANNEL_CONNECTED` ou `CHANNEL_TOKEN_REPLACED`). O token trocado **só é gravado se tudo passar**; falhou em (b), é descartado da memória sem gravar.
- **Os ids do navegador não são confiados:** `wabaId` e `phoneNumberId` só valem se a Graph, com o **token obtido do `code`**, confirmar. Um cliente que enviar a WABA ou o número de **outro** recebe `CHANNEL_NUMBER_NOT_IN_WABA` ou `CHANNEL_WRONG_APP`/`CHANNEL_MISSING_SCOPE` (o token do `code` dele não enxerga o que não é dele); número já ligado a outro cliente: 409 `CHANNEL_NUMBER_IN_USE`.
- **`code`: uso único e sem Redis.** A Meta é quem garante o uso único (segundo uso = erro = `CHANNEL_CODE_INVALID`); o Soprei não guarda o `code`, nem o `hash` dele. Duas submissões simultâneas do mesmo `code`: uma vence, a outra recebe `CHANNEL_CODE_INVALID` (provado no servidor falso, que consome o `code` na primeira troca). Reenviar depois de 502 na troca pode já ter consumido o `code`: o frontend refaz o fluxo.
- **CSRF e `state` (decisão 9):** o fluxo por **popup do JS SDK** não usa redirecionamento, e o endpoint é autenticado por `Authorization: Bearer` (não por cookie), então outro site não consegue fazer o navegador do cliente chamá-lo. O ataque que um `state` evitaria (injetar o `code` de **outra** conta na sessão da vítima) só conectaria o canal da vítima à WABA do atacante, e o `code` do atacante é um segredo que ele teria de fazer a vítima enviar com o Bearer dela; mesmo assim a posse do número é provada pela Graph com o token do próprio `code`. Por isso **não** há `state` nem nonce server-side nesta spec. Se o frontend decidir usar o fluxo por **redirecionamento**, `state` aleatório (de uso único, preso a `clientId` e usuário, TTL curto) passa a ser obrigatório e exige uma spec/ajuste antes.
- **Rate limit:** perfil `admin` (já por IP) e serialização por cliente (`lockClient` na gravação). Cada chamada custa até 4 idas à Graph, com prazo `WHATSAPP_SEND_TIMEOUT_MS` cada; erro de Meta nunca vira 5xx do Soprei com corpo (502 genérico).
- **Privacidade:** `code`, `client_secret` e o token trocado **nunca** vão a log, erro, métrica, auditoria nem resposta; o `code` entra no `redact`; erro de validação do corpo não ecoa valor; o erro do `ChannelProvisioner` leva só `{ operation, httpStatus, providerCode, retryable }`.
- **Registro do número (`/register`) e PIN (decisão do dono, 2026-10-30):** depois do `subscribed_apps` e **antes** da transação, o servidor chama `POST /{phone_number_id}/register` (token do cliente, `messaging_product: whatsapp` e `pin`) com um **PIN aleatório de 6 dígitos** gerado por ele (`crypto.randomInt`, CSPRNG). O PIN é guardado **cifrado** como o token (mesma AES-256-GCM, AAD ligada ao `clientId`) na coluna `ChannelConnection.registrationPinCiphertext` (migration aditiva `20261030190000_channel_registration_pin`) e **nunca** vai a log, resposta, métrica nem `redact` (`registrationPin` e `registrationPinCiphertext` são redigidos): o cliente jamais o vê nem o digita. Refazer o Embedded Signup de um cliente que já tem PIN guardado **reaproveita** o PIN (registrar de novo com o mesmo PIN é aceito; um PIN diferente seria recusado por número com verificação em duas etapas). O `PUT` manual **não** registra e preserva o PIN existente. Desconectar e remover o cliente apagam a linha, PIN incluído.
- **Se o `/register` falhar: não grava nada** (o caminho mais simples e seguro: nenhuma conexão sem número registrado; o cliente refaz o fluxo, que gera outro `code`). Erro permanente da Meta (PIN diferente de número já registrado com 2FA, 133005, número bloqueado...) vira **400 `CHANNEL_REGISTRATION_FAILED`** com mensagem constante; erro transitório (5xx, 429, rede, prazo) vira 502. O corpo da Meta nunca é copiado. Efeito colateral aceito: o `subscribed_apps` já foi feito (inofensivo, ver "Casos de borda").
- **409 antes do registro:** depois da prova de posse e **antes** do `/register`, o serviço confere se o número já é de **outro** cliente (409 `CHANNEL_NUMBER_IN_USE`). Sem isso, um token que enxerga uma WABA compartilhada trocaria o PIN do número alheio. O `@unique` continua decidindo a corrida na transação.
- **`code` inválido:** qualquer erro 4xx da troca vira **400 `CHANNEL_CODE_INVALID`** com mensagem única (inválido, expirado, já usado ou de outro app); 5xx, 429, rede e prazo viram 502.
- **A confirmar pelo implementer antes de codar (e, se mudar o desenho, ajustar a spec e passar pelo `reviewer`):** se o Embedded Signup atual exige `/register` do número (PIN) a cargo do servidor; se a troca do `code` precisa de `redirect_uri`; a validade do token de negócio; se `granular_scopes` traz a WABA do Embedded Signup.

### Envio com o token do cliente

- `MessageSender.sendText` passa a receber `accessToken: SecretString` (e `WhatsappCloudApiClient` deixa de guardar token: um cliente HTTP único, token por chamada). O `redirect: 'manual'`, o teto de 64 KiB e os prazos continuam.
- Porta nova `ChannelCredentials.forClient(clientId)` (implementada sobre `ChannelConnectionRepository` + `CredentialCipher`; `application` não importa o banco) devolve `{ kind: 'ready', phoneNumberId, token, tokenVersion | 'legacy' }`, `{ kind: 'token_invalid' }`, ou `{ kind: 'none' }`. **O processador lê isso pelo `clientId` do job, no banco, a cada envio**; nada vem do payload do webhook nem do job (o job continua levando só `phoneNumberId` para a checagem "número mudou").
- Ordem em `resolvePhoneNumber`: cliente suspenso descarta (regra da 011) -> número do job diferente do atual descarta -> `token_invalid` **descarta sem enviar e sem chamar o LLM** (log `warn`, `discarded`; nenhum texto padrão, pois não há token válido; as mensagens seguem pendentes e a próxima do contato, depois de reconectar, as responde juntas) -> `none` como hoje.
- **Marca `TOKEN_INVALID`:** envio recusado com `providerCode` **190** e conexão própria (`tokenVersion` numérico) -> `ChannelConnectionRepository.markTokenInvalid(clientId, tokenVersion)`, um `updateMany` com `clientId` e `tokenVersion` no `where` (um token novo gravado no meio não é invalidado por falha do antigo). Só o 190 marca; outros códigos permanentes (janela de 24 h, permissão, destinatário) continuam só permanentes. A falha segue `NonRetryableJobError`; o texto padrão **não** é tentado nesse caso (mesmo token). Métrica `channel_state_transitions_total{to="token_invalid"}` e log `warn` só com `clientId`.
- Os jobs que já estavam na fila continuam válidos: o token é lido na hora do envio, não gravado no job.

### Migração dos clientes existentes e do token global

- A migration é **aditiva** (tabela nova, `ALTER TYPE audit_action ADD VALUE` e `target_user_id` anulável, ver Auditoria); **não cifra nada** (não há chave no SQL) e não apaga o número dos clientes atuais.
- **Token global vira transição:** `WHATSAPP_ACCESS_TOKEN` passa a ser **opcional**. Cliente com número gravado e sem `ChannelConnection` é `LEGACY` e envia com o token global **se ele existir**; sem ele, é `none` (log `error`, nada enviado). Como o `PATCH` deixa de gravar número, ninguém **novo** entra em `LEGACY`; o dono pede ao `OWNER` de cada cliente existente (ou usa o próprio `OWNER` de teste) para fazer o `PUT` e o cliente sai de `LEGACY`. Quando nenhum cliente estiver `LEGACY`, remover a variável é só apagá-la (sem spec). Justificativa: remover o token global já na 015 derrubaria o único cliente em produção até o `PUT`; mantê-lo opcional e **só** para `LEGACY` não cria caminho novo (o número do cliente continua vindo do banco pelo `clientId`).

### Auditoria

Reusa `AuditEvent` (mesma trilha imutável, mesma transação da mudança, mesmas garantias da 008) em vez de uma tabela nova: ações novas `CHANNEL_CONNECTED`, `CHANNEL_TOKEN_REPLACED` (PUT sobre conexão existente, inclusive reconexão), `CHANNEL_DISCONNECTED`. O ator é o usuário. `target_user_id` passa a **anulável**, com `CHECK` (ações `USER_*` exigem alvo; `CHANNEL_*` exigem alvo nulo), e o `GET .../audit-events` devolve `targetUserId` nulo nessas ações (mudança **aditiva** do contrato). Sem token, número, WABA, IP nem texto no evento. A invalidação do token pelo worker **não** é auditada (não tem ator); aparece no `GET .../channel`, no log e na métrica. Log `info` `audit` só com ids e enum, depois do commit, como na 008.

### Webhook e assinatura

Nada muda no fluxo (um app, um `WHATSAPP_APP_SECRET`, assinatura sobre o corpo cru antes do JSON, `ClientId` só de `phone_number_id` -> cliente). Mais de um app Meta (por exemplo, um app só para o Embedded Signup) exigiria tentar uma **lista** de segredos em tempo constante, porque a assinatura é conferida antes de ler o `entry[].id` (WABA); isso **não** entra agora (ver "Fora de escopo"). O `app_id` esperado vira configuração (`WHATSAPP_APP_ID`), só usado no `debug_token`.

### Configuração (validada no módulo de config; documentada em `.env.example` e `.env.test.example`)

| Variável | Regra |
| --- | --- |
| `WHATSAPP_APP_ID` | obrigatória com `WHATSAPP_ENABLED=true`; dígitos; todo token (manual ou do Embedded Signup) precisa ter este `app_id` no `debug_token` |
| `WHATSAPP_APP_SECRET` | já existe; passa a servir também à troca do `code` e ao token de app do `debug_token` |
| (sem variável nova para o Embedded Signup) | o `config_id` e o domínio autorizado ficam no frontend e no painel Meta |
| `CHANNEL_CREDENTIALS_KEYS` | obrigatória com o canal ligado; ver "Cifra"; entra no `redact` |
| `CHANNEL_CREDENTIALS_ACTIVE_KEY_ID` | obrigatória com o canal ligado; precisa estar em `KEYS` |
| `WHATSAPP_ACCESS_TOKEN` | **passa a opcional** (só para clientes `LEGACY`; mínimo 16 se informado) |

Quem já usa o canal precisa **acrescentar as três variáveis novas** ao `.env` antes de subir (o boot falha com mensagem clara se faltar). O `redact` do logger ganha `accessToken` (já existe), `code`, `clientSecret`, `tokenCiphertext`, `CHANNEL_CREDENTIALS_KEYS` e `WHATSAPP_ACCESS_TOKEN`.

### Cliente Graph de administração

Porta `ChannelProvisioner` (`application/ports/`: `exchangeCode(code)`, `inspectToken`, `listPhoneNumberIds(wabaId, token)`, `subscribeApp`, `unsubscribeApp`) e implementação `src/infrastructure/external-apis/whatsapp/whatsapp-graph-admin.client.ts`, no mesmo padrão do `WhatsappCloudApiClient` (`fetch`, `redirect: 'manual'`, prazo `WHATSAPP_SEND_TIMEOUT_MS`, leitura com teto de 64 KiB, schemas Zod tolerantes). O token do cliente vai em `Authorization: Bearer`; o token de app (`WHATSAPP_APP_ID|WHATSAPP_APP_SECRET`) também em cabeçalho, **nunca** em query string nem em log. O erro devolvido leva só `{ operation, httpStatus, providerCode, retryable }` (nunca o corpo da Meta, que pode ecoar token ou número).

### Métricas (registry da 004; conjuntos fixos de labels, sem `clientId`, número, WABA ou token)

- `channel_connections_total{action,result}`: `action` ∈ `connect`, `replace_token`, `embedded_signup`, `disconnect`; `result` ∈ `ok`, `invalid_token`, `invalid_code`, `wrong_app`, `missing_scope`, `number_not_in_waba`, `number_in_use`, `graph_error`.
- `channel_state_transitions_total{to}`: `token_invalid`.
- `channel_credential_errors_total{reason}`: `malformed`, `unknown_key`, `tampered`.

## Critérios de aceite

Servidor Graph falso estendido (`src/test-support/fake-graph-api.ts`: troca de `code` por token com `code` de uso único, expirável e de outro app, `debug_token`, `GET /{waba}/phone_numbers`, `POST/DELETE /{waba}/subscribed_apps`, cenários de token inválido, outro app, escopo faltando, 5xx, demora, e registro do `Authorization` recebido por número). **Nenhum teste chama a Meta real.**

- [x] **Cifra:** roundtrip devolve o token; dois `encrypt` do mesmo texto dão saídas diferentes (IV aleatório); chave errada, `keyId` desconhecido, texto adulterado (um byte no IV, na tag e no cifrado), formato inválido e texto cifrado de outro `clientId` (AAD) lançam `CredentialDecryptionError` com `reason` correto e **sem** o texto nem a chave na mensagem, no `context` ou em `JSON.stringify`; rotação: texto cifrado com a chave antiga decifra enquanto ela está na lista, e o novo sai com a chave ativa.
- [x] **`SecretString`:** `String(s)`, `JSON.stringify(s)`, template string e `util.inspect(s)` devolvem `[redacted]`; só `reveal()` dá o valor.
- [x] **Config:** com o canal ligado, falham o boot: chave com tamanho diferente de 32 bytes, `keyId` repetido, ativo fora da lista, `WHATSAPP_APP_ID` ausente; com o canal desligado nada disso é exigido; `WHATSAPP_ACCESS_TOKEN` ausente é aceito; valores secretos nunca aparecem na mensagem de erro do boot.
- [x] **`MODEL_SCOPES`/schema:** `ChannelConnection` classificado como `tenant` (o teste de cobertura passa); `clientId` único; a `tenant-scope` recusa operação sem `clientId`; `ChannelConnectionRepository` só usa `findFirst`, `create`, `updateMany`, `deleteMany`, `count` com `clientId` no `where`; a migration aplica em `soprei_test` e o `CHECK` de auditoria recusa `USER_*` sem alvo e `CHANNEL_*` com alvo.
- [x] **PUT feliz:** com token válido do nosso app, escopos certos e número na WABA, responde 200 com `state = CONNECTED`, grava `Client.whatsappPhoneNumberId`, a conexão (texto cifrado **diferente** do token e que decifra para ele), chama `subscribed_apps`, grava `CHANNEL_CONNECTED` na mesma transação e **nenhuma** resposta, log ou métrica contém o token (captura de log e varredura do corpo e de `/metrics`).
- [x] **PUT recusado, sem gravar nada** (nem número, nem conexão, nem auditoria): token inválido (400 `CHANNEL_TOKEN_REJECTED`), de outro app (`CHANNEL_WRONG_APP`), sem escopo (`CHANNEL_MISSING_SCOPE`), número fora da WABA (`CHANNEL_NUMBER_NOT_IN_WABA`), Meta 5xx/429/prazo (502), corpo com campo extra, ausente ou com formato inválido (400 sem ecoar o valor).
- [x] **Posse do número:** o cliente B, com token válido de **outra WABA**, não consegue conectar o `phoneNumberId` que pertence à WABA do cliente A (`CHANNEL_NUMBER_NOT_IN_WABA`); o cliente B com token que lista o número **já conectado ao cliente A** recebe 409 `CHANNEL_NUMBER_IN_USE` sem revelar A, e A segue intacto; duas conexões concorrentes do mesmo número por clientes diferentes (Postgres real): exatamente uma vence, a outra recebe 409.
- [x] **Embedded Signup feliz:** `POST .../channel/embedded-signup` com `code` válido e `wabaId`/`phoneNumberId` corretos troca o `code` (o servidor falso recebe `client_id` = `WHATSAPP_APP_ID`, o segredo e o `code`, **fora da URL** se a Graph aceitar), valida como o `PUT`, grava a conexão cifrada, chama `subscribed_apps`, audita na mesma transação e responde 200 com o corpo do `GET`; o resultado no banco é equivalente ao do `PUT`.
- [x] **Embedded Signup recusado, sem gravar nada:** `code` inválido, expirado, **já usado** e de outro app (400 `CHANNEL_CODE_INVALID`, mensagem idêntica); duas submissões simultâneas do mesmo `code` (uma 200, a outra 400); token obtido de **outro `app_id`** (`CHANNEL_WRONG_APP`), sem escopo, `wabaId` ou `phoneNumberId` que o token do `code` não enxerga (`CHANNEL_NUMBER_NOT_IN_WABA`), troca ok e `subscribed_apps` com 5xx (502), Meta 5xx/429/prazo na troca (502); corpo com campo extra ou faltando (400 sem ecoar valor).
- [x] **Embedded Signup entre dois clientes:** o cliente B envia o `wabaId` e o `phoneNumberId` do cliente A com **o `code` de B**: recusado e A intacto; B tenta o número já conectado a A com WABA que o token dele enxerga: 409 `CHANNEL_NUMBER_IN_USE` sem revelar A; `code` de B não conecta A (o `clientId` vem do token de acesso, nunca do corpo).
- [x] **Vazamento no Embedded Signup:** captura de log, corpo de resposta, erros e `/metrics` em todos os cenários acima não contêm o `code`, o `client_secret`/`WHATSAPP_APP_SECRET`, o token trocado nem o corpo de erro do servidor falso (que os ecoa de propósito); o `redact` cobre `code`.
- [x] **`app_id` fixo no fluxo manual também:** `PUT` com token de outro `app_id` recusado (`CHANNEL_WRONG_APP`), idem ao do Embedded Signup.
- [x] **Permissões do Embedded Signup:** `AGENT`/`VIEWER` 403, `PlatformAdmin` 403, `:clientId` alheio 404, sem token 401; a rota está no inventário (`admin`, `requirePermission`) e não existe (404) com `WHATSAPP_ENABLED=false`.
- [x] **Trocar o token** (PUT sobre conexão existente): `tokenVersion` sobe, `status` volta a `CONNECTED`, evento `CHANNEL_TOKEN_REPLACED`, o texto cifrado muda; **trocar de número** libera o antigo (outro cliente consegue conectá-lo depois).
- [x] **DELETE:** apaga a linha (nenhum `tokenCiphertext` do cliente resta no banco), limpa o número, audita `CHANNEL_DISCONNECTED`, tenta o `DELETE .../subscribed_apps` depois do commit, é idempotente (segundo DELETE = 204, sem novo evento), e a falha do `unsubscribe` não desfaz nem muda o 204 (log `warn` e métrica, sem token). Webhook para o número desconectado: `unknown_number`, nada enfileirado.
- [x] **Remoção do cliente** (`DELETE /admin/clients/:id`) apaga a conexão na mesma transação (nenhum texto cifrado de cliente removido permanece).
- [x] **`PATCH /admin/clients/:id`** com `whatsappPhoneNumberId` responde 400; sem o campo, os demais continuam funcionando (testes antigos da 010/011 atualizados).
- [x] **Permissões:** matriz de `channel:read` e `channel:manage` por papel (snapshot em `permissions.test.ts`); `AGENT` e `VIEWER` 403 em `GET`, `PUT` e `DELETE`; `PlatformAdmin` 403; sem token 401; `:clientId` de outro cliente 404 antes da permissão; o inventário de rotas (`rate-limit.test.ts`) passa (perfil `admin`, `requirePermission`); as rotas não existem (404) com `WHATSAPP_ENABLED=false`.
- [x] **Envio com o token do cliente (isolamento):** dois clientes, A e B, com números e **tokens diferentes**: a resposta ao contato de A sai com o `Authorization` de A e pelo número de A, a de B com o de B e pelo número de B; o servidor Graph falso registra o par (token, número) e **nunca** vê o token de A com o número de B (nem o inverso), inclusive com mensagens dos dois no mesmo lote da fila; job adulterado (`phoneNumberId` de B com `clientId` de A) é descartado sem enviar (regra da 011 mantida).
- [x] **Texto cifrado trocado entre clientes:** copiar o `tokenCiphertext` de A para a linha de B faz o envio de B falhar como `CredentialDecryptionError` (`tampered`), sem enviar, sem marcar `TOKEN_INVALID` e sem token em log.
- [x] **`TOKEN_INVALID`:** envio recusado com 190 marca a conexão (`status`, `tokenInvalidAt`), `GET .../channel` passa a `TOKEN_INVALID`, `channel_state_transitions_total` sobe, o job vira `NonRetryableJobError` **sem** texto padrão; o próximo `flush` desse cliente é descartado **sem chamar o LLM** (o `mock` registra zero entradas); mensagens ficam pendentes; um `PUT` com token novo volta a `CONNECTED` e a mensagem seguinte do contato responde o lote inteiro. 190 de um `tokenVersion` antigo **não** invalida o token novo (`markTokenInvalid` condicional). Outro código permanente (ex.: 131047) não muda o estado. O estado de A não afeta B.
- [x] **`LEGACY`:** cliente com número e sem conexão envia com o token global quando ele existe; sem ele, nada é enviado e há log `error`; cliente **com** conexão nunca usa o token global (o servidor falso prova o `Authorization`).
- [x] **Auditoria:** `GET .../audit-events` lista os eventos de canal do **próprio** cliente com `targetUserId` nulo e nunca os de outro; eventos `USER_*` continuam iguais; log `audit` só com ids e enum.
- [x] **Privacidade:** teste de fluxo (PUT, envio, 190, DELETE) com captura de log prova que um token secreto de teste, o texto cifrado, as chaves de `CHANNEL_CREDENTIALS_KEYS` e o corpo de erro da Meta não aparecem em log, resposta, erro nem métrica; `redact` cobre os campos novos.
- [x] **Cliente Graph de administração:** `redirect` não é seguido, resposta acima de 64 KiB é cortada, token de app só em cabeçalho, erro sem corpo da Meta; classificação de erro (190 -> `CHANNEL_TOKEN_REJECTED`; 5xx/429/rede -> 502).
- [x] **Métricas:** `channel_connections_total`, `channel_state_transitions_total` e `channel_credential_errors_total` registradas com conjuntos fixos de labels (teste do registry).
- [ ] `typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes em Node 22 e na LTS mais recente.

## Teste manual com a Meta (feito pelo dono; nenhum agente chama a API real)

(1) no `.env`, acrescente `WHATSAPP_APP_ID` e as duas variáveis de chave (gerar com o comando acima); reinicie; (2) **Embedded Signup:** no frontend do dono (ou numa página mínima com o JS SDK, `config_id` e domínio autorizado), faça o fluxo com um número de teste e mande `{ code, wabaId, phoneNumberId }` ao `POST .../channel/embedded-signup` logado como `OWNER`; ou, pelo caminho manual, com a WABA de teste e um token do **nosso app** (o temporário de 24 h do painel serve; o de usuário do sistema é o permanente), `PUT /admin/clients/:clientId/channel` com `phoneNumberId`, `wabaId` e `accessToken`; token de **outro app** deve ser recusado; (3) mande uma mensagem pelo WhatsApp: a resposta chega e `GET .../channel` mostra `CONNECTED`; (4) invalide o token (revogue ou espere expirar), mande outra: o canal passa a `TOKEN_INVALID` e nada é enviado; (5) `PUT` com token novo e `DELETE`; (6) cliente antigo: `GET .../channel` mostra `LEGACY` até o `PUT`.

## Casos de borda e erros

- Meta fora do ar no `PUT`: 502 e **nada gravado** (nem número); repetir o `PUT` é seguro (idempotente). `subscribed_apps` falhar depois do `debug_token` ok: 502, nada gravado.
- Dois `PUT` do mesmo cliente ao mesmo tempo: a transação com `lockClient` serializa; vale o último, ambos com auditoria. O 409 de número usado vem do `@unique` (também sob corrida).
- Token válido na hora do `PUT` e expirado depois: só o 190 no envio revela; sem verificação periódica (ver "Fora de escopo"); `tokenExpiresAt` informa a data prevista quando a Meta a dá.
- Cliente suspenso: segue sem receber nada (011). O login de cliente suspenso é 401 (007), então na prática o `OWNER` dele não alcança estas rotas.
- `phoneNumberId` já conectado ao **mesmo** cliente: é o caso "trocar token".
- Chave de cifra removida da lista com linhas ainda cifradas por ela: o envio falha como `CredentialDecryptionError` (`unknown_key`), alto no log e na métrica, sem reduzir a segurança; recuperar = recolocar a chave ou o cliente refazer o `PUT`.
- Queda entre a transação e o `unsubscribe` do `DELETE`: o app segue assinado na WABA, mas o número não resolve mais cliente (`unknown_number`); resíduo inofensivo, sem token guardado.
- **`/register` ok e transação falha (S-1):** se o `/register` der certo e a transação de gravação falhar, o PIN gerado se perde (nada foi guardado); repetir o Embedded Signup tende a dar `CHANNEL_REGISTRATION_FAILED` (número já registrado com 2FA e outro PIN). A saída é o `PUT` manual (que não registra) ou o dono resetar o PIN. Não corrigido de propósito: gravar o PIN antes do `/register` exigiria uma conexão parcial.
- **Fluxos simultâneos do mesmo cliente (S-2):** dois Embedded Signup ao mesmo tempo, com `code`s diferentes, podem deixar guardado um PIN que não é o último aceito pela Meta (raro; a gravação é serializada por `lockClient`, mas os `/register` não). Sem mudança de comportamento.
- **`/register` recusado (S-4):** qualquer 4xx não retentável do `/register` (inclusive 190) vira `CHANNEL_REGISTRATION_FAILED`.
- **PIN guardado que não decifra (S-3):** o serviço gera um PIN novo e registra um `warn` só com o `clientId`.
- **`subscribed_apps` antes da transação:** a assinatura do app na WABA acontece antes da gravação; numa falha de persistência (ou do `/register`) o app pode ficar assinado na WABA com nada gravado. É inofensivo: o webhook cai em `unknown_number`.
- **Uma WABA = um cliente do Soprei até haver spec própria.** O `DELETE` desassina o app da WABA inteira, então numa WABA compartilhada (agência com vários clientes) desconectar um deixaria os outros sem webhook. Um `PUT`/Embedded Signup que **troca a `wabaId`** do cliente **não** desassina a WABA antiga (resíduo inofensivo, sem token guardado).
- Token com mais permissões do que precisa: aceito (a Meta não permite pedir o mínimo no token de sistema); é o token do próprio cliente e só é usado para enviar.

## Isolamento entre clientes

Toca em dados de tenant e em segredo. Barreiras, cada uma com teste:

1. `ChannelConnectionRepository` estende `PrismaTenantRepository`: `ClientId` é o primeiro parâmetro de todo método, `clientId` vai no `where` pela base, a `tenant-scope` recusa o que escapar e `MODEL_SCOPES` classifica o model (cobertura obrigatória). O único caminho de identificador externo para cliente segue sendo `findByWhatsappPhoneNumberId`.
2. O token usado em cada envio é lido **pelo `clientId` do job** (nunca do payload) e a cifra o **amarra ao `clientId`** (AAD): ciphertext copiado entre linhas não decifra.
3. `clientId` do `PUT`/`GET`/`DELETE` vem **só** do token de acesso (`userAuth(request)`); o `:clientId` do caminho é conferido (404 se divergir).
4. Posse do número provada **com o token do próprio cliente** (lista de números da WABA) antes de gravar; `@unique` em `whatsappPhoneNumberId` no banco decide a corrida.
5. Teste obrigatório: dois clientes com tokens e números diferentes nunca cruzam token, número, estado (`TOKEN_INVALID` de um não afeta o outro), auditoria nem leitura (`GET` de A não mostra dado de B).

## Fora de escopo

- **Tela/frontend do Embedded Signup e de onboarding** (projeto separado do dono; aqui só o contrato do backend). Fluxo por **redirecionamento** (exigiria `state`, ver decisão 9).
- **Cadastro público** (o cliente se cadastra sozinho: criar `Client` e `OWNER` sem o `PlatformAdmin`, e-mail, anti-abuso): **spec própria depois**. Por ora cliente e `OWNER` inicial são criados pelo `PlatformAdmin` (`POST /admin/clients`) e por `pnpm auth:cli create-user`.
- Se a documentação atual exigir **registro do número com PIN** (`/register`) ou `business_id` no Embedded Signup e isso não couber aqui, vira spec própria (o implementer avisa antes de codar).
- **Templates de mensagem e janela de 24 h** (hoje 131047 é só erro permanente); mensagens iniciadas pela empresa.
- **Mais de um número (ou WABA) por cliente**: o schema permite evoluir (`clientId` deixaria de ser único), mas não é feito.
- **Mais de um app Meta** (lista de `WHATSAPP_APP_SECRET` testada em tempo constante) e conferência de `entry[].id` (WABA) do webhook contra a conexão do cliente.
- **Verificação periódica da saúde do token**, alerta de expiração, renovação automática e reenvio/varredura de pendentes depois de reconectar (a retomada completa já é pendência da 013).
- **Comando de recifra em massa** e rotação de `WHATSAPP_APP_SECRET`/`WHATSAPP_VERIFY_TOKEN`; KMS/HSM e cifra com envelope por cliente.
- **BSUID** (contato sem telefone), **cobrança**, **política geral de retenção/LGPD** e expurgo da auditoria (spec de LGPD, antes de dados reais).
- **Remover `WHATSAPP_ACCESS_TOKEN`**: quando nenhum cliente estiver `LEGACY`, é só apagar a variável.
- Convite por e-mail, criação do `OWNER` pela API (o `OWNER` do cliente continua nascendo por `pnpm auth:cli create-user`).

## LGPD e privacidade

- Passam a ser **dado do cliente** (segredo, não pessoal do contato): token (cifrado), `waba_id` e `phone_number_id` (identificadores de negócio; não vão a log nem a label, por consistência com a 011). O `wabaId` e o número voltam apenas ao `OWNER`/`ADMIN` do próprio cliente.
- Retenção: a credencial vive enquanto o cliente a mantém conectada; **desconectar e remover o cliente apagam a linha** (texto cifrado incluído); não há cópia, histórico de tokens nem soft delete. A auditoria guarda só ids e enum (expurgo na spec de LGPD).
- Backups do banco contêm o texto cifrado, que sem a chave é inútil: a chave mestra fica **fora do banco** (variável de ambiente) e fora de backup do banco; a perda da chave exige novo `PUT` de cada cliente (documentado).
- Base legal e termos do Tech Provider da Meta para operar em nome de clientes (contrato de operador com o cliente) o dono confere antes de clientes reais.

## Decisões para o dono (recomendação marcada; o dono decide)

1. **Fatia desta spec. DECIDIDO pelo dono (2026-10-30): o Embedded Signup entra na 015** (endpoint do `code` junto com credenciais por cliente, cifra, estado, envio com o token do cliente e `PUT/GET/DELETE`). Pré-requisitos Meta já existem. O que um agente não testa (a Meta real e o frontend) é coberto por servidor falso e pelo teste manual do dono. Se o PR passar de ~2 000 linhas, divide: **015a = credenciais, cifra, estado, envio e `PUT/GET/DELETE`; 015b = Embedded Signup** (troca do `code`, que reaproveita o serviço de conexão da 015a).
2. **Quem opera o canal do cliente.** **(recomendada) `OWNER` e `ADMIN` do cliente; `PlatformAdmin` não** (consistente com a decisão 5 da 007: a plataforma não opera dentro do tenant e não manuseia o token do cliente). Alternativa: só `OWNER`; ou deixar o `PlatformAdmin` conectar em nome do cliente (mais fácil no começo, mas o dono passa a tocar credencial de terceiros e precisa de rota e auditoria próprias).
3. **Token global.** **(recomendada) opcional e só para clientes `LEGACY`, removido pelo dono quando todos tiverem feito o `PUT`.** Alternativa: remover já (derruba o cliente atual até o `PUT`) ou manter como fallback permanente (um segredo compartilhado de que nada se livra).
4. **Cifra.** **(recomendada) AES-256-GCM do `node:crypto`, chave mestra em variável de ambiente com lista de chaves e `keyId` (rotação), AAD com o `clientId`.** Alternativas: cifra por pgcrypto no banco (a chave passaria pelo SQL e pelos logs do Postgres); envelope com KMS (exige hospedagem, ainda não decidida).
5. **Auditoria.** **(recomendada) reusar `AuditEvent` com `target_user_id` anulável e `CHECK` por ação.** Alternativa: tabela própria `ChannelEvent` (nenhuma mudança no contrato da 008, mas duas trilhas para o `OWNER` consultar).
6. **Token inválido.** **(recomendada) marca `TOKEN_INVALID`, descarta os próximos `flush` sem LLM nem texto padrão e exige o `PUT`.** Alternativa: continuar tentando enviar (gasta LLM à toa e polui log) ou tentar o texto padrão (não há token que funcione).
7. **Posse do número.** **(recomendada) provar com o token do próprio cliente (`debug_token` + lista de números da WABA), primeiro a provar leva, `@unique` global.** Alternativa: verificação extra por código no número (SMS) ou aprovação manual do dono (atrito sem ganho: o token já prova o acesso).
8. **Um PR ou dois.** **(recomendada) um PR**, em commits por camada (cifra e config, model e repositório, cliente Graph, rotas, Embedded Signup, processador). Se passar de ~2 000 linhas, divide em 015a e 015b (ver decisão 1).
9. **`state`/CSRF no Embedded Signup.** **(recomendada) sem `state` nem nonce server-side**, porque o fluxo é por popup do JS SDK (sem redirecionamento), o endpoint usa Bearer (não cookie) e tudo que vem do navegador é revalidado na Graph com o token do próprio `code`. Alternativa: nonce de uso único emitido por `POST .../channel/embedded-signup/session` (Redis, preso a `clientId` e usuário, TTL 10 min) e enviado de volta com o `code`: mais uma rota e uma dependência de Redis sem fechar um ataque real neste desenho; passa a ser obrigatório se o frontend usar redirecionamento.

### Decididas pelo dono (2026-10-30)

Embedded Signup incluso na 015; verificação de negócio, app publicado, Tech Provider, acesso avançado às duas permissões, `config_id` e domínio autorizado já existem; o dono terá um frontend e o cliente se cadastra sozinho (**cadastro público é spec própria depois**; por ora `PlatformAdmin` e `pnpm auth:cli` criam cliente e `OWNER`); a aplicação roda em servidor (chave mestra só no ambiente do servidor, fora do git, rotação por `keyId`); `app_id` do `debug_token` igual a `WHATSAPP_APP_ID` para **todos** os tokens; `OWNER`/`ADMIN` operam o canal e `PlatformAdmin` recebe 403; token global só para `LEGACY`; auditoria reusa `AuditEvent`.

**Decisão do dono sobre o `/register` (2026-10-30):** o Soprei registra o número (`POST /{phone_number_id}/register`) com um **PIN aleatório de 6 dígitos** que ele gera (CSPRNG, `crypto.randomInt`) e guarda **cifrado** como o token (mesma cifra, AAD ligada ao `clientId`), em coluna da `ChannelConnection` com migration aditiva; o PIN nunca vai a log, resposta, métrica nem `redact`, e o cliente nunca o vê nem o digita.

### Perguntas ainda abertas

- Confirma a decisão 9 (sem `state`, fluxo por popup do JS SDK)? O frontend usará popup ou redirecionamento?
- Confirma cifra (decisão 4), `TOKEN_INVALID` (decisão 6), posse do número "primeiro a provar leva" (decisão 7) e um PR com divisão possível (decisão 8)?
- O fluxo atual do Embedded Signup exige que o Soprei registre o número (`/register` com PIN)? O implementer confere na documentação; se exigir, o dono decide se entra aqui ou em spec própria.

## Decisões e dependências novas

- **Sem dependência nova** (cifra em `node:crypto`, Graph por `fetch`, como na 011).
- Migration aditiva: tabela `channel_connections`, enum de status, três valores em `audit_action` (`ALTER TYPE ... ADD VALUE`, PostgreSQL >= 12, já exigido pela 008), `audit_events.target_user_id` anulável com `CHECK`. Não apaga nem reescreve migration aplicada.
- Variáveis novas: `WHATSAPP_APP_ID`, `CHANNEL_CREDENTIALS_KEYS`, `CHANNEL_CREDENTIALS_ACTIVE_KEY_ID`; `WHATSAPP_ACCESS_TOKEN` passa a opcional. Atualizar `.env.example`, `.env.test.example` e "Canal WhatsApp (spec 011)" em `AGENTS.md`.
- Mudança de contrato a registrar: `MessageSender.sendText` recebe o token; `PATCH /admin/clients/:id` perde `whatsappPhoneNumberId`; `audit-events` pode ter `targetUserId` nulo.

## Registro da implementação

### O que foi entregue (015a) e o que ficou de fora (015b)

Entregue e com teste: cifra AES-256-GCM (`src/infrastructure/security/`), `SecretString`, config e `redact`, model `ChannelConnection` (tenant), migration `20261030180000_channel_connections` (aditiva), repositório e unidade de trabalho do canal, permissões `channel:read`/`channel:manage`, `PUT`/`GET`/`DELETE /admin/clients/:clientId/channel`, cliente Graph de administração, `ChannelCredentials` (envio com o token do cliente lido do banco pelo `clientId` do job), `TOKEN_INVALID` (marca condicional à `tokenVersion`, flush descartado sem LLM), estado `LEGACY`, auditoria `CHANNEL_*` com `target_user_id` anulável e CHECK por ação, remoção do campo do `PATCH /admin/clients/:id`, métricas.

**Embedded Signup (015b) implementado depois, na mesma branch**, com a decisão do dono sobre o `/register` (ver "Decididas pelo dono"): `POST /admin/clients/:clientId/channel/embedded-signup`, `ChannelProvisioner.exchangeCode`/`registerNumber`, `ChannelConnectionService.embeddedSignup`, coluna `registration_pin_ciphertext` (migration `20261030190000_channel_registration_pin`), `FakeGraphApi` com troca de `code` (uso único, expirável, outro app) e `/register` (PIN certo, errado, já registrado). Fluxo: troca do `code` -> `debug_token` -> lista de números -> `subscribed_apps` -> conferência de número de outro cliente (409) -> `/register` com PIN aleatório (ou o guardado) -> transação (cifra token e PIN, conexão, número, auditoria). Falha em qualquer passo antes da transação não grava nada. Ajustes da revisão da 015a aplicados: `DatabaseError` no `save` (b), `oauthCode`/`registrationPin` no `redact` em vez de `code` (c), `ChannelCredentialsService` relê o cliente depois da conexão e confere `updatedAt` (erro transitório se mudou) (d), nota do `subscribed_apps` antes da transação (e) e "uma WABA = um cliente" (a) em "Casos de borda".

Desvios da 015b: (1) a troca do `code` usa `GET /oauth/access_token` (como a documentação descreve) com `client_secret` e `code` na query string, que nunca é logada, em vez do `POST` com corpo preferido pela spec; (2) a conferência de número de outro cliente (409) acontece **antes** do `/register`, não só no `@unique`; (3) o `/register` e o PIN são decisão do dono (acima); (4) métrica `channel_connections_total` ganhou o resultado `registration_failed`. Não confirmado na documentação: o formato de erro do `/register` para número com 2FA (assumido `error.code` 133005 só para teste; o serviço trata qualquer 4xx como `CHANNEL_REGISTRATION_FAILED`) e se a Meta aceita registrar de novo com o mesmo PIN (a spec assume que sim).

### Fatos da Meta reconferidos (WebFetch em 2026-10-30)

- Embedded Signup (`developers.facebook.com/docs/whatsapp/embedded-signup/implementation`): o evento `WA_EMBEDDED_SIGNUP` traz `waba_id`, `phone_number_id`, `business_id`; há tipos de término (`FINISH`, `FINISH_ONLY_WABA`, ...) em que **`phone_number_id` pode faltar**; `waba_id` passou a designar a "Messaging account". O `code` expira em 30 s. A configuração "WhatsApp Embedded Signup Configuration With 60 Expiration Token" sugere token de negócio de 60 dias (não confirmado). Embedded Signup v2 e v3 serão descontinuados em 2026-10-15: usar v4.
- Onboarding como Tech Provider (`.../embedded-signup/onboarding-customers-as-a-tech-provider`): troca do `code` por **`GET /oauth/access_token`** com `client_id`, `client_secret`, `code` (**sem `redirect_uri`** na página); depois `POST /<VERSION>/<WABA_ID>/subscribed_apps` com `Authorization: Bearer <token de negócio>` (resposta `{"success": true}`); depois **`POST /<PHONE_NUMBER_ID>/register`** com `messaging_product` e `pin` (6 dígitos). Tudo "server-to-server". A validade do token de negócio **não** é dita ali.
- **Não confirmados** (as páginas não os cobrem; a implementação os trata de forma tolerante e eles ficam para o teste manual do dono): formato exato da resposta de `GET /{waba}/phone_numbers` (assumido `{ data: [{ id }], paging }`, com `fields=id&limit=100` e seguimento de `paging.cursors.after` até 10 páginas; a página de referência só documenta o `POST`), campos do `debug_token` (assumidos `data.is_valid`, `app_id`, `scopes`, `granular_scopes[].target_ids`, `expires_at`; a página `.../access-tokens/debugging` devolveu 404) e se o `debug_token` aceita o token de app em `Authorization: Bearer`. Se a Meta recusar o Bearer do token de app, o ajuste é só em `whatsapp-graph-admin.client.ts` (mandar `access_token` em query levaria o segredo à URL: avaliar antes).

### Decisões e desvios

1. **`debug_token` leva o `input_token` na query string** (a API só o aceita assim); o token de app e o token do cliente, nas demais chamadas, vão só em `Authorization`. A URL nunca é logada. A spec preferia nada em URL; aqui é a exceção possível.
2. **Primeiro a provar leva**: o `@unique` de `Client.whatsappPhoneNumberId` decide dentro da transação com `lockClient`; o 409 `CHANNEL_NUMBER_IN_USE` vem **depois** da prova de posse (quem não prova posse recebe 400 e nunca descobre que o número está em uso). A transação perdedora é desfeita inteira (nenhuma conexão sobra). Corrida provada com Postgres real (8 rodadas).
3. `ChannelCredentials.forClient` lê o cliente e a conexão; o processador ainda lê o cliente (suspensão) e confere que o número da credencial é o do job (duas leituras, par token/número sempre coerente). Com `TOKEN_INVALID` o `flush` é descartado **antes** do LLM (pré-checagem); como o 190 só aparece no envio, a resposta daquele turno já estava gravada (sem `sentAt`, visível na API) e só as mensagens **seguintes** ficam pendentes.
4. `channel_connections_total` ganhou o resultado `unsubscribe_failed` (ação `disconnect`), para a falha do `unsubscribe` de melhor esforço.
5. `Client.delete` (soft delete) ficou atômico: abre transação (se não está em uma) e apaga a `ChannelConnection` junto.
6. `ValidationError` ganhou `options.code` (códigos `CHANNEL_*`); `CredentialDecryptionError` é erro novo (500 não operacional).
7. `WHATSAPP_ACCESS_TOKEN` virou opcional; `WHATSAPP_APP_ID` e as chaves são obrigatórias com o canal ligado. `loadIntegrationConfig()` injeta chaves e app id descartáveis.
8. `FakeGraphApi` estendido: `addToken`, `addWaba`, `failOperation`, `ofOperation`, `sendPairs`, `subscribed`, `expectedAppToken`; os erros dele ecoam o token de propósito. **Ainda sem** troca de `code` (015b).
9. Risco conhecido (previsto na spec): o `DELETE` desassina o app da WABA inteira; se uma agência tem vários clientes na mesma WABA, desconectar um deixa os outros sem webhook. O reviewer deve confirmar que isso é aceitável.

### Pastas finais

`src/infrastructure/security/` (nova), `src/application/channel/` (`channel-connection.service.ts`, `channel-credentials.service.ts`), `src/application/ports/` (`credential-cipher`, `channel-credentials`, `channel-provisioner`, `channel-unit-of-work`), `src/domain/entities/channel-connection.ts`, `src/domain/repositories/channel-connection.repository.ts`, `src/infrastructure/database/repositories/` (`channel-connection.repository.ts`, `channel-unit-of-work.ts`), `src/infrastructure/external-apis/whatsapp/whatsapp-graph-admin.client.ts`, `src/presentation/admin/channel.{controller,validators}.ts`, `src/shared/types/secret-string.ts`, `src/test-support/channel-credentials.ts`.

### Testes novos

`aes-gcm-credential-cipher.test.ts`, `secret-string.test.ts`, `whatsapp-graph-admin.client.test.ts`, processador (credencial por cliente), `channel-connection.integration.test.ts` (PUT/GET/DELETE, posse, corrida, permissões, auditoria, privacidade), `channel-credentials.integration.test.ts` (envio por cliente, 190, texto cifrado trocado, LEGACY), `channel-connection.repository.integration.test.ts` (isolamento, CHECK da auditoria), `channel-embedded-signup.integration.test.ts` (015b: feliz, recusas, code de uso único e simultâneo, dois clientes, PIN reaproveitado, permissões), `channel-credentials.service.test.ts`, testes de `exchangeCode`/`registerNumber` e do `redact`.
