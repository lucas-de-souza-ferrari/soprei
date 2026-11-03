# 019 — Envio de e-mail por SMTP genérico

- **Status:** concluída e mergeada (2026-11-03; CI verde em Node 22 e LTS); aprovada (2026-11-03, dono: "Aprovo tudo", com as 8 recomendações)
- **Branch:** `spec/019-smtp-generico`
- **Depende de:** 017 (contas e e-mail de confirmação). Passa pelo `reviewer` antes do merge (segredos, transporte e config de produção).

## Objetivo

Hoje o e-mail de confirmação de conta só sai por Gmail (`smtp.gmail.com:465` fixo no código, `GMAIL_USER` e `GMAIL_APP_PASSWORD` obrigatórios com `ACCOUNTS_ENABLED=true`). Isso impede testar localmente com um servidor SMTP de desenvolvimento (Mailpit/MailHog, sem autenticação nem TLS) e prende o produto a um provedor. A spec troca o envio por um SMTP genérico configurável por `EMAIL_PROVIDER_*`, sem mudar a porta `VerificationMailer` nem o fluxo da 017.

## Código lido (estado atual)

- `backend/src/infrastructure/external-apis/gmail/gmail-verification-mailer.ts`: `GmailVerificationMailer(user, password, transport?)`; `nodemailer.createTransport` com host/porta/`secure` fixos, timeouts de 5/5/10 s, `logger: false`; `from` = o próprio usuário; qualquer falha vira `ServiceUnavailableError` com mensagem fixa e sem `cause`. Teste ao lado com transporte falso.
- `backend/src/infrastructure/config/env.schema.ts`: `GMAIL_USER` e `GMAIL_APP_PASSWORD` (`optionalSecret`, vazio = ausente, linha ~57); no `superRefine`, com `ACCOUNTS_ENABLED=true` exige `APP_ORIGIN`, `GMAIL_USER`, `GMAIL_APP_PASSWORD` e valida o `GMAIL_USER` como e-mail (linhas ~185-194).
- `backend/src/index.ts` (~linha 232) monta o mailer só quando as contas estão ligadas; import na ~300.
- `backend/src/infrastructure/logger/logger.ts` (linhas ~21-22) redige `GMAIL_USER` e `GMAIL_APP_PASSWORD`.
- `backend/.env.example` (linhas ~188-190) documenta as duas variáveis. Porta: `VerificationMailer.sendVerification(email, token)` em `application/ports/account-session.ts`.
- `nodemailer` já é dependência (nenhuma dependência nova nesta spec).

## Decisões (recomendação; o dono confirma antes da implementação)

1. **Remover `GMAIL_USER`/`GMAIL_APP_PASSWORD`, sem retrocompatibilidade.** Recomendado: o produto não foi lançado e o dono é o único usuário; manter duas famílias de variáveis dobra a validação e as regras de segredo. Quem quiser Gmail usa o SMTP genérico: `EMAIL_PROVIDER_HOST=smtp.gmail.com`, `PORT=465`, `SECURE=true`, `USER`/`PSWD` (senha de app). Alternativa: aceitar as antigas como _fallback_ (mais código, dois caminhos para testar). Efeito: quem tem `ACCOUNTS_ENABLED=true` com Gmail precisa renomear as variáveis no `backend/.env` ao atualizar (registrar no handoff).
2. **Autenticação opcional, tudo ou nada.** `EMAIL_PROVIDER_USER` e `EMAIL_PROVIDER_PSWD` vazios (vazio vale como ausente) = sem `auth` no transporte (Mailpit). Um preenchido sem o outro: erro de config nomeando as duas variáveis.
3. **TLS.** `SECURE=true`: TLS implícito (tipicamente 465). `SECURE=false`: STARTTLS (587) ou texto puro local.
   - `NODE_ENV=production`: exige TLS. Ou `SECURE=true`, ou `SECURE=false` com `requireTLS: true` (o envio falha se o servidor não oferecer STARTTLS). Texto puro nunca é usado em produção, nem em loopback: o transporte sempre leva `requireTLS: true` quando `SECURE=false`.
   - Fora de produção: `SECURE=false` **só aceita texto puro (STARTTLS oportunista) se o host for loopback** (`localhost`, `127.0.0.0/8`, `::1`); host não loopback com `SECURE=false` usa `requireTLS: true` em todos os ambientes.
   - Autenticação nunca trafega sem TLS fora de loopback (consequência das regras acima). Em loopback sem TLS, o `auth` só vai se o dono configurar USER/PSWD (aceito: é a própria máquina).
   - Certificado do servidor sempre verificado (`tls.rejectUnauthorized` padrão); sem opção para desligar. Servidor de desenvolvimento com certificado autoassinado usa texto puro em loopback.
4. **Remetente.** `EMAIL_PROVIDER_FROM` obrigatório, validado como e-mail (`z.email()`), sem nome de exibição nem quebra de linha. O mailer envia `from: { name: 'Soprei', address: FROM }` (nome fixo em código; sem variável nova). Alternativa: variável `EMAIL_PROVIDER_FROM_NAME`; não recomendada (mais uma superfície sem necessidade).
5. **Validação no módulo de config (Zod).** `EMAIL_PROVIDER_HOST`: hostname ou IP, sem esquema, caminho, porta, espaço nem `@` (nada de URL); `EMAIL_PROVIDER_PORT`: inteiro 1 a 65535 (`z.coerce.number()`, **sem padrão**: o dono declara); `EMAIL_PROVIDER_SECURE`: `true`/`false` literais (`booleanLiteral`, padrão `false`); `USER`/`PSWD`: `optionalSecret`. Com `ACCOUNTS_ENABLED=true` passam a ser obrigatórias `APP_ORIGIN`, `EMAIL_PROVIDER_HOST`, `EMAIL_PROVIDER_PORT` e `EMAIL_PROVIDER_FROM`. Com `ACCOUNTS_ENABLED=false` as variáveis são ignoradas (não validadas além do formato quando presentes).
6. **Privacidade.** `EMAIL_PROVIDER_USER` e `EMAIL_PROVIDER_PSWD` entram no `redact` do logger (no lugar das do Gmail); nunca em log, erro nem métrica. Host e porta também não vão a log de falha de envio. O erro de envio segue `ServiceUnavailableError` com mensagem fixa, sem `cause`, sem host, usuário, destinatário nem resposta do servidor. O transporte mantém `logger: false` e `debug: false`.
7. **Nome e documentação.** `GmailVerificationMailer` vira `SmtpVerificationMailer` em `backend/src/infrastructure/external-apis/email/smtp-verification-mailer.ts` (a pasta `gmail/` some; nomes de arquivo `smtp-verification-mailer.ts`). `.env.example`, `AGENTS.md` (parágrafo de contas globais) e `docs/handoff.md` atualizados. `.env.example` documenta o Mailpit nativo no Windows: baixar o binário do Mailpit (releases oficiais), executar `mailpit` (SMTP em `127.0.0.1:1025`, interface em `http://127.0.0.1:8025`), com os valores de desenvolvimento abaixo. **O agente não instala nem executa o Mailpit.**
8. **Timeouts** (5/5/10 s) e o corpo do e-mail da 017 não mudam.

Valores de desenvolvimento (Mailpit), para o `.env.example` e o `backend/.env` do dono (que o agente não toca):

```
EMAIL_PROVIDER_HOST=127.0.0.1
EMAIL_PROVIDER_PORT=1025
EMAIL_PROVIDER_SECURE=false
EMAIL_PROVIDER_FROM=noreply@ledware.com.br
EMAIL_PROVIDER_USER=
EMAIL_PROVIDER_PSWD=
```

## Comportamento esperado

- Com `ACCOUNTS_ENABLED=true` e as variáveis acima, o cadastro envia o código de confirmação por SMTP ao servidor configurado; a mensagem chega no Mailpit, com remetente `Soprei <noreply@ledware.com.br>`, assunto e texto atuais.
- Sem `USER`/`PSWD`, o transporte não faz `AUTH`. Com os dois, faz `AUTH` (desde que as regras de TLS valham).
- A `SmtpVerificationMailer` recebe um objeto de opções tipado já validado (`host`, `port`, `secure`, `requireTLS`, `from`, `auth?`) e, opcionalmente, um transporte injetável (testes). A decisão `requireTLS` é calculada em função pura no módulo de config (`NODE_ENV`, `secure`, loopback), testável sem rede.
- Contrato de config: as variáveis `EMAIL_PROVIDER_*` acima; `GMAIL_*` deixam de existir (se ainda estiverem no ambiente, são ignoradas, como foi com a `ADMIN_API_KEY`).

## Critérios de aceite

- [x] Config: com `ACCOUNTS_ENABLED=true`, a ausência de cada uma entre `EMAIL_PROVIDER_HOST`, `EMAIL_PROVIDER_PORT`, `EMAIL_PROVIDER_FROM` e `APP_ORIGIN` falha com mensagem nomeando só a variável (sem valor). Com `ACCOUNTS_ENABLED=false` nenhuma é exigida.
- [x] Config rejeita: host com esquema (`smtp://x`), com `/`, porta, espaço ou `@`; porta 0, 65536, não inteira ou ausente; `SECURE` diferente de `true`/`false`; `FROM` que não é e-mail ou contém quebra de linha.
- [x] Config: `USER` preenchido sem `PSWD` (e o inverso) falha; ambos vazios ou ambos preenchidos passam; vazio vale como ausente.
- [x] Config em `NODE_ENV=production`: `SECURE=false` resulta em `requireTLS: true`; `SECURE=true` passa; texto puro nunca é produzido em produção (teste da função pura nas três combinações, inclusive host loopback).
- [x] Fora de produção: `SECURE=false` com host `127.0.0.1`, `::1` e `localhost` resulta em STARTTLS oportunista (`requireTLS: false`); com host não loopback (ex.: `mail.example.test`) resulta em `requireTLS: true`.
- [x] `SmtpVerificationMailer` com transporte falso: `from` é `{ name: 'Soprei', address: <FROM> }`, `to`, `subject` e `text` (código em linha separada, como hoje); `auth` só é passada ao `createTransport` quando há `USER`/`PSWD` (teste sobre a função que monta as opções do transporte, sem abrir conexão).
- [x] Falha de envio: `ServiceUnavailableError`, mensagem fixa, `cause` indefinido, sem host, usuário, senha, destinatário nem texto do erro original (erro do transporte falso carregando todos esses valores).
- [x] Teste de captura de log (`src/test-support/log-capture.ts`) com `EMAIL_PROVIDER_USER` e `EMAIL_PROVIDER_PSWD` sentinelas: um cadastro cujo envio falha e outro que dá certo, mais um log do objeto de config, não deixam aparecer a senha nem o usuário em nenhum log; o `redact` do logger cobre as duas chaves e não cobre mais `GMAIL_*`.
- [x] Um servidor SMTP falso em `node:net` (porta 0, loopback, mínimo: saudação, `EHLO`, `MAIL`, `RCPT`, `DATA`, `QUIT`, sem `STARTTLS` anunciado) recebe uma mensagem pelo transporte real do `nodemailer` em texto puro, sem `AUTH`, e o teste confere remetente, destinatário e presença do código. Um segundo caso com `USER`/`PSWD` prova que o `AUTH` é enviado em loopback sem TLS. Sem dependência nova, sem rede externa, nenhum e-mail real; termina sem processo órfão. (Se ficar frágil, o dono aceita cortar este item e ficar só com a função pura: ver Riscos.)
- [x] Nenhuma referência a `GMAIL_USER`, `GMAIL_APP_PASSWORD` ou `GmailVerificationMailer` resta em `backend/src`, `.env.example` e `AGENTS.md` (varredura por `grep` no teste de config ou verificação manual do reviewer registrada).
- [x] `index.ts` monta o `SmtpVerificationMailer` com as opções da config, e o smoke do compilado com `ACCOUNTS_ENABLED=true` e valores de loopback sobe (sem enviar).
- [x] Testes existentes de conta (017) continuam verdes sem servidor SMTP: eles usam mailer falso.
- [x] `pnpm typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes em Node 22 e na LTS mais recente; suítes novas repetidas 5 vezes.

## Casos de borda e erros

- **Servidor SMTP fora do ar ou lento:** igual hoje (timeouts do transporte, `ServiceUnavailableError`, o envio é em segundo plano e o cadastro responde o mesmo 202; métrica `account_verification_sends_total{result="failed"}` e `warn` só com `accountId`).
- **`SECURE=true` na porta 587 ou `SECURE=false` na 465** (confusão comum): o envio falha com o erro genérico; a spec não adivinha a combinação (ver Riscos).
- **STARTTLS exigido e não oferecido:** falha genérica; nada é enviado em texto puro.
- **Config inválida:** o boot loga as chaves com problema (nunca valores) e encerra com código 1, como hoje.
- **`FROM` com nome ou `<>`:** rejeitado; o nome "Soprei" é fixo em código.
- **Variáveis antigas `GMAIL_*` presentes:** ignoradas, sem aviso (decisão 1).

## Isolamento entre clientes

Não se aplica: o envio é de conta global (spec 017), não lê nem grava dado de tenant.

## Fora de escopo

- Provedores por API HTTP (SES, SendGrid, Resend...) e OAuth2 de Gmail.
- Fila, retentativa ou _outbox_ de e-mail (o envio segue em segundo plano, sem retentativa).
- E-mail de recuperação de senha, convites, expurgo de não confirmadas (specs seguintes da 017) e templates HTML.
- Várias contas/remetentes por cliente; DKIM/SPF/DMARC (configuração do domínio do dono).
- Pool de conexões SMTP, DSN, rastreio de entrega e _bounces_.
- Opção para aceitar certificado inválido.
- Instalar ou executar Mailpit pelo agente; mexer em `backend/.env`.

## Riscos

- **Quebra de config:** quem usa Gmail precisa renomear variáveis (mitigação: nota no handoff e no `.env.example`; o produto não foi lançado).
- **Texto puro em loopback:** correto para desenvolvimento; um `HOST=127.0.0.1` em produção atrás de um _relay_ local sem TLS é recusado de propósito (produção sempre exige TLS; um relay local deve oferecer STARTTLS).
- **Detecção de loopback por nome:** `localhost` pode resolver para outro endereço em máquina mal configurada; a spec trata só `localhost`, `127.0.0.0/8` e `::1` como loopback, e nomes DNS arbitrários nunca.
- **Teste com servidor SMTP falso em `node:net`:** pode ser frágil (protocolo e timing); se atrapalhar, cortar o critério e manter a função pura mais o transporte falso.
- **Porta e `SECURE` incoerentes** não são detectadas; erro genérico por privacidade dificulta o diagnóstico (o dono usa o Mailpit/log do servidor SMTP).

## Decisões e dependências novas

Nenhuma dependência nova (`nodemailer` já existe). Decisões 1 a 8 acima aguardam confirmação do dono; ao confirmar, registrar em `docs/context.md` (Histórico de decisões).

## Registro da implementação

- **Código:** `backend/src/infrastructure/external-apis/email/smtp-verification-mailer.ts` (`SmtpVerificationMailer`, `buildTransportOptions`, tipo `SmtpMailerOptions`; a pasta `gmail/` foi removida) e `backend/src/infrastructure/config/email.ts` (`isValidSmtpHost`, `isLoopbackHost`, `smtpRequireTls`, `smtpMailerOptions`, funções puras). `env.schema.ts` ganhou `EMAIL_PROVIDER_*` e as regras do `superRefine`; `logger.ts` redige `EMAIL_PROVIDER_USER`/`PSWD`; `index.ts` monta o mailer; `.env.example`, `AGENTS.md` e `README.md` atualizados.
- **Testes:** `config/email.test.ts` (config, TLS, redact e varredura de referências antigas), `email/smtp-verification-mailer.test.ts` (transporte falso, `auth`, erro fixo, captura de log com sentinelas) e `email/smtp-wire.test.ts` (servidor SMTP falso em `node:net`, porta 0, loopback: texto puro sem AUTH, AUTH em loopback sem TLS e STARTTLS exigido e não oferecido). Repetidos 5 vezes.
- **Decisões de detalhe:** `requireTLS` só é passado ao `nodemailer` com `secure=false` (com TLS implícito é ignorado); porta sem padrão; USER/PSWD só são conferidos "tudo ou nada" com `ACCOUNTS_ENABLED=true`; host aceita hostname ou IP puro (IPv6 sem colchetes).
- **Desvios:** nenhum. O critério do `grep` ficou como teste (`email.test.ts`) sobre `backend/src`; `.env.example` e `AGENTS.md` conferidos por busca manual.
- **Passo do dono:** renomear no `backend/.env` as variáveis do Gmail para `EMAIL_PROVIDER_*` (valores do Mailpit na spec ou `.env.example`).
- **Validação local (decisão do dono, 2026-11-03):** os testes locais foram dispensados para agilizar; a verificação das suítes fica no GitHub Actions. Antes dessa decisão, em Node 22.23.2 rodaram verdes: 1044 unitários de backend + 2 de frontend e 342 de integração, e as 3 suítes novas (8 + 36 testes) passaram 5 vezes em Node 24.18.0. Não houve bateria completa em Node 24, nem repetição em Node 22, nem smoke do compilado: dependem do CI. Os critérios acima marcados `[x]` têm teste escrito; os de "Node 22 e LTS", repetição e smoke do `index.ts` compilado não foram executados localmente e dependem do CI.
