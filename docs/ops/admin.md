# Admin da plataforma no servidor (spec 044, E4)

Como publicar o painel do dono (`admin/`) em `soadm.soprei.com` (D3), ligar a entrada com segundo fator e conferir que ele ficou fechado. As regras do admin estão em [docs/areas/plataforma.md](../areas/plataforma.md); o deploy, em [deploy.md](deploy.md). Tudo abaixo é passo do **dono** no servidor; nenhum agente tem acesso a ele, e **um agente não roda o `auth:cli` contra o banco do dono**.

**Estado (2026-11-24):** publicado e ligado na produção, em `https://soadm.soprei.com`, seguindo os passos abaixo; o staging não existe ainda.

## Como fica

| Peça             | Site das empresas                      | Admin da plataforma                                                           |
| ---------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| Hostname         | `www.soprei.com`                       | `soadm.soprei.com` (DNS A próprio, **sem proxy** da Cloudflare)               |
| Arquivos         | `/var/www/soprei/frontend/dist`        | `/var/www/soprei/admin/dist` (atalho para a release, como o site)             |
| nginx            | `deploy/nginx/production.conf.example` | `deploy/nginx/admin.conf.example`                                             |
| API              | `/api/*` -> backend `127.0.0.1:3001`   | **só** `/api/platform/*` -> `/platform/*` do **mesmo** backend; o resto é 404 |
| Entrada          | cookie da conta                        | cookie `__Host-soprei_platform` (senha + código do aplicativo autenticador)   |
| `/api/platform/` | **404** no nginx do site               | o único caminho da API                                                        |

O `deploy/deploy.sh` compila e publica o admin **junto com o site**, na mesma release (`admin/releases/<sha>-<data>`), com a mesma troca por atalho e o **mesmo rollback**: se a saúde, o site ou o admin não respondem depois da troca, o site e o admin voltam juntos à release anterior. Uma versão sem a pasta `admin/` (anterior à spec 044) não mexe no admin publicado.

## Passo a passo (uma vez)

### 1. O `deploy.sh` novo primeiro

O script que executa é o da versão **já instalada** (ver [deploy.md](deploy.md)): o deploy que leva a E4 ao servidor ainda roda o `deploy.sh` antigo, que **não** compila o admin. Depois que ele terminar, rode **mais um** deploy do mesmo SHA, que já usa o script novo:

- `deploy/deploy.sh --env staging --ref <sha> --force` e, depois, `deploy/deploy.sh --env production --ref <sha> --force` (o dry-run antes mostra a linha `admin da plataforma: publicado junto com o site`).
- Ou espere o próximo merge: o deploy automático já usa o script novo.

Nada instalado à mão muda nesta etapa: o programa de entrada (`/usr/local/sbin/soprei-deploy-entry`), o `sudoers` e o `sshd` continuam como estão (o programa chama o `deploy/deploy.sh` do clone). Confira: `ls -l /var/www/soprei/admin/dist` aponta para `releases/...` e `admin/dist/index.html` existe. Confira também `namei -l /var/www/soprei/admin/dist/index.html`: a pasta `admin` precisa de `drwxr-xr-x`. O `deploy.sh` anterior a 2026-11-24 deixava a pasta `admin/` que chegou pelo git só com o `root` (`umask 077`), e o nginx respondia 403 (`Permission denied` no `error.log`); a correção à mão é `chmod 755 /var/www/soprei/admin`, e o script atual já faz isso a cada deploy.

### 2. DNS e certificado

- Registro DNS **A** `soadm.soprei.com` para o IP do servidor, **sem proxy** (somente DNS), como o site.
- Certificado: `certbot certonly --nginx -d soadm.soprei.com` (o plugin do nginx valida sem o bloco do admin existir ainda). Faça isto **antes** de ligar o arquivo do admin no nginx (passo 3): com o atalho em `sites-enabled` apontando para um certificado que ainda não existe, o `nginx -t` do certbot falha. Se o atalho já estiver lá, tire-o (`rm /etc/nginx/sites-enabled/soprei-admin`), gere o certificado e recoloque-o. Confira a renovação: `certbot renew --dry-run`.

### 3. nginx

- `cp /var/www/soprei/deploy/nginx/admin.conf.example /etc/nginx/sites-available/soprei-admin` e `ln -s ../sites-available/soprei-admin /etc/nginx/sites-enabled/soprei-admin`.
- No bloco `server_name www.soprei.com` do **site** (`/etc/nginx/sites-available/soprei`, o arquivo real, espelhado em `deploy/nginx/production.conf.example`), acrescente o `location /api/platform/ { return 404; }` (defesa em profundidade: o cookie do admin já não vai ao hostname do site). Antes, uma cópia: `cp /etc/nginx/sites-available/soprei /root/soprei-nginx-antes-do-admin.conf`. Um jeito de inserir sem editor, logo antes do `location /webhooks/`: `sed -i 's|^    location /webhooks/ {|    location /api/platform/ {
        return 404;
    }

    location /webhooks/ {|' /etc/nginx/sites-available/soprei`, conferido com `grep -n -A3 'location /api/' /etc/nginx/sites-available/soprei`.
- `nginx -t` sem erro e `systemctl reload nginx`.
- **Não acrescente `add_header` dentro de um `location`** do admin: no nginx isso apaga, naquele `location`, todos os cabeçalhos do `server` (a CSP inclusive). O cache usa `expires` (que não tem esse efeito): `index.html` sem cache e `/assets/` (nomes com hash) por um ano.
- TLS: o exemplo fixa `ssl_protocols TLSv1.2 TLSv1.3;` no `server` do `443`, porque o `certbot certonly` do passo 2 não edita o arquivo (não acrescenta o `options-ssl-nginx.conf`) e o padrão do nginx muda com a versão. O nginx negocia o protocolo antes de saber o hostname, então vale o do `server` padrão da porta `443`: confira com `openssl s_client -connect soadm.soprei.com:443 -servername soadm.soprei.com -tls1_1 </dev/null` (deve **falhar**).
- HSTS: `Strict-Transport-Security: max-age=31536000`, só deste hostname (sem `includeSubDomains` e sem `preload`; o preload do domínio inteiro é decisão do dono, pendente). Uma vez enviado, o navegador recusa `http` neste hostname por um ano: mantenha o certificado renovando.
- O log de acesso do admin sai sem query string (`soprei_admin_sem_query`); a rotação de 30 dias do `access.log` e do `error.log` (logrotate) é a mesma do site.

### 4. `.env` da produção (`/var/www/soprei/backend/.env`, modo 600)

Acrescente, **ainda com o admin desligado**:

```
PLATFORM_ADMIN_ENABLED=false
ADMIN_ORIGIN=https://soadm.soprei.com
PLATFORM_TOTP_KEYS=k1:<chave>
PLATFORM_TOTP_ACTIVE_KEY_ID=k1
```

- `ADMIN_ORIGIN`: a origem **exata** do admin (`https`, sem barra no fim), **diferente** do `APP_ORIGIN`; a escrita em `/platform/*` só é aceita com esse `Origin`.
- `PLATFORM_TOTP_KEYS`: chaves **próprias** (nunca as `CHANNEL_CREDENTIALS_KEYS` do canal), no formato `keyId:<32 bytes em base64url>`, separadas por vírgula. Gere a chave no servidor, sem ela aparecer na tela nem ir para o histórico: uma cópia antes (`cp -p /var/www/soprei/backend/.env /root/soprei-env-antes-do-admin`) e depois `printf '
# Admin da plataforma (spec 044)
PLATFORM_ADMIN_ENABLED=false
ADMIN_ORIGIN=https://soadm.soprei.com
PLATFORM_TOTP_KEYS=k1:%s
PLATFORM_TOTP_ACTIVE_KEY_ID=k1
' "$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')" >> /var/www/soprei/backend/.env` (antes, `grep -oE '^(PLATFORM_[A-Z_]*|ADMIN_ORIGIN)=' /var/www/soprei/backend/.env` mostra só os nomes que já existem). Guarde uma cópia no gerenciador de senhas (sem ela, os segredos do segundo fator não se decifram e o fator precisa ser recadastrado).
- Opcionais: `PLATFORM_SESSION_IDLE_SECONDS` (padrão 1800) e `PLATFORM_SESSION_MAX_SECONDS` (padrão 43200, maior ou igual ao ocioso).
- Confira: `cd /var/www/soprei/backend && pnpm config:check` imprime `ok` (ou só os **nomes** das variáveis inválidas).
- **Troca de chave:** acrescente a nova à lista, aponte `PLATFORM_TOTP_ACTIVE_KEY_ID` para ela e mantenha a antiga até recadastrar o fator (passo 6), que regrava o segredo com a chave ativa.

### 5. Criar o administrador (se ainda não existe)

`cd /var/www/soprei && pnpm auth:cli create-platform-admin --email <seu e-mail>`. A senha é pedida sem eco (nunca por argumento). Só o id é impresso.

### 6. Cadastrar o segundo fator

`cd /var/www/soprei && pnpm auth:cli enroll-platform-totp --email <seu e-mail>`:

- Imprime **uma vez** a URI `otpauth://` e a chave; leve-a ao aplicativo autenticador do celular (digitando a chave) e responda com o código que ele mostra. Só grava se o código conferir. Depois, limpe o terminal (`clear`) e não copie a URI para nenhum outro lugar.
- **O cadastro já revoga as sessões Bearer da plataforma abertas antes** (ajuste I1 da revisão da E1): um refresh token antigo, obtido só com a senha, deixa de valer. Scripts do dono que usam `POST /auth/platform/login` passam a mandar também o campo `code` quando o admin for ligado (passo 7).
- Perdeu o celular: `pnpm auth:cli reset-password --platform-admin --email <seu e-mail>` troca a senha **e apaga o fator**; refaça este passo (não há códigos de recuperação, D5).

### 7. Ligar

- No `.env`: `PLATFORM_ADMIN_ENABLED=true`.
- Recarregue pelo próprio deploy, que valida o `.env` com o build e volta sozinho se a saúde falhar: `deploy/deploy.sh --env production --ref <sha atual> --force` (com `--allow-unstaged` se o staging estiver em outro SHA).
- A partir daqui `POST /auth/platform/login` também exige o código (D4).

### 8. Conferir (de fora do servidor)

- `https://soadm.soprei.com` abre a tela Entrar; entrar com e-mail, senha e código mostra a Visão geral; Sair volta à tela Entrar.
- Cabeçalhos: `curl -sI https://soadm.soprei.com/` mostra `Content-Security-Policy` (a de `admin.conf.example`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff` e `Strict-Transport-Security: max-age=31536000` (sem `includeSubDomains`), e `Cache-Control: no-cache` no `index.html`; um arquivo de `/assets/` mostra os mesmos cabeçalhos com `Cache-Control: max-age=31536000`. O console do navegador não mostra violação de CSP.
- Fechamentos: `curl -s -o /dev/null -w '%{http_code}\n' https://www.soprei.com/api/platform/auth/session` responde **404**; `https://soadm.soprei.com/api/auth/me` responde **404** (nenhuma outra rota da API passa pelo hostname do admin). O bloco do admin não tem `location /webhooks/`: esse caminho cai no `index.html` do app e nunca chega ao backend.
- O cookie `__Host-soprei_platform` aparece só em `soadm.soprei.com` (ferramentas do navegador), com `HttpOnly`, `Secure` e `SameSite=Strict`.

### 9. Conferência do admin no deploy (`ADMIN_HOST`)

Feito em 2026-11-24 (o admin está no ar desde então). Com o admin respondendo, um PR pequeno descomenta `ADMIN_HOST=soadm.soprei.com` (e `ADMIN_OK_CODES`) em `deploy/targets/production.conf`: a partir dele, todo deploy confere `https://soadm.soprei.com/` por `127.0.0.1` depois da troca e, se não responder, faz o rollback como faz com o site. **Não edite o alvo no servidor**: ele é versionado, e a árvore suja faz o deploy recusar.

## Opcional: só alguns IPs (lista `allow`, D5)

O padrão é **sem** lista (o IP do dono muda; o segundo fator é a proteção). Para restringir, no bloco `server` do `443` em `/etc/nginx/sites-available/soprei-admin`, descomente e preencha:

```
allow 127.0.0.1;
allow ::1;
allow <seu IP>;
deny all;
```

- Mantenha `127.0.0.1` e `::1` se o alvo tiver `ADMIN_HOST`: a conferência do deploy chega por `127.0.0.1` (ou acrescente `403` a `ADMIN_OK_CODES` por PR).
- O IP do dono não entra no repositório (o teste de `deploy/` recusa IP fora do loopback).
- IP mudou: edite a linha, `nginx -t` e `systemctl reload nginx`; fora da lista o nginx responde 403 antes de chegar ao backend.

## Staging (opcional)

O mesmo, no staging: `deploy/nginx/admin-staging.conf.example` (porta 3002, clone do staging, senha básica do staging), um hostname próprio (troque o marcador `<HOSTNAME_DO_ADMIN_STAGING>` no nginx e, ao descomentar, no `ADMIN_HOST` do alvo), chaves e `ADMIN_ORIGIN` **novos** (nunca os da produção) no `.env` do staging, o admin criado com `pnpm auth:cli` dentro de `/var/www/soprei-staging`, e `ADMIN_HOST`/`ADMIN_OK_CODES=200,401` em `deploy/targets/staging.conf` por PR. O `.env` de exemplo do staging (`deploy/env/staging.env.example`) mantém o admin desligado.

## Desligar numa emergência

- `PLATFORM_ADMIN_ENABLED=false` no `.env` e um deploy com `--force` (as rotas `/platform/*` passam a 404 e o login Bearer da plataforma volta a não pedir código).
- Ou, só no nginx: `rm /etc/nginx/sites-enabled/soprei-admin && nginx -t && systemctl reload nginx` (o app sai do ar; com `ADMIN_HOST` no alvo, o próximo deploy falharia na conferência: tire-o por PR antes).
- Sessões abertas: apagar o fator (`reset-password --platform-admin`) derruba todas na requisição seguinte.
