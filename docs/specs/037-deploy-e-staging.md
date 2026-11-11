# 037 — Deploy com rollback e staging

- **Status:** rascunho
- **Branch:** `spec/037-deploy-e-staging` (um PR por etapa: E1, E2 e, se o dono quiser, E3)
- **Depende de:** 033 (esta spec **recorta** dela a E4, deploy, e a D7, staging; o resto continua lá), 036 (`.nvmrc`, versão do Node de PRs e produção), 034 (`SHUTDOWN_TIMEOUT_MS`), 032 (nenhum dado real vai ao staging enquanto ela não existir).
- **Observação de numeração:** conferido em `docs/specs/` em 2026-11-11: existem 001 a 034 e 036 em arquivo (a 035 está **reservada** para "eficiência do turno" e não tem arquivo); esta é a **037**.
- **Esta spec passa pelo `reviewer`** antes do merge (acesso ao servidor, chave SSH de deploy, segredos, script que roda com privilégio, isolamento entre staging e produção).
- **Fatos externos e do servidor que não foram lidos na fonte** (sem rede, sem acesso ao servidor) estão marcados **(S#)** e listados em "Suposições a conferir". O que vem do dono (estado do servidor) está marcado como **relatado**.
- **Nada de código de produção foi escrito** para esta spec. Marcação: **[CÓDIGO]** = entra num PR do repositório; **[DONO]** = passo manual no servidor ou em painel de terceiros; **[DOC]** = documento.

## Objetivo

A produção já existe (servidor próprio do dono, montada à mão em 2026-11-11) e hoje cada atualização é uma sequência de comandos digitados (`git pull`, `pnpm install`, `build`, `migrate`, `pm2 reload`) sem checagem, sem volta e sem ensaio: um erro de configuração já deixou o processo em laço de reinício. Esta spec entrega **(1)** um `deploy.sh` versionado, executável com **um comando**, que aplica a versão pedida, espera o sistema responder e **volta sozinho ao código anterior** se não responder; **(2)** um **staging no mesmo servidor**, isolado da produção (banco, Redis, e-mail, segredos), onde a mesma revisão é ensaiada antes de ir à produção; e **(3, opcional e adiável)** o disparo desse deploy por GitHub Actions, com aprovação do dono.

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
| **E3** | **(opcional, adiável)** disparo por GitHub Actions com aprovação do dono                                       | CÓDIGO + DONO           |

**Ordem: E1, depois E2, depois E3.** A E1 sozinha já tira o risco principal (deploy sem volta); a E2 depende dela (usa o mesmo script); a E3 só vale a pena depois de o script ter rodado bem por algumas semanas e **o dono pode adiá-la sem prejuízo** para o resto (D9).

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

### D9 Fazer a E3 (GitHub Actions) agora?

- **Recomendação: adiar.** Faça E1 e E2, use o script à mão por algumas semanas e só então decida. A E3 conecta o GitHub ao servidor, o que **aumenta a superfície de ataque**, e economiza pouco (um comando SSH).
- **Alternativa:** fazer junto. Só com o usuário dedicado (D10), nunca com `root`.

### D10 Usuário dedicado para o serviço

- **Recomendação: criar o usuário `soprei` (sem shell de login interativo para terceiros), dono de `/var/www/soprei*` e do PM2, antes de qualquer E3.** Hoje tudo roda como `root`: o `pnpm install` executa scripts de dependências como `root`, e uma chave de deploy teria poder total sobre o servidor. Com o usuário dedicado, o pior caso de um deploy comprometido fica restrito ao Soprei. Para a E1 e a E2 (o dono entra por SSH e roda o script) continua valendo `root`, como hoje; o script funciona com os dois.
- **Alternativa:** manter `root` e não fazer a E3.

### D11 Quando a produção publica (só vale com E3)

- **Recomendação:** produção por **tag `v*`** criada pelo dono (a tag é a decisão consciente), staging por `workflow_dispatch` ou pela mesma tag antes da produção. A E1 aceita **qualquer** ref (branch, tag ou SHA) rodada à mão.

### D12 `config:check` nesta spec

- **Recomendação: sim, o mínimo** (item 7 de "O que muda em relação à 033"): pouco código, evita o erro que já aconteceu. **Alternativa:** deixar para a 033 e aceitar o laço de reinício como sinal de falha (então o rollback passa a ser a única proteção contra `.env` inválido, **com** indisponibilidade).

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

## E3 — Disparo por GitHub Actions [CÓDIGO + DONO] (opcional, cortável, pode ser adiada; D9)

**Só depois de E1 e E2 estarem em uso e do usuário dedicado (D10).** Arquivo novo `.github/workflows/deploy.yml`:

- **Gatilhos:** `workflow_dispatch` (entradas: ambiente `staging` ou `production` e a ref) e `push` de tag `v*` (D11: roda o staging e, **depois da aprovação do dono**, a produção do **mesmo** SHA).
- **Jobs em sequência:** (1) `resolve`: resolve o SHA e **recusa** se ele não é ancestral da `main` (um commit de branch de PR não é implantável); (2) `ci-gate`: consulta a API do GitHub (`GITHUB_TOKEN` com permissões só de leitura de `checks` e `actions`, **S23**) e **exige que o workflow CI desse mesmo SHA tenha terminado com sucesso**; (3) `deploy` com `environment: staging` ou `production` (**produção com aprovação obrigatória do dono**, e restrição das refs que podem usar o ambiente a `main` e `v*`), `concurrency` por ambiente **sem** `cancel-in-progress` (um deploy em andamento nunca é cancelado).
- **SSH:** o programa `ssh` nativo (sem ação de terceiros para SSH, para não somar uma cadeia de suprimento), chave em segredo **do ambiente** (`DEPLOY_SSH_KEY`), `known_hosts` fixado (a impressão digital do servidor guardada como variável, `StrictHostKeyChecking=yes`), chave gravada em arquivo `600` e apagada no fim. **Nenhum outro segredo** no GitHub: nenhum `.env`, nenhuma chave da Meta, da Anthropic ou do banco.
- **O que o servidor aceita:** a chave só roda um **comando fixo**: `authorized_keys` com `command="/usr/local/sbin/soprei-deploy-entry",restrict` (**S24**), e esse programa, instalado pelo dono **fora do repositório** e de propriedade do administrador, lê `SSH_ORIGINAL_COMMAND`, valida contra uma expressão regular estrita (`--env <production|staging> --ref <[A-Za-z0-9._/-]{1,100}>`) e chama `deploy.sh` com esses dois argumentos. `from=` na chave não é prático (os endereços dos executores do GitHub são muitos e mudam, **S24**), então a mitigação é a **chave restrita ao comando**, o **usuário dedicado sem `sudo`** e o ambiente com aprovação.
- **Risco declarado (aceito se o dono fizer a E3):** o GitHub passa a guardar uma chave que **dispara a implantação** de qualquer commit que esteja na `main` ou numa tag `v*`. Quem tem permissão de escrita no repositório e de criar tag controla o que roda no servidor (o script do repositório e os scripts de instalação das dependências executam como o usuário de deploy). Mitigações: `main` protegida e aprovação do dono nos PRs, aprovação do ambiente `production`, regra de proteção das tags `v*`, usuário dedicado, chave que só serve para isso e **troca imediata** dela (o servidor e as releases ficam; a chave não alcança segredos). Se o plano do GitHub deste repositório privado **não oferecer aprovação obrigatória de ambiente** (**S23**), a E3 **não deve ser feita** sem uma alternativa equivalente (por exemplo, restringir quem pode disparar e proteger as tags).
- **Alternativa sem abrir o SSH ao GitHub:** o servidor consulta periodicamente por uma tag nova e a publica sozinho (puxar em vez de empurrar). Menos superfície, mais uma peça em execução e **sem** a aprovação do GitHub; não detalhada aqui.

## Critérios de aceite

Os itens **[teste]** são automatizados no CI sem servidor; os **[manual]** são do dono no servidor, com o resultado registrado no "Registro da implementação" da spec (data e resultado, sem segredo).

### E1

- [ ] **[teste]** `backend/src/deploy-scripts.test.ts` (lê os arquivos como texto, no modelo de `ci-workflow.test.ts`) prova em `deploy/deploy.sh`: usa `set -euo pipefail`; a lógica está dentro de funções e `main "$@"` é a última linha; **não** contém `source` nem `. ` aplicados ao `.env`, nem `eval`, nem `set -x`, nem `cat`/`echo`/`printf` do conteúdo do `.env` ou de `DATABASE_URL`; usa `flock`; ignora `SIGHUP`; a chamada de `db:migrate:deploy` vem **antes** da de `pm2 startOrReload`; existe a função de rollback e ela é chamada na falha da espera de saúde; o rollback não roda com `--allow-breaking`; `--inject-health-failure` é recusado fora de `staging`; `--env` é obrigatório.
- [ ] **[teste]** O mesmo teste prova que nenhum arquivo de `deploy/` contém segredo (varredura por padrões como `JWT_SECRET=`, `_KEY=`, `_TOKEN=`, `PSWD=` e `postgres://` seguidos de valor) e que `ecosystem.config.cjs` declara `exec_mode: 'fork'`, `instances: 1`, `kill_timeout` maior ou igual ao `SHUTDOWN_TIMEOUT_MS` padrão (lido de `env.schema.ts`) e `max_memory_restart` por app.
- [ ] **[teste]** O mesmo teste prova que `targets/staging.conf` e `targets/production.conf` **não compartilham** porta, nome de app do PM2, caminho de diretório, caminho de `.env` nem URL de saúde, e que o staging não nomeia o banco `soprei` nem a porta 6379.
- [ ] **[teste]** `shellcheck` passa em `deploy/*.sh` (passo novo no job `static` do `ci.yml`; `ci-workflow.test.ts` atualizado para conhecê-lo; ferramenta presente na imagem do runner ou instalada de forma fixa, **S25**).
- [ ] **[teste de comportamento]** `backend/src/deploy-script.behavior.test.ts` executa o `deploy.sh` com `bash` num repositório Git temporário e **dublês** de `pm2`, `pnpm`, `curl` e `node` no `PATH` (o teste é ignorado, com aviso, se não houver `bash` ou `flock`), e prova: (a) deploy bem-sucedido sai com 0 e grava o estado; (b) `--dry-run` sai com 0, não altera `HEAD`, nem o estado, nem chama `pnpm install`; (c) falha de saúde provoca o rollback, restaura o `HEAD` anterior, sai com 2 e lista as migrations não revertidas; (d) falha do rollback sai com 3; (e) migration com `DROP COLUMN` sem a marca bloqueia **antes** de qualquer mudança (saída 1, `HEAD` intacto); (f) `config:check` falho **antes** da migration não deixa migration aplicada nem derruba o processo (o dublê do PM2 não recebe `reload`); (g) segunda execução simultânea sai com 1 (trava); (h) a saída e o log **não contêm** um valor secreto sentinela posto no `.env` falso; (i) `HEAD` diferente do estado registrado recusa; (j) `--env production` com SHA diferente do staging recusa sem `--allow-unstaged`.
- [ ] **[teste]** `config:check`: com `.env` válido sai com 0 e imprime só `ok`; com variável inválida ou ausente sai com 1 e imprime **só nomes**, com um valor sentinela inválido que **não** aparece na saída; não abre conexão (o teste roda sem Postgres nem Redis).
- [ ] **[manual]** Deploy real **na produção** de uma versão nova, com `--dry-run` antes e `--adopt` na primeira vez: `/health` e `/health/ready` voltam, a indisponibilidade medida é registrada e o site novo aparece.
- [ ] **[manual]** Deploy **com migration aditiva**: o código anterior segue respondendo durante a migration (a saída lista a migration aplicada).
- [ ] **[manual]** Rollback provado **no staging** com `--inject-health-failure`: o script volta ao SHA anterior, sai com 2 e o staging responde com a versão anterior.
- [ ] **[manual]** Um `.env` do staging com um valor inválido proposital é pego pelo `config:check` **sem derrubar o processo** (indisponibilidade zero).

### E2

- [ ] **[teste]** Os exemplos em `deploy/` não contêm segredo; o exemplo do Redis do staging declara porta diferente de 6379, `bind 127.0.0.1`, `appendonly yes`, `maxmemory-policy noeviction` e `requirepass` com marcador (sem valor); `staging.env.example` declara `NODE_ENV=production`, `LLM_PROVIDER=mock`, `WHATSAPP_ENABLED=false`, `BILLING_ENABLED=false`, `CHECKOUT_ENABLED=false`, `SCHEDULE_AI_ENABLED=false` e **nenhuma** variável `INFINITEPAY_*`, `ANTHROPIC_API_KEY` nem `WHATSAPP_*` preenchida; o exemplo do nginx do staging tem `auth_basic`, `X-Robots-Tag` e `proxy_set_header Authorization ""`.
- [ ] **[teste]** O `staging.env.example` **passa** em `parseConfig` quando preenchido com valores sintéticos (o teste monta um ambiente completo com segredos descartáveis e chama `parseConfig`: se um nome de variável mudar no schema, o exemplo e o teste quebram juntos).
- [ ] **[manual]** **Isolamento do staging em relação à produção**, cada item registrado: (1) a senha do Redis do staging **não** autentica na porta 6379 e a da produção não autentica na 6380; (2) com a URL do staging, `psql` **não** consegue conectar ao banco `soprei` (negado), e a role da produção não conecta ao `soprei_staging`; (3) `redis-cli -p 6380 FLUSHDB` no staging **não** altera nenhuma chave da produção (contagem de chaves antes e depois); (4) a API do staging escuta só em `127.0.0.1:3002` e a porta não responde de fora do servidor; (5) o `JWT_SECRET` do staging é diferente (um cookie de sessão de um ambiente é recusado no outro); (6) um cadastro no staging entrega o e-mail **só** no Mailpit e **nada** chega ao SMTP real (conferir o painel do provedor de e-mail); (7) sem a senha do nginx o staging responde 401; (8) `NODE_ENV=production`, cookie `Secure; HttpOnly; SameSite=Strict`, `Origin` errado recusado.
- [ ] **[manual]** `deploy/deploy.sh --env staging` e depois `--env production` com o **mesmo SHA**; o deploy de produção com outro SHA é recusado sem `--allow-unstaged`.
- [ ] **[manual]** `free -m` e `pm2 monit` depois de uma semana de uso e de pelo menos 3 deploys, com o **pior pico** registrado e comparado com a tabela de memória (ajustar `max_memory_restart` do staging se preciso).

### E3 (se feita)

- [ ] **[teste]** `deploy.yml` (teste de texto): gatilhos só `workflow_dispatch` e tag `v*`; existe o job de CI-gate **antes** do deploy; `environment: production` com aprovação (declarado e documentado); `permissions` mínimas; **nenhum** segredo além de `DEPLOY_SSH_KEY`; **nenhuma** ação de terceiros para SSH; `StrictHostKeyChecking=yes`; `concurrency` por ambiente com `cancel-in-progress: false`; `actionlint` passa (**S25**).
- [ ] **[teste]** O programa de entrada (`deploy/soprei-deploy-entry.sh`, exemplo para o dono instalar fora do repositório) rejeita, em teste de comportamento, argumento extra, ref com `;`, `$(`, espaço ou crase, ambiente desconhecido e comando vazio, e aceita `--env staging --ref main`.
- [ ] **[manual]** Dispare pelo Actions o staging e a produção do mesmo SHA com a aprovação; tente com um SHA que não está na `main` (recusado) e com a CI vermelha (recusado); a chave **não** abre um shell interativo (`ssh` sem comando é recusado).

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

## Isolamento entre empresas

Não se aplica: nenhum acesso a dados de empresa é criado ou alterado (script, configuração, exemplos e um comando de validação de ambiente). O isolamento que esta spec cuida é **entre ambientes** (staging e produção): bancos e roles separados com `CONNECT` negado ao outro, **instância de Redis separada**, segredos diferentes (inclusive `JWT_SECRET`), e-mail capturado e nenhum dado real no staging; os critérios **[manual]** da E2 provam isso. O `reviewer` confere a segurança do pipeline e do servidor (chave SSH, comando restrito, privilégio, redação de log).

## Fora de escopo

- **Backup externo, teste de restauração, `pnpm privacy:replay`** (033, E5; 032) e **monitoramento, alertas e uptime** (033, E6). O `PRE_MIGRATION_BACKUP` desta spec é só uma cópia local de segurança.
- **CSP e cabeçalhos do site** (033, E2), **segurança de produção** (Dependabot, `pnpm audit`, 2FA; 033, E7), **runbook completo** (033, E9; aqui só `docs/ops/deploy.md`), **homologação mínima** com `APP_VERSION`, gauges e cabeçalhos da API (033, E1), **teste de carga e lançamento gradual** (033, E8).
- **Blue-green, duas instâncias da API e deploy sem nenhuma interrupção.**
- **Separar o worker do processo da API** (033, E10; 034, E4).
- **Docker, contêineres, Kubernetes, Terraform.**
- **Migrar a produção para pastas por versão** (D1, alternativa) e **rollback por `dist.prev`** (D2, alternativa).
- **Segundo app da Meta e canal WhatsApp no staging** (D6), **cobrança e checkout no staging** (a InfinitePay não tem sandbox) e **dump de produção ou dump sintético no staging** (D3; 032).
- **Cloudflare com proxy ligado** (exige `real_ip` no nginx e `TRUST_PROXY` com as faixas dela; já registrado no handoff).
- **Mover a produção para outro usuário do sistema** além do que a E3 exigir (D10) e **rotação de segredos** (033, D6).
- **Deploy automático a cada merge** (o staging só atualiza quando o dono manda).

## Riscos

- **Script com poder de `root`** (até o D10): um defeito aqui afeta o servidor inteiro; por isso `set -euo pipefail`, `shellcheck`, testes de comportamento, `--dry-run` e a revisão do `reviewer`.
- **Build no servidor de 4 GB disputa memória com a produção:** reduzido por trava única, `nice` e teto de memória do build; medido na E2.
- **Rollback não reverte migration:** é a limitação central; a política, a varredura e o `--allow-breaking` sem rollback automático existem por causa dela.
- **A varredura de migration é por texto:** alarme, não prova.
- **Staging e produção no mesmo servidor:** uma falha do servidor derruba os dois e o staging disputa memória; aceito (o staging é descartável). O isolamento de dados e de segredos não depende do servidor ser outro.
- **E3 amplia a superfície de ataque** (chave de deploy no GitHub); por isso é opcional, adiável e condicionada ao usuário dedicado e à aprovação do ambiente.

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
- **S23** Permissões necessárias do `GITHUB_TOKEN` para consultar o resultado do CI de um SHA, e se o plano do GitHub deste repositório privado oferece **aprovação obrigatória de ambiente** e proteção de tags.
- **S24** Formato de `authorized_keys` com `command=` e `restrict`, uso de `SSH_ORIGINAL_COMMAND`, e a inviabilidade de `from=` com os executores do GitHub.
- **S25** `shellcheck` vem na imagem `ubuntu-latest` e como instalar `actionlint` de forma fixa.

## Passos do dono (separados do código)

1. Responder D1 a D12 (as recomendadas valem se ele disser "aprovo tudo").
2. **Antes da E1**, no servidor: `pm2 -v`, `node -v`, `pnpm -v`, `flock --version`, `free -m` (e swap), o valor de `SHUTDOWN_TIMEOUT_MS` e se o canal está ligado, o arquivo do nginx da produção (sem segredo) e o `ecosystem.config.cjs` atual; criar `/var/log/soprei-deploy` e `/var/lib/soprei-deploy`.
3. **E1:** depois do merge, `git pull` à mão **uma última vez**, rodar `deploy/deploy.sh --env production --dry-run`, depois `--adopt`, e registrar o resultado. Substituir o `ecosystem.config.cjs` do servidor pelo versionado (`pm2 startOrReload` e `pm2 save`).
4. **E2:** DNS do staging; certificado; banco e role; Redis separado; Mailpit; `.env` do staging (segredos novos, guardados também no gerenciador de senhas); clone; primeiro `deploy.sh --env staging --adopt`; os testes de isolamento da E2; a medição de memória.
5. **E3 (só se decidir fazer):** usuário dedicado, aprovação do ambiente `production`, chave de deploy, `authorized_keys` restrito e o programa de entrada.

## Decisões e dependências novas

Dependências de pacote: **nenhuma**. Ferramentas externas no CI (sem entrar no `package.json`): `shellcheck` e, na E3, `actionlint`. Ferramentas novas no **servidor** (E2): Mailpit e a segunda instância do Redis. Arquivos novos previstos: `deploy/` (script, ecosystem, alvos, exemplos de nginx, Redis, Mailpit e `.env` do staging), `backend/src/infrastructure/config/check-cli.ts` e o script `config:check`, `.gitattributes`, `docs/ops/deploy.md`, os dois testes de `backend/src/` e, na E3, `.github/workflows/deploy.yml`. Registrar em `docs/context.md`, depois da resposta do dono, o que foi decidido (D1 a D12) e, no `docs/handoff.md`, o servidor de staging (endereço, o que roda, onde estão os arquivos, sem segredo).
