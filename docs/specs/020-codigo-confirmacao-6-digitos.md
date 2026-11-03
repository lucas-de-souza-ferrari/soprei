# 020 — Código de confirmação de e-mail com 6 dígitos

- **Status:** concluída e mergeada (2026-11-03; CI verde em Node 22 e LTS); aprovada (2026-11-03, dono: "Aprovo tudo", com as 8 recomendações, incluindo o teto diário de 25 erros por conta)
- **Branch:** `spec/020-codigo-confirmacao-6-digitos`
- **Depende de:** 017 (contas e confirmação de e-mail), 019 (envio por SMTP genérico)
- **Segurança:** mexe em autenticação e em endpoint público; passa pelo `reviewer` antes do merge.

## Objetivo

Trocar o código de confirmação de e-mail, hoje um token de 43 caracteres (256 bits, ex.: `4SaUJXk9zCcO1mvSQNy3-Dh5IRi8yRcwS9-pAiOujlw`), por um código de **6 dígitos** fácil de digitar. Com 256 bits o código não era adivinhável; com 6 dígitos há só 1.000.000 de combinações, então a troca só é aceitável junto com limite de tentativas erradas, armazenamento com HMAC e expiração menor. A spec trata os três como parte do mesmo trabalho.

## Estado atual (lido no código)

- `AccountService.register` e `resend` geram `randomBytes(32).toString('base64url')` e guardam `SHA-256(token)` em `accounts.verification_hash`, com `verification_expires_at` (TTL `VERIFICATION_TTL_MS` = 30 min). Intervalo mínimo entre envios: 60 s (`retryBefore`, derivado do vencimento; não há coluna de "último envio").
- `AccountService.verify(email, password, token)` chama `credentials()`, que só conta falha de **senha** no bloqueio por conta (5 falhas em 15 min), e depois `accounts.verify(id, digest(token), now)`, um `updateMany` que casa hash + vencimento + `ACTIVE` + não confirmada. **Errar o código não conta em lugar nenhum**; só vale o limite por IP do perfil `login`.
- Resposta única a código errado ou vencido: 401 `Confirmação inválida ou expirada`.
- Controller: `POST /auth/verify-email` com `{ email, password, token }`; o schema exige `^[A-Za-z0-9_-]{43}$`.
- Mailer (`smtp-verification-mailer.ts`): texto com o token e "expira em 30 minutos".
- Frontend (`AccountApp.tsx`): campo "Código recebido por e-mail" (`autoComplete="one-time-code"`), envia `{ email, password, token }`; o e2e (`frontend/e2e/accounts.spec.ts`) preenche `codigo-ficticio`.
- Métrica existente: só `account_verification_sends_total{result}` (envio). Não há métrica de tentativas de confirmação.
- `Account` é global (sem `ClientId`); `verification_hash` já está no `redact` do logger.

## Ameaça que a spec precisa fechar

Alguém cadastra o e-mail de **outra pessoa** com uma senha que ele escolhe e tenta todos os códigos para confirmar a conta (a vítima nunca vê nada além de um e-mail que não pediu, mas a conta passa a ter o e-mail dela confirmado e a senha do atacante, e a vítima não consegue usá-lo para se cadastrar). Hoje isso é inviável pelos 256 bits; com 6 dígitos e sem limite seria questão de minutos (o perfil `login` por IP deixa ~100 por 15 min por IP, e IPs são baratos). Por isso:

- **Limite de tentativas erradas por código** (decisão 1): o código morre depois de N erros.
- **HMAC-SHA256 com chave derivada do `JWT_SECRET`** em vez de SHA-256 simples: com 6 dígitos, um vazamento só do banco permitiria reverter o hash em microssegundos (e confirmar a conta); com HMAC é preciso também o segredo.
- **Resposta uniforme**: código errado, vencido, esgotado ou inexistente devolvem exatamente a mesma 401, sem dizer qual.

## Comportamento esperado

### Geração e formato

- O código é `crypto.randomInt(0, 1_000_000)` convertido em texto e preenchido com zeros à esquerda até 6 dígitos (`'000042'`). Sem `Math.random`, sem módulo sobre bytes (viés).
- Registro e reenvio geram um código novo; o anterior morre (já é assim: a linha guarda um só hash).

### Armazenamento

- `verification_hash` passa a guardar `HMAC-SHA256(chave, "account-verification:" + accountId + ":" + código)` em hex. O `accountId` entra na mensagem para o mesmo código em duas contas gerar hashes diferentes. A chave é derivada do `JWT_SECRET` por HMAC com rótulo próprio (`soprei:account-verification:v1`), como já se faz com o contador de login (`loginSecret`), sem variável de ambiente nova.
- Como o `accountId` do `registerUnverified` é gerado antes do INSERT mas a linha pode já existir (conflito por e-mail, com outro id), o hash do `INSERT ... ON CONFLICT` não pode depender do id gerado: o desenho precisa ser (a) o repositório calcula o hash depois de saber o id real (RETURNING em duas etapas), ou (b) a mensagem do HMAC usa o **e-mail normalizado** em vez do id. **Recomendação: (b)** (o e-mail é estável e conhecido antes do INSERT, e mantém o INSERT único e atômico da 017). Ver decisão 5.
- Comparação em tempo constante: o banco compara hashes iguais por igualdade de texto, e isso é aceitável porque o valor comparado é o HMAC (derivado de segredo), não o código. Onde a comparação for feita em código (repositório em memória dos testes), usar `timingSafeEqual` sobre buffers do mesmo tamanho.

### Tentativas erradas (contador atômico)

- Coluna nova `accounts.verification_attempts` (`SMALLINT NOT NULL DEFAULT 0`), contagem de erros do **código vigente**; zera sempre que um código novo é gravado (registro, reenvio) e ao confirmar.
- Limite: `VERIFICATION_MAX_ATTEMPTS = 5` (constante no serviço, não variável de ambiente; decisão 1). No 5º erro o código **morre** (`verification_hash` e `verification_expires_at` viram `NULL`); a pessoa precisa pedir reenvio (respeitando o intervalo de 60 s).
- Atomicidade, sem ler-e-depois-gravar. `accounts.verify` passa a fazer, em ordem, dois comandos independentes e cada um atômico por si:
  1. **Sucesso:** `UPDATE accounts SET email_verified_at = $now, verification_hash = NULL, verification_expires_at = NULL, verification_attempts = 0 WHERE id = $id AND verification_hash = $hmac AND verification_expires_at > $now AND status = 'ACTIVE' AND email_verified_at IS NULL AND verification_attempts < 5`. Se `count = 1`, confirmou.
  2. **Falha (só se o 1 deu 0):** `UPDATE accounts SET verification_attempts = verification_attempts + 1, verification_hash = CASE WHEN verification_attempts + 1 >= 5 THEN NULL ELSE verification_hash END, verification_expires_at = CASE WHEN verification_attempts + 1 >= 5 THEN NULL ELSE verification_expires_at END WHERE id = $id AND verification_hash IS NOT NULL AND verification_expires_at > $now AND email_verified_at IS NULL AND status = 'ACTIVE' RETURNING verification_attempts` (SQL cru parametrizado, dentro de `infrastructure/database/`, como o `registerUnverified`; `Account` é global, então não há `clientId` a filtrar).
  - Por que não passa de 5: o Postgres serializa os UPDATEs da mesma linha; o 5º que perde apaga o hash na mesma instrução e todos os seguintes não casam `verification_hash IS NOT NULL` (nenhum incrementa nem confirma). Um acerto concorrente com erros só confirma se o UPDATE de sucesso rodar com `attempts < 5` e o hash ainda presente.
  - Cada tentativa errada consome **uma** contagem, mesmo que o corpo tenha o código certo para outra conta.
- O contador conta só tentativas que chegaram ao ponto de comparar o código (e-mail e senha corretos, conta ativa e não confirmada, código com formato válido, código vigente existente). Não conta: formato inválido, senha errada (já tem o bloqueio próprio) e conta já confirmada.
- Formato inválido (decisão 3): o schema Zod aceita **exatamente 6 dígitos** (`^\d{6}$`); outra coisa é 400 de validação, **sem** contar. Justificativa: o 400 acontece antes de `credentials()` e de qualquer consulta, não deixa o atacante testar nada, e contar formato inválido só permitiria a um terceiro esgotar o código da vítima com lixo. Quem erra por digitar de menos não perde tentativa (o frontend normaliza antes).

### Expiração

- `VERIFICATION_TTL_MS` passa de 30 para **15 minutos** (decisão 2). O intervalo mínimo de reenvio continua 60 s. O e-mail diz "expira em 15 minutos".
- O texto do erro continua `Confirmação inválida ou expirada` (401) para código errado, vencido, esgotado ou ausente; o tempo de resposta é o mesmo caminho (credenciais, um UPDATE de sucesso e, no erro, um UPDATE de falha). Não há como distinguir pela resposta.

### Endpoint

- `POST /auth/verify-email`: corpo `{ email, password, code }` (o campo se chama `code`; decisão 4). Perfil de rate limit `login` (fail-closed) inalterado. Senha errada segue no bloqueio por conta existente.
- `POST /auth/resend-verification` e `POST /auth/register` inalterados no contrato; o código novo zera o contador.

### E-mail

- `VerificationMailer.sendVerification(email, code)` (parâmetro renomeado). Texto: o código sozinho em uma linha, com espaço entre grupos opcional (`482 913`) **não**: manter os 6 dígitos contínuos para copiar com duplo clique; assunto `Seu código de confirmação do Soprei`; corpo: "Seu código de confirmação é:", linha em branco, `482913`, linha em branco, "Ele vale por 15 minutos. Se você não pediu este cadastro, ignore esta mensagem." Texto simples (sem HTML novo). O código não vai no assunto.

### Observabilidade

- Nova métrica `account_verification_attempts_total{result}` com resultados fixos: `verified`, `wrong`, `exhausted` (a tentativa que matou o código), `unavailable` (sem código vigente, vencido ou já esgotado). Sem id, e-mail, IP nem o código. O resultado detalhado fica só em métrica e log interno; a resposta ao cliente é uma só.
- Log `info`/`warn` só com `accountId` e o resultado (quando houver log); nunca o código, o hash, o e-mail nem o corpo. `verification_attempts` entra em nenhum label.
- O `redact` do logger já cobre `verificationHash`; acrescentar `code` **não** (mascararia códigos de erro, como já decidido na 015). A regra é não pôr o código em objeto de log; o teste de captura de log prova.

### Frontend

- Campo do código: `inputMode="numeric"`, `autoComplete="one-time-code"`, `pattern="[0-9]*"`, `maxLength` suficiente para colar com separadores (o valor é normalizado a cada mudança), rótulo e `id` atuais preservados (`Código recebido por e-mail`, `#verification`) para não quebrar os testes de acessibilidade.
- Normalização ao digitar e ao colar: remove tudo que não for dígito (espaços, hífen, ponto) e corta em 6; envia `code` com 6 dígitos. Botão de confirmar só habilitado com 6 dígitos (ou erro local em português, `Digite os 6 dígitos do código`, sem chamar a API).
- Mensagens em pt-BR: a 401 mostra `Confirmação inválida ou expirada. Se errou várias vezes, peça um novo código.`; 429 do bloqueio segue o texto atual.
- Texto da tela: "Confira seu e-mail e digite o código de 6 dígitos."
- e2e (`frontend/e2e/accounts.spec.ts`): trocar `codigo-ficticio` por `123456` e a asserção do corpo da requisição para `code`; acrescentar caso de colar `123 456` e `123-456` (normaliza para `123456`).

### Compatibilidade (decisão 6)

Produto não lançado, único usuário é o dono, sem contas legadas. Códigos antigos pendentes (hash SHA-256 do token longo) **não** são migrados: a migration zera `verification_hash` e `verification_expires_at` das contas não confirmadas (o código antigo nunca mais confere, porque o HMAC é outro, e o usuário pede reenvio ou se cadastra de novo; o intervalo de 60 s passa a valer na hora porque o vencimento é `NULL`). Contas confirmadas não mudam.

## Banco e migration

- Migration **nova** (não edita a da 017 nem outra aplicada): `ALTER TABLE accounts ADD COLUMN verification_attempts SMALLINT NOT NULL DEFAULT 0` e `UPDATE accounts SET verification_hash = NULL, verification_expires_at = NULL WHERE email_verified_at IS NULL`. Opcional: `CHECK (verification_attempts >= 0)`. Aditiva; model `Account` no Prisma ganha `verificationAttempts Int @default(0) @db.SmallInt @map("verification_attempts")`. `MODEL_SCOPES` não muda (`Account` continua `global`).
- A migration da 017 só existe nesta linha de branches e foi editada com aval do dono; por isso esta mexe em coluna por migration separada e posterior (ordem de timestamp maior que `20261103141000`).
- `registerUnverified` e `refreshVerification` passam a gravar `verification_attempts = 0` junto com o novo hash (no `ON CONFLICT DO UPDATE` também). `clearVerification` zera o contador.

## Critérios de aceite

Os testes são determinísticos: relógio injetável (`now`), sem `sleep` fixo; o repositório em memória e o de Postgres compartilham o mesmo contrato.

- [ ] O código gerado tem sempre 6 caracteres `0-9`; com `randomInt` substituído por valores controlados (0, 42, 999999), vira `000000`, `000042`, `999999`. O serviço usa `crypto.randomInt(0, 1_000_000)` (teste injeta a função; teste estático/de revisão proíbe `Math.random` no arquivo).
- [ ] `register` e `resend` guardam HMAC-SHA256 do código (não o SHA-256 simples, não o código); o mesmo código em duas contas com e-mails diferentes gera hashes diferentes; chave diferente do `JWT_SECRET` gera hash diferente.
- [ ] Código certo confirma; código errado, vencido (relógio avançado 15 min), já usado e de conta já confirmada respondem **a mesma** 401 `Confirmação inválida ou expirada` (mesmo status, código e mensagem).
- [ ] 4 erros seguidos e o 5º certo confirmam; 5 erros seguidos matam o código: o 6º envio, **mesmo com o código correto**, responde a mesma 401 e a conta segue não confirmada.
- [ ] Depois do esgotamento, `resend` respeita o intervalo de 60 s (com o código morto o vencimento é `NULL`, então a regra atual libera o reenvio; o teste fixa o comportamento escolhido na decisão 7) e o código novo zera o contador e confirma.
- [ ] Reenvio e novo `register` da conta não confirmada invalidam o código anterior (o antigo deixa de conferir) e zeram `verification_attempts`.
- [ ] Formato inválido (5 ou 7 dígitos, letras, vazio, espaços, token longo antigo) é 400 e **não** incrementa `verification_attempts` nem chega a `credentials()`.
- [ ] Senha errada em `verify` segue contando no bloqueio por conta existente e **não** incrementa `verification_attempts`; conta bloqueada responde 429 antes de qualquer comparação.
- [ ] **Integração com Postgres real:** 50 tentativas erradas simultâneas (`Promise.all`) contra o mesmo código resultam em exatamente 5 incrementos, hash `NULL` ao final e nenhuma tentativa posterior casando; 20 erradas simultâneas mais 1 certa: a certa confirma só se rodou antes do 5º erro, e nunca há `verification_attempts > 5`. Repetir em várias rodadas no mesmo teste (sem sleep).
- [ ] **Integração:** o código certo enviado depois do 5º erro **não** confirma a conta (linha continua com `email_verified_at IS NULL`).
- [ ] **Integração:** a migration nova existe, não altera migrations anteriores, zera hash e vencimento das contas não confirmadas e preserva as confirmadas (teste lê o SQL e/ou aplica em banco de teste).
- [ ] Schema Zod: aceita `123456` e `000000`; recusa 5 e 7 dígitos, `12345a`, `12 3456`, vazio, o token antigo de 43 caracteres e campo `token` (chave antiga).
- [ ] Mailer: o corpo contém o código recebido em linha própria, "15 minutos", assunto novo, e **não** contém o código no assunto; falha do transporte continua virando `ServiceUnavailableError` sem eco do código.
- [ ] Métrica `account_verification_attempts_total{result}` aparece com os quatro resultados fixos e nenhum outro label; log capturado de um fluxo completo (cadastro, erros, esgotamento, sucesso) **não** contém o código, o hash, o e-mail nem a senha (texto secreto como código de teste, como na 017).
- [ ] Frontend (unitário/componente): colar `123 456`, `123-456` e `123456` produz `123456`; letras são descartadas; mais de 6 dígitos são cortados; botão desabilitado ou erro local com menos de 6; o campo tem `inputMode="numeric"`, `autoComplete="one-time-code"` e o mesmo rótulo acessível de antes.
- [ ] e2e do Playwright (desktop e celular, claro e escuro) passa com o novo corpo `{ email, password, code }` e com o caso de colar com separadores; os testes de acessibilidade existentes seguem verdes sem ajuste de rótulo.
- [ ] `typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes no CI do GitHub Actions (decisão do dono de 2026-11-03: os testes só rodam lá; o agente não os executa localmente, então a spec exige testes determinísticos e sem espera fixa).

## Casos de borda e erros

- **Reenvio por SMTP que falha:** `clearVerification` (já existe) apaga o hash e o contador; o reenvio imediato fica liberado, como hoje.
- **Duas abas verificando ao mesmo tempo com o código certo:** uma confirma, a outra recebe a 401 uniforme (a conta já está confirmada).
- **Esgotou o código e a conta nunca é confirmada:** a conta não confirmada fica no banco como hoje; o expurgo de contas não confirmadas continua pendência da spec seguinte.
- **Atacante que esgota o código da vítima:** ele precisa do e-mail e da senha que **ele** definiu no cadastro, então consegue queimar o código que a vítima recebeu antes de ela digitar (negação de serviço de baixo custo). A vítima responde pedindo reenvio ou se cadastrando de novo (que assume a senha, regra da 017) e respeita o intervalo de 60 s. Risco aceito (ver Riscos).
- **Relógio:** vencimento e intervalo usam o `now` do serviço (injetável); no banco, o instante vem do parâmetro, como hoje.

## Isolamento entre clientes

Não se aplica: `Account` é global, sem `ClientId`, e esta spec não toca model de tenant nem a seleção de empresa. A migration não altera `MODEL_SCOPES`.

## Decisões para o dono

1. **Limite de tentativas erradas por código: 5 (recomendado).** Alternativas: 3 (mais seguro, pior para quem erra de digitação) ou 10 (dobra a chance de acerto por dia). Ao estourar, o código morre e é preciso reenviar (intervalo de 60 s).
2. **Validade: 15 min (recomendado)**, em vez de 30. Menos tempo para adivinhar e para um e-mail antigo servir; 15 min cobre folga de entrega. Alternativa: manter 30.
3. **Formato inválido não conta como tentativa (recomendado)**, só aceita exatamente 6 dígitos (400). Alternativa: contar tudo (permite a terceiro esgotar o código com lixo sem sequer saber a senha? não, precisa da senha; ganho de segurança nulo).
4. **Nome do campo do corpo: `code` (recomendado)**, em vez de manter `token` (que passa a mentir). Quebra o contrato da API; sem clientes além do próprio frontend, nesta mesma spec. Alternativa: manter `token` por compatibilidade.
5. **Chave do HMAC e mensagem:** chave derivada do `JWT_SECRET` (sem variável nova) e mensagem com o **e-mail normalizado** (recomendado, mantém o INSERT atômico). Alternativa: id da conta (exige duas etapas no registro). Rotacionar o `JWT_SECRET` invalida os códigos pendentes (aceitável: expiram em 15 min).
6. **Códigos pendentes antigos são invalidados** pela migration (recomendado; produto não lançado). Alternativa: deixar expirar sozinhos (30 min máximo) sem migration de dados; o código antigo de qualquer forma deixa de conferir por causa do HMAC.
7. **Reenvio depois de esgotar:** com o código morto o vencimento é `NULL`, o que **libera o reenvio na hora**, sem os 60 s, e isso abre uma brecha (esgotar e reenviar sem esperar, 5 tentativas por ciclo e o intervalo só limita o envio). **Recomendação:** guardar o instante do último envio para o intervalo de 60 s valer sempre, sem depender do vencimento: coluna `verification_sent_at TIMESTAMPTZ` na mesma migration, gravada em registro/reenvio e **não** apagada pelo esgotamento. O pedido do dono (60 s também após esgotar) exige isso; sem a coluna o `retryBefore` atual não segura. Alternativa mais simples: ao esgotar, manter `verification_expires_at` e só apagar o hash (código morto, vencimento intacto): o intervalo continua pelo vencimento atual e não precisa de coluna nova; o custo é o reenvio ficar bloqueado até 60 s depois do envio original (que já passou na maioria dos casos). **Recomendo a alternativa simples** (apagar só o hash, manter o vencimento), e a spec adota isso nos critérios acima: ajustar o UPDATE de falha para `verification_hash = CASE ... NULL ...` sem tocar `verification_expires_at`, e o teste "esgotou, reenvio antes de 60 s do envio é ignorado e depois libera".
8. **Teto diário de tentativas por conta: sim, 25 erros por 24 h (recomendado).** Ver Riscos. Alternativa: aceitar o risco residual (~0,7%/dia).

## Riscos

- **Risco residual do desenho básico:** 1.000.000 de combinações, 5 tentativas por código e um código novo a cada 60 s dão no máximo 1.440 códigos x 5 = **7.200 tentativas/dia por e-mail**, cada uma com chance de 1/1.000.000 (o código muda a cada reenvio): cerca de **0,7% de chance por dia** de o atacante acertar em algum momento, por e-mail visado, de graça e em série (e o atacante pode fazer isso contra muitos e-mails). Para uma confirmação de e-mail que decide quem controla a conta, 0,7%/dia é alto.
- **Recomendação (decisão 8): teto diário.** Contador cumulativo por conta, `verification_failures_day` e `verification_failures_since` (colunas novas na mesma migration), que **não zera** com reenvio, só ao confirmar ou quando passam 24 h. Com 25 erros na janela, `resend`/`register` não emitem código novo (respondem igual, sem enviar) e o vigente morre, até a janela acabar. Isso limita o ataque a 25 tentativas por dia por e-mail (~0,0025%/dia, ~0,9% por ano contínuo) e não depende de IP. Custo: o mesmo atacante consegue **bloquear a confirmação de um e-mail por até 24 h** (negação de serviço, já possível em menor grau pela sobreposição de cadastro; o dono real ainda tem a saída de esperar a janela). Se o dono preferir menos complexidade, aceitar o risco residual com 5 tentativas e 60 s fica registrado como risco aceito (como o do bloqueio de login na 017); a implementação do teto não exige spec nova, apenas as duas colunas, um `WHERE`/`CASE` a mais no UPDATE de falha e no `refreshVerification`.
- **Negação de serviço por esgotar o código** de uma vítima (ver Casos de borda): custo baixo para o atacante, saída para a vítima é reenviar ou refazer o cadastro. Aceito.
- **Vazamento só do banco:** com HMAC o atacante precisaria do `JWT_SECRET` para reverter 6 dígitos; vazamento do banco e do `JWT_SECRET` juntos permite reverter, mas aí o atacante já assina tokens.
- **Entropia menor também em fluxos futuros:** a recuperação de senha (spec seguinte) **não** deve reutilizar código de 6 dígitos sem o mesmo conjunto de proteções (contador, teto diário, HMAC).
- **Quebra de contrato** `token` -> `code`: sem consumidores além do frontend; frontend e backend precisam subir juntos.

## Fora de escopo

- Recuperação de senha de conta confirmada (spec seguinte; não herda o código de 6 dígitos sem as proteções acima).
- CAPTCHA ou prova de trabalho no cadastro.
- Limite por IP+e-mail ou por e-mail no cadastro (o `register` segue só com o perfil `login` por IP e o intervalo de 60 s da conta).
- Envio de e-mail por provedor de API (SMTP da 019 permanece).
- Expurgo de contas não confirmadas; login por link mágico; confirmação por link no e-mail.
- E-mail em HTML ou traduções; mudar a política de senha de 6 caracteres do cadastro (risco aceito da 017).
- Reabrir o bloqueio por conta de 5 falhas de **senha** (continua como está).

## Decisões e dependências novas

- Nenhuma dependência nova (`node:crypto` basta).
- Migration nova e aditiva (`verification_attempts`; com a decisão 8, também as colunas do teto diário; com a decisão 7 na variante recomendada, nenhuma coluna a mais).
- Atualizar na implementação: seção "Contas globais (spec 017)" em `AGENTS.md` (código de 6 dígitos, 5 tentativas, 15 min, HMAC), `.env.example` (nada muda), `docs/context.md` (histórico de decisões) e `docs/handoff.md`. A atualização desses arquivos é feita por quem implementar, depois da aprovação.
- Arquivos a tocar: `account.service.ts`, `account.repository.ts` (domínio e Prisma), `schema.prisma` e migration, `account.controller.ts`, `smtp-verification-mailer.ts`, porta `VerificationMailer`, `metrics.ts`, `AccountApp.tsx`, `frontend/e2e/accounts.spec.ts` e os testes correspondentes.

## Registro da implementação

- **Branch real:** `spec/020-codigo-6-digitos` (a linha "Branch" acima traz o nome planejado). Implementada por Claude Code (Sonnet 5.5) em 2026-11-03.
- **Validação (importante):** por decisão do dono (2026-11-03) **os testes não foram executados localmente**; só rodaram `typecheck`, `lint` e `format:check` (da raiz, Node 24.18.0) e `pnpm db:generate`. Todos os testes abaixo foram escritos e relidos, mas **dependem do CI do GitHub Actions** para ficarem verdes; por isso nenhum critério de aceite acima foi marcado `[x]`. A migration **não foi aplicada** em banco algum (o CI aplica com `db:migrate:deploy`).
- **Código:** `application/auth/verification-code.ts` (geração com `randomInt`, chave e HMAC), `account.service.ts` (TTL 15 min, `verify` devolve resultado ao observador `onVerificationAttempt`), `account.repository.ts` (domínio: constantes `VERIFICATION_MAX_ATTEMPTS=5`, `VERIFICATION_DAILY_FAILURE_CAP=25`, janela de 24 h e `VerifyOutcome`; Prisma: `verify` em dois UPDATEs atômicos de SQL cru, `registerUnverified` e `refreshVerification` com `now` para o teto diário), `schema.prisma`, migration `20261103150000_account_verification_attempts`, `account.controller.ts` (`verificationSchema` estrito com `code`), mailer, porta `VerificationMailer` (parâmetro `code`), `metrics.ts` (`account_verification_attempts_total{result}`), `index.ts` (observador: métrica e log só com id e resultado), `AccountApp.tsx` e os novos `verification-code.ts` e `verification-field.tsx` no frontend.
- **Decisões aplicadas:** 1 (5 erros), 2 (15 min), 3 (formato inválido é 400, sem contar), 4 (`code`), 5 (e-mail normalizado na mensagem do HMAC; chave derivada de `loginSecret`, que em produção já é derivado do `JWT_SECRET`, com rótulo `soprei:account-verification:v1`), 6 (migration zera hash e vencimento das não confirmadas), 7 (variante simples: o 5º erro apaga só o hash e mantém o vencimento) e 8 (teto de 25 erros em 24 h).
- **Desvio 1 (necessário pela decisão 7):** o CHECK `account_verification_pair` da 017 (hash e vencimento nulos juntos) impediria manter o vencimento com o hash apagado. A migration nova o troca por `account_verification_expiry` (`hash IS NULL OR vencimento IS NOT NULL`), sem editar a migration da 017. Também há o CHECK `account_verification_counters_check` (contadores não negativos).
- **Desvio 2 (desenho do teto diário, que a spec deixa em aberto):** a janela de 24 h abre no primeiro erro (`verification_failures_since`) e o contador `verification_failures_day` zera lazy: no primeiro erro depois de a janela passar ele recomeça em 1, e ao confirmar volta a 0. O UPDATE de falha também mata o código vigente no 25º erro (mesmo com poucos erros nele). `registerUnverified` e `refreshVerification` não emitem código quando a janela está aberta com 25 ou mais erros; o `refreshVerification` passou de `updateMany` para SQL cru para expressar a condição.
- **Desvio 3:** o contrato da porta do repositório ganhou o parâmetro `now` em `registerUnverified` e `refreshVerification` (a janela do teto sai do relógio injetável), e `verify` devolve `VerifyOutcome` em vez de `boolean`.
- **Desvio 4 (frontend):** o aviso informativo depois do cadastro ("cole o código abaixo") foi substituído por um parágrafo fixo na tela de confirmação ("Confira seu e-mail e digite o código de 6 dígitos."), para valer também ao abrir `/confirmar-email` direto. Com menos de 6 dígitos o botão continua habilitado e mostra o erro local `Digite os 6 dígitos do código` sem chamar a API (a alternativa que a spec permite).
- **Testes escritos (não executados):** unitários `verification-code.test.ts`, `account.service.test.ts` (repositório em memória `test-support/in-memory-account.repository.ts`, relógio injetável, sem sleep), contrato compartilhado `test-support/account-repository-contract.ts` (roda em memória e no Postgres), `account.controller.test.ts` (schema e rota), mailer, métrica; integração `database/account-verification.integration.test.ts` (contrato no Postgres, 50 erros simultâneos, 20 erros e 1 certa em 7 rodadas, certo depois do 5º erro, teto diário sob concorrência), `database/account-migration.integration.test.ts` (migration da 020 em schema temporário com rollback), `http/accounts-verification.integration.test.ts` (fluxo completo, métrica e log sem segredo) e os dois testes de contas existentes adaptados para `code`; frontend `verification-code.test.ts`, `verification-field.test.tsx` e o e2e `accounts.spec.ts` (`123456`, colar `123 456` e `123-456`, corpo `{ email, password, code }`).
- **Pendências:** CI verde (inclui o e2e do Playwright); revisão de segurança; aplicar a migration no banco de desenvolvimento do dono (`pnpm db:migrate:deploy`) depois do merge; frontend e backend precisam subir juntos (o campo mudou de `token` para `code`).
