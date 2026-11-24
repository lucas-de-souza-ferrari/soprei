# Staging do Soprei no mesmo servidor (spec 037, E2)

O staging é **uma segunda instalação do Soprei** no servidor da produção, **sem nenhum recurso compartilhado que a produção possa alterar**: diretório, porta, app do PM2, banco e role do PostgreSQL, **instância de Redis**, caixa de e-mail e **todos os segredos** são próprios. Os arquivos de exemplo estão em `deploy/` (sem segredo; marcadores `<ASSIM>` mostram o que o dono preenche). Tudo abaixo é passo do **dono** no servidor; nenhum agente tem acesso a ele.

| Peça           | Produção                         | Staging                                                                          |
| -------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| Hostname       | o de produção                    | subdomínio próprio (DNS A, **sem proxy** da Cloudflare)                          |
| Diretório      | `/var/www/soprei`                | `/var/www/soprei-staging` (clone próprio; mesma chave de deploy somente leitura) |
| Porta da API   | 3001                             | **3002** (`127.0.0.1`; nunca aberta no `ufw`)                                    |
| App no PM2     | `soprei-api`                     | `soprei-staging`                                                                 |
| Banco e role   | `soprei` e `soprei`              | `soprei_staging` e `soprei_staging`                                              |
| Redis          | porta 6379, banco `/1`, senha    | **instância própria**, porta **6380**, banco `/0`, senha **diferente**           |
| E-mail         | SMTP real                        | Mailpit local (nenhum e-mail sai do servidor)                                    |
| `.env`         | `backend/.env`                   | `/var/www/soprei-staging/backend/.env` (modo 600)                                |
| Alvo do script | `deploy/targets/production.conf` | `deploy/targets/staging.conf`                                                    |

## Limite do isolamento: só de CONFIGURAÇÃO (decisão do dono, 2026-11-11)

Enquanto staging e produção rodam **como o mesmo usuário do sistema** (`root`, mesmo PM2), o isolamento entre eles é **só de configuração**. Contra **erro de configuração** (URL errada no `.env`, senha trocada, limpeza de teste), o `REVOKE CONNECT`, a instância própria de Redis e as senhas diferentes protegem. Contra **execução de código no staging** (dependência comprometida, vulnerabilidade, quem tem a senha do nginx e explora algo), **não protegem**: o `.env` da produção é legível por `root`. Decisão do dono: o staging fica assim por enquanto, **somente com dados sintéticos**; o **usuário dedicado (D10) entra antes de qualquer dado real ou de abrir o staging ao público**.

## Passo a passo

### 1. DNS, clone e certificado

- Registro DNS A do staging (sem proxy). Clone: `git clone <o mesmo repositório> /var/www/soprei-staging` com a mesma chave de deploy somente leitura (`core.sshCommand`, como na produção).
- nginx: copie `deploy/nginx/staging.conf.example` para `/etc/nginx/sites-available/soprei-staging`, troque `<HOSTNAME_DO_STAGING>`, crie o arquivo de senhas (`htpasswd -c /etc/nginx/soprei-staging.htpasswd <usuario>`, fora do repositório) e rode o certbot como na produção. O exemplo tem `auth_basic`, `X-Robots-Tag "noindex, nofollow"` e `proxy_set_header Authorization ""` nas duas rotas de proxy (a senha básica não chega à API). O arquivo equivalente da produção está em `deploy/nginx/production.conf.example`, **reconstruído da descrição** e a conferir com o arquivo real (S20).
- Admin da plataforma no staging (spec 044, opcional): `deploy/nginx/admin-staging.conf.example` e a seção "Staging" de [admin.md](admin.md).

### 2. PostgreSQL (mesmo cluster, banco e role próprios)

Como administrador do banco:

```sql
CREATE ROLE soprei_staging LOGIN PASSWORD '<senha própria>';
CREATE DATABASE soprei_staging OWNER soprei_staging;
-- Sem CREATEDB (o migrate deploy não usa banco sombra).
REVOKE CONNECT ON DATABASE soprei FROM PUBLIC;
REVOKE CONNECT ON DATABASE soprei FROM soprei_staging;
REVOKE CONNECT ON DATABASE soprei_staging FROM PUBLIC;
GRANT CONNECT ON DATABASE soprei TO soprei;   -- só se a role da produção perder o acesso pelo REVOKE
```

Assim, mesmo um `.env` do staging com a URL errada **não consegue** abrir o banco de produção. Confira também o `pg_hba.conf` (conexões locais exigem senha). O dono da role dona do banco consegue criar a extensão `btree_gist` (confiável) na primeira migration. `DB_POOL_MAX=5` no staging (não disputar `max_connections`).

### 3. Redis separado

Segundo processo `redis-server` com arquivo, diretório, unidade `systemd`, porta e senha próprios: `deploy/redis/redis-staging.conf.example` (`/etc/redis-staging/redis.conf`, modo 640, root:redis; `bind 127.0.0.1`, `port 6380`, `requirepass`, AOF, `maxmemory 256mb`, `maxmemory-policy noeviction`, `dir /var/lib/redis-staging`) e `deploy/redis/redis-staging.service.example` (ou o modelo de instância do pacote da distribuição). **Não basta outro índice** no Redis da produção.

### 4. Mailpit (nunca enviar a terceiros)

O staging roda com `NODE_ENV=production`, e nesse modo o envio **exige STARTTLS com certificado verificado**: o Mailpit em texto puro não é aceito (D4). Recomendado: Mailpit no próprio servidor (`deploy/mailpit/mailpit-staging.service.example`; SMTP em `127.0.0.1:1025` com STARTTLS; interface só em `127.0.0.1:8025`) com certificado emitido por uma **autoridade privada do dono** (um `.pem` confiado pelo Node do staging por `NODE_EXTRA_CA_CERTS`, já declarado no app `soprei-staging` do `ecosystem.config.cjs`, caminho `/etc/soprei-staging/mailpit-ca.pem`; o certificado do Mailpit deve ser para `localhost`). Nenhuma checagem de certificado é desligada. A caixa é lida por túnel SSH: `ssh -L 8025:127.0.0.1:8025 <servidor>`. Alternativa: caixa de teste de terceiros (SMTP real com TLS público; só e-mails sintéticos). **Nunca** aponte o staging para o SMTP real da produção.

### 5. `.env` do staging

`deploy/env/staging.env.example` lista as variáveis; copie para `/var/www/soprei-staging/backend/.env` (modo 600) e troque cada marcador por um valor **novo** (guarde também no gerenciador de senhas). Em resumo: `NODE_ENV=production`, `PORT=3002`, `APP_ORIGIN` exatamente a origem do staging, `TRUST_PROXY=127.0.0.1,::1`, `DATABASE_URL` da role do staging, `REDIS_URL` na porta 6380 com a senha do staging, **`JWT_SECRET` novo e diferente** (um cookie, código ou convite de um ambiente nunca vale no outro), `LLM_PROVIDER=mock`, `WHATSAPP_ENABLED=false`, `BILLING_ENABLED=false`, `CHECKOUT_ENABLED=false`, `SCHEDULE_AI_ENABLED=false`. O staging **não recebe** chave da Anthropic, da Meta, da InfinitePay nem SMTP real; nenhuma variável repete um segredo da produção. Valide antes de subir: `cd /var/www/soprei-staging/backend && pnpm config:check` (depois do primeiro build).

### 6. Primeira publicação e PM2

`deploy/deploy.sh --env staging --adopt` (com `--ref <sha>` se for o caso; o app ainda não existe no PM2 e o `--adopt` permite; o script cria o app com `pm2 startOrReload`). Depois `pm2 save`. Para que o PM2 inicie o app depois de reiniciar o servidor, o `pm2-root` do systemd já cuida (como na produção).

### 7. Provar o isolamento (registrar cada item na spec 037)

1. A senha do Redis do staging **não** autentica na porta 6379 e a da produção não autentica na 6380.
2. Com a URL do staging, `psql` **não** conecta ao banco `soprei` (negado), e a role da produção não conecta ao `soprei_staging`.
3. `redis-cli -p 6380 -a <senha> FLUSHDB` no staging **não** altera nenhuma chave da produção (contagem de chaves antes e depois).
4. A API do staging escuta só em `127.0.0.1:3002` e a porta não responde de fora do servidor.
5. O `JWT_SECRET` do staging é diferente (um cookie de sessão de um ambiente é recusado no outro).
6. Um cadastro no staging entrega o e-mail **só** no Mailpit e **nada** chega ao SMTP real (confira o painel do provedor de e-mail).
7. Sem a senha do nginx o staging responde 401.
8. `NODE_ENV=production`, cookie `Secure; HttpOnly; SameSite=Strict`, `Origin` errado recusado.

### 8. Dados do staging

**Vazio no início.** A conta e a empresa de teste nascem pelo cadastro (o e-mail de confirmação chega ao Mailpit) e os dados de exemplo pelos botões "Carregar exemplo" (conhecimento, estoque e agenda). **É proibido** restaurar um `pg_dump` de produção no staging, inteiro ou parcial, enquanto a spec 032 não definir retenção e anonimização.

## Memória (4 GB): a conta

Estimativas de ordem de grandeza, a conferir com `free -m` e `pm2 monit` (S21): sistema, nginx e PM2 350 a 450 MB; produção 300 a 500 MB (+256 MB nos picos de hash de senha, teto `max_memory_restart 1G`); staging 250 a 350 MB (+256 MB nos picos, teto **700M**); PostgreSQL 300 a 600 MB; Redis (os dois) 60 a 150 MB; Mailpit 20 a 50 MB. Total em uso normal **1,4 a 2,2 GB**; pior caso dos tetos cerca de **2,9 GB**, sem folga para o build (por isso há uma **trava global** de deploy, `nice` e limite de memória no build). Confira se existe **swap** (recomendado 2 GB). O staging tem `max_memory_restart` menor de propósito: se algo for sacrificado por falta de memória, que seja o staging.
