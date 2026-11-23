# Backup do banco fora do servidor (spec 043)

O banco de produção é copiado **todo dia**, cifrado **antes de sair** do servidor e enviado para um armazenamento de **outro provedor**. Os programas estão em `deploy/backup/`; tudo abaixo é passo do **dono** no servidor e no computador dele. Um agente nunca executa esses programas no servidor, nunca vê a credencial do armazenamento nem a chave privada.

| Peça | Onde fica |
| --- | --- |
| Programa de backup | `/usr/local/sbin/soprei-backup` (cópia de `deploy/backup/soprei-backup.sh`) |
| Configuração | `/etc/soprei-backup/backup.conf` (root, 600; sem segredo) |
| Credencial do destino | `/etc/soprei-backup/rclone.conf` (root, 600) |
| Chave **pública** de cifra | dentro do `backup.conf` (`AGE_RECIPIENT`) |
| Chave **privada** de cifra | **só** no gerenciador de senhas do dono, em duas cópias; **nunca** no servidor |
| Cópias locais | `/var/backups/soprei` (claras e cifradas, 7 dias) |
| Cópias remotas | bucket do Cloudflare R2, pasta `postgres/` (só cifradas, 35 dias) |
| Estado da última execução | `/var/lib/soprei-backup/status` e `last-run.log` (saída das ferramentas; só root) |
| Agenda | `soprei-backup.timer` (todo dia às 03:30 de Brasília) |

**O que o backup cobre:** o PostgreSQL inteiro (empresas, contas, conversas, base de conhecimento, agenda, assinaturas e as credenciais cifradas do WhatsApp). **O que não cobre:** o Redis (sessões, limites e fila: as pessoas entram de novo, a Meta reenvia os webhooks) e os **segredos** do `backend/.env` (ver "O que guardar fora do servidor").

**Perda máxima de dados (RPO): 24 horas.** O tempo para voltar (RTO) é medido no primeiro teste de restauração e anotado na spec 043.

## O que guardar fora do servidor (gerenciador de senhas, duas cópias)

Sem estes itens um backup restaurado **não serve**:

1. A **chave privada do age** (o arquivo que o `age-keygen` gera). Perdeu, todos os backups ficam ilegíveis.
2. O **`backend/.env` da produção**, em especial `CHANNEL_CREDENTIALS_KEYS` (sem ela nenhum token do WhatsApp decifra e toda empresa precisa reconectar) e `JWT_SECRET`. Atualize a cópia sempre que trocar um segredo.
3. A credencial do R2 e o endereço do serviço de sinal de vida.

## Instalação (uma vez)

### 1. No computador do dono: par de chaves

```
age-keygen -o soprei-backup-chave-privada.txt
```

O comando mostra `Public key: age1...`. Guarde o **arquivo** no gerenciador de senhas (duas cópias) e apague-o do disco; só a linha `age1...` vai para o servidor.

### 2. No painel da Cloudflare: bucket do R2

1. Crie um bucket só para isto (por exemplo `soprei-backup`), armazenamento **Standard**.
2. **Regra de ciclo de vida:** apagar objetos **35 dias** depois de criados.
3. **Trava do bucket (bucket lock):** retenção de **30 dias** para todo o bucket. Enquanto a trava vale, ninguém apaga nem sobrescreve um backup, nem quem tiver a credencial do servidor. A trava tem precedência sobre o ciclo de vida, então o objeto some entre o 35º e o 36º dia.
4. **Token de API do R2:** permissão **Object Read & Write**, restrito **só a esse bucket**. Anote o ID da chave de acesso, a chave secreta e o ID da conta.

A trava substitui a "credencial sem permissão de apagar" da D3: o R2 não tem esse nível de permissão.

### 3. No servidor: programas e configuração

```
apt install age rclone
install -o root -g root -m 755 /var/www/soprei/deploy/backup/soprei-backup.sh /usr/local/sbin/soprei-backup
install -d -o root -g root -m 700 /etc/soprei-backup /var/backups/soprei /var/lib/soprei-backup
install -o root -g root -m 600 /var/www/soprei/deploy/backup/backup.conf.example /etc/soprei-backup/backup.conf
install -o root -g root -m 600 /var/www/soprei/deploy/backup/rclone.conf.example /etc/soprei-backup/rclone.conf
```

Edite os dois arquivos trocando cada marcador `<ASSIM>`: no `backup.conf`, a chave pública (`AGE_RECIPIENT`) e o destino (`REMOTE=<nome>:<bucket>/postgres`, com o mesmo `<nome>` da seção do `rclone.conf`); no `rclone.conf`, a credencial e o ID da conta. O programa recusa rodar se algum dos dois não for do root com modo 600.

Um merge **não reinstala** o programa: quando `deploy/backup/soprei-backup.sh` mudar, repita o `install` da segunda linha.

### 4. Primeira execução, à mão

```
/usr/local/sbin/soprei-backup --dry-run
/usr/local/sbin/soprei-backup
cat /var/lib/soprei-backup/status
```

O `--dry-run` só lê a configuração e lista o destino (prova que a credencial funciona) sem gerar, enviar nem apagar nada. Depois da execução real, o `status` mostra `result=ok`, o nome do arquivo e o tamanho; confira o objeto no painel do R2. Anote o tamanho e o tempo na spec 043.

### 5. Agenda

```
install -o root -g root -m 644 /var/www/soprei/deploy/backup/soprei-backup.service.example /etc/systemd/system/soprei-backup.service
install -o root -g root -m 644 /var/www/soprei/deploy/backup/soprei-backup.timer.example /etc/systemd/system/soprei-backup.timer
systemctl daemon-reload
systemctl enable --now soprei-backup.timer
systemctl list-timers soprei-backup.timer
```

### 6. Aviso de backup parado

Crie uma verificação num serviço de sinal de vida (por exemplo o healthchecks.io: período de 1 dia, tolerância de 12 horas, aviso por e-mail) e ponha o endereço dela em `PING_URL` no `backup.conf`. O programa faz um `GET` nesse endereço **só quando o backup termina bem**, sem enviar dado nenhum; se o serviço ficar 36 horas sem receber, ele avisa o dono. Teste desligando o timer por um ciclo e confirmando que o e-mail chega.

### 7. Desligar o backup antigo

Depois do primeiro backup novo bem-sucedido, desligue o `soprei-backup.sh` antigo (o agendamento dele no `cron` ou no `systemd`) e, passados 7 dias, apague `/root/backups`.

## Códigos de saída e o que fazer

| Saída | Significa | O que fazer |
| --- | --- | --- |
| 0 | Backup feito, enviado e conferido | Nada. `ping=failed` no `status` quer dizer que só o aviso não foi entregue. |
| 1 | Recusado antes de começar (configuração, modo de arquivo, ferramenta ausente) | Leia a mensagem (`journalctl -u soprei-backup`), corrija e rode de novo. |
| 2 | Um passo falhou | O `status` diz o passo (`dump`, `cifrar`, `listar`, `enviar`, `conferir`, `expirar`) e o `last-run.log` traz a saída da ferramenta. Nada antigo foi apagado; o arquivo cifrado que não subiu é enviado na próxima execução. |
| 3 | Outra execução em andamento | Espere terminar. |

- **Disco cheio:** apague as cópias mais antigas de `/var/backups/soprei` e de `/var/backups/soprei-predeploy` e rode de novo.
- **`conferir` com "outro tamanho":** existe no destino um arquivo com o mesmo nome e tamanho diferente (envio interrompido). Com a trava do bucket ele não pode ser sobrescrito: apague a cópia local cifrada desse dia (o backup do dia seguinte segue normal) e deixe o objeto expirar.

## Teste de restauração (no primeiro dia e depois uma vez por mês)

Um backup que nunca foi restaurado não é backup. Faça numa máquina que **não** seja a produção (o computador do dono ou uma máquina temporária com PostgreSQL da mesma versão principal e o `age`):

1. Baixe do R2 o arquivo mais recente (`soprei-<data>.dump.age`).
2. Tenha a chave privada num arquivo, só pelo tempo do teste.
3. Rode:

```
deploy/backup/soprei-restore-check.sh --as-current-user soprei-<data>.dump.age chave-privada.txt
```

(`--as-current-user` usa o seu usuário e as variáveis `PG*` do ambiente; num servidor Linux, como root e sem a opção, os comandos rodam como o usuário `postgres`.)

O programa decifra, restaura no banco temporário `soprei_restore_check`, mostra **só a contagem de linhas** das tabelas principais, diz quanto tempo levou e apaga o banco temporário e o arquivo decifrado, também se falhar. Ele recusa rodar se esse banco já existir. Apague o arquivo da chave privada ao terminar e anote a data e o tempo na spec 043.

## Restaurar a produção do zero

1. Servidor novo conforme `docs/ops/deploy.md` (PostgreSQL, Redis, nginx, PM2, clone do repositório).
2. `backend/.env` a partir da cópia do gerenciador de senhas (**os mesmos** `CHANNEL_CREDENTIALS_KEYS` e `JWT_SECRET`).
3. Banco vazio e role como na instalação original; depois, com a chave privada levada só para este passo:

```
age -d -i chave-privada.txt -o /root/restaurar.dump soprei-<data>.dump.age
runuser -u postgres -- pg_restore --no-owner --role=soprei -d soprei < /root/restaurar.dump
rm -f /root/restaurar.dump chave-privada.txt
```

4. `deploy/deploy.sh --env production --adopt` (aplica as migrations que faltarem e sobe o sistema).
5. **Antes de reabrir ao público:** refaça as **exclusões de dados** atendidas depois da data do backup. Um backup anterior a um pedido de exclusão traz o dado de volta; enquanto a etapa E4 da spec 032 não existir, o dono mantém a lista dessas exclusões e as repete à mão.
6. Reinstale o backup (seção "Instalação") no servidor novo.

O que **não** volta: sessões (todo mundo entra de novo), limites e a fila do Redis (a Meta reenvia os webhooks por até 7 dias), e tudo o que aconteceu depois do último backup.

## Regras

- O staging não tem backup e **nunca** recebe um backup da produção (`docs/ops/staging.md`).
- O backup contém dados pessoais de todas as empresas: só sai do servidor cifrado, e a chave privada só existe com o dono.
- A cópia antes de migration (`soprei-predeploy-backup`, spec 037) continua existindo e **não** substitui este backup.
