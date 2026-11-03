# 017 — Conta da pessoa e empresas dentro da conta

- **Status:** aprovada pelo dono em 2026-11-03; em implementação
- **Branch:** `spec/017-contas-e-empresas`
- **Depende de:** 007, 008 e 016; preserva o isolamento das specs 010, 011 e 015

## Objetivo

Permitir cadastro e login apenas com e-mail e senha. Depois de entrar, a pessoa poderá criar empresas e acessá-las dentro da própria conta, conforme decisão do dono em 2026-11-03.

Esta mudança substitui o rascunho anterior da 017 (login com `clientSlug` e consulta de conversas). O painel de conversas será uma fatia posterior. Autenticação, endpoint público, autorização e migração passam pelo `reviewer` antes do merge.

## Comportamento esperado

### Experiência decidida pelo dono

1. “Criar conta” pede somente e-mail e senha. Nenhuma empresa, slug, documento ou telefone é exigido nessa etapa.
   A tela pede confirmação da senha e oferece controles para mostrar e ocultar os dois campos. Por decisão do dono em 2026-11-03, a senha do cadastro público tem mínimo de 6 caracteres, uma letra maiúscula e um número, após normalização NFKC; confirmação divergente impede o envio. A política legada de 12 caracteres não muda.
2. Login pede somente e-mail e senha, mesmo que a pessoa participe de várias empresas.
3. A área autenticada lista exclusivamente as empresas às quais a conta tem acesso. Sem empresas, oferece “Criar empresa”.
4. A própria pessoa pode criar empresas e será `OWNER` de cada uma. Nome e dados da empresa são informados depois do cadastro da conta; identificadores técnicos são gerados pelo servidor e não são credenciais de login.
5. A pessoa seleciona a empresa em que quer trabalhar. Pode ser `OWNER` em A e `VIEWER` em B; empresa pode ter várias pessoas. Conversas, canal, auditoria e permissões permanecem separados por empresa.
6. Frontend segue a identidade da 016; cadastro, login, lista/criação/seleção de empresas, saída e erros são a experiência alvo. O detalhamento pode ser dividido nas fatias descritas em “Decisões”.

### Desenho adotado após autorização de implementação

- Separar **conta global** (e-mail normalizado único, hash scrypt e estado) de **participação em empresa** (`accountId`, `clientId`, papel e estado do vínculo). Preferir evoluir o `User` atual para vínculo, preservando seus ids e as FKs compostas da auditoria. Conta global terá repositório restrito à identidade; consultas de negócio continuam exigindo `ClientId`.
- Conta desativada perde acesso a todas as empresas; vínculo desativado perde acesso apenas à respectiva empresa. Empresa suspensa segue as regras existentes. `PlatformAdmin` continua identidade separada, nunca concedida pelo cadastro público.
- Criar empresa e vínculo `OWNER` para a conta autenticada na mesma transação. Falha não deixa empresa sem dono; `ownerId` enviado no corpo não determina a titularidade.
- Administrador de empresa não define nem redefine senha global de outra pessoa. Os contratos atuais de criação/reset com senha devem ser adaptados à gestão de vínculos, sem permitir assumir contas em outras empresas. Não associar vínculo apenas por e-mail não confirmado.
- Recomenda-se separar sessão da conta, sem privilégios de tenant, da credencial da empresa selecionada. O servidor valida vínculo ativo para selecionar/renovar; conhecer um `clientId` não concede acesso. Revogação precisa impedir uso de credenciais antigas conforme contrato final.
- Troca de empresa limpa caches e ignora respostas tardias. Senhas, tokens, códigos, contatos e conteúdo de conversas não entram em logs ou métricas.

### Contratos (detalhados ao final desta spec)

`POST /auth/login` passa a receber `{ email, password }`, sem `clientSlug`. Ainda precisam ser definidos endpoints/schemas de cadastro, confirmação de titularidade, identidade global, listagem/criação/seleção de empresas, renovação/logout e gestão de vínculos. Nenhum contrato implícito autoriza implementação.

O desenho final deve especificar armazenamento/transporte da sessão no navegador, claims/tipos de identidade, chaves Redis de conta versus tenant, rotação/reuso e escopo de revogação, hooks, CLI, auditoria, códigos de erro e limites antiabuso. Tokens apenas em memória, propostos no rascunho anterior, não foram aprovados.

## Critérios de aceite

- [x] Cadastro e login usam apenas e-mail/senha; conta sem vínculo entra e recebe lista vazia, sem privilégios de tenant.
- [x] E-mail normalizado é único entre contas, inclusive em cadastros concorrentes; hash/política de senha continuam atrás das portas existentes e segredos não aparecem em logs ou métricas.
- [x] Criação de empresa e vínculo `OWNER` é atômica. Uma conta cria e seleciona duas empresas; falha desfaz ambos os registros.
- [x] Papéis de A e B são independentes. Conta sem vínculo com C não lista, seleciona ou acessa dados de C, mesmo conhecendo ids.
- [x] Sessão sem tenant é recusada pelas rotas de negócio; conta/vínculo desativado, empresa suspensa e credenciais anteriores são tratados conforme os contratos aprovados.
- [x] Administrador de A não altera senha/estado global ou vínculo de B da mesma conta. Último `OWNER`, hierarquia e auditoria continuam protegidos sob concorrência.
- [x] Testes de navegador cobrem cadastro, login, conta sem empresa, criação, seleção/troca, logout, respostas tardias e teclado em telas estreitas/largas; dados de A não aparecem ao trocar para B.
- [x] Migração preserva ids/relações da auditoria e dados de negócio; teste cobre e-mails únicos, colisões e vínculos desativados, sem fusão automática ou escolha arbitrária de senha.
- [x] Sessões antigas são recusadas de forma controlada; CLI, exemplos de ambiente, documentação e testes refletem os novos contratos.
- [x] Os contratos finais de titularidade, antiabuso, renovação/revogação e falhas têm testes automatizados. Validação completa passa nas duas versões de Node exigidas.

- [ ] Revisão independente de segurança registrada antes do merge.

## Casos de borda e erros

- Mesmo e-mail em usuários atuais de clientes distintos pode ter senhas diferentes. Não escolher um hash arbitrário nem conceder todos os vínculos apenas porque os e-mails coincidem.
- Cadastro com e-mail de conta **já confirmada** devolve o mesmo 202, não envia nada, não troca a senha nem concede vínculos. Cadastro com e-mail de conta **ainda não confirmada** (revisão, I-1) permite ao dono real do e-mail assumir: substitui o hash da senha pela informada e envia código novo (o anterior deixa de valer), no máximo uma vez por 60 s por conta (o intervalo sai de `verification_expires_at` menos os 30 min de validade, sem coluna nova); sem o código enviado ao e-mail ninguém confirma, e a conta não entra antes de confirmar. Conta registrada por terceiro não pode apropriar-se de vínculo existente (vínculo só passa a valer após confirmação do e-mail).
- Limitações restantes (aceitas, pendência da spec seguinte): não há recuperação de senha de conta **confirmada** nem expurgo de contas não confirmadas; quem conhece o e-mail de uma conta não confirmada pode, a cada 60 s, trocar a senha dela e disparar um e-mail à caixa do dono (incômodo, sem tomada da conta); o bloqueio por e-mail (5 falhas em 15 min) não considera o IP.
- **Senha de 6 caracteres (risco aceito pelo dono, revisão I-3):** com a política do cadastro público (mínimo 6, uma maiúscula, um número) e o bloqueio por conta de 5 falhas em 15 min sem o IP, um atacante tem cerca de 480 tentativas por dia por e-mail. Pendências: lista de senhas comuns recusadas no cadastro e contador por IP + e-mail.
- Falha do Redis mantém autenticação fail-closed. Revogação parcial não pode preservar permissões de vínculo removido.
- Nome de empresa inválido e concorrência têm erros controlados. Limites de criação por conta/IP devem ser aprovados antes de expor os endpoints.

## Isolamento entre clientes

Conta global autentica a pessoa, mas não concede acesso automático a empresa alguma. Operações de negócio continuam com `ClientId` de credencial validada e vínculo autorizado pelo servidor. Manter barreiras de repositório, Prisma, FKs compostas e ESLint; classificar models novos em `MODEL_SCOPES`. O repositório global de identidade não deve virar porta genérica para dados de tenants.

Testes com duas contas e três empresas cobrem adulteração de ids, seleção de empresa alheia, tokens antigos, promoção indevida e troca de empresa no navegador. Todo teste de fluxo captura logs e prova ausência de dados secretos.

## Fora de escopo

- Painel de conversas, tempo real, edição de persona e telas do canal/Embedded Signup.
- SSO/login social, cobrança, planos e fusão/transferência de empresas.
- Troca da stack ou alteração do papel de `PlatformAdmin`.
- Deploy e dados reais antes de retenção/LGPD, RLS e recuperação de mensagens pendentes.

## Decisões e dependências novas

**Decidido pelo dono em 2026-11-03:** cadastro/login apenas por e-mail e senha; empresas dentro da conta; pessoa pode criar empresas e será dona delas.

**Propostas iniciais, substituídas pelo detalhamento aprovado abaixo:**

1. **Identidade/vínculos:** recomenda-se conta global nova e `User` evoluindo para vínculo, preservando ids da auditoria. Alternativa: model novo para vínculo e migração de todas as FKs. Detalhar schema após escolha.
2. **Titularidade/cadastro público:** recomenda-se confirmar e-mail antes de criar empresa ou receber vínculo, com código de uso único, prazo e limites. Provedor de e-mail ainda não escolhido. Alternativa de desenvolvimento: confirmação operacional pelo dono, sem abertura pública. Não associar contas legadas por e-mail não comprovado.
3. **Migração:** recomenda-se relatório prévio de colisões e resolução explícita aprovada pelo dono; nenhuma fusão automática. Invalidar sessões antigas com versão de identidade. Não recriar bancos nem reescrever migrations existentes.
4. **Sessão:** escolher persistência por cookie HttpOnly e sessão server-side (com CSRF, origem e concorrência detalhados) ou tokens em memória e novo login ao recarregar. Decisão ainda aberta; nenhuma nova dependência está aprovada.
5. **Divisão:** a mudança atravessa identidade, sessão, gestão de usuários e frontend. Recomenda-se detalhar primeiro fundação/migração na 017 e reservar as telas/onboarding completo à próxima fatia se não couber em um PR revisável. Não publicar estado intermediário inseguro.

### Detalhamento aprovado para implementação (2026-11-03)

O dono autorizou implementar e escolheu sessão persistente com cookie HttpOnly e envio real pelo Gmail. As recomendações de conta global, preservação dos ids de vínculo e bloqueio de colisões na migration são adotadas. Sem fusão automática e sem aplicação no banco de desenvolvimento pelo agente.

- Conta global em `Account`; `User.accountId` liga o vínculo preservado. A migration aborta caso existam e-mails repetidos; registros únicos mantêm seu hash e exigem confirmação de e-mail. As colunas legadas de credenciais ficam preservadas nesta migration aditiva, mas não autenticam contas globais.
- Cookie `soprei_session`: segredo aleatório de 256 bits, HttpOnly, SameSite Strict, Path `/`, Secure em produção; o Redis guarda chave derivada por SHA-256 e sessão sem segredos. Inatividade 7 dias e teto absoluto 30 dias, validade conferida pelo Redis. Login sempre emite segredo novo, e logout o revoga. Não há refresh token no navegador.
- `APP_ORIGIN` fixa a origem do frontend. Mutações exigem `Origin` exatamente igual e header `X-Soprei-Client: web`; sem CORS aberto, sem credenciais em URL. GETs autenticados não alteram permissões. Todas as respostas de identidade usam `no-store`.
- `POST /auth/register` `{email,password}`: 202 genérico, conta existente nunca troca senha nem recebe novo vínculo. `POST /auth/resend-verification` exige as mesmas credenciais; `POST /auth/verify-email` exige `{email,password,token}` e consome confirmação de uso único. Token de 256 bits tem apenas hash no banco e validade de 30 minutos; reenvio invalida o anterior. Falha do SMTP não confirma conta e pode ser recuperada pelo reenvio autenticado.
- `POST /auth/login` `{email,password}`: cookie e 204 após confirmação. `GET /auth/session`: identidade global e empresa selecionada; `POST /auth/logout`: revoga e limpa cookie. Listagem/criação/seleção: `GET/POST /account/companies`, `POST /account/companies/:clientId/select`. Criação recebe apenas `{name}` (1–200 caracteres); id/slug gerados pelo servidor, vínculo `OWNER` e auditoria na mesma transação.
- Cookie sem seleção não concede identidade de tenant. A cada consulta privada, conta e vínculo selecionado são relidos do banco antes de preencher `UserIdentity`; empresa suspensa/removida ou vínculo desativado impede o acesso. Seleção é compartilhada entre abas; URLs com o tenant anterior recebem a recusa existente.
- Rotas públicas de cadastro/login/confirmação usam perfil `login` (fail-closed), e demais rotas de conta perfil `admin`. Credenciais têm também bloqueio por e-mail com HMAC e limites existentes da 007. Gestão por empresa não redefine senha global; criação/reset legado por empresa fica indisponível neste fluxo até existir convite aprovado.
- Gmail SMTP TLS em `smtp.gmail.com:465`, com `GMAIL_USER` e `GMAIL_APP_PASSWORD` somente no ambiente do servidor. `nodemailer` é a dependência de envio (sem logs SMTP); testes usam transporte falso/local e nunca chamam Gmail real. Referências: [Google — senha de app](https://support.google.com/accounts/answer/185833), [Nodemailer — Gmail](https://nodemailer.com/usage/using-gmail/). O dono configura a verificação em duas etapas e senha de app, quando disponível para sua conta.
- `ACCOUNTS_ENABLED` liga os contratos novos; requer origem e credenciais Gmail explícitas. Sem configuração o modo novo não sobe, em vez de fingir envio de e-mail. Exemplos e instruções devem refletir essa configuração. Frontend usa proxy `/api` para mesma origem; sem tokens em armazenamento persistente.

## Registro da implementação

- Conta global `Account` e vínculo `User.accountId`, preservando os ids e FKs da auditoria. Migration aplicada somente em `soprei_test`; nunca no banco de desenvolvimento. Preflight testado com tabelas temporárias e rollback, sem criar/remover banco nem role.
- Cookie opaco dura no máximo 30 dias no navegador. O Redis limita a 7 dias de inatividade e 30 dias absolutos; só login/logout emitem/limpam cookie, para uma consulta atrasada não sobrescrever credenciais posteriores. Chaves de sessão global usam hash do segredo, sob namespace próprio; login de conta usa contador HMAC sem e-mail em chave/log. Essa é a nova exceção global às chaves por tenant.
- Papéis e estado do vínculo são relidos a cada requisição de negócio. Gestão de usuário por empresa conserva papéis/auditoria, mas não cria contas nem altera senha global. CLI legada recusa criação/reset de tenant no modo novo; reset de operador da plataforma permanece separado.
- Limite inicial de 20 empresas por conta, serializado por bloqueio da conta na transação, contando também vínculos de empresas removidas/suspensas. Não há limite por plano ou cobrança nesta fatia.
- Gmail via `nodemailer` e tipos de desenvolvimento; Zod no frontend valida respostas; Playwright verifica desktop/mobile com API falsa local. Navegação usa URLs e History API nativos: não foi adicionada biblioteca de roteamento para essas poucas telas. As dependências novas aceitam Node >=20 e preservam a faixa >=22 do projeto.
- Fluxo de confirmação exige e-mail, senha e token de uso único; reenvio exige as credenciais. Tokens não aparecem em links ou logs. Testes de envio injetam transporte falso, e nenhum e-mail real foi enviado pelo agente.
- Testes de integração cobrem cookie, confirmação/reuso/expiração, duplicata sem trocar senha, falha de e-mail com recuperação, empresas/papéis independentes, perda de acesso e revogação; logs capturados. Testes de navegador cobrem cadastro/login, recarga, empresas, teclado e resposta atrasada após logout.
- A LTS mais recente confirmada em 2026-11-03 é a [Node 26](https://nodejs.org/en/about/previous-releases); validação final usa Node 22.23.2 e 26.13.0. O executável da 26 foi baixado separadamente do site oficial e teve SHA-256 conferido; a versão instalada/selecionada do usuário não foi trocada.
- Correção aditiva da migração: um vínculo legado desativado continua desativado na empresa; a conta global permanece ativa e precisa confirmar e-mail. A correção só atua no backfill intocado, preservando alterações globais posteriores. A migration inicial aplicada não foi reescrita.
- `Cache-Control: no-store` cobre as rotas de conta e as rotas privadas no modo novo. Logout por refresh do operador da plataforma continua separado do logout por cookie e usa perfil de rate limit `refresh` (fail-closed).
- As suítes completas passaram em Node 22.23.2 e 26.13.0: 998 testes unitários de backend, 2 de frontend e 341 de integração. As suítes novas e de navegador passaram em cinco repetições em cada versão; a correção aditiva da migração também passou em cinco repetições em ambos. Typecheck, lint, format:check, build e smoke do compilado verdes. A limpeza recursiva de build foi bloqueada pela revisão automática: compilação fresca foi verificada em diretórios novos sob `backend/dist/`, preservando os anteriores. Configuração e teste de envio real Gmail são do dono. Revisão de segurança ainda pendente em sessão separada.

### Correções da revisão de segurança (2026-11-03, Claude Code)

- **I-1:** `AccountRepository.registerUnverified` é um único `INSERT ... ON CONFLICT (email) DO UPDATE ... WHERE email_verified_at IS NULL AND status = 'ACTIVE' AND (verification_expires_at IS NULL OR verification_expires_at <= agora + 30 min - 60 s) RETURNING id`: atômico, sem corrida, devolve id só quando algo foi gravado (e, portanto, um código sai). `refreshVerification` aplica o mesmo intervalo ao reenvio autenticado (pedido antecipado responde igual e não envia); `clearVerification` descarta o código cujo envio falhou, liberando novo cadastro/reenvio na hora. Testes: `accounts-registration.integration.test.ts` (atacante cadastra, vítima assume, código/senha antigos morrem, confirmada não muda, reenvio, rajada de 6 cadastros = 1 código).
- **I-2:** `register` responde 202 depois de gravar e envia em segundo plano (`AccountService.deliver`, sem promessa solta: erro capturado, observador só com id e resultado). Sem 503 por SMTP no cadastro (o reenvio autenticado continua 503 se falhar, pois quem pede conhece a senha). `drain()` é chamado no `onClose` do Fastify (até 10 s), então o desligamento espera os envios. Métrica `account_verification_sends_total{result}` (`sent`/`failed`) e log só com `accountId`. 202 idêntico (status, corpo, cabeçalhos) nos três casos, testado; o trabalho de banco é uma instrução em todos os casos e o hash de senha é pago antes.
- **I-3:** documentado acima como risco aceito.
- **S-1:** `/auth/logout` limpa o cookie só depois de revogar; Redis fora = 503 e cookie mantido; o frontend só sai da tela quando o servidor confirma e, se falhar, mostra "Saída não confirmada" e deixa tentar de novo (teste de navegador novo).
- **S-3:** `Secure` também quando `APP_ORIGIN` começa com `https:` (`cookieIsSecure`). O prefixo `__Host-` **não** foi adotado: exigiria `Secure` em HTTP local (Safari e proxies de desenvolvimento recusam); fica para a configuração de produção.
- **S-6:** a migration `20261103140000` (só existe nesta branch e não foi aplicada em desenvolvimento) passou a comparar e fazer o insert com `lower(email)`; teste com colisão só de caixa. Editada no lugar, com aval do dono; o `soprei_test` já a tinha aplicada com a versão anterior (o `migrate deploy` não confere checksum; se algum dia aparecer drift lá, é só essa edição).
- **S-9 (parcial):** testes de POST sem Origin com cookie = 403 (inclui rota de tenant) e Redis das sessões fora = 503 (`/auth/session` e rota de tenant); o 404 de `:clientId` divergente com cookie já estava coberto.
- **Pendências registradas, não feitas:** S-2, S-4, S-5, S-7, S-8 da revisão (ficam para a spec seguinte; ver `docs/context.md`), recuperação de senha de conta confirmada, expurgo de contas não confirmadas, lista de senhas comuns e contador por IP + e-mail, prefixo `__Host-`.
