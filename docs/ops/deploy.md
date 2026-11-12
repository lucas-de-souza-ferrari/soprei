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
                 [--allow-unstaged] [--inject-health-failure]
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
- **Migration que falha no meio:** o Prisma aplica cada migration numa transação; se falhar, ela fica registrada como falha e o próximo `migrate deploy` recusa até alguém resolver (`prisma migrate resolve`, decisão do dono, caso a caso). Conferir: `cd /var/www/soprei/backend && pnpm exec prisma migrate status` (com `DATABASE_URL` no ambiente, extraída do `.env` sem `source`). O script, nesse caso, **não troca nada**, restaura a árvore e sai com 2.

## Falhas e o que fazer

| Situação                                                                     | O que acontece                                                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env` não vale para a versão nova (variável nova obrigatória, valor inválido) | `config:check` no build novo falha **antes** da migration e de derrubar o processo; lista só os **nomes** das variáveis. Saída 2, sem indisponibilidade. Corrija o `.env`. |
| Build, instalação ou `db:generate` falham                                    | A árvore volta à versão anterior; o processo em execução nunca foi tocado. Saída 2.                                                          |
| Saúde não confirma (não responde, `/health/ready` 503, ou o PM2 reinicia o processo em laço) | Rollback automático: Git de volta ao SHA anterior, reinstala, recompila, recarrega e espera a saúde. Saída 2. Se o banco ou o Redis estão fora, o problema é de infraestrutura, não do código: o aviso final explica. |
| Rollback falhou                                                              | Saída 3, `INTERVENÇÃO MANUAL`. Conferir: `git -C <app> status`, `pm2 describe <app>`, `prisma migrate status`, o log do deploy. Depois de resolver, `--ref <SHA bom> --force`. |
| `SIGHUP` (queda do SSH)                                                      | Ignorado: o deploy continua e a saída também vai para o log.                                                                                  |
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
- O script funciona como `root` (como hoje) e como um usuário dedicado; o usuário dedicado `soprei` só passa a ser necessário se um dia o disparo por GitHub Actions (E3, adiada) for feito.
- `config:check` (`pnpm --filter soprei-backend config:check`, dentro de `backend/`) valida o `.env` do diretório atual com o mesmo schema do boot, sem abrir conexão: imprime `ok` ou só os nomes das variáveis inválidas.

## Medição de memória (E2)

Depois de uma semana de uso e de pelo menos 3 deploys: `free -m` e `pm2 monit` com o **pior pico** registrado, comparado com a tabela de memória da spec 037; ajuste `max_memory_restart` do staging se preciso. Se o servidor ficar perto do teto, desligue o staging fora do horário de ensaio (`pm2 stop soprei-staging`).
