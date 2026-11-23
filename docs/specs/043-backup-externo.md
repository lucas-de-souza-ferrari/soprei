# 043 — Backup externo do banco e teste de restauração

- **Status:** rascunho
- **Branch:** `spec/043-backup-externo`
- **Depende de:** 037 (deploy, programa de cópia antes de migration, padrão dos scripts de `deploy/`), 032 (prazo de 35 dias das cópias, D8). Substitui a etapa **E5 da spec 033** (rascunho, escrita antes de a produção existir); o resto da 033 não é tocado.
- **Esta spec passa pelo `reviewer`** antes do merge: o banco inteiro (dados pessoais de todas as empresas) sai do servidor, e há chave e credencial novas.
- **Fatos externos** (preço, franquia e permissões do armazenamento, opções das ferramentas) **não foram lidos na fonte nesta sessão**: o que está marcado **(S#)** é suposição e é conferido no E0, antes de qualquer código.

## Objetivo

A produção roda num único servidor e **não existe nenhuma cópia do banco fora dele**. Hoje há só duas cópias locais: a de antes de migration (`/usr/local/sbin/soprei-predeploy-backup`, as 3 últimas) e a diária em `/root/backups`, feita por um `soprei-backup.sh` que **não está no repositório** (horário, retenção e criptografia não conferidos). Se o servidor ou o disco se perder, perdem-se todas as empresas, conversas, assinaturas e as credenciais cifradas do WhatsApp. Esta spec põe no repositório um backup diário, cifrado antes de sair, enviado para fora do provedor do servidor, com aviso quando ele para e com restauração testada.

## Estado atual (conferido no repositório em 2026-11-23)

- `deploy/backup/soprei-predeploy-backup.example`: `pg_dump -Fc soprei` como o usuário `postgres` (`/usr/sbin/runuser`), sem senha em argumento, `umask 077`, grava em `.tmp` e renomeia, guarda 3. O cabeçalho diz "NÃO É BACKUP".
- O deploy automático (037) chama programas com `PATH=/usr/local/bin:/usr/bin:/bin`; por isso os scripts usam caminho completo para o que fica em `/usr/sbin`.
- O CI roda `shellcheck deploy/*.sh` (job `static`; `ci-workflow.test.ts` fixa esse comando) e há testes dos scripts com dublês no `PATH` (`deploy-script.behavior.test.ts`) e de texto (`deploy-scripts.test.ts`).
- O sistema não guarda arquivo fora do banco: documentos da base de conhecimento, catálogo, agenda e credenciais cifradas estão no PostgreSQL. O Redis guarda sessões, limites e a fila.
- Segredos que **não** estão no banco e sem os quais um backup restaurado não serve: `backend/.env` da produção, em especial `CHANNEL_CREDENTIALS_KEYS` (sem ela nenhum token do WhatsApp decifra) e `JWT_SECRET`.
- A spec 032 (E4, não implementada) prevê reaplicar exclusões depois de restaurar; esse comando ainda não existe.

## Comportamento esperado

### E0 — Passo zero (dono, antes do código)

O dono escolhe o destino (D1), cria o bucket e a credencial, gera o par de chaves de cifra **no computador dele** e confere S1 a S4. O resultado (sem segredo) é registrado nesta spec.

### E1 — Script de backup, agendamento e runbook

1. **`deploy/backup/soprei-backup.sh`** (versionado; instalado à mão pelo dono como `/usr/local/sbin/soprei-backup`, root, 755, como o programa de entrada da 037; um merge não o reinstala). Sem argumentos obrigatórios; `--dry-run` mostra o que faria sem gerar, enviar nem apagar nada.
2. **Configuração** em `/etc/soprei-backup/backup.conf` (root, modo 600; exemplo em `deploy/backup/backup.conf.example`), lida linha a linha **sem `source`**, com chaves fixas e valores validados por formato:
   - `DB_NAME` (padrão `soprei`), `LOCAL_DIR` (padrão `/var/backups/soprei`), `LOCAL_KEEP_DAYS` (padrão 7), `REMOTE_KEEP_DAYS` (padrão 35);
   - `AGE_RECIPIENT`: a chave **pública** de cifra (`age1...`). A chave privada **nunca** fica no servidor;
   - `REMOTE`: destino do `rclone` no formato `nome:bucket/pasta`. A credencial do armazenamento fica só no arquivo de configuração do `rclone` (root, 600), nunca neste arquivo, em argumento ou em log;
   - `PING_URL` (opcional): endereço do serviço de aviso (D4);
   - `STATUS_FILE` (padrão `/var/lib/soprei-backup/status`).
3. **Sequência**, com `set -euo pipefail`, `umask 077` e trava (`flock`) contra duas execuções ao mesmo tempo:
   1. `pg_dump -Fc` como `postgres` para `LOCAL_DIR/soprei-<UTC>.dump.tmp`; só ganha o nome final se terminar bem;
   2. cifra com `age -r <AGE_RECIPIENT>` para `.dump.age.tmp` e renomeia;
   3. envia **só o arquivo cifrado** com `rclone copyto`;
   4. confere que o objeto remoto existe e tem o mesmo tamanho do arquivo cifrado local (falha se não);
   5. apaga cópias locais (claras e cifradas) com mais de `LOCAL_KEEP_DAYS` dias e sobras `.tmp`;
   6. expiração remota conforme a D3;
   7. grava o `STATUS_FILE` (hora UTC, resultado, tamanho em bytes, nome do arquivo; nenhum segredo) e, com sucesso e `PING_URL` definida, faz **um** `GET` sem corpo e sem dado nenhum.
4. **Falha em qualquer passo:** código de saída diferente de zero, `STATUS_FILE` com o passo que falhou, nenhum aviso de sucesso, nenhuma cópia antiga apagada. O arquivo cifrado local que não subiu é reenviado na execução seguinte.
5. **Agendamento:** `deploy/backup/soprei-backup.service.example` e `soprei-backup.timer.example` (systemd, diário em horário de pouco uso, `Persistent=true`, `Nice` e `IOSchedulingClass` baixos). A cópia antes de migration (037) continua como está.
6. **`deploy/backup/soprei-restore-check.sh`**: recebe o caminho de um arquivo `.dump.age` e o de um arquivo de identidade do `age`; decifra, restaura num banco temporário de nome fixo `soprei_restore_check` (recusa qualquer outro nome e recusa rodar se o banco já existir), confere que as tabelas principais existem e têm linhas, imprime só contagens e apaga o banco temporário e o arquivo decifrado, inclusive quando falha.
7. **`docs/ops/backup.md`** (runbook): instalação passo a passo; o que guardar fora do servidor (D5); como restaurar a produção do zero; o que **não** volta (Redis: sessões e fila) e o que precisa ser refeito à mão (exclusões de dados pedidas depois da data do backup, enquanto a E4 da 032 não existir); RPO de 24 h e RTO a medir no primeiro teste.
8. **CI:** o `shellcheck` passa a cobrir `deploy/backup/*.sh` (e `ci-workflow.test.ts` acompanha).
9. **Um agente nunca executa esses scripts no servidor, nunca vê a credencial do armazenamento nem a chave privada.** Os testes usam dublês.

### E2 — Primeira restauração real (dono)

Depois do primeiro backup real: o dono baixa o arquivo, roda o `soprei-restore-check.sh` numa máquina que não seja a produção (ou no próprio servidor, levando a chave privada só pelo tempo do teste, D6), mede o tempo e registra na spec. A partir daí, uma vez por mês.

## Critérios de aceite

Todos por teste automatizado com dublês de `pg_dump`, `runuser`, `age`, `rclone`, `flock` e `curl` no `PATH` (novo `backend/src/backup-script.behavior.test.ts`, no molde do teste do deploy), salvo os marcados **[dono]**.

- [ ] Execução normal: gera o dump, cifra, envia só o arquivo `.age`, confere o tamanho remoto, grava o `STATUS_FILE` com resultado `ok` e sai com 0.
- [ ] O dublê do `rclone` nunca recebe o caminho de um arquivo não cifrado.
- [ ] `pg_dump` que falha: sai com código diferente de 0, não cifra, não envia, não apaga cópia antiga e não faz o aviso de sucesso; o `.tmp` não sobra.
- [ ] Envio que falha ou tamanho remoto diferente: sai com código diferente de 0, o arquivo cifrado local fica, nenhuma cópia antiga é apagada, `STATUS_FILE` aponta o passo.
- [ ] Na execução seguinte a uma falha de envio, o arquivo cifrado pendente é enviado junto com o novo.
- [ ] Expiração local: arquivos com mais de `LOCAL_KEEP_DAYS` dias somem; os mais novos ficam; nada fora de `LOCAL_DIR` e fora do padrão de nome `soprei-*.dump*` é tocado.
- [ ] Duas execuções simultâneas: a segunda sai sem fazer nada, com código próprio.
- [ ] `--dry-run` não chama `pg_dump`, `age`, `rclone` (exceto listagem) nem `curl`, e não cria nem apaga arquivo.
- [ ] Configuração ausente, com modo mais aberto que 600, com chave desconhecida, com `AGE_RECIPIENT` que não começa por `age1` ou com `REMOTE` fora do formato: sai com erro antes de qualquer passo.
- [ ] Sentinelas de segredo postas na configuração do `rclone` falsa e no ambiente não aparecem na saída, no `STATUS_FILE` nem nos argumentos registrados pelos dublês; o script não tem `set -x`, `source` nem `eval` (teste de texto, como `deploy-scripts.test.ts`).
- [ ] O `PING_URL` é chamado uma única vez, só com sucesso, por `GET`, sem corpo e sem parâmetro acrescentado pelo script.
- [ ] `soprei-restore-check.sh`: recusa nome de banco diferente de `soprei_restore_check`, recusa se o banco já existe, e apaga o banco temporário e o arquivo decifrado também quando a restauração falha.
- [ ] `shellcheck deploy/backup/*.sh` no job `static`, travado por `ci-workflow.test.ts`.
- [ ] `docs/ops/backup.md` existe e está na documentação de operação citada pelo README e pelo `AGENTS.md` (seção do deploy).
- [ ] **[dono]** Primeiro backup real no destino escolhido, com o tamanho registrado.
- [ ] **[dono]** Restauração de um backup real concluída fora do banco de produção, com o tempo medido registrado (RTO real).
- [ ] **[dono]** Aviso de backup parado disparado de propósito (timer desligado por um ciclo) e recebido.

## Casos de borda e erros

- **Disco cheio:** o dump falha, o `.tmp` é removido, nada antigo é apagado nessa execução; o runbook diz o que apagar à mão.
- **Rede fora ou credencial revogada:** falha no envio; o backup do dia fica local e cifrado; o aviso de parado chega ao dono depois do prazo (D4).
- **Relógio:** nomes e prazos em UTC.
- **Servidor comprometido:** quem toma o servidor lê o banco de qualquer jeito; a cifra protege o que está no armazenamento externo, e a D3 trata de o invasor não conseguir apagar os backups antigos.
- **Perda da chave privada:** todos os backups ficam ilegíveis. O runbook manda guardar duas cópias fora do servidor (D5) e o teste mensal de restauração prova que a chave ainda existe.
- **Restaurar ressuscita dado apagado:** um backup anterior a um pedido de exclusão traz o dado de volta. Até a E4 da 032, o runbook manda o dono manter a lista de exclusões atendidas e refazê-las depois de restaurar.
- **Staging:** não tem backup (banco descartável, só dado sintético) e **nunca** recebe um backup da produção (regra da 037).

## Isolamento entre empresas

Não há acesso a dados por código da aplicação. O backup é do banco inteiro, de todas as empresas: por isso sai do servidor **só cifrado**, a chave privada fica só com o dono e o teste de restauração imprime apenas contagens, nunca conteúdo.

## Fora de escopo

- Recuperação a um instante (arquivamento de WAL): fica para quando o prejuízo de perder até 24 h justificar.
- Backup do Redis (D7) e do staging.
- Monitoramento e alertas em geral (033, E6); aqui só o aviso de backup parado.
- Reaplicar exclusões automaticamente depois de restaurar (032, E4).
- Limite de idade de 35 dias na cópia antes de migration (item da 032).
- Backup automático do `.env` (D5: é manual, no gerenciador de senhas do dono).

## Decisões e dependências novas

Nenhuma dependência no `package.json`. No servidor, dois programas novos instalados pelo dono: `age` (cifra) e `rclone` (envio), ambos do repositório da distribuição (S3). Decisões para o dono:

- **D1 — Destino.** Recomendado: **Cloudflare R2** (o dono já tem conta na Cloudflare para o DNS; é outro provedor que não o do servidor; S1: franquia gratuita cobre o volume inicial). Alternativas: Backblaze B2; Hetzner Storage Box (mais simples, porém no mesmo provedor do servidor: um problema com a conta derruba servidor e backup juntos).
- **D2 — Cópia local.** Recomendado: manter 7 dias de cópia local **clara e cifrada** (restauração rápida sem depender da chave privada; o servidor já tem o banco em claro, então não aumenta a exposição). Alternativa: local só cifrada.
- **D3 — Expiração remota e proteção contra apagar.** Recomendado: expiração de 35 dias por **regra de ciclo de vida do bucket** e credencial do servidor **sem permissão de apagar** (S2), para que um invasor no servidor não destrua os backups; o script então não apaga nada no remoto. Alternativa: o script apaga com `rclone delete --min-age`, e a credencial pode apagar.
- **D4 — Aviso de backup parado.** Recomendado: serviço externo de "sinal de vida" (o script avisa a cada sucesso; se passar de 36 h sem aviso, o serviço manda e-mail ao dono; S4). Só um `GET`, nenhum dado sai. Alternativa: sem serviço externo, o dono confere o `STATUS_FILE` uma vez por semana.
- **D5 — Segredos.** Recomendado: fora do backup automático. O dono guarda no gerenciador de senhas dele, em duas cópias: a chave privada do `age`, o `backend/.env` da produção (com `CHANNEL_CREDENTIALS_KEYS` e `JWT_SECRET`) e a credencial do armazenamento; atualiza quando trocar um segredo. Alternativa: cifrar e enviar o `.env` junto (mais automático, mas junta dado e chave no mesmo lugar).
- **D6 — Onde testar a restauração.** Recomendado: no computador do dono ou numa máquina temporária, nunca deixando a chave privada no servidor. Alternativa: no próprio servidor, com a chave levada e apagada no mesmo comando.
- **D7 — Redis sem backup externo.** Recomendado: confirmar (sessões se refazem com novo login; a Meta reenvia webhooks; cotas e limites recomeçam). Registrar em `docs/context.md`.
- **D8 — Horário e prazos.** Recomendado: diário às 03:30 de Brasília, 7 dias locais, 35 dias remotos (o prazo da D8 da 032).
- **D9 — O `soprei-backup.sh` que já roda no servidor.** Recomendado: desligar depois do primeiro backup novo bem-sucedido e apagar `/root/backups` passados 7 dias. Alternativa: manter os dois por um mês.

Suposições a conferir no E0:

- **S1:** preço e franquia do armazenamento escolhido para cerca de 35 arquivos do tamanho do dump atual.
- **S2:** o destino permite credencial restrita a um bucket, com escrita e leitura e sem apagar, e regra de expiração por idade.
- **S3:** `age` e `rclone` existem no repositório do Ubuntu do servidor, em versão que tenha `rclone copyto` e `rclone lsjson`.
- **S4:** o serviço de sinal de vida escolhido aceita um `GET` simples e avisa por e-mail depois de 36 h.
- **S5:** tamanho atual do dump (`pg_dump -Fc`) e tempo que ele leva no servidor.
