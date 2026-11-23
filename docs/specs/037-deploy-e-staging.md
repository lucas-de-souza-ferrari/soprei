# 037 — Deploy com rollback e staging

- **Status:** concluída (E1 e E3 em produção; a E2, staging, está escrita e o servidor ainda não foi montado pelo dono; status normalizado em 2026-11-23, spec 042). Antes: **E1 e E2: aprovadas** pelo dono em 2026-11-11 (D1 a D12 como recomendadas) **e implementadas** (E1 em produção desde 2026-11-12, três deploys reais; a E2 está escrita, mas o servidor de staging ainda não existe). **E3: aprovada pelo dono em 2026-11-12 ("Aprovo todas": D9, D10 opção A, D11, D13 a D17 como recomendadas)** (D9 alterada a pedido do dono: deploy automático depois do merge na `main`; D10 e D11 reescritas; D13 a D17 novas). **E3 implementada, revisada, mergeada e em produção em 2026-11-12**: servidor e GitHub configurados pelo dono e primeiro deploy automático concluído (`53f06f2 -> 4234312`). Falta só o critério manual de desligar e religar.
- **Branch:** `spec/037-deploy-e-staging` (E1 e E2, já mergeadas); a revisão da E3 está em `spec/037-e3-deploy-automatico` (a implementação da E3, depois de aprovada, vai num PR próprio)
- **Depende de:** 033 (esta spec **recorta** dela a E4, deploy, e a D7, staging; o resto continua lá), 036 (`.nvmrc`, versão do Node de PRs e produção), 034 (`SHUTDOWN_TIMEOUT_MS`), 032 (nenhum dado real vai ao staging enquanto ela não existir).
- **Observação de numeração:** conferido em `docs/specs/` em 2026-11-11: existem 001 a 034 e 036 em arquivo (a 035 está **reservada** para "eficiência do turno" e não tem arquivo); esta é a **037**.
- **Esta spec passa pelo `reviewer`** antes do merge (acesso ao servidor, chave SSH de deploy, segredos, script que roda com privilégio, isolamento entre staging e produção).
- **Fatos externos e do servidor que não foram lidos na fonte** (sem rede, sem acesso ao servidor) estão marcados **(S#)** e listados em "Suposições a conferir". O que vem do dono (estado do servidor) está marcado como **relatado**.
- **Nada de código de produção foi escrito** para esta spec. Marcação: **[CÓDIGO]** = entra num PR do repositório; **[DONO]** = passo manual no servidor ou em painel de terceiros; **[DOC]** = documento.

## Objetivo

A produção já existe (servidor próprio do dono, montada à mão em 2026-11-11) e hoje cada atualização é uma sequência de comandos digitados (`git pull`, `pnpm install`, `build`, `migrate`, `pm2 reload`) sem checagem, sem volta e sem ensaio: um erro de configuração já deixou o processo em laço de reinício. Esta spec entrega **(1)** um `deploy.sh` versionado, executável com **um comando**, que aplica a versão pedida, espera o sistema responder e **volta sozinho ao código anterior** se não responder; **(2)** um **staging no mesmo servidor**, isolado da produção (banco, Redis, e-mail, segredos), onde a mesma revisão é ensaiada antes de ir à produção; e **(3, E3, pedida pelo dono em 2026-11-12)** o disparo **automático** desse deploy na produção pelo GitHub Actions, depois do merge na `main` e com o CI verde, por uma chave SSH que só consegue pedir "implante este SHA da `main`".

## Estado atual

**Lido no repositório (2026-11-11):**

- **Não existe `deploy/`** nem `ecosystem.config.cjs` no repositório; o arquivo do PM2 mora só no servidor (relatado).
- `backend/prisma.config.ts` faz `import 'dotenv/config'` e lê `DATABASE_URL` por `env('DATABASE_URL')` (lança se faltar); `db:generate` e `db:migrate:deploy` passam por ele.
- `loadConfig` (`backend/src/infrastructure/config/index.ts`) lê o `.env` do **diretório atual** e, se a validação falha, escreve o motivo em `stderr` e sai com **código 1**; `parseConfig` é **pura** (sem efeito colateral) e devolve a lista de variáveis inválidas. Dá para validar o ambiente **sem subir o processo, sem conectar a nada**.
- `SHUTDOWN_TIMEOUT_MS` (spec 034) tem padrão de **60 000 ms**; com o canal ligado precisa ser maior que a espera do worker.
- `smtpRequireTls` (`config/email.ts`): com `NODE_ENV=production` e `EMAIL_PROVIDER_SECURE=false` o envio **exige STARTTLS com certificado verificado**; só fora de produção o loopback aceita texto puro.
- `.nvmrc` = `24`; `packageManager` = `pnpm@12.3.4`; scripts da raiz `build`, `db:generate`, `db:migrate:deploy`; CI em `.github/workflows/ci.yml` e `node-compat.yml` (spec 036). **Não há** `.gitattributes` garantindo fim de linha LF para `*.sh` (conferir, **S1**).

**Relatado pelo dono (não verificável daqui):**

- 1 servidor Hetzner, Ubuntu 26.04 ARM, 4 GB de RAM, 38 GB de disco, usuário `root` (sem usuário dedicado), IPv4 fixo. Site e API no **mesmo hostname** (cookie `SameSite=Strict`): nginx serve `/var/www/soprei/frontend/dist` e faz proxy de `/api/` (removendo o prefixo) e de `/webhooks/` para `127.0.0.1:3001`; HTTPS pelo certbot (renovação automática); DNS na Cloudflare sem proxy; `ufw` com SSH e HTTP/HTTPS.
- Backend: `node dist/index.js` sob **PM2** (`name soprei-api`, `cwd /var/www/soprei/backend` porque o `dotenv` lê o `.env` do diretório atual, `exec_mode fork`, 1 instância, `kill_timeout 40000`, `max_memory_restart 1G`), `pm2-root` no systemd. Clone em `/var/www/soprei` com chave de deploy **somente leitura** (`core.sshCommand`). `.env` em `/var/www/soprei/backend/.env` (modo 600). PostgreSQL 18 e Redis 8 locais e exclusivos do Soprei (Redis com senha, AOF, `noeviction`, banco `/1`). Node 24 (binário oficial em `/usr/local`), pnpm 12.3.4.
- Rotina manual: `git pull`, `pnpm install --frozen-lockfile`, `pnpm db:generate` (**exige `DATABASE_URL` no ambiente**: extrair do `.env` com `grep`/`cut`, **nunca `source`** no `.env`, que tem valores com espaço e caracteres especiais), `pnpm build`, `pnpm db:migrate:deploy` em `backend/`, `pm2 reload soprei-api`. `GET /health` responde `{"status":"ok"}`; `GET /health/ready` checa banco e Redis. Migrations são aditivas **por convenção**; reverter o código **não** reverte migration.

**Atualizado em 2026-11-12 (para a revisão da E3):**

- **Relatado pelo dono:** produção em `https://www.soprei.com`, no mesmo servidor; tudo continua como `root` (PM2 `pm2-root`, código em `/var/www/soprei`). O dono roda `deploy/deploy.sh --env production --allow-unstaged` à mão; **três deploys reais bem-sucedidos** (037, 039 e 032-E1), com a cópia do banco antes da migration e o rollback automático disponível. **O servidor de staging não existe** (a E2 está só escrita): por isso a produção só passa com `--allow-unstaged` (D8). O dono faz push e merge pelo GitHub Desktop.
- **Lido no repositório:** `.github/workflows/ci.yml` (`name: CI`) roda em `pull_request`, em `push` na `main` e por `workflow_call` (o `node-compat.yml` semanal o chama com outras versões do Node); não declara `permissions`; `backend/src/ci-workflow.test.ts` exige que os jobs sejam **exatamente** `static`, `tests` e `browser`. `deploy/deploy.sh`: `--ref` aceita `^[A-Za-z0-9._/-]{1,100}$` e é resolvido, depois do `git fetch --prune --tags origin`, nesta ordem: `refs/remotes/origin/<ref>`, `refs/tags/<ref>`, `<ref>` (um SHA de 40 hexadecimais cai no último); **não confere** se o SHA está na `main` nem se é mais novo que o em execução (aceita voltar para trás). A trava é `flock -n` em `/var/lock/soprei-deploy.lock` (segunda execução sai com 1). A varredura de migrations olha só os `migration.sql` **adicionados** entre o SHA em execução e o alvo; sem a marca `-- breaking-approved:` sai com 1; com a marca exige `--allow-breaking`. O script honra as variáveis `SOPREI_DEPLOY_LOCK_FILE`, `SOPREI_DEPLOY_STATE_DIR`, `SOPREI_DEPLOY_LOG_DIR` e `SOPREI_DEPLOY_TARGETS_DIR` (ganchos de teste): quem chama o script pelo SSH **não pode** poder defini-las. O log de cada linha leva `usuario=<id -un>`.

## O que muda em relação à 033

A 033 foi escrita antes de a produção existir e supunha outro desenho. Para esta spec valem estas correções (a 033 **não é alterada** aqui; quem a retomar deve usá-las):

1. **PM2, não `systemd`:** a 033 (E3) propunha unidade `systemd` com `TimeoutStopSec=45`. A realidade é PM2 com `kill_timeout` de 40 s. E há um descompasso **novo**: desde a 034 o desligamento gracioso pode levar até `SHUTDOWN_TIMEOUT_MS` (**60 s por padrão**), mais que os 40 s do PM2, que então envia `SIGKILL` no meio do desligamento (ver D7).
2. **Build no servidor, não artefato do CI:** a 033 (E4) propunha um `.tar.gz` compilado no CI e copiado por SSH para `releases/<sha>/`. Aqui o build roda **no servidor**, como já é hoje. Motivos: o CI compila em x86 e o servidor é **ARM** (módulos nativos de dependências, **S2**), o desenho é o que o dono já opera, e a revisão é a mesma (mesmo commit e mesmo `pnpm-lock.yaml`). O que se perde (o binário implantado não é byte a byte o que o CI testou) é aceito; o CI verde da mesma revisão continua sendo exigido no E3.
3. **`prisma` em `dependencies`:** a 033 (E1) cogitava mover o `prisma` para `dependencies` para rodar `migrate deploy` no servidor. Como o servidor faz `pnpm install` completo (com `devDependencies`), **não é preciso**.
4. **Segredos:** a 033 (D6) propunha `/etc/soprei/backend.env`. O `.env` fica em `backend/.env` porque o `dotenv` lê do diretório atual; **não mudamos isso**. Vale o resto da D6 (modo 600, nunca no git, cópia no gerenciador de senhas do dono).
5. **Staging sem segundo app da Meta por ora:** a 033 (D7) recomendava um segundo app da Meta. Aqui o staging nasce **com o canal WhatsApp desligado** e o segundo app vira etapa futura opcional (D6).
6. **Verificação de migration:** a 033 (E4) propunha `scripts/check-migrations.mjs` no CI com uma linha-base. Aqui a checagem roda **no momento do deploy**, só sobre as migrations que **entram nesta troca de versão** (não precisa de linha-base). A checagem **no CI**, que barra o PR antes do merge, continua na 033.
7. **`config:check` mínimo vem para cá:** a 033 (E1) o previa com regras extras de produção. Aqui entra só o essencial (validar o `.env` com o mesmo schema, sem conectar e sem imprimir valores), porque é ele que evita o laço de reinício; as regras extras de produção continuam na 033.
8. **Não entram aqui:** `APP_VERSION` e a versão em `/health` (033, E1). Sem elas, o `deploy.sh` confirma que **o processo novo** subiu por outros sinais (ver E1, passo 9); quando a 033 as entregar, a comparação de versão é um acréscimo de uma linha.

## Etapas e ordem recomendada

| Etapa  | O que entrega                                                                                                  | Tipo                    |
| ------ | -------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **E1** | `deploy/deploy.sh`, `deploy/ecosystem.config.cjs`, alvos, `config:check`, testes de texto e de comportamento   | CÓDIGO                  |
| **E2** | Staging no mesmo servidor: nginx, certbot, banco, Redis separado, Mailpit, PM2, `.env`; publicação com o mesmo script | DONO + CÓDIGO (exemplos) |
| **E3** | Deploy **automático** na produção pelo GitHub Actions depois do merge na `main` com o CI verde (D9)            | CÓDIGO + DONO           |

**Ordem:** E1 (feita e em uso) e E2 (escrita; servidor ainda não montado). A E3 **não depende** do servidor de staging se o dono aceitar a D15 como recomendada; se escolher a alternativa da D15, a E3 espera a E2 no servidor.

## Decisões para o dono (recomendação em linguagem simples)

### D1 Como o código fica no servidor

- **Recomendação: continuar como hoje, no mesmo diretório (`/var/www/soprei`)**, com um cuidado: o script compila em pastas de espera (`dist.next`) e só **troca por renomeação** quando tudo deu certo, para que o site e a API não fiquem com arquivos pela metade durante o build. O site passa a ser servido por um atalho (`frontend/dist` vira link para a pasta da versão), o que torna a troca do site **instantânea** e a volta do site também.
- **Alternativa: pastas por versão (`releases/<sha>/`) e um link `current`.** Mais robusta (a versão antiga fica intacta, com as suas dependências, e a volta é trocar o link), mas muda o `cwd` do PM2, o caminho do `.env`, o `root` do nginx e o que o dono já operou. Mais peças para uma instância só. **Não recomendo agora**; dá para migrar depois sem mudar o contrato do script.

### D2 Como é o rollback do código

- **Recomendação: refazer o caminho para trás** (voltar o Git para a versão anterior, reinstalar, regenerar, recompilar, recarregar). É mais lento (de 1 a 3 minutos, **S3**) e **mais certo**: o que roda é exatamente o que foi construído com as dependências daquela versão.
- **Alternativa: guardar a compilação anterior (`dist.prev`) e só recolocá-la** quando `pnpm-lock.yaml` e `prisma/schema.prisma` não mudaram entre as duas versões. Mais rápido (segundos), com mais casos especiais. Fica como otimização futura.
- Em **qualquer** alternativa, **migration não é revertida** (o Prisma não tem "voltar"): a política de compatibilidade abaixo é o que torna o rollback do código seguro.

### D3 Dados do staging

- **Recomendação: o staging nasce vazio e é preenchido pelo próprio sistema** (criar conta pelo cadastro com o e-mail capturado, empresa nova, "Carregar exemplo" da base de conhecimento e da agenda, que já existem). **Nunca se copia dado real de produção**, nem "só um pedaço", **antes de a 032** definir retenção e um jeito de anonimizar.
- **Alternativa (futura, com spec própria):** gerar um dump **sintético** com volume parecido com o de produção, para ensaiar migrations pesadas. Não é preciso com o banco de hoje.

### D4 E-mail do staging (nunca enviar a terceiros)

O staging roda com `NODE_ENV=production` (para exercitar as mesmas regras de configuração) e, nesse modo, **a configuração exige STARTTLS com certificado verificado**: um Mailpit em texto puro **não é aceito**.

- **Recomendação: Mailpit local no próprio servidor**, ouvindo só em `127.0.0.1`, com STARTTLS e um certificado emitido por uma **autoridade privada do dono** (um arquivo `.pem` confiado pelo Node do staging com `NODE_EXTRA_CA_CERTS`, **S4**). Nenhum e-mail sai do servidor; a caixa é lida por túnel SSH (`ssh -L 8025:127.0.0.1:8025`), sem expor a interface. O certificado **continua sendo verificado**: não se desliga nenhuma checagem.
- **Alternativa A:** uma **caixa de teste de terceiros** que captura sem entregar (tipo Mailtrap, **S5**): SMTP real com TLS público, nada a manter, mas e-mails de teste (sintéticos) passam por um terceiro e é mais uma conta.
- **Alternativa B (não recomendada):** staging com `NODE_ENV=development`, para aceitar Mailpit em texto puro; o staging deixa de exercitar as regras de produção (`APP_ORIGIN` HTTPS, cookie `Secure`, `TRUST_PROXY`), que é justamente o que se quer ensaiar.
- **Nunca:** apontar o staging para o SMTP real de produção.

### D5 Quem acessa o staging

- **Recomendação: senha HTTP básica no nginx do staging** (uma credencial do dono, fora do repositório) **e** `X-Robots-Tag: noindex`. O cadastro do staging fica aberto, então sem isso qualquer pessoa na internet poderia criar contas no ambiente de teste. O nginx retira o cabeçalho `Authorization` antes do proxy (**S6**), para a senha básica não chegar à API.
- **Alternativa:** liberar só o IP do dono (`allow`/`deny` no nginx): sem senha, mas quebra quando o IP muda.
- **Alternativa:** staging aberto. **Não recomendado.**

### D6 Segundo app da Meta (WhatsApp no staging)

- **Recomendação: não agora.** O staging roda com `WHATSAPP_ENABLED=false` e a IA `mock`. A Meta permite **um webhook por app**, então ensaiar o canal exige um **segundo app em modo de desenvolvimento**, com webhook, segredos, número de teste e `config_id` próprios, e o domínio do staging nas listas do app (**S7**). Fica como **etapa futura opcional**, com spec própria, quando uma mudança no canal precisar de ensaio fora da produção. Enquanto isso, mudanças do canal são ensaiadas no PC do dono (como hoje) e validadas na produção com o número de teste.
- **Alternativa:** fazer agora. Mais cobertura, mais um app para administrar e proteger.

### D7 `kill_timeout` do PM2 x `SHUTDOWN_TIMEOUT_MS`

- **Recomendação: `kill_timeout` do PM2 em 65 000 ms** (5 s acima do padrão de 60 s do `SHUTDOWN_TIMEOUT_MS`), no `ecosystem.config.cjs` versionado. Assim o PM2 nunca mata o processo no meio de um desligamento que o próprio sistema ainda considera dentro do prazo. Se o `.env` do servidor já define `SHUTDOWN_TIMEOUT_MS` menor, o dono diz o valor e o ecosystem usa esse valor mais 5 s (**S8**).
- **Alternativa:** manter 40 s e baixar `SHUTDOWN_TIMEOUT_MS` para 35 000 no `.env`. Com o canal ligado o boot exige que esse valor seja maior que a espera do worker (`workerCloseTimeoutMs`), então talvez não caiba (**S8**); além disso mexe no comportamento do sistema, enquanto a primeira opção só ajusta o supervisor.

### D8 Promover do staging para a produção

- **Recomendação: a produção só aceita a revisão (SHA) que **já está** no staging**; um deploy de produção com outro SHA é recusado, a não ser que o dono passe `--allow-unstaged` de propósito (hotfix). O script guarda o SHA de cada ambiente num arquivo de estado. Atenção: o merge em **squash** cria um SHA novo na `main`, então o ensaio que vale é o da `main` **depois** do merge (um ensaio da branch do PR é opcional e serve para pegar problema antes do merge).
- **Alternativa:** sem trava (só disciplina). Mais simples e mais fácil de esquecer.

### D9 Fazer a E3 (GitHub Actions) agora? **(alterada em 2026-11-12, aguarda o dono)**

- **Antes (aprovado em 2026-11-11):** adiar a E3 até o script rodar bem à mão por algumas semanas.
- **Agora, a pedido do dono (2026-11-12): fazer a E3.** O script já rodou três vezes em produção sem problema, e o dono quer que o merge na `main` publique sozinho.
- **Recomendação: fazer a E3 agora, com o desenho desta revisão:** a chave que o GitHub guarda **não abre um terminal** no servidor; ela só consegue pedir "implante na produção este SHA, que já está na `main` e é mais novo do que o que está no ar". Todo o resto (o que roda, como volta, o que bloqueia) continua sendo o `deploy.sh` que já funciona.
- **Alternativa:** continuar adiando e seguir rodando o comando à mão (zero superfície nova; o custo é o dono entrar no servidor a cada merge).

### D10 Com que usuário o deploy automático roda **(reescrita em 2026-11-12, aguarda o dono)**

- **Antes (aprovado em 2026-11-11):** criar o usuário `soprei`, dono de `/var/www/soprei*` e do PM2, **antes** de qualquer E3; "nunca com `root`".
- **Fato que pesa:** hoje o processo da API **já roda como `root`** e o dono implanta como `root`. Quem consegue pôr código na `main` **já** consegue, no próximo deploy, rodar código como `root` (o código da aplicação e os scripts de instalação das dependências). O que a E3 acrescenta de risco **novo** é a **chave** guardada no GitHub; esse risco se controla limitando o que a chave pode pedir, não o usuário com que o deploy roda.
- **Recomendação (opção A): usuário de entrada `soprei-deploy` sem nenhum poder próprio, e o deploy continua como `root` pelo `sudo` restrito a um único programa.** A chave entra como `soprei-deploy`; o servidor **força** o programa de entrada (o comando que o GitHub manda é só um texto que ele confere); o programa só aceita `--env production --ref <SHA de 40 hexadecimais>` (e `--dry-run`); se o texto estiver certo, chama `sudo` para **um único programa**, que confere tudo de novo e roda o `deploy.sh` como `root`, com o ambiente limpo. **Nada muda** para o PM2 (`pm2-root`), para `/var/www/soprei`, para o `.env` nem para o deploy manual do dono. Em linguagem simples: quem rouba a chave consegue, no máximo, mandar publicar mais cedo um commit que já está na `main`.
- **Alternativa (opção B): passar a aplicação inteira para o usuário `soprei`** (o D10 original). Muda: `chown -R soprei:soprei /var/www/soprei` (o `.env` continua 600, agora de `soprei`), a chave somente leitura do Git passa para `~soprei/.ssh`, `/var/lib/soprei-deploy`, `/var/log/soprei-deploy` e a trava passam a ser de `soprei`, o PM2 passa a ser o de `soprei` (`pm2 delete soprei-api` no do `root`, `pm2 startup systemd -u soprei --hp /home/soprei`, `pm2 start deploy/ecosystem.config.cjs --only soprei-api`, `pm2 save`; uma janela curta fora do ar na troca), o programa de cópia do banco antes da migration (`pg_dump` como `postgres`) passa a precisar de `sudo -u postgres` restrito a ele, e o deploy manual do dono passa a ser `sudo -u soprei deploy/deploy.sh ...`. Ganho real: um defeito ou ataque **na aplicação** (não só no deploy) deixa de ter `root`. Custo: uma migração de servidor com risco de indisponibilidade e vários pontos para errar. **Recomendo fazer a opção B depois, em etapa própria** (ela é exigida de qualquer forma antes de dado real no staging, pela decisão I4 de 2026-11-11), sem travar a E3.

### D11 Quando a produção publica **(reescrita em 2026-11-12, aguarda o dono)**

- **Antes (aprovado em 2026-11-11, só valia com E3):** produção por tag `v*` criada pelo dono.
- **Recomendação: a cada push na `main` (o merge), depois de o workflow `CI` daquele mesmo commit terminar com sucesso.** É o pedido do dono: o merge passa a ser a decisão de publicar. Se o CI de um commit falha, nada é publicado e o próximo merge com CI verde publica tudo o que se acumulou (o `deploy.sh` só anda para a frente na `main`, ver E3). Merges muito próximos: só o mais recente é publicado (o anterior é "ultrapassado").
- **Alternativa:** publicar só quando o dono cria uma tag `v*` na `main` (o desenho anterior): mais um passo a cada publicação, mas o merge e a publicação viram duas decisões separadas.
- A E1 continua aceitando **qualquer** ref à mão (branch, tag ou SHA), como hoje.

### D12 `config:check` nesta spec

- **Recomendação: sim, o mínimo** (item 7 de "O que muda em relação à 033"): pouco código, evita o erro que já aconteceu. **Alternativa:** deixar para a 033 e aceitar o laço de reinício como sinal de falha (então o rollback passa a ser a única proteção contra `.env` inválido, **com** indisponibilidade).

### D13 Como o deploy espera o CI **(nova, 2026-11-12, aguarda o dono)**

- **Recomendação: um workflow separado, `.github/workflows/deploy.yml`, disparado por `workflow_run` quando o workflow `CI` termina**, e que só segue se o CI terminou com sucesso, veio de um `push` na `main` **deste** repositório (não de PR, não de fork). Motivos: (1) o arquivo que guarda o acesso ao servidor fica separado do `ci.yml`, que roda em **todo PR** e é chamado pelo `node-compat.yml` semanal; (2) o GitHub usa a versão do `deploy.yml` que está na `main`, então um PR que altere o arquivo não muda o que roda antes do merge (**S26**); (3) o `ci.yml` e o teste que o trava (`ci-workflow.test.ts`) não mudam de forma. Cuidado conhecido do `workflow_run`: o filtro `branches: [main]` olha o **nome** da branch de origem, e um PR vindo de um fork cuja branch se chama `main` passaria por ele (**S27**); por isso o `if` confere também `event == 'push'` e o repositório de origem, e o servidor confere de novo que o SHA está na `main`.
- **Alternativa: um job `deploy` dentro do próprio `ci.yml`, com `needs: [static, tests, browser]`** e `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`. Mais simples de ler (o SHA é o `github.sha` do próprio commit e não há o caso do fork), mas mistura o acesso ao servidor no arquivo que roda em todo PR, exige que o job não rode quando o `ci.yml` é chamado pelo `node-compat.yml` e muda o teste que exige exatamente três jobs.

### D14 Aprovação manual no ambiente `production` do GitHub **(nova, 2026-11-12, aguarda o dono)**

- **Recomendação: ambiente `production` sem aprovação manual, mas restrito à branch `main`** (só um job rodando a partir da `main` recebe os segredos dele). Motivo: o pedido é publicar sozinho depois do merge, e hoje só o dono faz merge; uma aprovação a cada merge seria um clique a mais que vira hábito. A barreira real fica no servidor (só SHA da `main`, só para a frente) e na proteção da `main` (PR obrigatório, CI obrigatório).
- **Alternativa: exigir a aprovação do dono no ambiente `production`** (o deploy espera um "Aprovar" no Actions). Protege contra um merge feito por outra pessoa ou por uma credencial roubada do GitHub, ao custo de um clique por publicação. **Pode não estar disponível** para repositório privado no plano atual da conta (**S23**); se não estiver, a alternativa equivalente é a D11 alternativa (tag criada pelo dono, com proteção de tags).

### D15 Staging (D8) enquanto o servidor de staging não existe **(nova, 2026-11-12, aguarda o dono)**

- **Recomendação: o automático publica na produção com `--allow-unstaged` até o staging existir**, e quem decide isso é um **arquivo do servidor** (`/etc/soprei-deploy/entry.conf`, `ALLOW_UNSTAGED=true`), não o GitHub. Quando o staging estiver no ar, o dono troca para `false` e uma mudança pequena da E3 (fora desta revisão) passa a publicar no staging e depois na produção o mesmo SHA. **Risco declarado:** sem ensaio, um defeito que passa no CI e não derruba a saúde (`/health` e `/health/ready` respondem, mas uma tela ou um fluxo quebra) chega à produção sem ninguém olhar antes. É o mesmo risco dos três deploys manuais já feitos, só que agora sem o dono olhar o plano antes; o rollback automático cobre só o que derruba a saúde.
- **Alternativa: o automático só passa a existir depois do staging no servidor (E2 montada)**, publicando staging e produção em sequência. Mais seguro, mas adia a E3 até o dono montar o staging (DNS, certificado, banco, Redis, Mailpit).

### D16 Merge que traz migration **(nova, 2026-11-12, aguarda o dono)**

- **Recomendação: segue normalmente quando a migration é aditiva** (a varredura do `deploy.sh` não acha nada; a cópia do banco antes da migration roda; o rollback do código continua seguro pela política de migration). **Migration marcada como destrutiva nunca roda pelo automático:** o programa de entrada **nunca** passa `--allow-breaking`, então o `deploy.sh` recusa com saída 1 sem mexer em nada, e o dono roda à mão. Lembrete: a varredura é alarme, não prova; o que a pega é a revisão do PR (índice único, `CHECK` novo, `NOT NULL` sem padrão).
- **Alternativa: qualquer migration pausa o automático.** O programa de entrada passa `--no-migrations` (opção nova do `deploy.sh`), que recusa com saída 1 se alguma migration entra; o Actions fica vermelho com a mensagem "há migration: rode à mão" e o dono roda `deploy.sh` no servidor. Mais controle sobre o momento da migration, ao custo de um deploy manual em cada spec com banco (a maioria). O valor fica em `/etc/soprei-deploy/entry.conf` (`MIGRATIONS=auto` ou `manual`), então o dono pode trocar sem PR.

### D17 O que o disparo manual (`workflow_dispatch`) pode fazer **(nova, 2026-11-12, aguarda o dono)**

- **Recomendação: só `--dry-run`.** Serve para o primeiro teste (provar chave, `known_hosts`, usuário, `sudo` e programa de entrada sem mudar nada) e para conferir o plano de um SHA. Publicar à mão continua sendo o comando do dono no servidor, como hoje.
- **Alternativa: o disparo manual também publica de verdade, com aprovação do dono** num segundo ambiente (`production-manual`, com revisor obrigatório, **S23**). Útil para republicar sem entrar no servidor; mais uma porta para proteger.

## E1 — `deploy.sh` com rollback [CÓDIGO]

### Arquivos novos (todos sem segredo)

- `deploy/deploy.sh` (bash; a lógica toda dentro de funções, chamada de `main "$@"` na última linha, para o bash **ler o arquivo inteiro antes de executar**: o script troca o Git no meio da execução e um script lido aos poucos poderia ler pedaços de outra versão).
- `deploy/ecosystem.config.cjs`: os apps `soprei-api` (produção) e `soprei-staging`; `script: dist/index.js`, `exec_mode: fork`, `instances: 1`, `kill_timeout` (D7), `max_memory_restart` (`1G` na produção, ver "Memória" na E2), `cwd` por ambiente (o `dotenv` lê o `.env` do diretório atual), `env` **sem segredo** (nada além de variáveis não sensíveis; os segredos continuam só no `.env`).
- `deploy/targets/production.conf` e `deploy/targets/staging.conf`: pares `CHAVE=valor` versionados, **sem segredo** (diretório da aplicação, caminho do `.env`, nome do app no PM2, porta, URL de saúde, `REQUIRE_STAGED`, `PRE_MIGRATION_BACKUP` opcional, prazos de saúde). Lidos pelo script como texto (`while read`), não por `source`.
- `backend/src/infrastructure/config/check-cli.ts` + script `config:check` (o mínimo do D12): carrega o `.env` do diretório atual, chama `parseConfig`, **sai com 0 e imprime só `ok`**, ou **sai com 1 e imprime só os nomes** das variáveis inválidas (a parte antes de `:` de cada item; **nunca** valor nem a mensagem do Zod). Não abre conexão.
- `.gitattributes` com `*.sh text eol=lf` (se ainda não houver, **S1**).
- `docs/ops/deploy.md` **[DOC]**: uso, códigos de saída, o que fazer em cada falha, a política de migration e como reconhecer uma migration não aditiva. (O runbook completo continua na 033, E9.)

### Uso

```
deploy/deploy.sh --env <production|staging> [--ref <branch|tag|sha>] [--previous]
                 [--dry-run] [--force] [--adopt] [--allow-breaking]
                 [--allow-unstaged] [--inject-health-failure]
```

- `--env` é **obrigatório** (nenhum padrão: não existe "deploy sem querer na produção").
- `--ref` padrão `main`. `--previous` usa o SHA anterior registrado (volta manual).
- `--dry-run`: faz só a leitura (veja abaixo) e imprime o plano; **não altera nada**.
- `--force`: reimplanta o mesmo SHA (sem isso, "já está nessa versão" sai com 0).
- `--adopt`: **primeira execução** num servidor montado à mão: registra o `HEAD` atual como "versão em execução" (o dono confirma). Sem o registro e sem `--adopt`, o script recusa (código 1).
- `--allow-breaking`: ver a política de migration.
- `--allow-unstaged`: só produção (D8).
- `--inject-health-failure`: **só aceito com `--env staging`**; faz a primeira espera de saúde falhar de propósito, para o dono provar o rollback sem estragar nada (código 1 se usado em produção).

### O que o script faz, em ordem

Tudo roda com `set -euo pipefail`, `umask 077`, `LC_ALL=C` e `IFS` controlado. Comandos que escrevem no log passam por um filtro que troca `postgres(ql)://...` e valores de `JWT_SECRET=`, `*_KEY=`, `*_SECRET=`, `*_TOKEN=` e `PSWD=` por `[redacted]` (rede de segurança: o script não imprime segredos por desenho, **nem** executa `set -x`).

1. **Trava única:** `flock` não bloqueante num arquivo de trava **global** (`/var/lock/soprei-deploy.lock`; vale para os dois ambientes juntos, porque compilam no mesmo servidor com 4 GB, **S9**). Segunda execução: sai com código 1 dizendo que há outra em andamento.
2. **Pré-condições (só leitura):** árvore Git **limpa** (`git status --porcelain` vazio; o que está no `.gitignore`, como `dist`, não conta); `HEAD` igual ao SHA registrado como em execução (senão uma execução anterior morreu no meio: o script manda rodar `--ref <SHA registrado> --force`); versão do Node com a mesma major do `.nvmrc`; `pnpm` na versão do `packageManager`; `.env` existe, com modo `600` e legível; espaço livre de pelo menos 2 GB; app presente no PM2 (`pm2 jlist`); saúde **atual** respondendo (se já está fora do ar antes do deploy, o script avisa e segue só com `--force`).
3. **Resolver a versão:** `git fetch --prune --tags origin` (a chave de deploy é só leitura) e `git rev-parse --verify "<ref>^{commit}"`. Registra o SHA **anterior** (o que roda agora) como alvo de volta. Em produção com `REQUIRE_STAGED`, confere D8.
4. **Varredura de migrations** entre o SHA anterior e o alvo (só os arquivos de `backend/prisma/migrations/` que **entram**; a lista dos nomes vai ao log): se algum contém `DROP`, `RENAME`, `SET NOT NULL` ou `ALTER COLUMN ... TYPE`, `TRUNCATE`, `DELETE FROM` ou remoção de valor de enum, **e não** traz a linha `-- breaking-approved: <motivo>`, o script **aborta antes de mexer em qualquer coisa** (código 1). Com a marca, exige também `--allow-breaking`.
5. **Fim do `--dry-run`:** imprime o plano (de qual SHA para qual, migrations que entram e classificação de cada uma, espaço, Node, estado do PM2 e da saúde) e sai com 0. **A partir daqui o script altera o servidor.**
6. **Preparar a versão (o processo atual segue no ar):** `git checkout --detach <sha>` (nada de `git pull`: sem mesclagem), `pnpm install --frozen-lockfile`, `pnpm db:generate` com `DATABASE_URL` **extraída do `.env` por `grep`/`cut`** e exportada só para esse comando (nunca `source`, nunca impressa), e o build em **pastas de espera**: backend em `backend/dist.next` e site em `frontend/releases/<sha>` (o build recebe `--outDir`, **S10**), com `nice` e `NODE_OPTIONS=--max-old-space-size` limitado (o build disputa os 4 GB com a produção). Falha em qualquer passo: **restaura** a árvore (passo "Restaurar", abaixo) e sai com 2; o processo atual nunca foi tocado.
7. **`config:check` no build novo** (`node dist.next/.../check-cli.js`, com o `.env` do ambiente): se o `.env` não vale para a versão nova (variável nova obrigatória faltando, valor fora da regra), **falha aqui**, **antes da migration e antes de derrubar o processo**, listando só os nomes. Nenhuma indisponibilidade. Restaura e sai com 2.
8. **Migration, ainda com a versão antiga no ar:**
   - se há migration pendente e o alvo define `PRE_MIGRATION_BACKUP`, executa-o antes (em produção é recomendado; ver "Backup antes de migration" abaixo, **S11**); falhou, **não migra**;
   - `pnpm db:migrate:deploy` em `backend/`, com prazo (padrão 300 s) e `DATABASE_URL` pelo mesmo caminho do passo 6. Falhou ou estourou: **não troca nada**, restaura a árvore, avisa que **o banco pode ter ficado com migration parcial** (o Prisma registra a migration como falha e o próximo deploy recusa até o dono resolver; o aviso diz como conferir: `pnpm exec prisma migrate status`) e sai com 2.
9. **Trocar e recarregar:** renomeia `backend/dist` para `backend/dist.prev` e `backend/dist.next` para `backend/dist` (o processo em execução já carregou seu código; a pasta anterior fica para diagnóstico); `pm2 startOrReload deploy/ecosystem.config.cjs --only <app>` (**S12**); anota `restart_time` do PM2.
10. **Esperar a saúde (prazo e estabilidade):** consulta `GET /health` e `GET /health/ready` a cada 2 s, com prazo de 90 s. Só dá certo com **5 respostas boas seguidas** (cerca de 10 s) **e** o `restart_time` do PM2 **sem crescer** além do reinício que o próprio deploy causou **e** `status` `online` (**S13**): isso pega o laço de reinício, que um único `200` não pega. `curl` com `--max-time 3`, sem seguir redirecionamento.
11. **Trocar o site:** só depois da saúde, o script move o link `frontend/dist` para `frontend/releases/<sha>` por **renomeação atômica** (`ln -sfn` num link temporário e `mv -T`) e confere que `GET /` do site responde 200 por `127.0.0.1` com o cabeçalho `Host` do ambiente. (Ordem escolhida: API primeiro, site depois; o site é estático e não pode "falhar a subida".) Mantém as 3 últimas `releases` do site e apaga `dist.prev` antiga.
12. **Registrar e encerrar:** grava `current` (alvo) e `previous` (anterior) em `/var/lib/soprei-deploy/<ambiente>/`, uma linha de resumo no log (ambiente, de-para dos SHAs curtos, migrations aplicadas por nome, tempo total e **indisponibilidade medida**: do `reload` até a primeira saúde boa) e sai com 0.

### Falha na saúde: rollback automático

Se o passo 9 ou o 10 falha (ou o passo 11 não consegue confirmar o site), o script executa o **rollback do código**: `git checkout --detach <SHA anterior>`, `pnpm install --frozen-lockfile`, `db:generate`, build em pasta de espera, troca, `startOrReload`, nova espera de saúde (mesmas regras) e **restaura o link do site** para a release anterior. Resultado:

| Situação                                                         | Código de saída | O que o dono vê                                                                                                      |
| ---------------------------------------------------------------- | :-------------: | -------------------------------------------------------------------------------------------------------------------- |
| Deploy concluído                                                 |        0        | resumo                                                                                                               |
| Falhou **antes** de mexer (pré-condição, trava, migration proibida) |        1        | motivo; nada mudou                                                                                                   |
| Falhou **e** a versão anterior voltou (saudável)                 |        2        | `DEPLOY FALHOU; VOLTEI PARA <sha>`; **lista as migrations aplicadas nesta tentativa e que NÃO foram revertidas**    |
| Falhou **e** o rollback também falhou                            |        3        | `INTERVENÇÃO MANUAL`, o estado de cada peça (Git, PM2, banco) e os comandos para conferir; o script **não tenta de novo** |

- **Com `--allow-breaking` não há rollback automático** (o código antigo pode não funcionar sobre o banco já alterado e a saúde, que só toca banco e Redis, poderia mentir). O script para no código 3 e manda **restaurar o backup feito antes da migration** ou corrigir para a frente.
- Sinais: o script ignora `SIGHUP` (queda do SSH não o interrompe; a saída também vai para o log). `SIGINT` e `SIGTERM` **antes** do passo 8 restauram a árvore e saem; **a partir do passo 8** são ignorados até o fim (um deploy não pode parar entre a migration e a saúde).
- Restaurar a árvore (falhas antes da troca): `git checkout --detach <SHA anterior>`, `pnpm install --frozen-lockfile`, `pnpm db:generate`; a compilação em uso nunca foi trocada.

### Log e rastro

`/var/log/soprei-deploy/<ambiente>.log` (modo 600; o dono cria o diretório, **S14**; rotação por `logrotate` fica na 033), uma linha por evento com carimbo UTC, ambiente, evento, SHAs curtos e usuário do sistema. **Não registra** variáveis de ambiente, conteúdo do `.env`, URLs de conexão, e-mails nem dados de empresa ou contato. A saída dos comandos (`pnpm`, `prisma`, `tsc`) vai ao log **depois** do filtro de redação.

### Tempo de indisponibilidade esperado

Com **1 instância em modo fork**, a troca é um reinício: o `pm2 reload` equivale a parar e subir (**S12**), então há uma janela em que o nginx responde 502: o tempo de desligamento (segundos; até `kill_timeout` se houver job ativo) mais o boot (conexão a banco e Redis e o pré-aquecimento do hash de senha), **estimado em 5 a 20 s (S15)**; o script **mede** e registra. A Meta retenta o webhook; os jobs da fila ficam no Redis. Aceito (zero downtime com duas instâncias continua fora de escopo). O site (estático) troca sem janela.

### Backup antes de migration (opção do alvo)

`PRE_MIGRATION_BACKUP` é um comando **opcional** definido no alvo (em produção, um `pg_dump -Fc` como o usuário `postgres` por autenticação local, **sem senha em argumento nem em variável**, arquivo `600`, só as 3 últimas cópias em `/var/backups/soprei-predeploy/`). **É cópia local no mesmo servidor, não é backup** (isso é a 033, E5) e contém dados pessoais: entra na política de retenção da 032. **Recomendação:** usar em produção; no staging, desnecessário.

## Política de migration (como o rollback fica seguro)

- **Regra:** toda migration deve ser **aditiva e compatível com a versão anterior do código** (coluna nova anulável ou com valor padrão, tabela nova, índice novo, valor novo de enum que só o código novo usa). Assim, voltar o código é seguro mesmo com a migration aplicada.
- **Aditiva não é o mesmo que compatível.** Exemplos que parecem aditivos e **quebram** o código antigo: um índice **único** que a escrita antiga viola, um `CHECK` novo que dados gravados pela versão antiga violam, uma coluna `NOT NULL` com padrão que o código antigo sobrescreve com nulo. **O revisor confere a compatibilidade com a versão anterior** em todo PR com migration (item de revisão).
- **Como o dono reconhece uma migration não aditiva:** o `--dry-run` e o deploy **listam os arquivos de migration que entram** e **bloqueiam** (código 1, nada alterado) os que contêm `DROP`, `RENAME`, `SET NOT NULL`, mudança de tipo de coluna, `TRUNCATE`, `DELETE FROM` ou remoção de valor de enum sem a marca `-- breaking-approved: <motivo>`. A varredura é por texto: é um **alarme, não uma prova** (pode haver falso positivo, como um `DROP` de uma coluna criada na mesma migration; falso negativo é possível em SQL incomum).
- **Se uma mudança destrutiva é inevitável:** duas versões em sequência (**expandir**: adicionar o novo e passar o código a usar o novo; **contrair**, numa versão posterior: remover o antigo). Se o dono decide mesmo assim por uma só versão: a marca no arquivo, `--allow-breaking`, o backup antes da migration (recomendado e, em produção, **exigido pelo script**: sem `PRE_MIGRATION_BACKUP` com sucesso, recusa) e **sem rollback automático** (acima).
- **Migration que falha no meio:** o Prisma aplica cada migration numa transação; se falhar, ela fica registrada como falha e o próximo `migrate deploy` recusa até alguém resolver (`prisma migrate resolve`, decisão do dono, caso a caso; fica no `docs/ops/deploy.md`).

## E2 — Staging no mesmo servidor [DONO + CÓDIGO (exemplos versionados)]

O staging é **uma segunda instalação do Soprei** no mesmo servidor, **sem nenhum recurso compartilhado com a produção que possa ser alterado por ela**: diretório, porta, app do PM2, banco e role do PostgreSQL, **instância de Redis**, caixa de e-mail e **todos os segredos** são próprios.

### Peças (nomes de exemplo; o dono pode trocar)

| Peça                  | Produção (hoje)                  | Staging                                                         |
| --------------------- | -------------------------------- | --------------------------------------------------------------- |
| Hostname              | o de produção                    | subdomínio próprio (ex.: `staging.soprei.com`), registro DNS A sem proxy da Cloudflare |
| Diretório             | `/var/www/soprei`                | `/var/www/soprei-staging` (clone próprio, mesma chave de deploy somente leitura, **S16**) |
| Porta da API          | 3001                             | **3002** (`127.0.0.1`; nunca aberta no `ufw`)                   |
| App no PM2            | `soprei-api`                     | `soprei-staging`                                                |
| Banco e role          | `soprei` e role `soprei`         | `soprei_staging` e role `soprei_staging`                        |
| Redis                 | porta 6379, banco `/1`, senha    | **instância própria**, porta **6380**, banco `/0`, senha **diferente** |
| E-mail                | SMTP real                        | Mailpit local (D4)                                              |
| `.env`                | `backend/.env`                   | `/var/www/soprei-staging/backend/.env` (modo 600)               |
| Alvo do script        | `deploy/targets/production.conf` | `deploy/targets/staging.conf`                                   |

### PostgreSQL (mesmo cluster, banco e role próprios) **[DONO]**

- `CREATE ROLE soprei_staging LOGIN PASSWORD '<senha própria>'`; `CREATE DATABASE soprei_staging OWNER soprei_staging`. **Sem `CREATEDB`** (o `migrate deploy` não usa banco sombra). A role dona do banco consegue criar a extensão `btree_gist` (confiável) na primeira migration.
- **Separação dos dois lados:** `REVOKE CONNECT ON DATABASE soprei FROM PUBLIC` e do `soprei_staging`; `REVOKE CONNECT ON DATABASE soprei_staging FROM PUBLIC`, deixando conectar só o `soprei_staging` (**S17**: conferir também o `pg_hba.conf`, que exige senha para conexões locais). Assim, mesmo um `.env` do staging com a URL errada **não consegue** abrir o banco de produção.
- `DB_POOL_MAX` pequeno no staging (5) para não disputar `max_connections` com a produção.

### Redis separado **[DONO]** (exemplo versionado em `deploy/redis/redis-staging.conf.example`)

Segundo processo `redis-server` com **arquivo de configuração, diretório de dados, unidade `systemd` e porta próprios** (a unidade de exemplo em `deploy/redis/redis-staging.service.example`, ou o modelo de instância do pacote da distribuição, **S18**): `bind 127.0.0.1`, `port 6380`, `requirepass` (placeholder no exemplo, valor só no servidor), `appendonly yes`, `appendfsync everysec`, **`maxmemory-policy noeviction`** com `maxmemory` de 256 MB, `dir /var/lib/redis-staging`. **Não basta outro índice** (`/2`) no Redis da produção: um `FLUSHDB` ou uma limpeza de teste no staging jamais pode alcançar a produção, e a senha de um não abre o outro.

### Mailpit (D4) **[DONO]**

Binário ARM64 do Mailpit (**S19**) como serviço `systemd` no staging: SMTP em `127.0.0.1:1025` com STARTTLS e o certificado da autoridade privada do dono (`NODE_EXTRA_CA_CERTS` definido no app do PM2 do staging, apontando para o `.pem` da autoridade; `EMAIL_PROVIDER_HOST=localhost`, o nome que consta do certificado), interface web em `127.0.0.1:8025` (só por túnel SSH) e limite de mensagens guardadas. Exemplo de unidade em `deploy/mailpit/mailpit-staging.service.example`.

### nginx e HTTPS **[DONO]** (exemplo em `deploy/nginx/staging.conf.example`)

`server_name` do staging, certificado pelo certbot (mesmo procedimento da produção), `location /api/` (remove o prefixo) e `location /webhooks/` para `127.0.0.1:3002`, `root` em `/var/www/soprei-staging/frontend/dist`, `auth_basic` (D5) com o arquivo de senhas fora do repositório, `add_header X-Robots-Tag "noindex, nofollow" always` e `proxy_set_header Authorization ""` **nas rotas de proxy** (**S6**). O arquivo equivalente da **produção** também entra em `deploy/nginx/production.conf.example`, **colado pelo dono** sem segredo, para o repositório descrever o que roda (a spec não leu o arquivo do servidor, **S20**).

### `.env` do staging **[DONO]** (lista de nomes em `deploy/env/staging.env.example`, sem valores secretos)

| Variável                                                           | Valor no staging                                                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                         | `production` (mesmas regras de configuração)                                                              |
| `HOST`, `PORT`                                                     | `127.0.0.1`, `3002`                                                                                       |
| `APP_ORIGIN`                                                       | `https://<hostname do staging>` (a origem exata; o cookie e o `Origin` do site valem só para ela)         |
| `TRUST_PROXY`                                                      | `127.0.0.1,::1` (o nginx é o proxy; mesmo valor lógico da produção)                                       |
| `DATABASE_URL`                                                     | role e banco do staging                                                                                   |
| `REDIS_URL`                                                        | porta 6380, senha do staging, `/0`                                                                        |
| `JWT_SECRET`                                                       | **novo e diferente** (um token, código ou convite de um ambiente nunca vale no outro)                     |
| `AUTH_REDIS_PREFIX` e demais prefixos                              | os padrões (a separação é pela instância; o prefixo igual não importa)                                    |
| `ACCOUNTS_ENABLED`, `EMAIL_PROVIDER_*`                             | `true`; Mailpit (D4); `EMAIL_PROVIDER_SECURE=false` com STARTTLS (a regra de `NODE_ENV=production`)       |
| `LLM_PROVIDER`                                                     | **`mock`** (sem chave de IA e sem gasto)                                                                  |
| `WHATSAPP_ENABLED`                                                 | **`false`** (e nenhuma variável `WHATSAPP_*` preenchida)                                                  |
| `BILLING_ENABLED`, `CHECKOUT_ENABLED`, `SCHEDULE_AI_ENABLED`       | **`false`** (sem cobrança, sem checkout, sem IA de agenda; não há `INFINITEPAY_*`)                        |
| `CHANNEL_MANUAL_CONNECT_ENABLED`                                   | ausente (recusado em produção)                                                                            |
| `METRICS_TOKEN`                                                    | próprio                                                                                                   |
| `RATE_LIMIT_ENABLED`, `LOG_LEVEL`                                  | `true`, `info`                                                                                            |
| `DB_POOL_MAX`, `SHUTDOWN_TIMEOUT_MS`                               | `5`; o do D7                                                                                              |

**Nenhuma variável do staging repete um segredo da produção.** O staging não recebe chave da Anthropic, da Meta, da InfinitePay nem SMTP real.

### Dados do staging (D3)

Vazio no início. A conta e a empresa de teste nascem pelo cadastro (o e-mail de confirmação chega ao Mailpit), os dados de exemplo pelos botões "Carregar exemplo" (conhecimento, estoque e agenda). **Proibido** restaurar um `pg_dump` de produção no staging, inteiro ou parcial, enquanto a 032 não definir retenção e anonimização; o `docs/ops/deploy.md` repete a proibição.

### Memória (4 GB): a conta

Estimativas de ordem de grandeza (**S21**: conferir com `free -m` e `pm2 monit` depois de uma semana):

| Consumidor                                               |        Estimativa | Teto configurado                    |
| -------------------------------------------------------- | ----------------: | ----------------------------------- |
| Sistema, nginx, PM2, certbot                             |        350 a 450 MB | -                                   |
| Soprei produção (Node)                                   |     300 a 500 MB (+256 MB nos picos de hash de senha) | `max_memory_restart 1G` (como hoje) |
| Soprei staging (Node)                                    |     250 a 350 MB (+256 MB nos picos) | `max_memory_restart` **700M**       |
| PostgreSQL (um cluster, dois bancos)                     |        300 a 600 MB | -                                   |
| Redis produção + Redis staging                           |          60 a 150 MB | `maxmemory` do staging: 256 MB      |
| Mailpit                                                  |           20 a 50 MB | limite de mensagens                 |
| **Total em uso normal**                                  |    **1,4 a 2,2 GB** |                                     |
| **Pior caso dos tetos** (1 GB + 700 MB + Postgres + resto) |      **cerca de 2,9 GB** | cabe nos 4 GB, sem folga para o build |

- **O build durante o deploy** (`tsc` e o build do site) pode usar de 0,8 a 1,5 GB (**S21**): por isso há **uma só trava global** (nunca dois deploys ao mesmo tempo), o `nice` e o limite de `--max-old-space-size` no script. Conferir se existe **swap** (recomendado 2 GB como rede de segurança, **S22**); se a primeira medição mostrar o servidor perto do teto, **o staging é desligado fora do horário de ensaio** (`pm2 stop soprei-staging`) antes de se pensar em outro servidor.
- O staging tem `max_memory_restart` menor que o da produção de propósito: se algum dos dois for sacrificado por falta de memória, que seja o staging.

### Publicar e promover (o mesmo script)

1. Mergear na `main`. 2. `deploy/deploy.sh --env staging --ref main` (ou uma branch do PR, para ensaiar antes do merge). 3. Conferir no staging (checklist em `docs/ops/deploy.md`: entrar, criar empresa, abrir as abas, ler o e-mail no Mailpit). 4. `deploy/deploy.sh --env production --ref <o mesmo SHA>` (D8). O script mostra, no resumo, os dois SHAs lado a lado.

## E3 — Deploy automático pelo GitHub Actions [CÓDIGO + DONO] (aprovada em 2026-11-12; D9, D10 opção A, D11, D13 a D17 como recomendadas; implementada, ver o Registro)

O texto abaixo segue as recomendações de D10 (opção A), D11 e D13 a D17, aprovadas pelo dono.

### Fluxo

1. O dono faz o merge do PR na `main`.
2. O workflow `CI` (`ci.yml`, inalterado) roda no `push` da `main`.
3. Quando o `CI` termina, o GitHub dispara o `deploy.yml` (`workflow_run`, D13). O job só segue se: `conclusion == 'success'`, `event == 'push'`, `head_branch == 'main'`, `head_repository.full_name == github.repository` **e** a variável do repositório `DEPLOY_ENABLED == 'true'` (o interruptor, ver "Desligar numa emergência"). Senão o job é pulado (cinza, não vermelho).
4. **Ultrapassado?** O job lê, pela API do GitHub, o SHA atual da ponta da `main`. Se não for o `head_sha` do CI que terminou (houve outro merge depois), o job encerra com sucesso e escreve no resumo "ultrapassado por um commit mais novo; ele será publicado quando o CI dele terminar". Isso é só para não gerar ruído; quem **garante** que nada volta para trás é o servidor (passo 6).
5. O job entra por SSH no servidor como `soprei-deploy` e manda o texto `--env production --ref <head_sha>` (40 hexadecimais).
6. No servidor, o programa de entrada confere o texto e chama o `deploy.sh` como `root` com `--env production --ref <sha> --auto` (mais `--allow-unstaged` se `/etc/soprei-deploy/entry.conf` disser, D15). Com `--auto`, o `deploy.sh`, **depois do `git fetch`**, exige que o SHA (a) esteja na `main` (`git merge-base --is-ancestor <sha> refs/remotes/origin/main`) e (b) seja **igual ou mais novo** que a versão em execução registrada (`git merge-base --is-ancestor <atual> <sha>`); igual = "já está nessa versão" (saída 0); fora disso, saída 1 sem mexer em nada. A partir daí é o deploy de sempre (varredura, cópia do banco, migration, troca, saúde, rollback).
7. A saída do `deploy.sh` (já filtrada pela redação do próprio script) aparece no log do job; o código de saída volta pelo `ssh` e vira o resumo do Actions.

### Arquivos novos e alterados [CÓDIGO]

- **`.github/workflows/deploy.yml`** (novo).
- **`deploy/soprei-deploy-entry.sh`** (novo): o programa de entrada, versionado como **modelo** que o dono instala em `/usr/local/sbin/soprei-deploy-entry` (dono `root`, modo 755). O que roda é a cópia instalada, **nunca** o arquivo do repositório: um merge não muda o porteiro. Fica em `deploy/*.sh`, então já passa pelo `shellcheck` do CI.
- **`deploy/deploy.sh`** (alterado): opção `--auto` (abaixo) e, só se o dono escolher a alternativa da D16, `--no-migrations`.
- **`deploy/sudoers/soprei-deploy.example`**, **`deploy/ssh/sshd-soprei-deploy.conf.example`** e **`deploy/entry/entry.conf.example`** (novos, sem segredo): os textos que o dono copia.
- **`.github/workflows/ci.yml`** (alterado só no job `static`): passo `actionlint` (versão fixa, binário baixado com o SHA-256 conferido no próprio passo, **S25**). `backend/src/ci-workflow.test.ts` passa a conhecer o passo.
- **`backend/src/deploy-workflow.test.ts`** (novo, irmão do `ci-workflow.test.ts`): trava gatilhos e permissões do `deploy.yml`.
- **`backend/src/deploy-script.behavior.test.ts`** e **`deploy-scripts.test.ts`** (alterados): cenários de `--auto` e do programa de entrada.
- **`docs/ops/deploy.md`** [DOC]: seção "Deploy automático" (como funciona, como ler o resumo, como desligar, o que fazer em cada código); a linha que diz que o usuário dedicado só seria preciso "se um dia a E3 for feita" é reescrita.

### `deploy.sh --auto` [CÓDIGO]

- Só aceito com `--ref` de **exatamente 40 hexadecimais minúsculos** (nada de branch, tag ou SHA curto).
- **Recusado** junto com `--previous`, `--force`, `--adopt`, `--allow-breaking` e `--inject-health-failure` (saída 1 antes da trava). Aceita `--dry-run`, `--allow-unstaged` e (D16 alternativa) `--no-migrations`.
- Depois do `git fetch`: o SHA precisa estar na `main` e não pode ser mais antigo que o registrado (passo 6 do fluxo). Isso fecha dois buracos de hoje: um SHA de branch de PR (ou de fork, que nem chega ao `fetch` da `main`) e a volta para um commit antigo da `main` (por exemplo, a repetição de uma execução antiga do Actions).
- Com `--auto`, o log registra `modo=auto` na linha de início.
- O deploy manual do dono (sem `--auto`) **não muda**.

### O programa de entrada [CÓDIGO (modelo) + DONO (instalação)]

Um só arquivo, com duas fases:

1. **Fase de fora (roda como `soprei-deploy`, forçada pelo `sshd`):** lê `SSH_ORIGINAL_COMMAND`. Aceita **só** dois textos, comparados por expressão regular ancorada e sem nada além: `--env production --ref <[0-9a-f]{40}>` e `--env production --ref <[0-9a-f]{40}> --dry-run`. Qualquer outra coisa (vazio, argumento a mais, `staging`, SHA curto, maiúsculas, espaço duplo, `;`, `$(`, crase, `|`, `&`, quebra de linha, tamanho acima de 80 caracteres) sai com 64 e uma mensagem fixa, sem ecoar o texto recebido. Aceito, faz `exec sudo -n /usr/local/sbin/soprei-deploy-entry --from-ssh <sha> <deploy|dry-run>`.
2. **Fase de dentro (roda como `root` pelo `sudo`):** confere de novo os dois argumentos (mesma regra, posicional), lê `/etc/soprei-deploy/entry.conf` como texto (sem `source`; `ENABLED`, `ALLOW_UNSTAGED`, `MIGRATIONS`, só `true`/`false`/`auto`/`manual`; dono `root`, modo 600), recusa com 1 se `ENABLED` não for `true`, e faz `exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root LC_ALL=C /var/www/soprei/deploy/deploy.sh --env production --ref <sha> --auto [...]`. O `env -i` garante que os ganchos de teste do `deploy.sh` (`SOPREI_DEPLOY_*`) e qualquer variável vinda do SSH **não chegam** ao script; o `HOME=/root` faz o `pm2` achar o daemon do `root` (**S28**).
- Cada pedido aceito ou recusado vai ao `syslog` (`logger -t soprei-deploy-entry`): resultado e, se aceito, o SHA curto; nunca o texto recusado.
- Os caminhos que o teste precisa trocar ficam em constantes no topo (`readonly SUDO=/usr/bin/sudo`, `readonly DEPLOY=/var/www/soprei/deploy/deploy.sh`, `readonly CONF=/etc/soprei-deploy/entry.conf`): o teste copia o arquivo e troca essas linhas por dublês. **Nenhuma variável de ambiente muda o comportamento** do programa instalado.

### Servidor: usuário, chave e `sudo` [DONO] (D10 opção A)

- **Usuário `soprei-deploy`:** `adduser --system --group --shell /bin/sh --home /home/soprei-deploy soprei-deploy` (sem senha). O shell precisa existir porque o `sshd` roda o comando forçado pelo shell do usuário (**S24**); o acesso interativo é bloqueado pelo comando forçado e pelo `restrict`, não pelo shell. Fora do grupo `sudo`.
- **`~soprei-deploy/.ssh/authorized_keys`** com dono `root` e modo 644 (o próprio usuário não consegue trocar a linha, **S24**), uma linha só:
  `restrict,command="/usr/local/sbin/soprei-deploy-entry" ssh-ed25519 AAAA... soprei-github-deploy`
  O `restrict` desliga encaminhamento de porta, de agente e de X11, terminal (`pty`) e o `~/.ssh/rc` (**S24**). `from=` não é usado (os endereços dos executores do GitHub são muitos e mudam).
- **Defesa em dobro no `sshd`** (`/etc/ssh/sshd_config.d/soprei-deploy.conf`, do exemplo): `Match User soprei-deploy` com `ForceCommand /usr/local/sbin/soprei-deploy-entry`, `AuthenticationMethods publickey`, `PasswordAuthentication no`, `DisableForwarding yes`, `PermitTTY no`. Conferir com `sshd -t` antes de recarregar e **manter uma sessão de `root` aberta** até testar.
- **`/etc/sudoers.d/soprei-deploy`** (do exemplo, editado com `visudo -f`), modo 440: `soprei-deploy ALL=(root) NOPASSWD: /usr/local/sbin/soprei-deploy-entry --from-ssh *`. O `*` aceita qualquer argumento, por isso **a fase de dentro confere tudo de novo**; o `sudo` limpa o ambiente por padrão (`env_reset`, **S29**).
- **`/etc/soprei-deploy/entry.conf`** (root, 600): `ENABLED=true`, `ALLOW_UNSTAGED=true` (D15), `MIGRATIONS=auto` (D16).
- **Chave:** par `ed25519` **só para isto**, sem senha (o Actions não digita), gerado na máquina do dono; a parte pública vai para o `authorized_keys`, a privada **só** para o segredo do GitHub, e a cópia local é apagada.
- **`known_hosts` fixado:** a linha `<host> ssh-ed25519 AAAA...` vem do **próprio servidor** (`/etc/ssh/ssh_host_ed25519_key.pub`, lida numa sessão do dono), nunca de `ssh-keyscan` feito de fora (que confiaria no primeiro que responder).

### `deploy.yml` [CÓDIGO]

- **Gatilhos:** `workflow_run` (`workflows: [CI]`, `types: [completed]`, `branches: [main]`) e `workflow_dispatch` (entrada `sha`, texto obrigatório; D17: sempre `--dry-run`). **Nunca** `pull_request_target`, `pull_request`, `push`, `schedule`, `issue_comment` nem `repository_dispatch`.
- **Permissões:** `permissions: {}` no topo; no job, só `contents: read` (ler a ponta da `main`). _(Revisão da E3: o `actions: read` saiu, não era necessário.)_
- **Job único `deploy`:** `runs-on: ubuntu-latest`, `environment: production` (segredos só dele; restrito à branch `main`, D14), `timeout-minutes: 30` (maior que build + migration de 300 s + saúde de 90 s + rollback), `if:` com as condições do passo 3 do fluxo; no `workflow_dispatch`, `github.ref == 'refs/heads/main'` e `vars.DEPLOY_ENABLED == 'true'`.
- **`concurrency`:** `group: deploy-production-${{ github.event_name }}` (revisão da E3: o dry-run manual tem grupo próprio e nunca tira da fila um deploy real pendente), `cancel-in-progress: false` (um deploy em andamento nunca é cancelado; o GitHub guarda no máximo um pendente e um pendente novo substitui o anterior, **S30**, o que combina com o "só o mais novo"). A trava do `deploy.sh` continua valendo contra um deploy manual simultâneo (o automático sai com 1 e o dono repete depois, ou o próximo merge publica).
- **Sem `actions/checkout` e sem nenhuma ação de terceiros** (`uses:` ausente): o job só precisa de `ssh` e `gh`, que já vêm na imagem (**S31**). Nada do repositório é executado no executor do GitHub.
- **Valores do evento nunca dentro do script:** `head_sha` e a entrada `sha` chegam ao passo por `env:` e são conferidos com `^[0-9a-f]{40}$` antes de qualquer uso (evita injeção pelo `${{ }}`).
- **SSH:** o `ssh` do sistema, chave gravada em `$RUNNER_TEMP` com `umask 077`, `-i <arquivo> -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<arquivo do segredo> -o ServerAliveInterval=30 -T`, usuário e host dos segredos. Um passo final com `if: always()` apaga os dois arquivos. Nada de `set -x`.
- **Segredos (do ambiente `production`):** `DEPLOY_SSH_KEY`, `DEPLOY_SSH_KNOWN_HOSTS`, `DEPLOY_SSH_HOST`; variável do ambiente `DEPLOY_SSH_USER` (`soprei-deploy`). **Nenhum outro segredo** no GitHub: nada do `.env`, nenhuma chave da Meta, da Anthropic, da InfinitePay nem do banco. O GitHub mascara os segredos no log (**S32**); o host fica em segredo também para não aparecer no log.
- **Resumo do Actions** (`$GITHUB_STEP_SUMMARY`): modo (automático ou dry-run), SHA curto, o código e o significado, e a linha `RESUMO:`, `DEPLOY FALHOU` ou `INTERVENÇÃO MANUAL` do `deploy.sh` quando houver:

| Código | No resumo | Job |
| :----: | --------- | --- |
| 0 | publicado (ou "já está nessa versão", ou plano do dry-run) | verde |
| 1 | recusado antes de mexer, nada mudou (trava ocupada, migration destrutiva, SHA fora da `main` ou mais antigo, `ENABLED=false`) | vermelho |
| 2 | falhou e a versão anterior voltou saudável; lista as migrations não revertidas | vermelho |
| 3 | **intervenção manual**: entrar no servidor | vermelho |
| 64 | o programa de entrada recusou o pedido (defeito do workflow) | vermelho |
| 255 | o SSH falhou (rede, chave, `known_hosts`); o deploy **pode não ter começado**: conferir `/var/log/soprei-deploy/production.log` | vermelho |
| outro | inesperado: conferir o log do servidor | vermelho |

- Se o job for cancelado ou o SSH cair no meio, o `deploy.sh` continua no servidor (ignora `SIGHUP` e, desde a revisão da E3, `SIGPIPE`; o filtro e o `tee` também, e o log continua sendo gravado) e o resultado fica só no log do servidor; o resumo diz isso.
- Uma falha deixa o job vermelho; o aviso por e-mail é o padrão do GitHub para quem disparou (**S33**). Alerta próprio fica na 033.

### Riscos da E3 (declarados)

- **Chave vazada:** quem a tem consegue só pedir o dry-run ou o deploy de um SHA que **já está na `main`** e é **mais novo** que o em execução. Não abre terminal, não encaminha porta, não escolhe outro ambiente, não passa `--force`, `--allow-breaking` nem `--previous`, não lê o `.env`. O pior caso é publicar mais cedo um commit que já foi mergeado (alguns segundos fora do ar) ou ocupar a trava. Resposta: apagar a linha do `authorized_keys` e o segredo, gerar outra chave.
- **Quem pode fazer merge (ou push) na `main` controla o servidor como `root`** no próximo deploy (o código da aplicação e os scripts de instalação das dependências rodam como `root` na opção A). Já é assim com o deploy manual; o que muda é que **ninguém olha o plano** antes. Mitigações: proteção da `main` (PR obrigatório, CI obrigatório, sem push direto, sem `--force`), só o dono com permissão de escrita, `CODEOWNERS` em `deploy/` e `.github/` com revisão do dono, 2FA na conta do GitHub. A opção B da D10 reduz o estrago de um defeito da aplicação, não o de um merge malicioso.
- **Fork e PR de terceiros nunca podem disparar:** o `deploy.yml` não tem gatilho de PR; o `workflow_run` de um CI vindo de PR (inclusive de fork com branch chamada `main`, **S27**) é barrado pelo `if` (`event == 'push'` e repositório de origem); o ambiente `production` só entrega segredos à `main`; e o servidor recusa SHA fora da `main`. **`pull_request_target` é proibido** (o teste trava).
- **O executor do GitHub e o próprio GitHub** passam a fazer parte da cadeia: uma conta do GitHub tomada com permissão de administrador pode trocar o workflow e ler os segredos do ambiente; o limite continua sendo o programa de entrada. Por isso a chave não alcança segredo nenhum do servidor.
- **Publicação sem ensaio** (D15) e **sem ninguém olhar o plano**: o rollback automático só cobre o que derruba a saúde.
- **O log do job mostra a saída do `deploy.sh`** (já filtrada): SHAs, nomes de migrations, espaço em disco, versões, caminhos e `usuario=root`. Qualquer pessoa com leitura do repositório vê; aceito (não há segredo nem dado de empresa nessa saída).
- **Migration aditiva incompatível que a varredura não pega** (índice único, `CHECK`, `NOT NULL` sem padrão): sem o dono olhar o plano, ela chega à produção pelo automático; a revisão do PR é a barreira (D16).

### Desligar numa emergência [DONO]

Qualquer um destes basta; do mais rápido ao mais definitivo:

1. **No GitHub:** Settings > Secrets and variables > Actions > Variables: `DEPLOY_ENABLED` = `false` (os próximos jobs são pulados). Ou Actions > "Deploy" > "Disable workflow".
2. **Um deploy em andamento:** **não** cancele no meio da migration; cancelar o job do Actions não para o `deploy.sh` (ele ignora `SIGHUP` e segue até o fim, com rollback se precisar). Acompanhe por `tail -f /var/log/soprei-deploy/production.log`.
3. **No servidor:** `ENABLED=false` em `/etc/soprei-deploy/entry.conf` (todo pedido sai com 1, nada roda).
4. **Cortar o acesso:** apagar a linha do `/home/soprei-deploy/.ssh/authorized_keys`, apagar o segredo `DEPLOY_SSH_KEY` no GitHub e, se a chave vazou, gerar outra. Para tirar tudo: remover também `/etc/sudoers.d/soprei-deploy` e o arquivo do `sshd` (recarregar com `sshd -t && systemctl reload ssh`).

O deploy manual (`deploy/deploy.sh` como `root`) continua funcionando em todos esses casos.

### Passos do dono da E3, em ordem

1. **Aprovar** a E3 (D9, D10, D11, D13 a D17). Implementação em PR próprio, com o `reviewer`.
2. **GitHub, antes do merge do PR da E3:** proteção da `main` (PR obrigatório, checks `static`, `tests` e as fatias de `browser` obrigatórios, sem push direto nem `--force`); conferir que só o dono tem escrita; 2FA ligado; criar o ambiente `production` (Settings > Environments) com "Deployment branches" = só `main` e, se a D14 alternativa, o dono como revisor obrigatório (**S23**); criar a variável **`DEPLOY_ENABLED` = `false`** (o workflow chega à `main` desligado).
3. **Merge do PR da E3 e deploy manual dele** (`deploy/deploy.sh --env production --allow-unstaged`, como hoje): o `deploy.sh` instalado precisa ter o `--auto` antes do primeiro pedido automático (o script que executa é o já instalado).
4. **Chave** (na máquina do dono): `ssh-keygen -t ed25519 -N '' -C soprei-github-deploy -f <arquivo temporário>`. A privada vai **só** para o segredo `DEPLOY_SSH_KEY` do ambiente `production`; a pública vai para o servidor no passo 5; depois, apagar os dois arquivos locais.
5. **Servidor** (como `root`, **com uma segunda sessão de `root` aberta** até o fim, para não se trancar fora):
   1. `adduser --system --group --shell /bin/sh --home /home/soprei-deploy soprei-deploy`.
   2. `install -o root -g root -m 755 /var/www/soprei/deploy/soprei-deploy-entry.sh /usr/local/sbin/soprei-deploy-entry` (do arquivo **já implantado** no passo 3, nunca de uma branch).
   3. `install -d -o root -g root -m 700 /etc/soprei-deploy` e o `entry.conf` a partir de `deploy/entry/entry.conf.example` (`ENABLED=true`, `ALLOW_UNSTAGED=true`, `MIGRATIONS=auto`), `chmod 600`.
   4. `visudo -f /etc/sudoers.d/soprei-deploy` com a linha de `deploy/sudoers/soprei-deploy.example`; `chmod 440`; `visudo -c` sem erro.
   5. `install -d -o root -g root -m 755 /home/soprei-deploy/.ssh` e o `authorized_keys` (dono `root`, modo 644) com a linha `restrict,command="/usr/local/sbin/soprei-deploy-entry" <chave pública>`.
   6. `deploy/ssh/sshd-soprei-deploy.conf.example` em `/etc/ssh/sshd_config.d/soprei-deploy.conf`; `sshd -t` sem erro; `systemctl reload ssh`.
   7. Copiar a linha de `/etc/ssh/ssh_host_ed25519_key.pub` no formato `<host> ssh-ed25519 AAAA...` para o segredo `DEPLOY_SSH_KNOWN_HOSTS`.
6. **Conferir à mão, de outra máquina, com a chave temporária antes de apagá-la** (ou repetir depois pelo Actions): `ssh -T soprei-deploy@<host>` sem comando é recusado (64) sem abrir terminal; `ssh soprei-deploy@<host> 'ls'` e `ssh -L 9000:127.0.0.1:3001 soprei-deploy@<host> ...` são recusados; `ssh soprei-deploy@<host> '--env production --ref <SHA atual da main> --dry-run'` responde "já está nessa versão" (código 0) e o `syslog` mostra o pedido aceito.
7. **Segredos restantes do ambiente `production`:** `DEPLOY_SSH_HOST` (o endereço do servidor) e a variável `DEPLOY_SSH_USER` = `soprei-deploy`.
8. **Primeiro teste pelo Actions, só dry-run:** `DEPLOY_ENABLED` = `true`; Actions > "Deploy" > "Run workflow" na `main`, com o SHA atual da `main`: o resumo mostra o código 0; o log do servidor (`/var/log/soprei-deploy/production.log`) mostra `modo=auto`. **A partir daqui, o próximo merge publica sozinho.**
9. **Primeiro automático:** um PR pequeno (só documentação) mergeado: o CI termina, o deploy roda sozinho e o resumo mostra o código 0. Registrar no "Registro da implementação" da spec (data e resultado, sem segredo nem endereço).

### Alternativa não detalhada: o servidor puxa em vez de o GitHub empurrar

Um temporizador no servidor consulta a `main` (pela chave somente leitura que já existe), espera o CI verde e publica sozinho. Nenhuma chave do servidor fica no GitHub (menos superfície), mas é mais uma peça rodando no servidor, ele precisa de um token de leitura da API do GitHub para saber do CI e o resumo do Actions deixa de existir. Fica registrada caso o dono prefira não abrir o SSH ao GitHub.

## Critérios de aceite

Os itens **[teste]** são automatizados no CI sem servidor; os **[manual]** são do dono no servidor, com o resultado registrado no "Registro da implementação" da spec (data e resultado, sem segredo).

### E1

- [x] **[teste]** `backend/src/deploy-scripts.test.ts` (lê os arquivos como texto, no modelo de `ci-workflow.test.ts`) prova em `deploy/deploy.sh`: usa `set -euo pipefail`; a lógica está dentro de funções e `main "$@"` é a última linha; **não** contém `source` nem `. ` aplicados ao `.env`, nem `eval`, nem `set -x`, nem `cat`/`echo`/`printf` do conteúdo do `.env` ou de `DATABASE_URL`; usa `flock`; ignora `SIGHUP`; a chamada de `db:migrate:deploy` vem **antes** da de `pm2 startOrReload`; existe a função de rollback e ela é chamada na falha da espera de saúde; o rollback não roda com `--allow-breaking`; `--inject-health-failure` é recusado fora de `staging`; `--env` é obrigatório.
- [x] **[teste]** O mesmo teste prova que nenhum arquivo de `deploy/` contém segredo (varredura por padrões como `JWT_SECRET=`, `_KEY=`, `_TOKEN=`, `PSWD=` e `postgres://` seguidos de valor) e que `ecosystem.config.cjs` declara `exec_mode: 'fork'`, `instances: 1`, `kill_timeout` maior ou igual ao `SHUTDOWN_TIMEOUT_MS` padrão (lido de `env.schema.ts`) e `max_memory_restart` por app.
- [x] **[teste]** O mesmo teste prova que `targets/staging.conf` e `targets/production.conf` **não compartilham** porta, nome de app do PM2, caminho de diretório, caminho de `.env` nem URL de saúde, e que o staging não nomeia o banco `soprei` nem a porta 6379.
- [x] **[teste]** _(confirmado pelo CI verde da `main`, 2026-11-12)_ _(passo adicionado ao `static` e conhecido pelo `ci-workflow.test.ts`; **não rodado localmente**, sem a ferramenta; o CI confirma)_ `shellcheck` passa em `deploy/*.sh` (passo novo no job `static` do `ci.yml`; `ci-workflow.test.ts` atualizado para conhecê-lo; ferramenta presente na imagem do runner ou instalada de forma fixa, **S25**).
- [x] **[teste de comportamento]** _(confirmado pelo CI verde da `main` no Ubuntu, 2026-11-12)_ _(escrito; 20 dos 25 cenários verdes no Windows local, 5 pulados com aviso: link simbólico, trava e modo de arquivo; falta o CI Linux)_ `backend/src/deploy-script.behavior.test.ts` executa o `deploy.sh` com `bash` num repositório Git temporário e **dublês** de `pm2`, `pnpm`, `curl` e `node` no `PATH` (o teste é ignorado, com aviso, se não houver `bash` ou `flock`), e prova: (a) deploy bem-sucedido sai com 0 e grava o estado; (b) `--dry-run` sai com 0, não altera `HEAD`, nem o estado, nem chama `pnpm install`; (c) falha de saúde provoca o rollback, restaura o `HEAD` anterior, sai com 2 e lista as migrations não revertidas; (d) falha do rollback sai com 3; (e) migration com `DROP COLUMN` sem a marca bloqueia **antes** de qualquer mudança (saída 1, `HEAD` intacto); (f) `config:check` falho **antes** da migration não deixa migration aplicada nem derruba o processo (o dublê do PM2 não recebe `reload`); (g) segunda execução simultânea sai com 1 (trava); (h) a saída e o log **não contêm** um valor secreto sentinela posto no `.env` falso; (i) `HEAD` diferente do estado registrado recusa; (j) `--env production` com SHA diferente do staging recusa sem `--allow-unstaged`.
- [x] **[teste]** `config:check`: com `.env` válido sai com 0 e imprime só `ok`; com variável inválida ou ausente sai com 1 e imprime **só nomes**, com um valor sentinela inválido que **não** aparece na saída; não abre conexão (o teste roda sem Postgres nem Redis).
- [x] **[manual]** _(2026-11-12: vários deploys reais na produção, com 3,1 a 3,2 s fora do ar)_ Deploy real **na produção** de uma versão nova, com `--dry-run` antes e `--adopt` na primeira vez: `/health` e `/health/ready` voltam, a indisponibilidade medida é registrada e o site novo aparece.
- [x] **[manual]** _(2026-11-12: deploy da 039 aplicou `20261112100000_channel_coexistence` com a versão anterior no ar)_ Deploy **com migration aditiva**: o código anterior segue respondendo durante a migration (a saída lista a migration aplicada).
- [ ] **[manual]** Rollback provado **no staging** com `--inject-health-failure`: o script volta ao SHA anterior, sai com 2 e o staging responde com a versão anterior.
- [ ] **[manual]** Um `.env` do staging com um valor inválido proposital é pego pelo `config:check` **sem derrubar o processo** (indisponibilidade zero).

### E2

- [x] **[teste]** Os exemplos em `deploy/` não contêm segredo; o exemplo do Redis do staging declara porta diferente de 6379, `bind 127.0.0.1`, `appendonly yes`, `maxmemory-policy noeviction` e `requirepass` com marcador (sem valor); `staging.env.example` declara `NODE_ENV=production`, `LLM_PROVIDER=mock`, `WHATSAPP_ENABLED=false`, `BILLING_ENABLED=false`, `CHECKOUT_ENABLED=false`, `SCHEDULE_AI_ENABLED=false` e **nenhuma** variável `INFINITEPAY_*`, `ANTHROPIC_API_KEY` nem `WHATSAPP_*` preenchida; o exemplo do nginx do staging tem `auth_basic`, `X-Robots-Tag` e `proxy_set_header Authorization ""`.
- [x] **[teste]** O `staging.env.example` **passa** em `parseConfig` quando preenchido com valores sintéticos (o teste monta um ambiente completo com segredos descartáveis e chama `parseConfig`: se um nome de variável mudar no schema, o exemplo e o teste quebram juntos).
- [ ] **[manual]** **Isolamento do staging em relação à produção**, cada item registrado: (1) a senha do Redis do staging **não** autentica na porta 6379 e a da produção não autentica na 6380; (2) com a URL do staging, `psql` **não** consegue conectar ao banco `soprei` (negado), e a role da produção não conecta ao `soprei_staging`; (3) `redis-cli -p 6380 FLUSHDB` no staging **não** altera nenhuma chave da produção (contagem de chaves antes e depois); (4) a API do staging escuta só em `127.0.0.1:3002` e a porta não responde de fora do servidor; (5) o `JWT_SECRET` do staging é diferente (um cookie de sessão de um ambiente é recusado no outro); (6) um cadastro no staging entrega o e-mail **só** no Mailpit e **nada** chega ao SMTP real (conferir o painel do provedor de e-mail); (7) sem a senha do nginx o staging responde 401; (8) `NODE_ENV=production`, cookie `Secure; HttpOnly; SameSite=Strict`, `Origin` errado recusado.
- [ ] **[manual]** `deploy/deploy.sh --env staging` e depois `--env production` com o **mesmo SHA**; o deploy de produção com outro SHA é recusado sem `--allow-unstaged`.
- [ ] **[manual]** `free -m` e `pm2 monit` depois de uma semana de uso e de pelo menos 3 deploys, com o **pior pico** registrado e comparado com a tabela de memória (ajustar `max_memory_restart` do staging se preciso).

### E3 (aprovada com as recomendações; a alternativa da D16, `--no-migrations`, não foi escolhida)

- [x] **[teste]** `backend/src/deploy-workflow.test.ts` (lê `.github/workflows/deploy.yml` como texto, no modelo de `ci-workflow.test.ts`) prova: os gatilhos são **só** `workflow_run` (com `workflows: [CI]`, `types: [completed]`, `branches: [main]`) e `workflow_dispatch`; **não** aparecem `pull_request_target`, `pull_request`, `push:`, `schedule`, `issue_comment` nem `repository_dispatch`; `permissions: {}` no topo e, no job, só `contents: read` (nenhum `write`; o `actions: read` saiu na revisão); o job declara `environment: production`; `concurrency` com `group: deploy-production-${{ github.event_name }}` (revisão) e `cancel-in-progress: false`; o `if:` do job contém `workflow_run.conclusion == 'success'`, `workflow_run.event == 'push'`, `workflow_run.head_branch == 'main'`, `workflow_run.head_repository.full_name == github.repository` e `vars.DEPLOY_ENABLED == 'true'`; **não há `uses:`** (nenhuma ação, nem `checkout`); os únicos segredos citados são `DEPLOY_SSH_KEY`, `DEPLOY_SSH_KNOWN_HOSTS` e `DEPLOY_SSH_HOST`; nenhum `run:` contém `${{` (valores do evento só por `env:`); o comando `ssh` tem `StrictHostKeyChecking=yes`, `BatchMode=yes`, `IdentitiesOnly=yes` e `UserKnownHostsFile=`; existe passo com `if: always()` que apaga a chave; não há `set -x`; `timeout-minutes` declarado; o `workflow_dispatch` manda sempre `--dry-run` (D17); e o `ci.yml` continua com `name: CI` (o nome que o `workflow_run` procura).
- [x] **[teste]** _(confirmado pelo CI verde da `main`, job `static` com o `actionlint`, 2026-11-12)_ `ci-workflow.test.ts` passa a conhecer o passo `actionlint` no job `static` (ordem dos comandos), e o passo confere o SHA-256 do binário baixado (**S25**); o `actionlint` passa no `ci.yml`, no `node-compat.yml` e no `deploy.yml`.
- [x] **[teste de comportamento]** Programa de entrada (`deploy/soprei-deploy-entry.sh`, cópia com as constantes `SUDO`, `DEPLOY` e `CONF` trocadas por dublês): na fase de fora **aceita** exatamente `--env production --ref <40 hex>` e o mesmo com `--dry-run`, e chama o dublê do `sudo` com `--from-ssh <sha> deploy|dry-run`; **recusa com 64, sem chamar o `sudo` e sem ecoar o texto**: comando vazio, `--env staging ...`, SHA com 39 ou 41 caracteres, SHA em maiúsculas, `main` como ref, argumento extra (`--force`, `--allow-breaking`, `--previous`, `--adopt`), espaço duplo, `;`, `$(`, crase, `|`, `&`, quebra de linha e texto com mais de 80 caracteres. Na fase de dentro: argumentos fora da regra saem com 64; `ENABLED=false` sai com 1 sem chamar o dublê do `deploy.sh`; com `ALLOW_UNSTAGED=true` passa `--allow-unstaged`, com `false` não; o dublê do `deploy.sh` recebe `--auto` e **não** recebe nenhuma variável `SOPREI_DEPLOY_*` posta no ambiente do teste; `HOME` é `/root`; `entry.conf` com valor fora da lista ou com `$(` é recusado sem ser executado.
- [x] **[teste de comportamento]** _(confirmado pelo CI verde da `main` no Ubuntu, inclusive a publicação real com link simbólico, 2026-11-12)_ `deploy.sh --auto` (no `deploy-script.behavior.test.ts`, com o repositório temporário e os dublês de sempre): `--auto` com `--ref main`, SHA curto ou maiúsculo sai com 1 antes da trava; `--auto` junto com `--force`, `--previous`, `--adopt`, `--allow-breaking` ou `--inject-health-failure` sai com 1; SHA que existe no repositório mas **não está na `main`** sai com 1 sem mexer (`HEAD` e estado intactos); SHA da `main` **mais antigo** que o registrado sai com 1 sem mexer; o SHA registrado sai com 0 ("já está nessa versão"); um SHA mais novo da `main` publica (saída 0) e o log tem `modo=auto`; migration destrutiva marcada sai com 1 (sem `--allow-breaking` no automático). Se a D16 alternativa for escolhida: `--no-migrations` com migration entrando sai com 1 sem mexer, e sem migration publica.
- [x] **[teste]** `deploy-scripts.test.ts` prova que `soprei-deploy-entry.sh` usa `set -euo pipefail`, não contém `source`, `eval` nem `set -x`, usa `env -i` na chamada do `deploy.sh`, e que os exemplos novos (`sudoers`, `sshd`, `entry.conf`) não têm segredo nem chave; que o exemplo do `sudoers` só permite `/usr/local/sbin/soprei-deploy-entry --from-ssh *` e o do `sshd` tem `ForceCommand`, `PermitTTY no`, `DisableForwarding yes` e `AuthenticationMethods publickey`.
- [x] **[manual]** _(2026-11-12, ver "Configuração no servidor e no GitHub" no Registro da E3)_ Os passos 6, 8 e 9 de "Passos do dono da E3": a chave **não** abre terminal nem encaminha porta; um pedido fora do formato é recusado; o dry-run pelo Actions sai com 0; o primeiro merge publica sozinho com o resumo correto.
- [x] **[manual]** _(2026-11-12; o SHA antigo foi conferido no log do Actions, o da branch foi informado pelo dono)_ Recusas provadas pelo Actions (`workflow_dispatch` em dry-run): um SHA que **não** está na `main` (de uma branch de PR) sai com 1; um SHA antigo da `main` sai com 1.
- [x] **[manual]** _(2026-11-12)_ Um commit na `main` com o CI **vermelho** não dispara deploy (o job aparece pulado); um PR (de branch do próprio repositório) com CI verde **não** dispara deploy.
- [x] **[manual]** _(2026-11-13, testado pelo dono)_ Desligar: com `DEPLOY_ENABLED=false` o próximo merge não publica (job pulado); com `ENABLED=false` no `entry.conf` o pedido sai com 1. Religar e registrar.

## Casos de borda e erros

- **`.env` inválido na versão nova** (variável nova obrigatória, valor fora da regra): pego pelo `config:check` no passo 7, antes da migration e de derrubar o processo; sem ele, o processo sairia com código 1 e o PM2 entraria em laço de reinício (já aconteceu com uma chave de IA curta).
- **Processo sobe, mas o banco ou o Redis não respondem:** `/health/ready` dá 503; a espera de saúde estoura e o rollback roda (o código anterior também não terá banco; o aviso final explica que o problema é de infraestrutura, não do código).
- **Laço de reinício depois da troca:** o `restart_time` do PM2 cresce durante a espera de estabilidade e o deploy falha mesmo que alguns `200` tenham passado.
- **SIGKILL do PM2 no meio do desligamento** (D7): sem o ajuste, um job do canal em andamento pode ser cortado; o BullMQ o retenta (entrega pelo menos uma vez, como na 011).
- **Dois deploys ao mesmo tempo ou staging e produção juntos:** a trava global recusa o segundo.
- **Script atualizado pelo próprio deploy:** o `deploy.sh` que **executa** é o da versão **já instalada**, não o da versão-alvo (mudanças no script só valem a partir do deploy seguinte; um defeito no script não se corrige com um deploy "pelo próprio script quebrado": o dono corrige com `git checkout` manual do arquivo ou roda a versão boa copiada). Registrado no `docs/ops/deploy.md`.
- **Queda do SSH no meio:** `SIGHUP` ignorado; o log mostra o resultado; antes do passo 8 uma interrupção restaura, depois dele não interrompe.
- **Servidor sem espaço ou sem memória durante o build:** o build falha, a árvore é restaurada e o processo em execução nunca foi tocado (código 2). Um `OOM` do próprio PM2 de produção durante o build é o risco que a regra "um deploy por vez", o `nice` e o limite de memória do build reduzem (**S21**).
- **Primeira execução em servidor montado à mão:** sem `--adopt` o script recusa; com ele, registra o estado atual e segue.
- **Mesmo SHA:** sai com 0 ("já está nessa versão") a menos de `--force`.
- **`git fetch` sem rede ou sem a chave:** código 1, nada alterado.
- **Migration em andamento por mais tempo que o prazo:** o prazo de 300 s encerra o comando; o banco **pode** ter ficado com migration parcial (ver a política); nada é trocado.
- **Rollback quando a migration que entrou não é compatível:** é o caso que a varredura tenta barrar antes; se passar despercebido e o código antigo falhar sobre o banco novo, o resultado é o código 3 com instruções (corrigir para a frente ou restaurar o backup).
- **(E3) Dois merges seguidos:** o CI do primeiro termina depois do segundo merge: o job do primeiro vê que a ponta da `main` mudou e encerra como "ultrapassado"; se mesmo assim o pedido chegar ao servidor depois do segundo deploy, o `--auto` recusa por ser mais antigo (saída 1).
- **(E3) Repetir uma execução antiga do Actions** ("Re-run"): mesmo caso; nunca volta para trás. Repetir a execução do commit em produção dá "já está nessa versão" (0).
- **(E3) Deploy manual do dono durante um automático (ou o contrário):** a trava global recusa o segundo (saída 1); o automático fica vermelho e o próximo merge, ou o dono à mão, publica.
- **(E3) CI vermelho na `main`:** nada é publicado; o próximo commit com CI verde publica o que se acumulou (o `--auto` aceita pular commits intermediários, só não volta).
- **(E3) Job cancelado ou SSH caído no meio:** o `deploy.sh` segue até o fim no servidor (ignora `SIGHUP` e `SIGPIPE`; o log continua); o resumo do Actions diz "resultado desconhecido: ver o log do servidor".
- **(E3) O próprio merge da E3:** chega à `main` com `DEPLOY_ENABLED=false` (job pulado). Se a variável faltar, o `if` também pula (comparação com `'true'`).
- **(E3) `deploy.sh` instalado antigo, sem `--auto`:** o pedido sai com 1 ("opção desconhecida") sem mexer; por isso o passo 3 dos passos do dono publica a E3 à mão antes de ligar o automático.

## Isolamento entre empresas

Não se aplica: nenhum acesso a dados de empresa é criado ou alterado (script, configuração, exemplos e um comando de validação de ambiente). O isolamento que esta spec cuida é **entre ambientes** (staging e produção): bancos e roles separados com `CONNECT` negado ao outro, **instância de Redis separada**, segredos diferentes (inclusive `JWT_SECRET`), e-mail capturado e nenhum dado real no staging; os critérios **[manual]** da E2 provam isso. O `reviewer` confere a segurança do pipeline e do servidor (chave SSH, comando restrito, privilégio, redação de log). **A E3 passa pelo `reviewer` antes do merge** (segredo no GitHub, acesso remoto ao servidor, `sudo` para `root`).

## Fora de escopo

- **Backup externo, teste de restauração, `pnpm privacy:replay`** (033, E5; 032) e **monitoramento, alertas e uptime** (033, E6). O `PRE_MIGRATION_BACKUP` desta spec é só uma cópia local de segurança.
- **CSP e cabeçalhos do site** (033, E2), **segurança de produção** (Dependabot, `pnpm audit`, 2FA; 033, E7), **runbook completo** (033, E9; aqui só `docs/ops/deploy.md`), **homologação mínima** com `APP_VERSION`, gauges e cabeçalhos da API (033, E1), **teste de carga e lançamento gradual** (033, E8).
- **Blue-green, duas instâncias da API e deploy sem nenhuma interrupção.**
- **Separar o worker do processo da API** (033, E10; 034, E4).
- **Docker, contêineres, Kubernetes, Terraform.**
- **Migrar a produção para pastas por versão** (D1, alternativa) e **rollback por `dist.prev`** (D2, alternativa).
- **Segundo app da Meta e canal WhatsApp no staging** (D6), **cobrança e checkout no staging** (a InfinitePay não tem sandbox) e **dump de produção ou dump sintético no staging** (D3; 032).
- **Cloudflare com proxy ligado** (exige `real_ip` no nginx e `TRUST_PROXY` com as faixas dela; já registrado no handoff).
- **Mover a aplicação para o usuário `soprei`** (D10 opção B; etapa própria, exigida antes de dado real no staging pela decisão I4) e **rotação de segredos** (033, D6).
- **Deploy automático do staging** (até o servidor de staging existir; com a D15 alternativa ele entra na E3), **deploy automático por tag** (D11 alternativa), **publicar pelo `workflow_dispatch`** (D17 alternativa) e o modelo em que **o servidor puxa** (E3, alternativa não detalhada).
- **Alerta próprio de falha de deploy** (Slack, e-mail próprio, uptime): fica na 033 (E6); na E3 só o aviso padrão do GitHub.
- **Verificar no CI, antes do merge, se a migration é aditiva** (continua na 033).

## Riscos

- **Script com poder de `root`** (até o D10): um defeito aqui afeta o servidor inteiro; por isso `set -euo pipefail`, `shellcheck`, testes de comportamento, `--dry-run` e a revisão do `reviewer`.
- **Build no servidor de 4 GB disputa memória com a produção:** reduzido por trava única, `nice` e teto de memória do build; medido na E2.
- **Rollback não reverte migration:** é a limitação central; a política, a varredura e o `--allow-breaking` sem rollback automático existem por causa dela.
- **A varredura de migration é por texto:** alarme, não prova.
- **Staging e produção no mesmo servidor:** uma falha do servidor derruba os dois e o staging disputa memória; aceito (o staging é descartável). O isolamento de dados e de segredos não depende do servidor ser outro.
- **E3 amplia a superfície de ataque** (chave de deploy no GitHub) e tira o olhar do dono sobre o plano antes de cada publicação; a lista completa e as mitigações estão em "Riscos da E3 (declarados)". A chave só pede "este SHA da `main`, para a frente"; o risco que sobra é o de quem pode fazer merge, que já existia.

## Suposições a conferir (nada abaixo foi lido na fonte)

- **S1** `.gitattributes` com LF para `*.sh` existe ou precisa ser criado.
- **S2** O servidor é ARM e o CI é x86; há dependências com binário nativo.
- **S3** Tempo de `pnpm install` e de build no ARM com 4 GB (de 1 a 3 minutos?).
- **S4** O Node confia em `NODE_EXTRA_CA_CERTS` para a verificação de TLS do envio SMTP do projeto (a biblioteca de SMTP) e o Mailpit aceita STARTTLS com certificado próprio.
- **S5** Existem caixas de teste de terceiros que capturam e-mail sem entregar, com TLS público.
- **S6** O nginx aceita `auth_basic` junto de `proxy_set_header Authorization ""` sem quebrar o site e a API no mesmo host.
- **S7** Requisitos do segundo app da Meta em modo de desenvolvimento (webhook, domínio, número de teste).
- **S8** O valor atual de `SHUTDOWN_TIMEOUT_MS` e se o canal está ligado no `.env` de produção.
- **S9** O build compete com a produção pela memória de 4 GB; swap existente?
- **S10** `tsc --outDir` e `vite build --outDir` funcionam com os scripts atuais (`tsconfig.build.json` e a configuração do Vite); o `build` da raiz pode precisar de variantes.
- **S11** O `pg_dump` como usuário `postgres` por autenticação local funciona no servidor.
- **S12** `pm2 reload` em modo **fork** equivale a parar e subir (sem zero downtime) e `pm2 startOrReload <ecosystem> --only <app>` aplica `kill_timeout` e `max_memory_restart` alterados sem apagar o app; `pm2 save` após criar o app do staging.
- **S13** `pm2 jlist` expõe `pm2_env.status`, `pm2_env.restart_time` e `pm2_env.pm_uptime`, e o servidor tem `node` para ler o JSON (sem depender de `jq`).
- **S14** Diretórios `/var/log/soprei-deploy`, `/var/lib/soprei-deploy` e o arquivo de trava criados com as permissões certas.
- **S15** Indisponibilidade de 5 a 20 s no `reload`.
- **S16** A mesma chave de deploy (somente leitura) serve para o segundo clone do mesmo repositório.
- **S17** Comportamento de `REVOKE CONNECT` no PostgreSQL 18 e o `pg_hba.conf` do servidor.
- **S18** Como rodar um segundo Redis 8 no Ubuntu 26.04 (modelo de instância do pacote ou unidade própria).
- **S19** Binário ARM64 do Mailpit e as opções de TLS e de limite de mensagens.
- **S20** O arquivo nginx da produção (não foi lido).
- **S21** Consumo real de memória (tabela da E2) e do build.
- **S22** Existência de swap.
- **S23** Se o plano do GitHub da conta, para este repositório **privado**, oferece ambientes com segredos próprios, **restrição de branch** do ambiente e **revisor obrigatório** (minha lembrança: revisor obrigatório em repositório privado exige plano pago; ambientes e segredos de ambiente podem ter a mesma limitação). Se o ambiente não estiver disponível, a saída é segredos do repositório + o `if` do job restrito à `main` (mais fraco: qualquer workflow do repositório os leria) e a decisão volta ao dono. `contents: read` basta para ler a ponta da `main` pela API.
- **S24** Formato de `authorized_keys` com `command=` e `restrict` (que inclui `no-port-forwarding`, `no-agent-forwarding`, `no-X11-forwarding`, `no-pty` e `no-user-rc`), uso de `SSH_ORIGINAL_COMMAND`, o `sshd` rodar o comando forçado **pelo shell do usuário** (com `nologin` não funcionaria), `authorized_keys` com dono `root` aceito pelo `StrictModes`, `ForceCommand`/`DisableForwarding`/`PermitTTY` no `Match User` da versão do OpenSSH do Ubuntu 26.04, e a inviabilidade de `from=` com os executores do GitHub.
- **S25** `shellcheck` vem na imagem `ubuntu-latest` (confirmado na prática pelo CI da E1); `actionlint` **não** vem: instalar por binário de versão fixa com SHA-256 conferido (versão e soma a escolher na implementação, com a fonte registrada).
- **S26** O `workflow_run` usa a definição do workflow que está na **branch padrão** (um PR que altere `deploy.yml` não muda o que roda antes do merge) e só dispara para workflows de nome igual ao `name:` do `ci.yml` (`CI`); o `ci.yml` chamado por `workflow_call` pelo `node-compat.yml` **não** dispara o `workflow_run` com o nome `CI`.
- **S27** No `workflow_run`, o filtro `branches:` compara o **nome** da branch de origem, e um PR de fork com branch chamada `main` passa nele; `github.event.workflow_run.event`, `head_branch`, `head_sha`, `conclusion` e `head_repository.full_name` existem com esses nomes.
- **S28** Com `HOME=/root` e `PATH=/usr/local/bin:/usr/bin:/bin`, o `pm2` chamado pelo `sudo` encontra o daemon do `root` (`/root/.pm2`) e o `node`/`pnpm` do servidor (instalados em `/usr/local`).
- **S29** O `sudo` do Ubuntu 26.04 limpa o ambiente por padrão (`env_reset`), não exige terminal (`requiretty` desligado) e aceita `*` como "quaisquer argumentos" no `sudoers`. **Conferido em 2026-11-12:** o Ubuntu 26.04 do servidor usa o **sudo-rs**, que não conhece `requiretty` e recusa o arquivo com ela; a linha `Defaults:soprei-deploy !requiretty` saiu do exemplo (o sudo-rs nunca exige terminal).
- **S30** `concurrency` sem `cancel-in-progress` guarda **no máximo um** job pendente por grupo, e um pendente novo cancela o pendente anterior (não o que está rodando).
- **S31** `ssh` e `gh` estão na imagem `ubuntu-latest` e o `gh` aceita o `GITHUB_TOKEN` por `GH_TOKEN`; `vars.*` pode ser usado no `if:` do job.
- **S32** O GitHub mascara no log os valores de segredos (inclusive em várias linhas, como a chave e o `known_hosts`).
- **S33** O GitHub avisa por e-mail quem disparou o workflow quando ele falha (no `workflow_run`, o autor do evento original).

## Passos do dono (separados do código)

1. Responder D1 a D12 (as recomendadas valem se ele disser "aprovo tudo").
2. **Antes da E1**, no servidor: `pm2 -v`, `node -v`, `pnpm -v`, `flock --version`, `free -m` (e swap), o valor de `SHUTDOWN_TIMEOUT_MS` e se o canal está ligado, o arquivo do nginx da produção (sem segredo) e o `ecosystem.config.cjs` atual; criar `/var/log/soprei-deploy` e `/var/lib/soprei-deploy`.
3. **E1:** depois do merge, `git pull` à mão **uma última vez**, rodar `deploy/deploy.sh --env production --dry-run`, depois `--adopt`, e registrar o resultado. Substituir o `ecosystem.config.cjs` do servidor pelo versionado (`pm2 startOrReload` e `pm2 save`).
4. **E2:** DNS do staging; certificado; banco e role; Redis separado; Mailpit; `.env` do staging (segredos novos, guardados também no gerenciador de senhas); clone; primeiro `deploy.sh --env staging --adopt`; os testes de isolamento da E2; a medição de memória.
5. **E3:** responder D9, D10, D11 e D13 a D17; depois, a lista detalhada em "Passos do dono da E3, em ordem" (seção E3).

## Decisões e dependências novas

Dependências de pacote: **nenhuma**. Ferramentas externas no CI (sem entrar no `package.json`): `shellcheck` e, na E3, `actionlint`. Ferramentas novas no **servidor** (E2): Mailpit e a segunda instância do Redis. Arquivos novos previstos: `deploy/` (script, ecosystem, alvos, exemplos de nginx, Redis, Mailpit e `.env` do staging), `backend/src/infrastructure/config/check-cli.ts` e o script `config:check`, `.gitattributes`, `docs/ops/deploy.md`, os dois testes de `backend/src/` e, na E3, `.github/workflows/deploy.yml`. Registrar em `docs/context.md`, depois da resposta do dono, o que foi decidido (D1 a D12) e, no `docs/handoff.md`, o servidor de staging (endereço, o que roda, onde estão os arquivos, sem segredo).

**E3 (revisão de 2026-11-12):** dependências de pacote: **nenhuma**; nenhuma ação de terceiros no `deploy.yml`. Ferramenta nova no CI: `actionlint` (binário fixo com SHA-256). No servidor: usuário `soprei-deploy`, `/usr/local/sbin/soprei-deploy-entry`, `/etc/soprei-deploy/entry.conf`, `/etc/sudoers.d/soprei-deploy`, `/etc/ssh/sshd_config.d/soprei-deploy.conf`. No GitHub: ambiente `production` (segredos `DEPLOY_SSH_KEY`, `DEPLOY_SSH_KNOWN_HOSTS`, `DEPLOY_SSH_HOST`, variável `DEPLOY_SSH_USER`), variável de repositório `DEPLOY_ENABLED` e a proteção da `main`. Depois da resposta do dono, registrar em `docs/context.md` as decisões D9, D10, D11 e D13 a D17.

## Registro da implementação (2026-11-11, E1 e E2; a E3 não foi feita, D9)

- **Quem e onde:** Claude Code (Sonnet 5.5, implementer), branch `spec/037-deploy-e-staging`. Nenhum acesso ao servidor: nada foi executado fora do repositório e do PC do dono (só testes com dublês).
- **Arquivos:** `deploy/deploy.sh`, `deploy/ecosystem.config.cjs`, `deploy/targets/{production,staging}.conf`, `deploy/redis/redis-staging.{conf,service}.example`, `deploy/mailpit/mailpit-staging.service.example`, `deploy/nginx/{staging,production}.conf.example`, `deploy/env/staging.env.example`, `deploy/backup/soprei-predeploy-backup.example`; `backend/src/infrastructure/config/check-cli.ts` (+ teste) e o script `config:check` em `backend/package.json`; `backend/src/deploy-scripts.test.ts` e `backend/src/deploy-script.behavior.test.ts`; `docs/ops/deploy.md` e `docs/ops/staging.md`; `.github/workflows/ci.yml` (passo `shellcheck deploy/*.sh` no job `static`) e `ci-workflow.test.ts`; `.gitignore` (`backend/dist.next`, `dist.prev`, `dist.failed`, `frontend/releases`, `frontend/.dist.new`); `AGENTS.md` e `docs/context.md`.
- **S1 resolvida:** o `.gitattributes` já existia (`* text=auto eol=lf`, cobre os `.sh`); nada a criar. O bit executável de `deploy.sh` e do exemplo de backup foi gravado com `git update-index --chmod=+x` (um teste confere).
- **S10 confirmada localmente:** `pnpm --filter soprei-backend exec tsc -p tsconfig.build.json --outDir dist.next` (~15 s no PC do dono) e `pnpm --filter soprei-frontend exec vite build --outDir <abs>/frontend/releases/<nome>` funcionam com os scripts atuais; o `check-cli.js` compilado roda por `node dist.next/infrastructure/config/check-cli.js` (`ok` e, com variável inválida, só os nomes, saída 1). S3 (tempos no ARM), S4, S6, S9, S11 a S22 (incluindo o formato do `pm2 jlist` e o comportamento do `pm2 startOrReload` em fork) seguem **não verificadas** (dependem do servidor ou da rede).
- **`config:check`:** `check-cli.ts` reaproveita `parseConfig` (o mesmo schema do boot), imprime `ok` ou só os nomes (parte antes do `:` de cada item, filtrada por `^[A-Za-z0-9_.]+$`), nunca valor nem a mensagem do Zod; não abre conexão; só roda como programa quando o arquivo é o ponto de entrada (os testes importam as funções puras). Roda do diretório atual (o `.env` do dotenv).
- **Desvios e decisões de implementação (o que a spec não detalhava):**
  - **Chaves extras no alvo**, lidas como texto e validadas (valores só com `[A-Za-z0-9_./:@%+,-]`): `SITE_HOST`, `SITE_OK_CODES`, `HEALTH_INTERVAL_SECONDS`, `HEALTH_STABLE_COUNT`, `MIN_FREE_KB`, `BUILD_MEMORY_MB`, `MIGRATE_TIMEOUT_SECONDS`, `HEALTH_TIMEOUT_SECONDS`. `ENV_FILE` precisa ser `APP_DIR/backend/.env` (o script confere, porque o `config:check` lê o `.env` do diretório atual do backend).
  - **Conferência do site (passo 11):** `curl --resolve <SITE_HOST>:443:127.0.0.1 https://<SITE_HOST>/` (certificado verificado), em vez de HTTP puro com cabeçalho `Host`: a porta 80 do nginx redireciona para HTTPS. No staging `SITE_OK_CODES=200,401` (a senha básica responde 401: prova nginx no ar, e o `index.html` da release é conferido no disco).
  - **Nomes de release do site:** `frontend/releases/<sha12>-<AAAAMMDDHHMMSS>` (o sufixo de hora evita sobrescrever uma release em uso num `--force`). Na primeira vez a pasta real `frontend/dist` é movida para `releases/legacy-<hora>` e passa a ser atalho (janela de milissegundos sem o diretório). O rollback do site é só religar o atalho (o site só é trocado depois da saúde da API).
  - **`PRE_MIGRATION_BACKUP` é um caminho** de programa executável do dono (não uma linha de comando): o exemplo está em `deploy/backup/`. `production.conf` já aponta para `/usr/local/sbin/soprei-predeploy-backup`; **com migration a aplicar e o arquivo ausente o script recusa (saída 1)**: o dono instala o programa antes do primeiro deploy com migration (ou esvazia a chave). Com `--allow-breaking`, o backup é exigido só em produção (o staging pode ficar sem).
  - **Varredura de migrations:** só arquivos **adicionados** entre os SHAs (`--diff-filter=A`); migration alterada depois de aplicada não é tratada aqui (o próprio Prisma recusa). Comentários SQL são removidos antes de procurar as palavras; a marca `-- breaking-approved: <motivo>` é procurada no texto cru.
  - **`--adopt` e app ausente no PM2** (ambiente novo): o script segue mesmo sem o app, e o atalho "já está nessa versão" **não** vale (nada está rodando); o app é criado por `pm2 startOrReload`. Com o app presente, `--adopt` só registra o `HEAD` como em execução. O dry-run nunca grava estado.
  - **Rede de segurança `ERR` (`set -E`):** um erro inesperado do próprio script antes do ponto sem volta restaura a árvore; depois dele aciona o rollback (ou a intervenção manual com `--allow-breaking`). Depois da saúde e do site confirmados o `trap` sai (falha ao gravar o estado dá saída 3 com instrução).
  - **Ganchos de teste:** `SOPREI_DEPLOY_LOCK_FILE`, `SOPREI_DEPLOY_STATE_DIR`, `SOPREI_DEPLOY_LOG_DIR` e `SOPREI_DEPLOY_TARGETS_DIR` mudam os caminhos fixos (padrões: os da spec); quem pode defini-los já controla o ambiente do script.
  - **Descritor da trava:** todo comando filho longo roda por `run_cmd` (`9>&-`), para o daemon do PM2 não herdar a trava.
  - **`nice` e memória:** os builds rodam com `nice -n 10` e `NODE_OPTIONS=--max-old-space-size=<BUILD_MEMORY_MB>`. O build do site roda também o `tsc --noEmit` do frontend (o que o `pnpm build` faz).
  - **`nginx/production.conf.example` foi RECONSTRUÍDO** da descrição do desenho, não copiado do servidor (S20); o arquivo diz isso no cabeçalho e pede conferência. O hostname dele (`www.soprei.com`) já é público.
  - **`shellcheck` com a severidade padrão** (sem `--severity`); como não pôde ser rodado localmente, um aviso de estilo novo pode quebrar o job `static` na primeira execução do CI: a correção é pontual.
- **Verificação feita (Windows + Git Bash, Node 24.18; sem `flock` real nem link simbólico):** `pnpm typecheck`, `pnpm lint` e `pnpm format:check` verdes; `deploy-scripts.test.ts` (38), `check-cli.test.ts` (7), `ci-workflow.test.ts` (8) e `domain-vocabulary.test.ts` verdes; `deploy-script.behavior.test.ts`: 20 verdes e 5 pulados com aviso (os que precisam de `ln -s`, de `flock` real ou de modo de arquivo fiel). O caminho feliz foi exercitado numa cópia **temporária** do script em que só a troca do atalho foi trocada por cópia de pasta (apagada depois): saída 0, estado gravado, ordem backup, migration e reload, URL do banco entregue aos comandos e nunca impressa. A troca real do atalho (`ln -sfn` + `mv -T`), a leitura do atalho, a poda de releases e a trava com `flock` real **ainda não foram executadas por ninguém**: o CI (Ubuntu) as roda.
- **Não verificado (e por quê):** `shellcheck` (ferramenta ausente); os 5 cenários pulados; tudo que depende do servidor (PM2 real, nginx, Redis separado, Mailpit com STARTTLS e `NODE_EXTRA_CA_CERTS` (S4), certbot, `REVOKE CONNECT`, tempos no ARM, memória); os critérios **[manual]** de E1 e E2 seguem abertos (são do dono, no servidor). O `reviewer` ainda não passou (a spec exige).
- **Dúvidas para o dono:** (1) o programa de backup antes de migration (`/usr/local/sbin/soprei-predeploy-backup`) deve ser instalado antes do primeiro deploy com migration; ou prefere deixar `PRE_MIGRATION_BACKUP` vazio no começo? (2) hostname do staging (o `staging.soprei.com` do alvo é um exemplo). (3) o valor atual de `SHUTDOWN_TIMEOUT_MS` no `.env` de produção (S8): o `kill_timeout` de 65 000 ms assume o padrão de 60 000.

### Correções da revisão do reviewer (2026-11-11)

- **B1 (bloqueante):** o `umask 077` global deixava a release do site ilegível para o nginx. Agora o build do backend e do site roda com `umask 022`, a release recebe `chmod -R u=rwX,go=rX`, `frontend/releases` e a pasta `legacy-*` ficam 755; o 077 continua para log, estado, trava e backup. O teste de comportamento do deploy concluído confere os modos (roda no CI Linux; no Windows local fica pulado).
- **I1:** com `HEAD` diferente do registrado, `--force` agora aceita, avisa no log e reimplanta o `--ref`; a versão de volta, se falhar, é a **registrada**. Teste: recusa sem `--force`, plano com `--force` (local) e recuperação completa com `--force` (Linux).
- **I2:** `switch_site` valida a release e prepara o atalho temporário **antes** de mover a pasta real `frontend/dist`; `restore_site` devolve a pasta (move de volta) se a troca falhar ou houver rollback. Teste: falha do `mv -T` na primeira vez deixa `frontend/dist` de volta (roda local).
- **I3 e S7:** troca do `dist` por `swap_dist_dirs` (usada na troca e no rollback): cada `mv` é conferido, `mv -T`, confirma que `dist.next` sumiu e devolve o `dist` antigo se falhar no meio. Falha da troca depois da migration e antes do reload = "nada trocado": restaura a árvore, **sem** recompilar nem recarregar o PM2, saída 2 e lista as migrations não revertidas. Teste com dublê de `mv` e `dist.prev` residual.
- **S2:** `git fetch` e `git checkout` passam por `run_cmd` (o `git gc --auto` destacado não herda a trava). **S3:** o filtro de redação cobre `//usuario:senha@` e os nomes sensíveis sem diferenciar maiúsculas (`password=`, `apiKey=`, `Token=`), com teste. **S4:** `read_env_value` trata `export NOME=` e comentário no fim (teste com `.env` desse formato). **S6:** o alvo recusa `..`, componente começando com `-`, `APP_DIR` raso, `HEALTH_URL`/`READY_URL` fora de `http://127.0.0.1:`, e o curl usa `--` antes da URL. **S9:** o exemplo de backup grava em `.tmp` e renomeia no sucesso. **S5/S8:** lacunas da varredura de migration e a troca de `node_modules` com o processo antigo no ar registradas em `docs/ops/deploy.md`. **S10:** o dublê do curl do site só devolve 200 se `frontend/dist/index.html` existe.
- **S1 (shellcheck):** continua **não rodado**. Baixar o binário exigiria download não autorizado pelo dono, então não foi feito. Revisão à mão: o `ls -1dt` (SC2012) virou `find -printf | sort` no script e no exemplo de backup, e o `sed` sobre here-string (SC2001) virou `git show | sed`. Podem sobrar avisos de estilo que só o CI mostra.
- **I4 (decisão do dono, 2026-11-11):** o isolamento do staging é só de **configuração** enquanto staging e produção rodam como o mesmo usuário do sistema (`root`, mesmo PM2). Contra erro de configuração, `REVOKE CONNECT`, Redis próprio e senhas diferentes protegem; contra execução de código no staging, **não** (o `.env` de produção é legível por `root`). O staging fica **somente com dados sintéticos**; o usuário dedicado (D10) entra **antes** de qualquer dado real ou de abrir o staging ao público. Registrado em `docs/ops/staging.md` e `docs/ops/deploy.md`.
- **Verificação local depois das correções (Windows, Node 24.18):** `deploy-script.behavior.test.ts` 30 cenários, 24 verdes, 6 pulados (link simbólico, `flock`, modo de arquivo), 0 falhas. Os cenários de recuperação com `--force`, `--previous` e segundo deploy foram exercitados também numa cópia temporária do teste que finge link simbólico (apagada). **Ainda sem verificação:** `shellcheck`, `ln -s`/`mv -T` reais, os modos da release, a trava com `flock` real e tudo no servidor.

### Primeiro deploy real e correções (2026-11-12)

- **CI:** o passo `shellcheck` apontou quatro avisos de nível "info", todos de comportamento proposital: o `export DATABASE_URL` dentro de subshell (SC2030/SC2031) e as funções chamadas só pelo `trap` (SC2329). Marcados com `# shellcheck disable=` e o motivo, sem mudança de comportamento.
- **Primeiro deploy em produção (dono, 2026-11-12):** o servidor rodava `27139bb`, anterior ao `deploy.sh`. Em vez de `git pull` à mão, o script foi rodado de uma cópia temporária (`git archive origin/main deploy`), com a árvore no código em execução e o `ecosystem.config.cjs` antigo retirado da raiz: `--env production --adopt --allow-unstaged` (sem staging ainda). Resultado: **saída 0**, `27139bb -> 010b8f9`, cópia do banco antes da migration `20261111120000_notifications` (aditiva), saúde estável na primeira espera, site trocado por atalho para a release, tempo total 49 s e **indisponibilidade medida de 3,1 s**. Critérios [manual] da E1 cumpridos neste deploy: concluído com estado gravado, backup antes de migration e troca do site; o rollback real em produção não foi provocado.
- **Defeito 1 (corrigido):** na adoção de um servidor já atualizado à mão (mesmo SHA, app no ar), o script saía com "já está nessa versão" **antes** de registrar a versão em execução, e o deploy seguinte recusaria por falta de versão registrada. Agora a adoção é registrada nesse caso (o dry-run só avisa). Teste novo em `deploy-script.behavior.test.ts`.
- **Defeito 2 (corrigido):** o script recarregava o app com o `ecosystem.config.cjs` versionado mas não gravava a lista do PM2, então um reinício do servidor traria de volta a configuração anterior (`kill_timeout`). Agora `pm2 save` roda depois de um deploy concluído e de um rollback concluído (falha do `pm2 save` só avisa, não desfaz). Asserções nos testes do deploy concluído e do rollback. No primeiro deploy, o dono rodou `pm2 save` à mão.
- `docs/ops/deploy.md`, seção "Primeira vez", passou a descrever os dois casos (código anterior ao script, pela cópia temporária; e código já na `main`, só com `--adopt`).

## Registro da implementação da E3 (2026-11-12)

- **Quem e onde:** Claude Code (Opus 5.5, implementer), branch `spec/037-e3-deploy-automatico` (sobre `858a416`, a aprovação). **Nenhum acesso ao servidor nem ao GitHub do dono**: nada foi instalado, configurado nem disparado; os passos do servidor e do GitHub estão escritos para o dono em `docs/ops/deploy.md` ("Deploy automático pelo GitHub Actions (E3)").
- **Arquivos:** `deploy/deploy.sh` (`--auto`, `check_auto_rules`, `modo=` na linha de início); `deploy/soprei-deploy-entry.sh` (novo, modelo do programa de entrada, bit executável no Git); `deploy/entry/entry.conf.example`, `deploy/sudoers/soprei-deploy.example`, `deploy/ssh/sshd-soprei-deploy.conf.example` e `deploy/ssh/authorized_keys.example` (novos, sem segredo; a chave pública é um marcador); `.github/workflows/deploy.yml` (novo); `.github/workflows/ci.yml` (passos "Instalar o actionlint" e `actionlint` no job `static`, depois do `shellcheck`; os três jobs continuam os mesmos); `backend/src/deploy-workflow.test.ts` (novo, 11 testes); `backend/src/ci-workflow.test.ts` (conhece o passo; `runsOf` ignora blocos `run: |`); `backend/src/deploy-scripts.test.ts` (`--auto`, programa de entrada, exemplos, documentação); `backend/src/deploy-script.behavior.test.ts` (cenários do `--auto` e do programa de entrada); `docs/ops/deploy.md`; `AGENTS.md`; `docs/handoff.md`.
- **actionlint (S25):** versão **1.7.12** (release de 30 de março de 2026, a mais recente em 2026-11-12), binário `actionlint_1.7.12_linux_amd64.tar.gz`, SHA-256 `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`, lido em 2026-11-12 do arquivo `actionlint_1.7.12_checksums.txt` do release `https://github.com/rhysd/actionlint/releases/tag/v1.7.12` (fonte também no comentário do passo). O passo baixa com `curl -fsSL`, confere com `sha256sum --check --strict` **antes** de extrair e põe o binário no `GITHUB_PATH`; o `actionlint` lê todos os arquivos de `.github/workflows/` e usa o `shellcheck` da imagem nos blocos `run:`.
- **Desvios e decisões de implementação (o que a spec não detalhava):**
  - **`MIGRATIONS` no `entry.conf`:** só aceita `auto` (D16 recomendada); `manual` (a alternativa, com `--no-migrations`) **não foi implementado** e é recusado como valor inválido (todo pedido sai com 1). A chave é opcional (padrão `auto`); `ENABLED` é obrigatória; `ALLOW_UNSTAGED` tem padrão `false`.
  - **Programa de entrada:** além de `SUDO`, `DEPLOY` e `CONF`, também `LOGGER` (o teste troca o `logger` por um dublê; no servidor, `logger` é melhor esforço e nunca derruba o pedido) e **`REQUIRE_ROOT`** viraram constantes. Com `REQUIRE_ROOT=true` (o instalado), a fase de dentro recusa rodar fora do `root` e recusa `entry.conf` que não seja do `root` com modo 600 (o teste usa `false`, porque não roda como `root`). Sem argumentos = fase de fora; `--from-ssh <sha> <deploy|dry-run>` = fase de dentro; qualquer outra coisa = 64. A fase de dentro faz `cd /` antes do `exec env -i`.
  - **Mensagem de recusa fixa:** `soprei-deploy-entry: pedido recusado (fora do formato aceito)` (64); o `syslog` recebe só "pedido recusado", "pedido aceito: sha=<7> modo=<...>" ou "recusado: <motivo fixo>".
  - **`--auto` no `deploy.sh`:** as recusas de formato e de combinação de opções saem com 1 em `parse_args` (antes do log e da trava); as regras de `main` e "para a frente" (`git merge-base --is-ancestor`) rodam logo depois de `resolve_ref`, antes da regra do staging e da varredura. SHA igual ao registrado segue para "já está nessa versão" (0). Sem `--ref`, o padrão `main` é recusado pelo `--auto`.
  - **`deploy.yml`:** `defaults.run.shell: bash`; o passo do SSH usa `set +e` para o código de saída chegar ao resumo; o `ssh` ganhou, além do previsto, `-F /dev/null`, `GlobalKnownHostsFile=/dev/null`, `UpdateHostKeys=no` e `ConnectTimeout=20`; usuário e host são conferidos por expressão regular (nada começando com `-`). A leitura da ponta da `main` (`gh api repos/<repo>/git/ref/heads/main`) é **fail-open**: se falha, o job segue (quem garante "para a frente" é o servidor). A chave e o `known_hosts` vão para `$RUNNER_TEMP` com `umask 077` e são apagados por um passo com `if: always()` (que também apaga a saída guardada para o resumo).
  - **Variável `DEPLOY_SSH_USER`:** variável do **ambiente** `production` (lida num passo); `DEPLOY_ENABLED` é variável do **repositório** (o `if:` do job é avaliado antes de o ambiente existir).
- **Verificação feita (Windows + Git Bash, Node 24.18):** `pnpm typecheck` e `pnpm lint` verdes; `deploy-workflow.test.ts` (11), `ci-workflow.test.ts` (9) e `deploy-scripts.test.ts` (54) verdes; `deploy-script.behavior.test.ts`, só os cenários novos (`--auto`, programa de entrada e `modo=manual`), **41 verdes e 1 pulado** (a publicação real com `--auto`, que depende de link simbólico), repetidos três vezes.
- **Não verificado (e por quê):** `shellcheck` e `actionlint` (ausentes no PC do dono; o CI os roda: um aviso novo pode quebrar o job `static` na primeira execução e a correção é pontual); o cenário da publicação real com `--auto` (link simbólico, roda no CI Ubuntu); a suíte completa (CI). **Tudo no servidor e no GitHub** (S23 a S33): ambiente `production` e restrição de branch no plano da conta, `command=`/`restrict`/`ForceCommand` no OpenSSH do Ubuntu 26.04 (inclusive o escopo do bloco `Match` num arquivo de `sshd_config.d`), `sudo` com `env_reset` e `*`, `HOME=/root` achando o PM2 do `root`, `concurrency` com um pendente, `gh` e `ssh` na imagem, máscara dos segredos e o e-mail de falha. Cada uma tem a forma de conferir nos passos do dono. Os critérios **[manual]** da E3 seguem abertos. **O `reviewer` ainda não passou** (a spec exige: segredo no GitHub, acesso remoto, `sudo` para `root`).

### Correções da revisão do reviewer da E3 (2026-11-12)

- **B1 (bloqueante, corrigido):** com `ssh -T` a saída do `deploy.sh` vai a um pipe do `sshd`; se a conexão caía (job cancelado, prazo, rede), o `tee` e o `sed` do filtro morriam por SIGPIPE e o próprio deploy junto, sem rollback. Agora o subshell do filtro faz `trap '' INT TERM HUP PIPE` e usa `tee --output-error=warn-nopipe -a` (GNU coreutils: para de escrever na saída fechada e segue gravando o log, então o `sed` nunca vê o pipe fechado), e o `run_deploy` também ignora SIGPIPE. Testes de comportamento novos com a saída em `| head -n1`: o dry-run `--auto` (roda também no Windows) **falha com o script anterior e passa com o novo** (conferido trocando o arquivo localmente); o deploy `--auto` completo prova estado novo, `RESUMO: concluído` no log e `pm2 save` (precisa de link simbólico: roda no CI Linux). `deploy.yml` e `docs/ops/deploy.md` passaram a dizer só isso ("foi feito para seguir até o fim"; a queda real do SSH com o `sudo` no meio só se confere no servidor).
- **I1 (corrigido):** no `--auto`, `resolve_ref` não procura mais `refs/remotes/origin/<ref>` nem tags: resolve só `"$REF^{commit}"` e exige `TARGET_SHA == REF` (senão `die1`). Teste: uma branch no origin chamada com o SHA pedido e apontando para outro commit não muda o plano.
- **I2 (corrigido):** o cabeçalho do exemplo do `sshd` e o passo do dono guardam `sshd -T -C user=root,host=x,addr=127.0.0.1` em `/root/sshd-antes.txt` antes de instalar, geram `/root/sshd-depois.txt` depois do `sshd -t` e exigem `diff` vazio antes do `systemctl reload ssh` (teste de texto confere a ordem).
- **Sugestões aplicadas:** (1) grupo de concorrência `deploy-production-${{ github.event_name }}`, para o dry-run manual não substituir um deploy real pendente (os dois juntos no servidor: a trava recusa o segundo com 1); (2) mensagem "o mais novo será publicado se o CI dele passar"; (3) com `CHECK_OWNERSHIP=true` (o instalado), o programa de entrada confere, antes do `exec`, que o `deploy.sh` e a pasta `deploy/` são do `TRUSTED_UID` (0) e sem escrita para grupo e outros (o `entry.conf` continua exigindo modo 600); o teste roda no Linux com o próprio uid como dono confiável e cobre `deploy.sh` 775, pasta 757, `entry.conf` 644 e outro dono; (4) o teste compara o `if:` do job inteiro, normalizado, com o texto esperado (uma disjunção a mais falha); (5) `actions: read` removido (a leitura de `git/ref` só precisa de `contents: read`); (6) o `entry.conf.example` diz que `MIGRATIONS` é reservada e só aceita `auto`.
- **Risco residual (declarado):** quem tiver a chave de deploy consegue publicar **qualquer commit da `main` mais novo que o em execução, inclusive um cujo CI falhou** (o servidor não consulta o CI; quem filtra pelo CI verde é o workflow). Não consegue voltar versão, escolher outro ambiente, rodar migration destrutiva (`--allow-breaking` nunca é passado), reimplantar com `--force`, abrir terminal, encaminhar porta nem executar outra coisa.
- **Verificação depois das correções (Windows + Git Bash, Node 24.18):** `pnpm typecheck`, `pnpm lint` e `pnpm format:check` verdes; `deploy-workflow.test.ts` 11/11, `ci-workflow.test.ts` 9/9, `deploy-scripts.test.ts` 56/56 e `deploy-script.behavior.test.ts` 66 verdes, 9 pulados com aviso (link simbólico, inclusive o B1 completo; `flock`; modo de arquivo, inclusive a conferência de dono do programa de entrada), 0 falhas. `shellcheck` e `actionlint` continuam **não rodados** localmente; os pulados rodam no CI Ubuntu.

### Configuração no servidor e no GitHub e primeiro deploy automático (2026-11-12)

- **Servidor (dono, como `root`, seguindo `docs/ops/deploy.md`):** usuário `soprei-deploy` (sem senha, fora do grupo `sudo`), programa de entrada em `/usr/local/sbin/soprei-deploy-entry`, `entry.conf` com `ENABLED=true`, `MIGRATIONS=auto` e `ALLOW_UNSTAGED=true` (o staging ainda não existe), `sudoers`, `authorized_keys` com `restrict` e `command=`, e o bloco `Match` do `sshd` (o `diff` da configuração do `root` saiu vazio antes do reload).
- **Defeitos achados na configuração (corrigidos):**
  - O `sudoers` com `Defaults ... !requiretty` foi recusado pelo `visudo`, porque o Ubuntu 26.04 usa o `sudo-rs`. A linha saiu (PR #4).
  - O pedido começa com `-` e o programa `ssh` aceita opções depois do destino, então saía com 255 (`unknown option -- -`) sem chegar ao servidor. O `deploy.yml` e o passo 5 de `docs/ops/deploy.md` ganharam `--` antes do destino, com asserção no `deploy-workflow.test.ts` (PR #5, publicado à mão em `53f06f2`).
- **Conferências à mão pela chave (passos 6 e 8):**
  - pedido vazio e pedido fora do formato: 64;
  - pedido de terminal: recusado;
  - túnel de porta para o backend: recusado (`curl` sem resposta);
  - dry-run de `53f06f2`: 0, com o pedido aceito registrado no `journalctl`.
- **GitHub:** os três segredos no ambiente `production`, `DEPLOY_SSH_USER` e `DEPLOY_ENABLED=true`.
  - Dry-run manual pelo Actions de `53f06f2`: **0**.
  - Dry-run de `162b122` (antigo da `main`): **1**, com "mais antigo que a versão em execução… Nada foi alterado".
  - Dry-run do SHA de uma branch: 1 (informado pelo dono).
- **CI vermelho não publica:** o CI da `main` em `53f06f2` falhou num e2e instável do celular (o menu não abria depois de trocar de empresa) e o run do Deploy apareceu pulado, já com `DEPLOY_ENABLED` ligado. O teste foi corrigido no PR #6 (`openMenu` tenta de novo com `expect.toPass`).
- **PR com CI verde não publica:** o CI do PR #6 passou e nenhum run do Deploy foi criado para ele.
- **Primeiro deploy automático:** depois do merge do PR #6, o CI da `main` em `4234312` ficou verde e o Deploy rodou sozinho.
  - Saída **0**, `53f06f2 -> 4234312`, nenhuma migration (o backup antes da migration rodou mesmo assim).
  - Saúde confirmada com 5 respostas boas seguidas, app no ar, sem reinício.
  - Tempo total 50 s; **indisponibilidade medida de 3,16 s**.
- **Ainda aberto:**
  - o staging (E2): enquanto ele não existir, `ALLOW_UNSTAGED=true` deixa a produção aceitar SHA que não passou pelo staging.
