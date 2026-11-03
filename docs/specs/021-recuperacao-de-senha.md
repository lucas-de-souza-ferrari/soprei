# 021 — Recuperação de senha e expurgo de contas não confirmadas

- **Status:** concluída e mergeada (2026-11-03; CI verde em Node 22 e LTS); aprovada (2026-11-03, dono: "Aprovo tudo", com as 12 recomendações; **a decisão 5 foi revertida pelo dono no mesmo dia**: a política de senha do cadastro público é mantida, ver decisão 5)
- **Branch:** `spec/021-recuperacao-de-senha`
- **Depende de:** 017 (contas globais), 019 (SMTP genérico), 020 (código de 6 dígitos com HMAC, limite de tentativas e teto diário)
- **Segurança:** mexe em autenticação, em endpoints públicos e em sessões; passa pelo `reviewer` antes do merge (de preferência outro agente/modelo).

## Objetivo

(A) Quem esquece a senha de uma conta **confirmada** hoje fica trancado (a CLI legada não gerencia senha global): criar a recuperação por código de 6 dígitos enviado ao e-mail. (B) Contas **não confirmadas** ficam para sempre no banco: expurgá-las. Fecha um dos riscos aceitos da 017 (contas não confirmadas eternas; a senha curta do cadastro público segue como risco aceito, decisão 5) e cumpre o que a 020 deixou registrado: a recuperação **não** herda o código de 6 dígitos sem as mesmas proteções (HMAC, contador por código, teto diário).

## Estado atual (lido no código)

- `Account` (global, sem `ClientId`): `email` único, `password_hash`, `status`, `email_verified_at`, colunas `verification_*` (hash, vencimento, tentativas, erros do dia e início da janela). `users.account_id` -> `accounts(id)` com `ON DELETE RESTRICT`.
- `AccountService` (`application/auth/account.service.ts`): `register`, `resend`, `verify`, `login`; `credentials()` usa o bloqueio por conta (chave `HMAC(loginSecret, "account:" + e-mail)`, 5 falhas em 15 min via `SessionStore.loginLockState/recordLoginFailure/resetLoginFailures`). O envio do cadastro roda em segundo plano (`deliver`, `drain` no desligamento).
- `verification-code.ts`: `generateVerificationCode` (`randomInt`), `deriveVerificationKey` (HMAC do segredo com o rótulo `soprei:account-verification:v1`) e `verificationDigest` (HMAC com `account-verification:<e-mail>:<código>`).
- `PrismaAccountRepository`: SQL cru atômico (`registerUnverified`, `refreshVerification`, `verify` em dois UPDATEs: sucesso e falha com contador por código, teto de 25 erros em 24 h e o hash apagado no esgotamento, vencimento mantido para o intervalo de 60 s). Constantes em `domain/repositories/account.repository.ts`.
- Sessão da conta (`RedisAccountSessionStore`, porta `AccountSessionStore` com `create/read/select/revoke`): chave `<prefixo>account-session:<sha256(secret)>`, valor JSON `{ accountId, id, clientId, createdAt, expiresAt }`, TTL ocioso 7 dias e teto de 30 dias, script Lua `READ`. **Não há índice por conta nem revogação em massa**: só se revoga uma sessão pelo próprio cookie. É a peça que falta para "encerrar todas as sessões" depois de trocar a senha.
- `account.controller.ts`: hook `onRequest` exige `Origin` igual a `APP_ORIGIN` e `X-Soprei-Client: web` em todo método não `GET`; `/auth/register`, `/auth/resend-verification`, `/auth/verify-email` e `/auth/login` usam o perfil de rate limit `login` (fail-closed, `RATE_LIMIT_LOGIN_*`, padrão 10 por 900 s por IP).
- O cadastro público usa `accountPasswordSchema` (6 a 128 caracteres depois do NFKC, uma maiúscula Unicode e um número, sem NUL). `newPasswordSchema` (12 a 128, spec 007) é só dos usuários de tenant e da CLI e não muda. `loginPasswordSchema` (mínimo 1) não muda: contas antigas com senha curta seguem entrando.
- Mailer: `SmtpVerificationMailer` (texto simples; falha vira `ServiceUnavailableError` com mensagem fixa), porta `VerificationMailer` em `application/ports/account-session.ts`.
- Frontend: `AccountApp.tsx` com páginas `login | register | verify | companies`, `VerificationField` e `verification-code.ts` (normaliza colar com separadores), beUI e tokens de tema.

## Ameaça que a spec precisa fechar

Diferente da confirmação de e-mail (020), **quem tenta adivinhar o código de recuperação não precisa da senha**: basta o e-mail da vítima. O que decide a conta é só o código de 6 dígitos (1.000.000 de combinações). Logo, o limite por código e o **teto diário por conta** são a defesa principal; o limite por IP (perfil `login`, 10 por 900 s, no máximo 960 tentativas por dia por IP) é irrelevante contra quem tem muitos IPs, e IP+e-mail fica fora de escopo.

Conta de risco residual (como a 020): 5 tentativas por código e um código novo a cada 60 s dariam até 7.200 tentativas por dia por e-mail, cerca de **0,72% por dia** de tomada de conta, de graça e em série (mediana de ~100 dias). Com o teto de **10 erros por conta em 24 h** (recomendado) ficam 10 tentativas por dia: ~0,0010% por dia, ~0,36% por ano de ataque contínuo contra um único e-mail. Com 25 (o da 020) seriam ~0,0025% por dia, ~0,9% por ano. Por isso o teto é **mais apertado que o da confirmação**: aqui o alvo é uma conta já viva, não um cadastro novo. O custo é o de sempre: quem conhece o e-mail pode gastar o teto e bloquear a recuperação da vítima por até 24 h (ver Riscos).

## Comportamento esperado

### Rotas (mesmo plugin de contas; mesmo hook de `Origin`/`X-Soprei-Client`; perfil de rate limit `login`, fail-closed; `Cache-Control: no-store`)

- `POST /auth/password-reset/request` — corpo `{ email }` (`emailSchema`, objeto estrito). Responde **sempre** `202 { message: 'Se existir uma conta, enviamos um código para o e-mail informado.' }`, para conta inexistente, não confirmada, desativada, confirmada, "cedo demais" (intervalo de 60 s) e "teto diário estourado". Só conta **confirmada e ativa** dentro do intervalo e do teto grava código e recebe e-mail; o envio roda em segundo plano (sem 503 por SMTP; o `drain` do desligamento espera, como no cadastro).
- `POST /auth/password-reset/confirm` — corpo `{ email, code, newPassword }` (estrito; `code` com `^\d{6}$`; `newPassword` pelo mesmo `accountPasswordSchema` do cadastro público). Sucesso: `204` (sem cookie e **sem login automático**). Código errado, vencido, esgotado, já usado, ausente, conta inexistente, não confirmada ou desativada: a **mesma** `401 { code, message: 'Código inválido ou expirado' }`. Corpo inválido (código fora do formato, senha curta) é `400` de validação, **sem** contar tentativa e sem consultar o banco. Bloqueio por rate limit: 429 do perfil.

A senha nova inválida (400) não vaza se o código estava certo: o schema valida antes de qualquer consulta, então um 400 não diz nada sobre a conta.

### Código, armazenamento e contadores

- Código: `generateVerificationCode()` da 020 (`randomInt`, 6 dígitos com zeros à esquerda). Mesmo componente, finalidade **distinta**.
- **Separação de finalidade:** chave própria `deriveResetKey(secret)` = HMAC do segredo com o rótulo `soprei:password-reset:v1` e mensagem `password-reset:<e-mail normalizado>:<código>`. Um código de confirmação de e-mail nunca confere como de recuperação, e vice-versa (rótulo, prefixo da mensagem **e** colunas diferentes). O `loginSecret` é o mesmo derivado do `JWT_SECRET` usado na 020; sem variável de ambiente nova. Rotacionar o `JWT_SECRET` invalida os códigos pendentes (expiram em 15 min).
- **Colunas novas em `accounts`** (decisão 1; migration nova e aditiva, não edita as anteriores): `reset_hash text`, `reset_expires_at timestamptz`, `reset_attempts smallint NOT NULL DEFAULT 0`, `reset_failures_day smallint NOT NULL DEFAULT 0`, `reset_failures_since timestamptz`; `CHECK (reset_attempts >= 0 AND reset_failures_day >= 0)` e `CHECK (reset_hash IS NULL OR reset_expires_at IS NOT NULL)`. `Account` no Prisma ganha os campos; `MODEL_SCOPES` não muda (`global`). `resetHash` entra no `redact` do logger.
- Um código pendente por conta (o novo substitui o anterior, que morre). Validade **15 minutos**; intervalo mínimo de **60 s** entre códigos, derivado do vencimento (`expires - TTL`) como na 020; o esgotamento apaga só o hash e **mantém o vencimento**, então o intervalo continua valendo.
- Constantes no domínio (não variáveis de ambiente): `RESET_MAX_ATTEMPTS = 5` por código, `RESET_DAILY_FAILURE_CAP = 10` por conta em janela de 24 h (aberta no primeiro erro, contador zerado preguiçosamente; zera ao redefinir). Atingido o teto, o código vigente morre e `request` não emite código novo (202 igual, sem e-mail) até a janela fechar.

### Atomicidade (SQL cru parametrizado, dentro de `infrastructure/database/`, `Account` é global)

Todas as instruções casam por **e-mail** (a mesma chave da mensagem do HMAC, sem leitura prévia e sem diferença observável entre conta existente e inexistente):

1. **Pedir código** (`issueResetCode(email, hash, expiresAt, retryBefore, now)`): um único `UPDATE accounts SET reset_hash, reset_expires_at, reset_attempts = 0 WHERE email = $1 AND email_verified_at IS NOT NULL AND status = 'ACTIVE' AND (reset_expires_at IS NULL OR reset_expires_at <= retryBefore) AND (reset_failures_since IS NULL OR reset_failures_since <= janela OR reset_failures_day < 10) RETURNING id`. Mesma instrução e mesmo custo para qualquer e-mail; sem linha = não envia.
2. **Conferir sem consumir** (`hasValidResetCode(email, hash, now)`): `SELECT` do mesmo predicado do sucesso (hash igual, vencimento futuro, `reset_attempts < 5`, ativa e confirmada). Serve para decidir se vale pagar o scrypt (decisão 7).
3. **Falha** (`recordResetFailure(email, now)`): igual ao UPDATE de falha da 020 (incrementa `reset_attempts` e o contador do dia; apaga o hash no 5º erro da vez ou no 10º do dia; mantém o vencimento; só atua com hash e vencimento vigentes), devolvendo `wrong | exhausted | unavailable`.
4. **Sucesso** (`resetPassword(email, hash, newPasswordHash, now)`): `UPDATE accounts SET password_hash = $new, reset_hash = NULL, reset_expires_at = NULL, reset_attempts = 0, reset_failures_day = 0, reset_failures_since = NULL, updated_at = CURRENT_TIMESTAMP WHERE email = $1 AND reset_hash = $2 AND reset_expires_at > $now AND reset_attempts < 5 AND status = 'ACTIVE' AND email_verified_at IS NOT NULL RETURNING id`. Troca de senha e invalidação do código são a **mesma** instrução; o Postgres serializa por linha, então: dois pedidos com o código certo, um vence e o outro é 401; 50 erros simultâneos geram exatamente 5 incrementos; um acerto concorrente só vale se rodar antes do esgotamento. O código usado e qualquer outro pendente morrem juntos (há uma só linha de código).

### Fluxo do `confirm` no serviço (`AccountService.confirmPasswordReset`)

1. Valida formato (controller). 2. `hasValidResetCode`; se não, `recordResetFailure` e 401 uniforme. 3. Só com o código conferido: hash da senha nova (`PasswordHasher.hash`, lane padrão `auth`, com o teto de fila existente: fila cheia = 503 `ServiceUnavailableError`, nada gravado; quem chega aqui já provou o código, então o custo do scrypt não é amplificável por quem não o tem). 4. **Revogação antes do commit:** `AccountSessionStore.revokeAll(accountId)` (ver abaixo); falhou = 503, nada gravado, o código segue válido e a pessoa tenta de novo. O `accountId` vem de `findByEmail` (uma leitura que só ocorre depois do código conferido). 5. `resetPassword`; sem linha (perdeu a corrida ou o código acabou de morrer) = `recordResetFailure` e a mesma 401. 6. **Revogação depois do commit** (fecha a janela em que um login com a senha antiga criou uma sessão entre os passos 4 e 5); falhou = 503 `SERVICE_UNAVAILABLE` com a senha já trocada e o código já gasto, como na 008 (o 503 não diz que a troca aconteceu; a pessoa entra com a senha nova; a janela de milissegundos é a única sessão que pode sobrar, aceita). 7. Zera o bloqueio de login por conta (`resetLoginFailures` na chave `account:<e-mail>`; melhor esforço, só log `warn` com `accountId`). 8. Envia o aviso "senha alterada" em segundo plano (decisão 8). 9. Observador `onPasswordReset(result, accountId)` (métrica e log).

Conta com e-mail **não confirmado** nunca redefine (o predicado exige `email_verified_at IS NOT NULL`): a confirmação vem antes; essa pessoa usa "Confirmar e-mail" ou se cadastra de novo (regra da 017).

### Revogação de todas as sessões da conta

Porta `AccountSessionStore` ganha `revokeAll(accountId): Promise<void>`. Implementação no Redis (decisão 6): **contador de geração por conta** `<prefixo>account-gen:<accountId>`; `revokeAll` faz `INCR` e `EXPIRE` de 31 dias (maior que o teto absoluto de 30 dias da sessão). `create` (agora em script Lua) lê a geração e a grava na sessão (`gen`); o `READ` compara a geração gravada com a atual (chave montada a partir do prefixo e de `data.accountId`) e, se a atual for maior, **apaga a sessão e responde como ausente** (401). Sessões antigas sem o campo `gen` valem como `gen = 0` (ficam válidas até a primeira revogação). Sem lista de chaves por conta, sem `SCAN`, e a corrida entre criar sessão e revogar fica resolvida dentro do Lua. Redis fora = 503 (fail-closed, como o restante das sessões). O relógio é o do Redis, como já é.

### Política de senha (decisão 5)

A nova senha da recuperação usa **exatamente a política do cadastro público** (`accountPasswordSchema`: 6 a 128 caracteres depois do NFKC, uma maiúscula e um número, sem NUL): um só schema compartilhado, para os dois fluxos não divergirem. O contrato do cadastro **não muda** (decisão 5, decisão do dono em 2026-11-03): nem o schema, nem o frontend de cadastro, nem os testes e e2e que usam senhas curtas. `newPasswordSchema` (12 caracteres, spec 007) continua só no que já o usa. `loginPasswordSchema` e `credentials` continuam aceitando qualquer senha já existente. Lista de senhas comuns fica **fora de escopo** (sem dependência nova).

### E-mails (texto simples, sem HTML; `SmtpVerificationMailer` ganha os dois métodos ou uma classe irmã na mesma pasta, e a porta `PasswordResetMailer`)

- **Código:** assunto `Seu código para redefinir a senha do Soprei` (distinto do de confirmação; o código não vai no assunto). Corpo: "Seu código para redefinir a senha é:", linha em branco, os 6 dígitos contínuos, linha em branco, "Ele vale por 15 minutos. Se você não pediu isso, ignore esta mensagem; sua senha continua a mesma."
- **Aviso:** assunto `Sua senha do Soprei foi alterada`; corpo: "A senha da sua conta foi alterada e todas as sessões abertas foram encerradas. Se foi você, não precisa fazer nada. Se não foi, redefina a senha de novo e confira o acesso ao seu e-mail." Sem código, sem senha, sem IP, sem link.
- Falha do transporte: `ServiceUnavailableError` com mensagem fixa, sem eco do código nem do e-mail; no `request`, falha de envio apaga o código (`clearResetCode(id, hash)`, libera novo pedido já, melhor esforço) e vira só métrica e log; o aviso de senha alterada que falha só loga.

### Auditoria (decisão 9)

`Account` é global e `AuditEvent` é model de **tenant** (`clientId` obrigatório, chaves compostas para `users`), então não há onde gravá-lo sem inventar um cliente. **Recomendação:** sem tabela de auditoria nesta spec; log `info` estruturado **só com `accountId` e o resultado** + métrica + o e-mail de aviso ao titular (que é a trilha que importa para ele). Uma trilha de auditoria global de contas (com política de retenção) entra na spec de retenção/LGPD. Nunca vão a log: e-mail, código, hash, senha, cookie.

### Observabilidade

Métricas de labels fixos (nenhum id, e-mail, IP ou código):

- `account_password_reset_requests_total{result}`: `issued` (código gravado, envio disparado) e `ignored` (nada gravado, por qualquer motivo).
- `account_password_reset_attempts_total{result}`: `reset`, `wrong`, `exhausted`, `unavailable`, `revoke_failed`.
- `account_password_reset_emails_total{kind,result}`: `kind` = `code`/`notice`, `result` = `sent`/`failed`.
- `account_purged_total` (sem labels) e `account_purge_runs_total{result}` (`ok`, `error`).

Logs: só `accountId`, resultado e contagens. Erro do ioredis só por `describeRedisError`.

### Expurgo de contas não confirmadas (decisão 11)

- **Quem:** conta com `email_verified_at IS NULL`, **sem nenhum `User`** (nunca criou empresa; na prática é sempre verdade, a checagem é cinto e suspensório e o `ON DELETE RESTRICT` é a terceira barreira) e com `updated_at` mais antigo que `ACCOUNT_UNVERIFIED_RETENTION_DAYS` (padrão 7). Usa `updated_at` (última atividade de cadastro/reenvio/erro, já mantida por todos os UPDATEs) e não `created_at`, para não apagar a conta de quem acabou de se cadastrar de novo.
- **Como:** `UnverifiedAccountPurger` (`application/auth/`, porta `UnverifiedAccountPurgeRepository`; implementação em `infrastructure/database/repositories/`) com `runOnce(now)`, e timer no processo, ligado em `src/index.ts` só com `ACCOUNTS_ENABLED=true`: `setInterval` com `unref()`, primeira execução curta (~30 s) depois do boot, intervalo `ACCOUNT_PURGE_INTERVAL_MINUTES` (padrão 60; **0 desliga**), até 10 lotes de 100 por execução (constantes), sem sobreposição (execução em curso pula o tique), erro engolido com log `error` só de contagem e métrica `error`, e o `closeInfrastructure` para o timer e espera a execução ativa. Sem dependência nova. **Alternativa rejeitada:** purga oportunista dentro do `register` (acopla latência do cadastro à limpeza e quebra o "mesmo trabalho observável"). Com várias instâncias a purga continua correta (`SKIP LOCKED`).
- **SQL** (módulo revisado em `infrastructure/database/`, parametrizado; lê `users` só por existência de `account_id`, sem dado de tenant): `DELETE FROM accounts WHERE id IN (SELECT a.id FROM accounts a WHERE a.email_verified_at IS NULL AND a.updated_at < $cutoff AND NOT EXISTS (SELECT 1 FROM users u WHERE u.account_id = a.id) ORDER BY a.updated_at LIMIT $batch FOR UPDATE SKIP LOCKED) AND email_verified_at IS NULL AND updated_at < $cutoff AND NOT EXISTS (SELECT 1 FROM users u WHERE u.account_id = accounts.id) RETURNING id` (contagem de linhas, nunca e-mail). Sem corrida com a confirmação: o `UPDATE` de `verify` e o `DELETE` disputam a mesma linha; se a confirmação confirma primeiro, o `DELETE` repete o predicado sobre a linha atualizada e não a apaga (conta confirmada **nunca** é apagada); se o `DELETE` vence, o `verify` não encontra a linha e responde `unavailable` (401 uniforme). Índice parcial `accounts_unverified_updated_at_idx ON accounts (updated_at) WHERE email_verified_at IS NULL` só na migration (o Prisma não o representa).
- **Depois do expurgo** o e-mail fica livre: um novo cadastro cria conta nova com outro id. Sessões não existem para conta não confirmada (o login exige confirmação).

### Frontend (`frontend/src/AccountApp.tsx`, beUI, tokens e acessibilidade existentes; nenhuma cor nova)

- Tela de entrada ganha o botão/link **"Esqueci minha senha"**. Páginas novas `forgot` (`/recuperar-senha`: campo e-mail; mensagem neutra depois do envio, **sempre**, mesmo em erro 4xx que não seja 429: "Se existir uma conta, enviamos um código para o e-mail informado.") e `reset` (`/redefinir-senha`: e-mail preenchido, `VerificationField` reaproveitado com a normalização ao colar, nova senha e confirmação com os alternadores de visibilidade, ajuda e validação local iguais às do cadastro: "Mínimo de 6 caracteres, com uma letra maiúscula e um número."). Link "Já tenho um código" na tela de pedido; "Voltar para entrar" nas duas.
- Mensagens pt-BR: 401 `Código inválido ou expirado. Se errou várias vezes, peça um novo código.`; 429 o texto atual; sucesso volta ao login com `Senha redefinida. Entre com a nova senha.` (limpa campos de senha e código); sem login automático.
- Cadastro: não muda (decisão 5); a validação local e o texto de ajuda do cadastro e da recuperação vêm do mesmo módulo (`frontend/src/account-flow.ts`).
- Testes: unitários (componente: navegação entre telas, mensagem neutra, normalização do código, erro local com menos de 6 dígitos, senhas diferentes, não chama a API com entrada inválida), `contrast.test.ts` só se entrar par texto/fundo novo, e2e Playwright em `frontend/e2e/accounts.spec.ts` (fluxo completo com API interceptada, desktop/celular, claro/escuro, sem violação de acessibilidade, corpo `{ email, code, newPassword }`; ajustar as senhas dos testes existentes).

### Configuração (`env.schema.ts` e `.env.example`; só com `ACCOUNTS_ENABLED=true`)

`ACCOUNT_UNVERIFIED_RETENTION_DAYS` (inteiro 1 a 90, padrão 7) e `ACCOUNT_PURGE_INTERVAL_MINUTES` (inteiro 0 a 1440, padrão 60; 0 desliga). Nenhuma variável para os limites de recuperação (constantes no domínio, como na 020). O perfil de rate limit é o `login` existente (decisão 4).

## Critérios de aceite

Testes determinísticos: relógio injetável (`now`), `randomInt` injetável, esperas com prazo, nenhum `sleep` fixo como asserção. O CI é a palavra final; localmente o agente roda só `typecheck`, `lint`, `format:check` e, se um teste falhar, o arquivo que falhou (decisão do dono, ver `AGENTS.md`).

**Recuperação**
- [x] `request` responde o mesmo `202` e a mesma mensagem para: e-mail inexistente, conta não confirmada, desativada, confirmada, pedido repetido em menos de 60 s e teto diário estourado; só a confirmada e ativa fora do intervalo e do teto grava código e chama o mailer (teste com mailer falso conta chamadas).
- [x] `request` faz a mesma instrução de banco para qualquer e-mail (teste do repositório em memória e contrato em Postgres) e o envio roda em segundo plano: SMTP que falha ou demora não altera a resposta (202) e libera novo pedido (`clearResetCode`); `drain` espera o envio.
- [x] Código guardado como HMAC-SHA256 com o rótulo `soprei:password-reset:v1` e mensagem com o e-mail normalizado: o código nunca aparece no banco; chave diferente gera hash diferente; **um código de confirmação de e-mail (020) não redefine senha e um código de recuperação não confirma e-mail** (teste cruzado nos dois sentidos).
- [x] `confirm` com código certo troca a senha, responde 204, não define cookie, e o login com a senha antiga falha e com a nova funciona; o código usado não vale de novo (401).
- [x] Código errado, vencido (relógio +15 min), esgotado, já usado, de conta inexistente, não confirmada ou desativada respondem **a mesma** 401 (mesmo `code` e `message`; comparar só esses campos, o `requestId` muda).
- [x] 4 erros seguidos e o 5º certo redefinem; 5 erros matam o código: o 6º envio **com o código certo** é 401 e a senha não muda; o reenvio respeita os 60 s (vencimento mantido) e o código novo zera o contador.
- [x] Teto diário: 10 erros em 24 h (mesmo com códigos novos entre eles) matam o código vigente e `request` deixa de emitir código (202 igual, sem e-mail) até a janela de 24 h passar; redefinir com sucesso zera o contador.
- [x] Formato inválido (código com 5 ou 7 dígitos, letras, espaços, token longo; senha fora da política do cadastro, como "curta" ou sem maiúscula; campo extra) é 400 e **não** incrementa contador, não consulta o banco e não gasta hash.
- [x] Hash da senha só é calculado depois de o código ser conferido (teste com hasher falso que conta chamadas: erro de código = 0 hashes); fila do hasher cheia depois do código conferido = 503 e a senha e o código ficam intactos.
- [x] **Efeitos:** depois de redefinir, todas as sessões da conta (cookie) deixam de valer (`/auth/session` 401), inclusive as criadas antes e uma criada entre a revogação prévia e o commit; sessão criada depois do reset vale; o bloqueio de login por conta (5 falhas) é zerado; sessões de **outra** conta não são afetadas.
- [x] Redis fora **antes** do commit: 503, senha e código intactos (repetir funciona); Redis fora **depois** do commit: 503 com a senha já trocada (login com a nova funciona depois que o Redis volta) e o código gasto; nenhum dos dois loga segredo.
- [x] Conta com e-mail não confirmado nunca redefine (mesmo com código forjado no banco) e conta desativada idem; `register` repetido de conta não confirmada segue funcionando como na 017.
- [x] Aviso "senha alterada" enviado uma vez por redefinição bem-sucedida, nunca por tentativa falha, sem código, senha ou link; falha do aviso não afeta a resposta.
- [x] Rota fora de `Origin`/`X-Soprei-Client` válidos é 403 (hook existente) e o inventário de rotas de rate limit (`rate-limit.test.ts`) passa com as duas rotas no perfil `login` fail-closed (Redis do limiter fora = 503 sem consultar o banco).

**Integração com Postgres real**
- [x] 50 `confirm` errados simultâneos contra o mesmo código = exatamente 5 incrementos, hash `NULL` ao final e nenhum seguinte casa; 20 errados + 1 certo, em várias rodadas: a certa só vale se rodou antes do 5º erro e `reset_attempts` nunca passa de 5; o código certo depois do 5º erro **não** troca a senha.
- [x] Dois `confirm` simultâneos com o mesmo código certo e senhas diferentes: exatamente um 204, e o `password_hash` final é o do vencedor.
- [x] Teto diário sob concorrência: nunca passa de 10 erros contados na janela.
- [x] `issueResetCode` concorrente (vários `request` ao mesmo tempo) grava no máximo um código por intervalo.
- [x] O contrato compartilhado `test-support/account-repository-contract.ts` cobre os novos métodos e roda no repositório em memória **e** no de Postgres.
- [x] Migration nova (timestamp maior que `20261103150000`) aplicada em schema temporário com rollback, como em `account-migration.integration.test.ts`: existe, não altera migrations anteriores, cria as colunas, os CHECKs e o índice parcial, e preserva as contas existentes.

**Expurgo**
- [x] Apaga conta não confirmada, sem `User`, com `updated_at` além da retenção; **não** apaga: não confirmada recente (`updated_at` renovado por novo cadastro), confirmada antiga, e conta com `User` (mesmo forçando o estado no teste).
- [x] Respeita o tamanho do lote e o teto de lotes por execução; execução vazia não faz nada; erro do repositório não derruba o processo, loga só a contagem e conta `error`.
- [x] **Corrida com a confirmação (Postgres real):** em várias rodadas, `verify` correto e expurgo disputando a mesma conta nunca produzem "`verified` e linha apagada" nem conta confirmada apagada; quando o expurgo vence, `verify` responde `unavailable` (401 uniforme).
- [x] Depois do expurgo o mesmo e-mail pode se cadastrar de novo e recebe código; o id é novo.
- [x] Timer: `unref`, para no desligamento esperando a execução ativa, não sobrepõe execuções, `ACCOUNT_PURGE_INTERVAL_MINUTES=0` não agenda nada, só existe com `ACCOUNTS_ENABLED=true` (teste com agendador injetável, sem esperar tempo real).
- [x] Config: `env.schema` recusa retenção fora de 1 a 90 e intervalo fora de 0 a 1440; `.env.example` documenta as duas variáveis (teste de config existente).

**Privacidade e observabilidade**
- [ ] Log capturado de um fluxo completo (pedido, erros, esgotamento, sucesso, aviso, expurgo) **não** contém código, hash, senha, e-mail nem cookie (usar `logContains` de `src/test-support/log-capture.ts`, nunca `includes` cru: um código de 6 dígitos coincide por acaso com timestamp ou UUID); `resetHash` no `redact`.
- [x] As métricas novas aparecem com os labels fixos listados e nenhum outro; erros do mailer e do Redis não vazam e-mail, código nem endereço.
- [x] Mailer: corpos e assuntos dos dois e-mails conforme acima (código em linha própria, "15 minutos", código fora do assunto, aviso sem código), falha do transporte vira `ServiceUnavailableError` sem eco.
- [x] Schemas Zod: `confirm` aceita `123456`/`000000` e recusa 5/7 dígitos, `12345a`, `12 3456`, vazio, campos extras e a chave `token`; `request` recusa campos extras; o schema de senha da recuperação é o mesmo do cadastro (aceita `Abcde1`; recusa `Abc1`, sem maiúscula, sem número, NUL e mais de 128 caracteres).
- [ ] Frontend e e2e conforme a seção Frontend; `typecheck`, `lint`, `format:check`, `test`, `test:integration` e `test:browser` verdes no CI, em Node 22 e na LTS.

## Casos de borda e erros

- **Dois pedidos seguidos:** o segundo, antes de 60 s, responde o mesmo 202 e não envia; o código do primeiro continua valendo.
- **Pedido, depois lembra a senha:** o código pendente fica válido até vencer; o login normal não o invalida (inócuo: exige o e-mail).
- **Duas abas confirmando:** uma vence, a outra recebe a 401 uniforme.
- **Pedido na janela do esgotamento:** o código morto mantém o vencimento; novo pedido só depois dos 60 s e só se o teto diário permitir.
- **Conta com bloqueio de login ativo:** a redefinição zera o bloqueio (a pessoa pode entrar de imediato com a senha nova).
- **Senha nova igual à antiga:** aceita (não há histórico de senhas).
- **Falha do banco no meio:** nada muda sem a instrução atômica; a revogação prévia só desloga sessões (efeito seguro).
- **Conta desativada depois de pedir o código:** o predicado exige `ACTIVE`; 401 uniforme.
- **Expurgo e usuário que acabou de se cadastrar:** protegido pelo `updated_at` e pelo predicado repetido sob lock; o pior caso é a pessoa se cadastrar de novo.
- **Reinício do processo:** o timer volta ao boot; execução interrompida deixa lotes pela metade, sem inconsistência (cada lote é uma instrução).
- **Relógio:** vencimentos, janela e corte do expurgo usam o `now` do serviço (injetável); no banco o instante vai por parâmetro; sessões usam o relógio do Redis.

## Isolamento entre clientes

`Account` é global (sem `ClientId`) e a spec não cria nem altera model de tenant; `MODEL_SCOPES` não muda (as colunas novas são de `accounts`). A única leitura de dado de tenant é a existência de `users.account_id` no expurgo (SQL controlado, só `EXISTS`, nenhuma coluna devolvida, dentro de `infrastructure/database/`). Revogar as sessões de uma conta atinge só as chaves da própria conta (geração por `accountId`, nunca por e-mail nem cliente). Testes: sessão de outra conta continua válida depois do reset; o expurgo não toca conta com `User` (nem clientes, usuários ou auditoria); o fluxo não cria vínculo, empresa nem sessão de tenant.

## Riscos

- **Negação de serviço por esgotar o teto diário:** quem conhece o e-mail da vítima pode enviar 10 códigos errados e bloquear a recuperação dela por até 24 h (e queimar o código que ela acabou de receber). Custo baixo, sem a senha. Mitigações aceitas: a vítima ainda entra com a senha atual; a janela fecha sozinha; o teto é por conta, não por IP. Ver decisão 2 (10 vs 25).
- **Risco residual de adivinhação:** ~0,0010% por dia (~0,36% por ano de ataque contínuo) por e-mail visado com 6 dígitos e teto de 10. Reduzível com código de 8 dígitos (100 vezes menos), que a spec **não** adota para reaproveitar o componente da 020 (decisão 3).
- **E-mail comprometido = conta comprometida:** quem lê a caixa de entrada redefine a senha. É inerente ao modelo; mitigado só pelo aviso "senha alterada" (que também chega à caixa comprometida) e por 2FA, que está fora de escopo.
- **Revogação depois do commit:** Redis fora depois da troca devolve 503 com a senha já trocada; a revogação prévia cobre as sessões existentes e só uma sessão criada em milissegundos entre os dois passos pode sobrar (a quem tem a senha antiga).
- **Senha curta (risco aceito, já registrado na 017):** o cadastro e a recuperação aceitam senha de 6 caracteres com maiúscula e número, o que facilita adivinhação. A defesa continua sendo o bloqueio por conta (5 falhas em 15 min, que a redefinição zera) e o rate limit do perfil `login` por IP; não há medidor de força nem lista de senhas comuns. Quem toma a conta pela recuperação precisa do e-mail; quem adivinha a senha precisa passar pelo bloqueio.
- **Concorrência de purga e SMTP:** envio de código em andamento para conta que acabou de ser expurgada simplesmente não confirma (401 uniforme).
- **Sessões sem `gen`** (anteriores à spec) só caem na primeira revogação; aceitável (produto não lançado).
- **Quem pré-cadastra o e-mail de outra pessoa** continua podendo bloquear a confirmação dela pelo teto da 020 (risco aceito já registrado); o expurgo o limita no tempo apenas se o atacante parar de renovar a conta.

## Fora de escopo

- Troca de senha **logado** (`/account/password`), convites, e-mail de boas-vindas.
- Lista grande (ou pequena) de senhas comuns; medidor de força; histórico de senhas.
- 2FA, CAPTCHA ou prova de trabalho; limite por IP+e-mail (o perfil `login` por IP e o teto por conta são a defesa).
- Recuperação por SMS ou WhatsApp; link mágico; e-mail em HTML, templates ou traduções.
- Auditoria global de contas em tabela e política de retenção/LGPD (spec própria).
- Mudar o bloqueio de login por conta (5 falhas em 15 min) ou o fluxo de confirmação de e-mail da 020.
- Redefinir senha de `User` legado/tenant ou do `PlatformAdmin` (a CLI continua para eles); recuperação de conta desativada.
- Painel de administração das contas expurgadas; tabela de "e-mails bloqueados".

## Decisões para o dono

1. **Onde guardar o código de recuperação: colunas novas em `accounts` (recomendado).** Mantém um único código pendente por conta, UPDATE atômico por linha como na 020 e a invalidação do anterior de graça. Alternativa: tabela `password_resets` (histórico e várias linhas, mas exige joins, limpeza e mais SQL para a mesma garantia).
2. **Limites: 5 erros por código e teto de 10 erros por conta em 24 h (recomendado)**, mais apertado que o 25 da confirmação porque o alvo é uma conta viva e o atacante não precisa da senha. Alternativas: 25 como na 020 (menos DoS, ~2,5 vezes mais risco de adivinhação) ou aceitar só os 5 por código (~0,72% por dia, **não recomendado**).
3. **Código de 6 dígitos, 15 min de validade, 60 s entre pedidos (recomendado)**, reaproveitando o componente da 020. Alternativa: 8 dígitos só na recuperação (100 vezes menos risco, componente novo e e-mail mais incômodo).
4. **Rate limit por IP: reaproveitar o perfil `login` (fail-closed) (recomendado)**, sem variável nova; divide a cota de 10 por 15 min com o login na mesma rede. Alternativa: perfil novo `recovery` (config própria, entra em `FAIL_CLOSED_RATE_LIMIT_PROFILES`).
5. **Política de senha: a do cadastro público é mantida, na recuperação e no cadastro (decisão do dono, 2026-11-03, revertendo a recomendação de 12 a 128 caracteres).** 6 a 128 caracteres depois do NFKC, uma maiúscula e um número (`accountPasswordSchema`), um único schema compartilhado. O contrato do cadastro não muda. Motivo: decisão do dono. Alternativas descartadas: 12 a 128 (recomendação original, muda o cadastro, o frontend e os e2e) e 10 caracteres.
6. **Revogação das sessões da conta: contador de geração por conta no Redis**, comparado a cada leitura de sessão, em Lua (recomendado), com revogação **antes e depois** do commit (503 em qualquer falha, nada perde o código no primeiro caso). Alternativa: índice de sessões por conta (conjunto no Redis; precisa de limpeza e de `SCAN`) ou só depois do commit (senha trocada com sessões antigas vivas se o Redis falhar).
7. **Hash da senha só depois de o código ser conferido (recomendado)** (leitura sem consumir, depois o UPDATE atômico). Evita amplificar custo de scrypt por quem não tem o código e não distingue conta existente de inexistente. Alternativa: sempre hashear antes (tempo idêntico em todo caminho, mas deixa qualquer um ocupar a fila do hasher e prejudicar o login).
8. **Avisar o titular por e-mail depois de redefinir (recomendado: sim)**, texto simples, sem código, senha nem link. Alternativa: não avisar (menos e-mail, mas a vítima de um sequestro não fica sabendo).
9. **Auditoria: só log estruturado com `accountId`, métrica e o e-mail de aviso, sem tabela (recomendado)**, porque `AuditEvent` é de tenant e a trilha global de contas depende da política de retenção/LGPD. Alternativa: tabela global `account_events` agora (mais migration, retenção sem política).
10. **Sem login automático depois de redefinir (recomendado)**: a pessoa entra com a senha nova (um passo a mais, mas a sessão só nasce de um login com senha). Alternativa: criar sessão ao redefinir.
11. **Expurgo: contas não confirmadas, sem `User`, com `updated_at` há mais de 7 dias, em lotes de 100, por um timer no próprio processo a cada 60 min (recomendado)**, `unref`, desligável com `0`, `SKIP LOCKED` e predicado repetido no `DELETE`. Alternativas: retenção de 3 ou 30 dias; purga oportunista no `register` (rejeitada acima); processo/cron externo (hospedagem ainda não decidida).
12. **Nomes: `POST /auth/password-reset/request` e `/confirm`, páginas `/recuperar-senha` e `/redefinir-senha`, variáveis `ACCOUNT_UNVERIFIED_RETENTION_DAYS` e `ACCOUNT_PURGE_INTERVAL_MINUTES` (recomendado).** Alternativas livres.

## Decisões e dependências novas

- Nenhuma dependência nova (`node:crypto`, `nodemailer` e `ioredis` já existem; timer nativo).
- Migration nova e aditiva (cinco colunas, dois CHECKs, índice parcial só no SQL). Aplicar com `pnpm db:migrate:deploy` depois do merge (passo do dono).
- Portas e módulos a tocar: `account.service.ts` (e um serviço pequeno de recuperação se o arquivo ficar grande), `verification-code.ts` (ou `reset-code.ts`) para a chave/HMAC de recuperação, domínio e repositório Prisma de contas, `application/ports/account-session.ts` (`revokeAll`, `PasswordResetMailer`), `redis-account-session-store.ts`, `account.controller.ts`, mailer SMTP, `metrics.ts`, `env.schema.ts`, `.env.example`, `index.ts`, `redact` do logger, `schema.prisma` e a migration, `AccountApp.tsx` e componentes, `frontend/e2e/accounts.spec.ts`, os testes citados e `test-support/` (repositório em memória e contrato).
- Atualizar na implementação, pelo implementador e depois da aprovação: `AGENTS.md` (seção "Contas globais": recuperação, teto de 10, política de senha do cadastro mantida, revogação por geração, expurgo), `docs/context.md` (histórico de decisões e roadmap), `docs/handoff.md`.
- Fontes: spec 020 (desenho do código, HMAC, tentativas e teto), OWASP Forgot Password Cheat Sheet (resposta uniforme, código de uso único e com validade curta, invalidar sessões) e NIST SP 800-63B (tamanho mínimo, sem composição), consultados como referência de desenho.

## Registro da implementação

Implementada por Claude Code (Sonnet 5.5) na branch `spec/021-recuperacao-de-senha`. Commits: frontend (telas), banco (migration, repositórios, contrato), serviço/rotas/sessões/expurgo, testes de inventário e este registro.

**Decisão do dono durante a implementação (2026-11-03):** a decisão 5 foi revertida. A senha da recuperação usa a política do cadastro público (`accountPasswordSchema`: 6 a 128 caracteres depois do NFKC, uma maiúscula e um número), o mesmo schema do cadastro; o contrato do cadastro, o frontend de cadastro e os testes com senha curta **não mudaram**. O texto original da spec (12 a 128) foi corrigido acima.

**Pastas e arquivos principais**
- `backend/prisma/migrations/20261103160000_account_password_reset/` (aditiva: 5 colunas `reset_*`, 2 CHECKs, índice parcial `accounts_unverified_updated_at_idx`) e `schema.prisma`.
- `domain/repositories/account.repository.ts` (constantes `RESET_*`, novos métodos e `UnverifiedAccountPurgeRepository`); `infrastructure/database/repositories/account.repository.ts` e `unverified-account-purge.repository.ts` (SQL cru parametrizado, só em `infrastructure/database/`).
- `application/auth/`: `reset-code.ts`, `account.service.ts` (`requestPasswordReset`, `confirmPasswordReset`), `unverified-account-purger.ts`, `purge-timer.ts`; porta `account-session.ts` (`revokeAll`, `PasswordResetMailer`, `AccountMailer`).
- `infrastructure/auth/redis-account-session-store.ts` (geração por conta, `create`/`READ` em Lua), `external-apis/email/smtp-verification-mailer.ts` (código e aviso), `metrics`, `config/env.schema.ts`, `lifecycle.ts`, `index.ts`, `logger.ts` (`resetHash`).
- Frontend: `account-flow.ts` (páginas, caminhos, política de senha, mensagens), `AccountApp.tsx`, `main.tsx`.
- Testes novos: `account-password-reset.test.ts`, `unverified-account-purger.test.ts`, `account-reset-contract.ts` (exportado por `account-repository-contract.ts`), `account-password-reset.integration.test.ts` (banco), `unverified-account-purge.integration.test.ts`, `redis-account-session-store.integration.test.ts`, `accounts-password-reset.integration.test.ts` (HTTP, Postgres e Redis reais), `smtp-password-reset-mailer.test.ts`, `account-password-reset.controller.test.ts`, `account-purge-config.test.ts`, `account-flow.test.ts` e o e2e `frontend/e2e/accounts.spec.ts`.

**O que foi executado localmente (verde):** `typecheck`, `lint` e `format:check` da raiz; a migration aplicada **só** em `soprei_test`; todos os arquivos novos ou alterados, um por vez, mais os de contas, sessões, rate limit, métricas, config, mailer e logger; Playwright de `accounts.spec.ts` (desktop e celular, claro e escuro, 12 testes). **Não rodado localmente (depende do CI):** a suíte completa, a repetição em Node 22 e na LTS, `pnpm build` e o smoke do processo compilado.

**Desvios e achados**
- **CTE `MATERIALIZED` no expurgo.** O SQL da spec (`DELETE ... WHERE id IN (SELECT ... LIMIT ... FOR UPDATE SKIP LOCKED)`) apagou mais linhas que o lote no teste (o planejador reexecuta a subconsulta). O lote agora sai de `WITH picked AS MATERIALIZED (...)`; o predicado continua repetido no DELETE.
- **Métrica com "emails" no nome:** o teste antigo de métricas (spec 008) recusava `email` em qualquer parte do corpo; passou a recusar só em nomes de label (o nome `account_password_reset_emails_total` vem da spec).
- **Contrato** da recuperação fica em `account-reset-contract.ts` e é reexportado por `account-repository-contract.ts` (arquivo próprio para não crescer demais).
- **Testes de "componente" do frontend:** o projeto não tem jsdom; a lógica (caminhos, política de senha, mensagem neutra, 4xx neutro) é testada em `account-flow.test.ts` e a navegação entre telas, a mensagem neutra, a normalização do código e as validações locais no e2e. O critério "sem violação de acessibilidade" **não** tem verificação automática (o projeto não usa axe; nenhum teste de acessibilidade existente foi estendido).
- **Estado dos critérios que ficaram `[ ]`:** o de log de um fluxo completo cobre pedido, erros, esgotamento, sucesso e aviso (`accounts-password-reset.integration.test.ts`), mas o log do expurgo (só contagens, em `index.ts`) não é capturado por teste; o último (CI em Node 22 e LTS, `test:browser`) depende do CI.
- `unverified-account-purger`: `startPurgeTimer` recebe `enabled` (`ACCOUNTS_ENABLED`) para a regra "só com contas ligadas" ser testável.
- O hash fictício e o tempo do `confirm` não são igualados entre código certo e errado: o custo do scrypt só existe depois do código conferido (decisão 7 da spec).

**Fontes consultadas:** a própria spec 020 e o código existente (`verification-code.ts`, `PrismaAccountRepository.verify`, `RedisAccountSessionStore`); documentação do PostgreSQL sobre `FOR UPDATE SKIP LOCKED` e CTE `MATERIALIZED`.
