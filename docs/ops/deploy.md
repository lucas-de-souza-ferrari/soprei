# Deploy do Soprei (spec 037)

Como atualizar a produção (e o staging) com **um comando**, esperar o sistema responder e **voltar sozinho** ao código anterior se não responder. O script é `deploy/deploy.sh`; o que ele faz, passo a passo, está na [spec 037](../specs/037-deploy-e-staging.md). Este documento é o guia de uso. O runbook completo (backup externo, restauração, monitoramento) continua na spec 033.

## Visão geral

- Um clone por ambiente no mesmo servidor: produção em `/var/www/soprei`, staging em `/var/www/soprei-staging` (ver [staging.md](staging.md)). O `.env` de cada um fica em `<clone>/backend/.env` (modo 600, nunca no Git).
- O script compila **no servidor**, em pastas de espera (`backend/dist.next` e `frontend/releases/<sha>-<data>`), e só troca quando tudo deu certo. O site é servido por um atalho (`frontend/dist` aponta para a release atual), então a troca e a volta do site são instantâneas.
- O processo da API é recarregado pelo PM2 (`deploy/ecosystem.config.cjs`). Com uma instância em modo fork há uma janela curta (segundos) em que o nginx responde 502; o script **mede** e registra essa indisponibilidade.
- O script que **executa** é o da versão **já instalada**, não o da versão-alvo: uma mudança no `deploy.sh` só vale a partir do deploy seguinte. Um defeito no próprio script não se corrige "pelo script quebrado": corrija o arquivo à mão (`git checkout <sha-bom> -- deploy/deploy.sh`) ou rode uma cópia boa.

## Uso

```
deploy/deploy.sh --env <production|staging> [--ref <branch|tag|sha>] [--previous]
                 [--dry-run] [--force] [--adopt] [--allow-breaking]
                 [--allow-unstaged] [--inject-health-failure] [--auto]
```

| Opção                     | O que faz                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--env`                   | **Obrigatório** (não existe padrão: nunca há "deploy sem querer na produção").                                                                             |
| `--ref`                   | Branch, tag ou SHA. Padrão `main` (resolvida em `origin/main` depois do `git fetch`).                                                                      |
| `--previous`              | Usa o SHA anterior registrado (volta manual).                                                                                                              |
| `--dry-run`               | Só leitura: faz as checagens, mostra o plano (SHAs, migrations que entram e a classificação de cada uma, espaço, Node, PM2, saúde) e sai com 0.            |
| `--force`                 | Reimplanta o mesmo SHA (sem ele, "já está nessa versão" sai com 0) e segue mesmo se o sistema já estiver fora do ar antes do deploy.                        |
| `--adopt`                 | **Primeira execução** num servidor montado à mão: registra o `HEAD` atual como "versão em execução". Sem registro e sem `--adopt`, o script recusa.        |
| `--allow-breaking`        | Autoriza migration marcada como destrutiva. **Não há rollback automático** com ele (ver "Política de migration").                                          |
| `--allow-unstaged`        | Só produção: aceita um SHA que não está no staging (emergência).                                                                                           |
| `--inject-health-failure` | Só staging: faz a primeira espera de saúde falhar de propósito, para provar o rollback sem estragar nada.                                                  |
| `--auto`                  | Modo do deploy automático (E3; quem o passa é o programa de entrada, não o dono). Só com `--ref` de 40 hexadecimais; recusa `--previous`, `--force`, `--adopt`, `--allow-breaking` e `--inject-health-failure`; depois do `git fetch`, o SHA precisa estar na `main` e não pode ser mais antigo que a versão registrada (saída 1 sem mexer). O log registra `modo=auto` (o manual, `modo=manual`). |

### Códigos de saída

| Código | Significado                                                       | O que fazer                                                                                                                                                                               |
| ------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | Deploy concluído (ou "já está nessa versão", ou `--dry-run`)      | Ler o resumo (SHAs, migrations aplicadas, indisponibilidade medida).                                                                                                                      |
| 1      | Recusado **antes** de mexer em qualquer coisa                     | Nada mudou. Ler o motivo (pré-condição, trava, versão, migration proibida, `git fetch` sem rede) e corrigir.                                                                              |
| 2      | Falhou **e** a versão anterior voltou saudável                    | `DEPLOY FALHOU; VOLTEI PARA <sha>`. O log lista as migrations aplicadas nesta tentativa e que **não** foram revertidas. Corrigir para a frente e tentar de novo.                          |
| 3      | Falhou **e** o rollback também falhou, ou o deploy tinha `--allow-breaking` | `INTERVENÇÃO MANUAL`: o script mostra o estado de cada peça (Git, PM2, banco) e os comandos de conferência, e **não tenta de novo**. Ver "Falhas e o que fazer". |

## Primeira vez num servidor montado à mão

1. Crie os diretórios (uma vez, como `root`): `mkdir -p /var/log/soprei-deploy /var/lib/soprei-deploy && chmod 700 /var/log/soprei-deploy /var/lib/soprei-deploy`. A trava é `/var/lock/soprei-deploy.lock` (global: staging e produção nunca compilam juntos, o servidor tem 4 GB).
2. Confira as ferramentas: `pm2 -v`, `node -v` (mesma major do `.nvmrc`), `pnpm -v` (a do `packageManager`), `flock --version`, `free -m` (e swap).
3. **Se o código em execução é anterior ao `deploy.sh`** (o caso do primeiro servidor, em 2026-11-12): não faça `git pull`. Busque a versão nova e rode o script **de uma cópia temporária**, com a árvore no código que está no ar; assim ele registra a versão em execução, faz a cópia do banco, migra e troca, com rollback. Tire da raiz qualquer arquivo fora do Git (por exemplo um `ecosystem.config.cjs` antigo): o script exige a árvore limpa.
   - `cd /var/www/soprei && git fetch origin && mkdir -p /root/soprei-deploy-bootstrap && git archive origin/main deploy | tar -x -C /root/soprei-deploy-bootstrap`
   - `bash /root/soprei-deploy-bootstrap/deploy/deploy.sh --env production --adopt --dry-run` (mais `--allow-unstaged` enquanto não houver staging) e, se o plano estiver certo, o mesmo comando sem `--dry-run`.
   - Depois: `rm -rf /root/soprei-deploy-bootstrap`; as próximas execuções usam o `deploy/deploy.sh` de `/var/www/soprei`.
4. **Se o código em execução já é o da `main`** (atualizado à mão): `deploy/deploy.sh --env production --adopt` registra a versão em execução e sai sem implantar nada ("já está nessa versão"). O script grava a lista do PM2 (`pm2 save`) a cada deploy ou rollback concluído. Registre o resultado na spec 037.
5. (Recomendado em produção) Instale o programa de cópia antes de migration: `deploy/backup/soprei-predeploy-backup.example` como `/usr/local/sbin/soprei-predeploy-backup` (root, 755). O alvo de produção já aponta para esse caminho; **com migration a aplicar e o arquivo ausente o script recusa** (código 1). **É cópia local, não é backup** e contém dados pessoais (retenção na spec 032).

O estado fica em `/var/lib/soprei-deploy/<ambiente>/` (`current` e `previous`, um SHA por arquivo); o log em `/var/log/soprei-deploy/<ambiente>.log` (modo 600; uma linha por evento com carimbo UTC, ambiente, SHAs curtos e usuário). O log não recebe `.env`, URL de conexão, e-mails nem dados de empresa ou contato; toda saída de comando passa por um filtro que troca URLs de conexão e valores de `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PSWD` e `JWT_SECRET` por `[redacted]` (rede de segurança: o script não imprime segredo por desenho e nunca roda `set -x`).

## Rotina

1. Merge na `main` (o merge em squash cria um SHA novo: o ensaio que vale é o da `main` **depois** do merge).
2. `deploy/deploy.sh --env staging --ref main --dry-run`, depois sem `--dry-run`.
3. Checklist no staging (entrar, criar uma empresa, abrir as abas, carregar os exemplos, ler o e-mail de confirmação no Mailpit por túnel SSH).
4. `deploy/deploy.sh --env production --ref <o mesmo SHA>`. A produção **só aceita o SHA que já está no staging** (D8); outro SHA é recusado, a menos de `--allow-unstaged` (hotfix). O resumo mostra os dois SHAs lado a lado.

Para provar o rollback no staging: `deploy/deploy.sh --env staging --ref <sha> --inject-health-failure` deve voltar ao SHA anterior, sair com 2 e o staging seguir respondendo.

## O que o script confere antes de mexer (saída 1 se falhar)

Trava global livre; árvore do Git limpa; `HEAD` igual ao SHA registrado (senão uma execução anterior parou no meio: rode `--ref <SHA> --force`; com `--force` o script aceita o `HEAD` divergente, avisa no log e, se a nova tentativa falhar, a versão de volta é a **registrada**, não o `HEAD`); Node na major do `.nvmrc`; `pnpm` na versão do `packageManager`; `.env` existente e com modo 600; pelo menos 2 GB livres; app presente no PM2 (exceto com `--adopt`); sistema respondendo agora (senão só segue com `--force`); `git fetch` funcionando; SHA do staging (produção); varredura das migrations que entram.

## Política de migration (como o rollback fica seguro)

O rollback volta o **código**; **migration nunca é revertida** (o Prisma não tem "voltar").

- **Regra:** toda migration deve ser **aditiva e compatível com a versão anterior do código** (coluna nova anulável ou com valor padrão, tabela nova, índice novo, valor novo de enum que só o código novo usa). Assim voltar o código é seguro mesmo com a migration aplicada.
- **Aditiva não é o mesmo que compatível.** Parecem aditivos e **quebram** o código antigo: um índice **único** que a escrita antiga viola, um `CHECK` novo que dados gravados pela versão antiga violam, uma coluna `NOT NULL` com padrão que o código antigo sobrescreve com nulo. O revisor confere a compatibilidade em todo PR com migration.
- **Como reconhecer uma migration não aditiva:** o `--dry-run` e o deploy **listam os arquivos de migration que entram** e **bloqueiam** (saída 1, nada alterado) os que contêm `DROP`, `RENAME`, `SET NOT NULL`, `ALTER COLUMN ... TYPE`, `TRUNCATE` ou `DELETE FROM` (inclui remoção de valor de enum, que o Prisma faz por `RENAME`/`DROP`) **sem** a linha `-- breaking-approved: <motivo>`. A varredura é por texto: **alarme, não prova** (falso positivo, como um `DROP` de coluna criada na mesma migration, e falso negativo em SQL incomum são possíveis). **Lacunas conhecidas, que NÃO disparam o alarme e quebram o código antigo:** `ADD COLUMN ... NOT NULL` sem valor padrão, índice **único** novo, `CHECK` novo, chave estrangeira nova que a escrita antiga viola. Só a revisão do PR pega esses casos.
- **Instalar dependências e código gerado com o processo antigo no ar (D1, risco aceito):** o `pnpm install` e o `db:generate` mexem em `node_modules` e no cliente gerado do Prisma enquanto o processo antigo ainda roda; módulos carregados depois (importação tardia) podem vir da versão nova. Se o processo antigo cair nessa janela, o rollback refaz o caminho.
- **Mudança destrutiva inevitável:** duas versões em sequência (**expandir**: adicionar o novo e passar o código a usá-lo; **contrair**, numa versão posterior: remover o antigo). Se o dono decide por uma versão só: a marca no arquivo, `--allow-breaking`, o backup antes da migration (em produção **exigido**: sem `PRE_MIGRATION_BACKUP` no alvo e com sucesso, o script recusa) e **sem rollback automático**: se a saúde falhar, o script para em `INTERVENÇÃO MANUAL` e manda restaurar o backup feito antes da migration ou corrigir para a frente.
- **Valor novo de enum que a versão anterior LÊ (spec 039, `message_role` = `HUMAN`):** a migration `20261112100000_channel_coexistence` é aditiva e passa na varredura, mas **a versão anterior do código falha ao ler uma mensagem `HUMAN`** (o Prisma antigo não conhece o valor). O desenho escolhido: nenhuma linha `HUMAN` é gravada enquanto `WHATSAPP_COEXISTENCE_ENABLED` estiver desligada (o eco só é tratado com ela ligada). Portanto: (1) faça o deploy da 039 com a flag **desligada** (o rollback para a versão anterior continua seguro); (2) ligue a flag só depois de o deploy da 039 estar estável; (3) **depois do primeiro eco gravado, não volte o código para antes da 039** (o rollback automático entre versões posteriores continua seguro, porque elas conhecem o valor). Se precisar voltar mesmo assim: desligue a flag, espere a fila esvaziar e corrija para a frente; não apague as mensagens `HUMAN` (são dados).
- **Migration que falha no meio:** o Prisma aplica cada migration numa transação; se falhar, ela fica registrada como falha e o próximo `migrate deploy` recusa até alguém resolver (`prisma migrate resolve`, decisão do dono, caso a caso). Conferir: `cd /var/www/soprei/backend && pnpm exec prisma migrate status` (com `DATABASE_URL` no ambiente, extraída do `.env` sem `source`). O script, nesse caso, **não troca nada**, restaura a árvore e sai com 2.

## Falhas e o que fazer

| Situação                                                                     | O que acontece                                                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env` não vale para a versão nova (variável nova obrigatória, valor inválido) | `config:check` no build novo falha **antes** da migration e de derrubar o processo; lista só os **nomes** das variáveis. Saída 2, sem indisponibilidade. Corrija o `.env`. |
| Build, instalação ou `db:generate` falham                                    | A árvore volta à versão anterior; o processo em execução nunca foi tocado. Saída 2.                                                          |
| Saúde não confirma (não responde, `/health/ready` 503, ou o PM2 reinicia o processo em laço) | Rollback automático: Git de volta ao SHA anterior, reinstala, recompila, recarrega e espera a saúde. Saída 2. Se o banco ou o Redis estão fora, o problema é de infraestrutura, não do código: o aviso final explica. |
| Rollback falhou                                                              | Saída 3, `INTERVENÇÃO MANUAL`. Conferir: `git -C <app> status`, `pm2 describe <app>`, `prisma migrate status`, o log do deploy. Depois de resolver, `--ref <SHA bom> --force`. |
| `SIGHUP` e `SIGPIPE` (queda do SSH, job cancelado)                           | Ignorados: o deploy continua até o fim (com rollback se precisar) e a saída continua indo para o log, mesmo com quem lia a saída já desconectado. |
| `SIGINT`/`SIGTERM` antes da migration                                        | Restaura a árvore e sai. **Depois** do início da migration são ignorados até o fim (não se para entre a migration e a saúde).                |
| Servidor sem espaço ou memória durante o build                               | O build falha, a árvore é restaurada, o processo em execução nunca foi tocado (saída 2). O `nice` e o teto de memória do build reduzem o risco de o PM2 ser sacrificado. |
| Mesmo SHA                                                                    | Sai com 0 ("já está nessa versão"); `--force` reimplanta.                                                                                     |

## Permissões de arquivos

O script roda com `umask 077` (log, estado, trava e backup ficam privados). O **build** roda com `umask 022` e a release do site recebe `chmod -R u=rwX,go=rX` (`frontend/releases` e a pasta `legacy-*`, 755): o nginx roda como outro usuário e precisa ler o site. Se mexer nessas pastas à mão, mantenha o nginx com permissão de leitura.

## Restrições (valem sempre)

- O isolamento do staging é só de configuração enquanto os dois ambientes rodam como o mesmo usuário (decisão do dono, 2026-11-11; ver [staging.md](staging.md)): só dados sintéticos até o usuário dedicado existir.

- **Nunca** restaure um `pg_dump` de produção no staging, inteiro ou parcial, enquanto a spec 032 não definir retenção e anonimização (o staging nasce vazio e é preenchido pelo próprio sistema).
- **Nunca** faça `source` do `.env` (valores com espaço e caracteres especiais quebram o shell, e o conteúdo não pode ir para o ambiente do script). Extraia o valor que precisar com `grep`/`cut`.
- Segredos, e-mail pessoal e o IP do servidor não entram no repositório.
- O deploy (manual ou automático) roda como `root`, como hoje (D10 opção A, aprovada em 2026-11-12): o deploy automático entra pelo usuário `soprei-deploy`, que não tem poder próprio e só consegue chamar, pelo `sudo` restrito, o programa de entrada. Passar a aplicação inteira para um usuário dedicado `soprei` (D10 opção B) é etapa própria, futura, exigida antes de qualquer dado real no staging (decisão I4).
- `config:check` (`pnpm --filter soprei-backend config:check`, dentro de `backend/`) valida o `.env` do diretório atual com o mesmo schema do boot, sem abrir conexão: imprime `ok` ou só os nomes das variáveis inválidas.

## Deploy automático pelo GitHub Actions (E3)

Aprovado pelo dono em 2026-11-12 (D9, D10 opção A, D11, D13 a D17 como recomendadas). Desenho e riscos: seção E3 da [spec 037](../specs/037-deploy-e-staging.md).

### Como funciona

1. O merge na `main` dispara o workflow `CI` (`ci.yml`). Quando ele termina, o GitHub dispara o `Deploy` (`.github/workflows/deploy.yml`, `workflow_run`). O job só roda se o CI terminou **com sucesso**, veio de um **push na `main` deste repositório** e a variável do repositório `DEPLOY_ENABLED` é `true`; senão aparece **pulado** (cinza).
2. Se a ponta da `main` já é outro commit (dois merges seguidos), o job termina verde com "ultrapassado": o mais novo será publicado se o CI dele passar.
3. O job entra por SSH como `soprei-deploy` e manda só o texto `--env production --ref <SHA>`. A chave do GitHub não abre terminal: o servidor força o programa de entrada (`/usr/local/sbin/soprei-deploy-entry`), que confere o texto, chama pelo `sudo` a si mesmo como `root`, relê `/etc/soprei-deploy/entry.conf` e roda `deploy/deploy.sh --env production --ref <SHA> --auto` (mais `--allow-unstaged` enquanto o staging não existir, D15) com o ambiente limpo.
4. Com `--auto`, o `deploy.sh` exige que o SHA esteja na `main` e não seja mais antigo que o em execução. Daí em diante é o deploy de sempre (varredura de migration, cópia do banco, migration, troca, saúde, rollback). **Migration marcada como destrutiva nunca roda pelo automático** (D16): o programa de entrada nunca passa `--allow-breaking`, então o deploy sai com 1 sem mexer e o dono roda à mão.
5. A saída do `deploy.sh` (já filtrada pela redação) aparece no log do job e o código de saída vira o resumo do Actions. O disparo manual ("Run workflow", com o SHA) **só faz o dry-run** (D17).

O programa de entrada que roda é a **cópia instalada** em `/usr/local/sbin/`, não o arquivo do repositório: um merge não troca o porteiro. Quando `deploy/soprei-deploy-entry.sh` mudar num PR, o dono reinstala à mão (passo 5.2 abaixo).

### Como ler o resumo do Actions

| Código | No resumo                                                                                                                       | Job      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 0      | publicado (ou "já está nessa versão", ou o plano do dry-run)                                                                    | verde    |
| 1      | recusado antes de mexer, nada mudou (trava ocupada, migration destrutiva, SHA fora da `main` ou mais antigo, `ENABLED=false`)    | vermelho |
| 2      | falhou e a versão anterior voltou saudável; lista as migrations não revertidas                                                  | vermelho |
| 3      | **intervenção manual**: entrar no servidor e seguir "Falhas e o que fazer"                                                      | vermelho |
| 64     | o programa de entrada recusou o pedido (defeito do workflow)                                                                     | vermelho |
| 255    | o SSH falhou (rede, chave, `known_hosts`); o deploy **pode não ter começado**: conferir `/var/log/soprei-deploy/production.log` | vermelho |
| outro  | resultado desconhecido (job cancelado, conexão caída): o `deploy.sh` foi feito para seguir até o fim no servidor (ignora `SIGHUP` e `SIGPIPE` e continua gravando o log); conferir o log do servidor | vermelho |

Um deploy manual do dono durante um automático (ou o contrário) é recusado pela trava global (saída 1): o próximo merge, ou o dono à mão, publica. Uma falha deixa o job vermelho e o GitHub avisa por e-mail quem disparou o evento (S33); alerta próprio fica na spec 033.

### Passos do dono, em ordem (nenhum agente toca o servidor nem o GitHub)

Onde a implementação depende de um comportamento do GitHub, do OpenSSH ou do `sudo` que não foi lido na fonte, o passo diz **como conferir** (S23 a S33 da spec).

1. **GitHub, antes do merge do PR da E3:**
   1. Proteção da `main` (Settings > Branches ou Rules): PR obrigatório; checks `static`, `tests` e as três fatias de `browser` obrigatórios; sem push direto nem `--force`. Conferir que só o dono tem escrita (Settings > Collaborators) e que o 2FA está ligado.
   2. Settings > Environments > New environment `production`; em "Deployment branches and tags", **só `main`**. Sem revisor obrigatório (D14). **Conferir S23:** se o plano da conta não oferecer ambientes (ou a restrição de branch) para repositório privado, **pare** e fale com quem implementou: o desenho depende disso.
   3. Settings > Secrets and variables > Actions > Variables (do **repositório**): `DEPLOY_ENABLED` = `false`. O workflow chega à `main` desligado.
2. **Merge do PR da E3 e deploy manual dele**, como hoje: `deploy/deploy.sh --env production --allow-unstaged` (dry-run antes). O `deploy.sh` instalado precisa ter o `--auto` antes do primeiro pedido automático.
3. **Chave**, na sua máquina: `ssh-keygen -t ed25519 -N '' -C soprei-github-deploy -f <arquivo temporário>`. A privada vai **só** para o segredo `DEPLOY_SSH_KEY` do ambiente `production` (passo 6); a pública vai para o servidor (passo 4.5). Depois do passo 5, apague os dois arquivos locais.
4. **Servidor**, como `root`, **com uma segunda sessão de `root` aberta até o fim** (para não se trancar fora):
   1. `adduser --system --group --shell /bin/sh --home /home/soprei-deploy soprei-deploy` (sem senha, fora do grupo `sudo`). O shell precisa existir: o `sshd` roda o comando forçado pelo shell do usuário (S24).
   2. `install -o root -g root -m 755 /var/www/soprei/deploy/soprei-deploy-entry.sh /usr/local/sbin/soprei-deploy-entry` (do arquivo **já implantado** no passo 2, nunca de uma branch).
   3. `install -d -o root -g root -m 700 /etc/soprei-deploy` e `install -o root -g root -m 600 /var/www/soprei/deploy/entry/entry.conf.example /etc/soprei-deploy/entry.conf` (`ENABLED=true`, `ALLOW_UNSTAGED=true`, `MIGRATIONS=auto`; o programa recusa outro dono ou modo).
   4. `visudo -f /etc/sudoers.d/soprei-deploy` com o conteúdo de `deploy/sudoers/soprei-deploy.example`; `chmod 440 /etc/sudoers.d/soprei-deploy`; `visudo -c` sem erro. O Ubuntu 26.04 usa o **sudo-rs**, que recusa opções que não conhece (por isso o exemplo não tem `!requiretty`; confirmado no servidor em 2026-11-12). **Conferir S29:** `sudo -l -U soprei-deploy` lista só a linha do programa de entrada; `grep -r requiretty /etc/sudoers /etc/sudoers.d` não mostra `requiretty` ligado para todos.
   5. `install -d -o root -g root -m 755 /home/soprei-deploy/.ssh` e o `authorized_keys` (dono `root`, modo 644) com a linha de `deploy/ssh/authorized_keys.example`, trocando o marcador pela chave pública.
   6. **Conferir S24** pelo cabeçalho de `deploy/ssh/sshd-soprei-deploy.conf.example`: **antes** de instalar, `sshd -T -C user=root,host=x,addr=127.0.0.1 > /root/sshd-antes.txt`; copie o exemplo para `/etc/ssh/sshd_config.d/soprei-deploy.conf` e rode `sshd -t` sem erro; gere `/root/sshd-depois.txt` do mesmo jeito e exija **`diff /root/sshd-antes.txt /root/sshd-depois.txt` vazio** (qualquer diferença = o bloco `Match` vazou para o `root`: não recarregue, apague o arquivo); confira com `sshd -T -C user=soprei-deploy,...` que o `ForceCommand` vale para o `soprei-deploy`; **só então** `systemctl reload ssh`.
   7. Copie a linha de `/etc/ssh/ssh_host_ed25519_key.pub` no formato `<host> ssh-ed25519 AAAA...` (o `<host>` é exatamente o que vai em `DEPLOY_SSH_HOST`) para o segredo `DEPLOY_SSH_KNOWN_HOSTS`. Nunca use `ssh-keyscan` de fora.
   8. **Conferir S28:** `sudo -u root env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root pm2 jlist >/dev/null && echo ok` responde `ok` (o `pm2`, o `node` e o `pnpm` são achados com esse `PATH` e o daemon é o do `root`).
5. **Conferir à mão, de outra máquina, com a chave temporária** (antes de apagá-la): `ssh -i <chave> -T soprei-deploy@<host>` sem comando é recusado (64) sem abrir terminal; `ssh -i <chave> soprei-deploy@<host> ls` e `ssh -i <chave> -N -L 9000:127.0.0.1:3001 soprei-deploy@<host>` são recusados (com `-N` a conexão fica aberta sem rodar nada; o que se confere é que o túnel não passa: com ela aberta, `curl -m 5 http://127.0.0.1:9000/health` falha); `ssh -i <chave> -- soprei-deploy@<host> '--env production --ref <SHA atual da main> --dry-run'` (o `--` antes do destino é obrigatório: sem ele o programa `ssh` lê o pedido, que começa com `-`, como opção e sai com 255) responde "já está nessa versão" (código 0) e `journalctl -t soprei-deploy-entry` (ou `/var/log/syslog`) mostra o pedido aceito.
6. **Segredos e variável do ambiente `production`:** `DEPLOY_SSH_KEY` (a privada), `DEPLOY_SSH_KNOWN_HOSTS` (passo 4.7), `DEPLOY_SSH_HOST` (endereço do servidor; segredo para não aparecer no log); variável do ambiente `DEPLOY_SSH_USER` = `soprei-deploy`. **Nenhum outro segredo** no GitHub (nada do `.env`).
7. **Primeiro teste pelo Actions, só dry-run:** `DEPLOY_ENABLED` = `true`; Actions > "Deploy" > "Run workflow" na `main`, com o SHA atual da `main`: o resumo mostra o código 0 e o log do servidor (`/var/log/soprei-deploy/production.log`) mostra `modo=auto`. Recusas a provar do mesmo jeito (o dry-run manual tem grupo de concorrência próprio e nunca tira da fila um deploy real pendente; se os dois chegarem juntos ao servidor, a trava recusa o segundo com 1): um SHA de uma branch de PR sai com 1; um SHA antigo da `main` sai com 1. **A partir daqui, o próximo merge publica sozinho.**
8. **Primeiro automático:** um PR pequeno (só documentação) mergeado: o CI termina, o deploy roda sozinho e o resumo mostra 0. Confira também que um PR (de branch do repositório) com CI verde **não** dispara deploy (o `Deploy` aparece pulado ou nem aparece). Registre data e resultado no "Registro da implementação" da spec 037 (sem segredo nem endereço).

### Desligar numa emergência

Qualquer um destes basta, do mais rápido ao mais definitivo:

1. **No GitHub:** Settings > Secrets and variables > Actions > Variables: `DEPLOY_ENABLED` = `false` (os próximos jobs são pulados). Ou Actions > "Deploy" > "..." > "Disable workflow".
2. **Um deploy em andamento:** **não** cancele no meio da migration. Cancelar o job do Actions ou perder a conexão não deve parar o `deploy.sh`: ele ignora `SIGHUP` e `SIGPIPE`, vai até o fim (com rollback se precisar) e continua gravando o log. Isso foi provado com a saída num pipe que fecha cedo (teste de comportamento); a queda real do SSH com o `sudo` no meio só se confere no servidor. Acompanhe com `tail -f /var/log/soprei-deploy/production.log`.
3. **No servidor:** `ENABLED=false` em `/etc/soprei-deploy/entry.conf` (todo pedido sai com 1, nada roda).
4. **Cortar o acesso:** apague a linha de `/home/soprei-deploy/.ssh/authorized_keys` e o segredo `DEPLOY_SSH_KEY` no GitHub; se a chave vazou, gere outra (passo 3). Para tirar tudo: remova também `/etc/sudoers.d/soprei-deploy` e `/etc/ssh/sshd_config.d/soprei-deploy.conf` (`sshd -t && systemctl reload ssh`).

O deploy manual (`deploy/deploy.sh` como `root`) continua funcionando em todos esses casos.

## Medição de memória (E2)

Depois de uma semana de uso e de pelo menos 3 deploys: `free -m` e `pm2 monit` com o **pior pico** registrado, comparado com a tabela de memória da spec 037; ajuste `max_memory_restart` do staging se preciso. Se o servidor ficar perto do teto, desligue o staging fora do horário de ensaio (`pm2 stop soprei-staging`).
