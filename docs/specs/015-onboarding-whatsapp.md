# 015 — Onboarding de clientes no canal WhatsApp (credenciais por cliente)

- **Status:** rascunho (aguarda o dono; "spec B" do canal WhatsApp)
- **Branch:** `spec/015-onboarding-whatsapp`
- **Depende de:** 011 (canal), 013 (agrupamento), 007 (autenticação), 008 (papéis, permissões, auditoria)
- **Segurança:** guarda segredo de terceiros, toca isolamento e endpoint de administração: **passa pelo `reviewer` antes do merge** (foco: criptografia e uso do token, isolamento entre clientes, posse do número).

## Objetivo

Hoje há um app Meta, um `WHATSAPP_ACCESS_TOKEN` global e o `Client.whatsappPhoneNumberId` gravado à mão pelo `PlatformAdmin`. Para atender vários clientes, cada um precisa ter **a própria credencial do canal**, guardada cifrada, e poder **conectar, trocar o token e desconectar o próprio número pela API**, sem o dono mexer no banco ou no `.env`. O envio passa a usar o token **do cliente do job**, nunca um global.

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
- **Embedded Signup (não implementado aqui, ver decisão 1):** o navegador abre o fluxo com `FB.login` (config id do Facebook Login for Business), devolve um `code` de vida curta e, por evento `WA_EMBEDDED_SIGNUP`, `phone_number_id`, `waba_id` e `business_id`; o servidor troca o `code` por token em `GET /oauth/access_token` (app id e segredo), assina o app na WABA e, se preciso, registra o número (`/register`, PIN). Exige verificação de negócio, revisão do app com acesso avançado às duas permissões acima, domínio autorizado no JS SDK e uma **tela** que o Soprei ainda não tem.

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
- `DELETE .../channel` (`channel:manage`) -> 204, idempotente (sem conexão também é 204). Numa transação: apaga a `ChannelConnection` (some o texto cifrado), limpa `Client.whatsappPhoneNumberId` e audita. **Depois** do commit, melhor esforço e sem o token ficar em lugar nenhum: `DELETE /{wabaId}/subscribed_apps` (falha só loga e conta). Cliente `LEGACY` também pode desconectar (só limpa o número).
- Autorização: `channel:read` e `channel:manage` ao `OWNER` e ao `ADMIN` (matriz abaixo). O token é credencial do negócio do cliente: `AGENT` e `VIEWER` não veem nem o estado.

| Permissão | OWNER | ADMIN | AGENT | VIEWER |
| --- | :---: | :---: | :---: | :---: |
| `channel:read` (`GET .../channel`) | x | x | | |
| `channel:manage` (`PUT`, `DELETE .../channel`) | x | x | | |

- Erros: corpo inválido 400 sem ecoar o valor; `accessToken` inválido, de outro app, sem escopo ou número fora da WABA: 400 com `code` fixo (`CHANNEL_TOKEN_REJECTED`, `CHANNEL_WRONG_APP`, `CHANNEL_MISSING_SCOPE`, `CHANNEL_NUMBER_NOT_IN_WABA`; `ValidationError` ganha `options.code` se preciso, como o `ConflictError`) e mensagem constante; Meta fora do ar, 5xx, 429 ou prazo: 502 (`ExternalServiceError`) **sem** gravar nada; conflito 409; sem permissão 403.
- **`PATCH /admin/clients/:id` deixa de aceitar `whatsappPhoneNumberId`** (corpo com o campo = 400): duas portas para o número divergiriam. `persona`, `name` e `status` seguem iguais.

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
| `WHATSAPP_APP_ID` | obrigatória com `WHATSAPP_ENABLED=true`; dígitos |
| `CHANNEL_CREDENTIALS_KEYS` | obrigatória com o canal ligado; ver "Cifra"; entra no `redact` |
| `CHANNEL_CREDENTIALS_ACTIVE_KEY_ID` | obrigatória com o canal ligado; precisa estar em `KEYS` |
| `WHATSAPP_ACCESS_TOKEN` | **passa a opcional** (só para clientes `LEGACY`; mínimo 16 se informado) |

Quem já usa o canal precisa **acrescentar as três variáveis novas** ao `.env` antes de subir (o boot falha com mensagem clara se faltar). O `redact` do logger ganha `accessToken` (já existe), `tokenCiphertext`, `CHANNEL_CREDENTIALS_KEYS` e `WHATSAPP_ACCESS_TOKEN`.

### Cliente Graph de administração

Porta `ChannelProvisioner` (`application/ports/`: `inspectToken`, `listPhoneNumberIds(wabaId, token)`, `subscribeApp`, `unsubscribeApp`) e implementação `src/infrastructure/external-apis/whatsapp/whatsapp-graph-admin.client.ts`, no mesmo padrão do `WhatsappCloudApiClient` (`fetch`, `redirect: 'manual'`, prazo `WHATSAPP_SEND_TIMEOUT_MS`, leitura com teto de 64 KiB, schemas Zod tolerantes). O token do cliente vai em `Authorization: Bearer`; o token de app (`WHATSAPP_APP_ID|WHATSAPP_APP_SECRET`) também em cabeçalho, **nunca** em query string nem em log. O erro devolvido leva só `{ operation, httpStatus, providerCode, retryable }` (nunca o corpo da Meta, que pode ecoar token ou número).

### Métricas (registry da 004; conjuntos fixos de labels, sem `clientId`, número, WABA ou token)

- `channel_connections_total{action,result}`: `action` ∈ `connect`, `replace_token`, `disconnect`; `result` ∈ `ok`, `invalid_token`, `wrong_app`, `missing_scope`, `number_not_in_waba`, `number_in_use`, `graph_error`.
- `channel_state_transitions_total{to}`: `token_invalid`.
- `channel_credential_errors_total{reason}`: `malformed`, `unknown_key`, `tampered`.

## Critérios de aceite

Servidor Graph falso estendido (`src/test-support/fake-graph-api.ts`: `debug_token`, `GET /{waba}/phone_numbers`, `POST/DELETE /{waba}/subscribed_apps`, cenários de token inválido, outro app, escopo faltando, 5xx, demora, e registro do `Authorization` recebido por número). **Nenhum teste chama a Meta real.**

- [ ] **Cifra:** roundtrip devolve o token; dois `encrypt` do mesmo texto dão saídas diferentes (IV aleatório); chave errada, `keyId` desconhecido, texto adulterado (um byte no IV, na tag e no cifrado), formato inválido e texto cifrado de outro `clientId` (AAD) lançam `CredentialDecryptionError` com `reason` correto e **sem** o texto nem a chave na mensagem, no `context` ou em `JSON.stringify`; rotação: texto cifrado com a chave antiga decifra enquanto ela está na lista, e o novo sai com a chave ativa.
- [ ] **`SecretString`:** `String(s)`, `JSON.stringify(s)`, template string e `util.inspect(s)` devolvem `[redacted]`; só `reveal()` dá o valor.
- [ ] **Config:** com o canal ligado, falham o boot: chave com tamanho diferente de 32 bytes, `keyId` repetido, ativo fora da lista, `WHATSAPP_APP_ID` ausente; com o canal desligado nada disso é exigido; `WHATSAPP_ACCESS_TOKEN` ausente é aceito; valores secretos nunca aparecem na mensagem de erro do boot.
- [ ] **`MODEL_SCOPES`/schema:** `ChannelConnection` classificado como `tenant` (o teste de cobertura passa); `clientId` único; a `tenant-scope` recusa operação sem `clientId`; `ChannelConnectionRepository` só usa `findFirst`, `create`, `updateMany`, `deleteMany`, `count` com `clientId` no `where`; a migration aplica em `soprei_test` e o `CHECK` de auditoria recusa `USER_*` sem alvo e `CHANNEL_*` com alvo.
- [ ] **PUT feliz:** com token válido do nosso app, escopos certos e número na WABA, responde 200 com `state = CONNECTED`, grava `Client.whatsappPhoneNumberId`, a conexão (texto cifrado **diferente** do token e que decifra para ele), chama `subscribed_apps`, grava `CHANNEL_CONNECTED` na mesma transação e **nenhuma** resposta, log ou métrica contém o token (captura de log e varredura do corpo e de `/metrics`).
- [ ] **PUT recusado, sem gravar nada** (nem número, nem conexão, nem auditoria): token inválido (400 `CHANNEL_TOKEN_REJECTED`), de outro app (`CHANNEL_WRONG_APP`), sem escopo (`CHANNEL_MISSING_SCOPE`), número fora da WABA (`CHANNEL_NUMBER_NOT_IN_WABA`), Meta 5xx/429/prazo (502), corpo com campo extra, ausente ou com formato inválido (400 sem ecoar o valor).
- [ ] **Posse do número:** o cliente B, com token válido de **outra WABA**, não consegue conectar o `phoneNumberId` que pertence à WABA do cliente A (`CHANNEL_NUMBER_NOT_IN_WABA`); o cliente B com token que lista o número **já conectado ao cliente A** recebe 409 `CHANNEL_NUMBER_IN_USE` sem revelar A, e A segue intacto; duas conexões concorrentes do mesmo número por clientes diferentes (Postgres real): exatamente uma vence, a outra recebe 409.
- [ ] **Trocar o token** (PUT sobre conexão existente): `tokenVersion` sobe, `status` volta a `CONNECTED`, evento `CHANNEL_TOKEN_REPLACED`, o texto cifrado muda; **trocar de número** libera o antigo (outro cliente consegue conectá-lo depois).
- [ ] **DELETE:** apaga a linha (nenhum `tokenCiphertext` do cliente resta no banco), limpa o número, audita `CHANNEL_DISCONNECTED`, tenta o `DELETE .../subscribed_apps` depois do commit, é idempotente (segundo DELETE = 204, sem novo evento), e a falha do `unsubscribe` não desfaz nem muda o 204 (log `warn` e métrica, sem token). Webhook para o número desconectado: `unknown_number`, nada enfileirado.
- [ ] **Remoção do cliente** (`DELETE /admin/clients/:id`) apaga a conexão na mesma transação (nenhum texto cifrado de cliente removido permanece).
- [ ] **`PATCH /admin/clients/:id`** com `whatsappPhoneNumberId` responde 400; sem o campo, os demais continuam funcionando (testes antigos da 010/011 atualizados).
- [ ] **Permissões:** matriz de `channel:read` e `channel:manage` por papel (snapshot em `permissions.test.ts`); `AGENT` e `VIEWER` 403 em `GET`, `PUT` e `DELETE`; `PlatformAdmin` 403; sem token 401; `:clientId` de outro cliente 404 antes da permissão; o inventário de rotas (`rate-limit.test.ts`) passa (perfil `admin`, `requirePermission`); as rotas não existem (404) com `WHATSAPP_ENABLED=false`.
- [ ] **Envio com o token do cliente (isolamento):** dois clientes, A e B, com números e **tokens diferentes**: a resposta ao contato de A sai com o `Authorization` de A e pelo número de A, a de B com o de B e pelo número de B; o servidor Graph falso registra o par (token, número) e **nunca** vê o token de A com o número de B (nem o inverso), inclusive com mensagens dos dois no mesmo lote da fila; job adulterado (`phoneNumberId` de B com `clientId` de A) é descartado sem enviar (regra da 011 mantida).
- [ ] **Texto cifrado trocado entre clientes:** copiar o `tokenCiphertext` de A para a linha de B faz o envio de B falhar como `CredentialDecryptionError` (`tampered`), sem enviar, sem marcar `TOKEN_INVALID` e sem token em log.
- [ ] **`TOKEN_INVALID`:** envio recusado com 190 marca a conexão (`status`, `tokenInvalidAt`), `GET .../channel` passa a `TOKEN_INVALID`, `channel_state_transitions_total` sobe, o job vira `NonRetryableJobError` **sem** texto padrão; o próximo `flush` desse cliente é descartado **sem chamar o LLM** (o `mock` registra zero entradas); mensagens ficam pendentes; um `PUT` com token novo volta a `CONNECTED` e a mensagem seguinte do contato responde o lote inteiro. 190 de um `tokenVersion` antigo **não** invalida o token novo (`markTokenInvalid` condicional). Outro código permanente (ex.: 131047) não muda o estado. O estado de A não afeta B.
- [ ] **`LEGACY`:** cliente com número e sem conexão envia com o token global quando ele existe; sem ele, nada é enviado e há log `error`; cliente **com** conexão nunca usa o token global (o servidor falso prova o `Authorization`).
- [ ] **Auditoria:** `GET .../audit-events` lista os eventos de canal do **próprio** cliente com `targetUserId` nulo e nunca os de outro; eventos `USER_*` continuam iguais; log `audit` só com ids e enum.
- [ ] **Privacidade:** teste de fluxo (PUT, envio, 190, DELETE) com captura de log prova que um token secreto de teste, o texto cifrado, as chaves de `CHANNEL_CREDENTIALS_KEYS` e o corpo de erro da Meta não aparecem em log, resposta, erro nem métrica; `redact` cobre os campos novos.
- [ ] **Cliente Graph de administração:** `redirect` não é seguido, resposta acima de 64 KiB é cortada, token de app só em cabeçalho, erro sem corpo da Meta; classificação de erro (190 -> `CHANNEL_TOKEN_REJECTED`; 5xx/429/rede -> 502).
- [ ] **Métricas:** `channel_connections_total`, `channel_state_transitions_total` e `channel_credential_errors_total` registradas com conjuntos fixos de labels (teste do registry).
- [ ] `typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes em Node 22 e na LTS mais recente.

## Teste manual com a Meta (feito pelo dono; nenhum agente chama a API real)

(1) no `.env`, acrescente `WHATSAPP_APP_ID` e as duas variáveis de chave (gerar com o comando acima); reinicie; (2) com o número de teste da Meta (a WABA de teste e o token **temporário de 24 h** do painel; token de usuário do sistema serve para o permanente), faça `POST /auth/login` como `OWNER` e `PUT /admin/clients/:clientId/channel` com `phoneNumberId`, `wabaId` e `accessToken`; (3) mande uma mensagem pelo WhatsApp: a resposta chega e `GET .../channel` mostra `CONNECTED`; (4) invalide o token (revogue ou espere expirar), mande outra: o canal passa a `TOKEN_INVALID` e nada é enviado; (5) `PUT` com token novo e `DELETE`; (6) cliente antigo: `GET .../channel` mostra `LEGACY` até o `PUT`.

## Casos de borda e erros

- Meta fora do ar no `PUT`: 502 e **nada gravado** (nem número); repetir o `PUT` é seguro (idempotente). `subscribed_apps` falhar depois do `debug_token` ok: 502, nada gravado.
- Dois `PUT` do mesmo cliente ao mesmo tempo: a transação com `lockClient` serializa; vale o último, ambos com auditoria. O 409 de número usado vem do `@unique` (também sob corrida).
- Token válido na hora do `PUT` e expirado depois: só o 190 no envio revela; sem verificação periódica (ver "Fora de escopo"); `tokenExpiresAt` informa a data prevista quando a Meta a dá.
- Cliente suspenso: segue sem receber nada (011). O login de cliente suspenso é 401 (007), então na prática o `OWNER` dele não alcança estas rotas.
- `phoneNumberId` já conectado ao **mesmo** cliente: é o caso "trocar token".
- Chave de cifra removida da lista com linhas ainda cifradas por ela: o envio falha como `CredentialDecryptionError` (`unknown_key`), alto no log e na métrica, sem reduzir a segurança; recuperar = recolocar a chave ou o cliente refazer o `PUT`.
- Queda entre a transação e o `unsubscribe` do `DELETE`: o app segue assinado na WABA, mas o número não resolve mais cliente (`unknown_number`); resíduo inofensivo, sem token guardado.
- Token com mais permissões do que precisa: aceito (a Meta não permite pedir o mínimo no token de sistema); é o token do próprio cliente e só é usado para enviar.

## Isolamento entre clientes

Toca em dados de tenant e em segredo. Barreiras, cada uma com teste:

1. `ChannelConnectionRepository` estende `PrismaTenantRepository`: `ClientId` é o primeiro parâmetro de todo método, `clientId` vai no `where` pela base, a `tenant-scope` recusa o que escapar e `MODEL_SCOPES` classifica o model (cobertura obrigatória). O único caminho de identificador externo para cliente segue sendo `findByWhatsappPhoneNumberId`.
2. O token usado em cada envio é lido **pelo `clientId` do job** (nunca do payload) e a cifra o **amarra ao `clientId`** (AAD): ciphertext copiado entre linhas não decifra.
3. `clientId` do `PUT`/`GET`/`DELETE` vem **só** do token de acesso (`userAuth(request)`); o `:clientId` do caminho é conferido (404 se divergir).
4. Posse do número provada **com o token do próprio cliente** (lista de números da WABA) antes de gravar; `@unique` em `whatsappPhoneNumberId` no banco decide a corrida.
5. Teste obrigatório: dois clientes com tokens e números diferentes nunca cruzam token, número, estado (`TOKEN_INVALID` de um não afeta o outro), auditoria nem leitura (`GET` de A não mostra dado de B).

## Fora de escopo

- **Embedded Signup** (troca de `code`, `business_id`, registro do número com PIN, evento `WA_EMBEDDED_SIGNUP`): spec 016, depois da tela de onboarding e da configuração no painel Meta (ver decisão 1). O `PUT` desta spec é o ponto que ela reaproveita (a troca do `code` só produz o token e o `waba_id`).
- **Tela/frontend de onboarding** (painel admin, projeto separado).
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

1. **Fatia desta spec.** **(recomendada) A: 015 = credenciais por cliente, cifra, estado, envio com o token do cliente e `PUT/GET/DELETE` do `OWNER`/`ADMIN` com validação pela Graph API; Embedded Signup vira a 016.** Motivo: o Embedded Signup precisa de tela, domínio autorizado, `config_id` e revisão do app no painel Meta (o que um agente não pode configurar nem testar) e, no fim, só produz `{ token, waba_id, phone_number_id }` para o mesmo `PUT`; tudo o que é crítico de segurança (cifra, isolamento, posse do número, estado) cabe e é testável agora com servidor falso. Alternativa B: incluir já o endpoint do `code` (troca por token, `subscribed_apps`, registro do número) nesta spec: PR bem maior, só verificável de ponta a ponta com tela e Meta reais. Alternativa C: só token manual para sempre (não escala sem o dono intermediar).
2. **Quem opera o canal do cliente.** **(recomendada) `OWNER` e `ADMIN` do cliente; `PlatformAdmin` não** (consistente com a decisão 5 da 007: a plataforma não opera dentro do tenant e não manuseia o token do cliente). Alternativa: só `OWNER`; ou deixar o `PlatformAdmin` conectar em nome do cliente (mais fácil no começo, mas o dono passa a tocar credencial de terceiros e precisa de rota e auditoria próprias).
3. **Token global.** **(recomendada) opcional e só para clientes `LEGACY`, removido pelo dono quando todos tiverem feito o `PUT`.** Alternativa: remover já (derruba o cliente atual até o `PUT`) ou manter como fallback permanente (um segredo compartilhado de que nada se livra).
4. **Cifra.** **(recomendada) AES-256-GCM do `node:crypto`, chave mestra em variável de ambiente com lista de chaves e `keyId` (rotação), AAD com o `clientId`.** Alternativas: cifra por pgcrypto no banco (a chave passaria pelo SQL e pelos logs do Postgres); envelope com KMS (exige hospedagem, ainda não decidida).
5. **Auditoria.** **(recomendada) reusar `AuditEvent` com `target_user_id` anulável e `CHECK` por ação.** Alternativa: tabela própria `ChannelEvent` (nenhuma mudança no contrato da 008, mas duas trilhas para o `OWNER` consultar).
6. **Token inválido.** **(recomendada) marca `TOKEN_INVALID`, descarta os próximos `flush` sem LLM nem texto padrão e exige o `PUT`.** Alternativa: continuar tentando enviar (gasta LLM à toa e polui log) ou tentar o texto padrão (não há token que funcione).
7. **Posse do número.** **(recomendada) provar com o token do próprio cliente (`debug_token` + lista de números da WABA), primeiro a provar leva, `@unique` global.** Alternativa: verificação extra por código no número (SMS) ou aprovação manual do dono (atrito sem ganho: o token já prova o acesso).
8. **Um PR ou dois.** **(recomendada) um PR**, em commits por camada (cifra e config, model e repositório, cliente Graph, rotas, processador). Se passar de ~2 000 linhas, divide em 015a (cifra, model, envio por cliente, `TOKEN_INVALID`) e 015b (rotas e auditoria).

### Perguntas que só o dono responde

- Embedded Signup agora ou só token manual por enquanto (decisão 1)? Em quanto tempo o primeiro cliente real vai conectar, e **quantos clientes** nos primeiros meses (mais de uns poucos justifica ir direto à 016)?
- A verificação de negócio, o app publicado e o status de Tech Provider (informados em 2026-10-27) seguem valendo? O app já tem **acesso avançado** a `whatsapp_business_management` e `whatsapp_business_messaging`? Existe `config_id` de Embedded Signup e domínio autorizado?
- Os tokens dos clientes serão **de usuário do sistema do próprio cliente** (manual) ou do **Embedded Signup** (token de negócio do nosso app)? Isso define se o `debug_token` com `app_id` fixo no nosso app, como proposto, serve para todos.
- Quem cria o `OWNER` de cada cliente no começo (o dono, pelo CLI)? Confirma que o dono **não** quer conectar o canal em nome do cliente (decisão 2)?
- Onde roda a aplicação (hospedagem ainda aberta): decide onde mora a chave mestra e como ela é rotacionada.

## Decisões e dependências novas

- **Sem dependência nova** (cifra em `node:crypto`, Graph por `fetch`, como na 011).
- Migration aditiva: tabela `channel_connections`, enum de status, três valores em `audit_action` (`ALTER TYPE ... ADD VALUE`, PostgreSQL >= 12, já exigido pela 008), `audit_events.target_user_id` anulável com `CHECK`. Não apaga nem reescreve migration aplicada.
- Variáveis novas: `WHATSAPP_APP_ID`, `CHANNEL_CREDENTIALS_KEYS`, `CHANNEL_CREDENTIALS_ACTIVE_KEY_ID`; `WHATSAPP_ACCESS_TOKEN` passa a opcional. Atualizar `.env.example`, `.env.test.example` e "Canal WhatsApp (spec 011)" em `AGENTS.md`.
- Mudança de contrato a registrar: `MessageSender.sendText` recebe o token; `PATCH /admin/clients/:id` perde `whatsappPhoneNumberId`; `audit-events` pode ter `targetUserId` nulo.

## Registro da implementação

(a preencher pelo implementer, com as fontes e datas da documentação da Meta conferida)
