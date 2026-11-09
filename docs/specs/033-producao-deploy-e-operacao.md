# 033 — Produção, deploy e operação

- **Status:** rascunho
- **Branch:** `spec/033-producao-deploy-e-operacao` (por etapa, se o dono preferir PRs menores; ver "Etapas")
- **Depende de:** 005 (rate limit e `TRUST_PROXY`), 004 (métricas e logs), 011, 015 e 023 (webhook e Embedded Signup), 017 a 021 e 025 (cookie, `APP_ORIGIN`, SMTP), 027 (`btree_gist`), 028 e 031 (`SCHEDULE_AI_ENABLED`, `BILLING_ENABLED`). Conversa com a **032** (retenção, backups, exclusão): **a 032 vem antes de dados reais**; esta spec fornece onde e como rodar.
- **Observação de numeração:** conferido em `docs/specs/` em 2026-11-09: existem 001 a 031; esta é a **033** (a 032 é LGPD e retenção). A 031 está em implementação na branch `spec/031-planos-e-assinaturas` e **não é alterada** aqui.
- **Esta spec passa pelo `reviewer`** antes do merge (segredos, endpoint público, cabeçalhos de segurança, pipeline de deploy com acesso ao servidor).
- **Fatos externos** (preços, limites e recursos de hospedagem, Cloudflare, e-mail, Meta, Anthropic) **não foram lidos na fonte** (sem rede): tudo marcado **(S#)** é **suposição** a conferir no **E0**. **Valores de custo são estimativas** (câmbio de R$ 5,50 por US$ 1 e por EUR 1,00 ~ R$ 6,00, suposição).
- **Nada de código de produção foi escrito** para esta spec. Marcação: **[CÓDIGO]** = entra num PR do repositório; **[DONO]** = passo manual do dono (conta, cartão, DNS, painel de terceiros); **[DOC]** = documento em `docs/`.

## Objetivo

Hoje a produção **não existe**: PostgreSQL e Redis rodam nativos no PC do dono, o site de teste está em `workers.dev` (Cloudflare) e o backend sobe com `pnpm dev`. Antes de empresas reais, decidir **onde roda cada peça**, como **entrar em produção sem derrubar nada**, como **voltar atrás**, como **saber que algo quebrou** e como **restaurar** dados. Esta spec dá **opções com recomendação** (o dono decide), separa o que é código do que é passo manual, e propõe um **lançamento gradual** com as chaves `BILLING_ENABLED` e `SCHEDULE_AI_ENABLED` desligadas até seus testes.

## Estado atual (lido no código)

- **Processo único:** `src/index.ts` sobe Fastify, **worker do BullMQ no mesmo processo (concorrência 1)**, timer de expurgo e conexões Redis separadas (aplicação, rate limit, sessões, fila). `SIGINT`/`SIGTERM` -> `shutdown`: `app.close()`, para o expurgo, fecha a fila **esperando o job ativo (até 30 s)** e só então banco e Redis (`infrastructure/lifecycle.ts`). Sem `terminationGracePeriod`/`TimeoutStopSec` definidos em lugar nenhum (não há unidade de serviço no repositório).
- **Saúde:** `GET /health` (processo vivo) e `GET /health/ready` (banco e Redis, 200 ou 503), fora do rate limit. `GET /metrics` só existe com `METRICS_TOKEN` (32+ caracteres), Bearer em tempo constante. **Não há** versão do build nem profundidade da fila entre as métricas.
- **Cookie e CSRF:** o cookie da conta é `HttpOnly; SameSite=Strict; Path=/; Max-Age=30 dias` e `Secure` com `NODE_ENV=production` ou `APP_ORIGIN` HTTPS (`presentation/auth/account.controller.ts`); `Origin` precisa ser `APP_ORIGIN` e o cabeçalho `X-Soprei-App: web` é obrigatório. O site chama **`/api/...` no mesmo origin** (`frontend/src/api.ts`, `fetch(`/api${path}`)`; em desenvolvimento o Vite faz proxy e remove o `/api`). **Consequência de desenho: em produção o site e a API têm de parecer o mesmo site** (mesmo origin ou subdomínios do mesmo domínio registrável); com `SameSite=Strict`, site em `*.workers.dev` e API em outro domínio **não manda o cookie**.
- **Proxy:** `TRUST_PROXY` aceita `false`, lista de IPs/CIDRs (`true` é recusado em produção); com o canal ligado precisa estar **definido** explicitamente; o IP real é o último endereço do `X-Forwarded-For` que não está na lista. Rate limit com perfis `fail-closed` (`login`, `refresh`) e `fail-open` (os demais).
- **Segredos hoje (todos por variável de ambiente, `config` Zod, `redact` no log):** `JWT_SECRET` (também deriva as chaves HMAC dos códigos de e-mail, da recuperação de senha, do convite e do contador de login), `CHANNEL_CREDENTIALS_KEYS` (e `..._ACTIVE_KEY_ID`; perder = **nenhum token do WhatsApp decifra**), `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN` (legado, opcional), `ANTHROPIC_API_KEY`, SMTP (`EMAIL_PROVIDER_*`), `METRICS_TOKEN` e as de cobrança da 031.
- **Build e migrations:** `pnpm build` (`tsc` para `dist/`), `pnpm start` (`node dist/index.js`); **`prisma` é `devDependency`** e o Prisma Client é gerado em `src/generated/prisma` (ignorado pelo git; `db:generate` antes do build). `pnpm db:migrate:deploy` é o que o CI usa contra o Postgres do serviço. Migration `20261105100000_schedule_appointments` cria `btree_gist` (`CREATE EXTENSION IF NOT EXISTS`, extensão confiável).
- **Peso do processo:** o `scrypt` usa ~128 MiB por hash e há **no máximo 2 simultâneos** (+ a fila de até 32 esperando): o processo precisa de **folga de memória** (pelo menos ~1 GiB só para isso em pico).
- **Frontend:** SPA do Vite (`frontend/`), `index.html` tem **script inline** do tema (CSP precisa tratá-lo), o SDK do Facebook é injetado em tempo de execução só na tela do canal (023). **Não há CSP, nem `frame-ancestors`, nem cabeçalhos de segurança no repositório** (pendência registrada na 018 e na 023). O `localStorage` guarda só o tema.
- **CI:** `.github/workflows/ci.yml` roda em `pull_request` e `push` na `main` (Node 22 e LTS, Postgres 18 e Redis 8 como services). **Não há deploy, nem `dependabot`, nem `pnpm audit`.**
- **Meta:** o app está **Publicado**, é **Tech Provider** e tem **um único webhook** (callback) por app. Embedded Signup (023) exige o domínio do site em Allowed domains e em Valid OAuth redirect URIs, em HTTPS válido.

## Etapas (pequenas e cortáveis)

| Etapa | O que entrega | Tipo |
| --- | --- | --- |
| **E0** | Passo zero: conferir preços, limites e termos; decidir D1 a D7 | DONO |
| **E1** | Homologação mínima no código: versão do build, `config:check`, gauges, cabeçalhos da API | CÓDIGO |
| **E2** | CSP e cabeçalhos do site, script do tema sem inline, teste com CSP | CÓDIGO |
| **E3** | Infra base (servidor, banco, Redis, domínio, HTTPS, proxy, cookies) com `APP_ORIGIN` e `TRUST_PROXY` verificados | DONO + DOC + CÓDIGO (unidades e scripts) |
| **E4** | Deploy por GitHub Actions: release, `migrate deploy`, healthcheck, rollback, política de migração | CÓDIGO |
| **E5** | Backups e teste de restauração; reaplicar exclusões (032) | CÓDIGO + DONO |
| **E6** | Monitoramento e alertas (métricas, logs, uptime) | CÓDIGO + DONO |
| **E7** | Segurança de produção: auditoria de dependências, Dependabot, 2FA, rotação de segredos | CÓDIGO + DONO |
| **E8** | Staging, carga e **lançamento gradual** (piloto) | DONO + CÓDIGO (script de carga) |
| **E9** | Runbook em `docs/ops/` | DOC |
| **E10 (opcional)** | Separar o worker do processo da API | CÓDIGO, só se a carga pedir |

## Decisões e opções (o dono decide; recomendação em linguagem simples)

### D1 Onde hospedar o backend, o PostgreSQL e o Redis

Todas as faixas de preço abaixo são **estimativa e suposição (S1)**; confirmar na página do provedor no E0.

| Opção | O que é | Custo mensal estimado | Prós | Contras |
| --- | --- | --- | --- | --- |
| **A. Uma VPS só** (Node, PostgreSQL 18 e Redis 8 na mesma máquina, com proxy reverso) | Um servidor virtual de 2 vCPU e 4 GB, num provedor europeu barato (Hetzner, ~EUR 5 a 10) **ou** nacional (Locaweb, Hostinger, Magalu Cloud, ~R$ 40 a 100) | **R$ 50 a 120** com backup externo e e-mail | Mais barato; é **igual ao ambiente do dono** (nativo, sem Docker); controle total (extensão `btree_gist`, `noeviction` no Redis) | **Você administra tudo** (atualizações, disco, segurança, backup); um servidor só = ponto único de falha; fora do Brasil = mais latência e transferência internacional (032) |
| **B. PaaS** (Render, Fly.io, Railway) com Postgres e Redis gerenciados | Aplicação em contêiner e bancos como serviço | **R$ 150 a 350** | Menos administração; backups embutidos | Mais caro; contêiner (o dono não usa Docker, mas produção pode); Redis gerenciado cobrado por comando pode **encarecer o BullMQ**; extensões e `noeviction` dependem do plano (S2) |
| **C. Nuvem grande em São Paulo** (AWS, GCP, Azure, Oracle) | VM + banco e cache gerenciados | **R$ 450 a 900+** (Oracle Free Tier pode ser R$ 0, mas sem garantia, S3) | Dados no Brasil, escala, backups, alta disponibilidade | Mais cara e mais complexa para o tamanho atual |

**Recomendação (simples): Opção A, uma VPS, para começar e validar com poucos pilotos**, com **backup fora da máquina** e o **Cloudflare na frente** (que o dono já usa). Motivos: custo baixo, é parecido com o que você já roda no PC, e o produto ainda não tem volume. **Onde:** se o advogado (032, J) exigir dados no Brasil, usar VPS nacional ou nuvem em São Paulo; se aceitar transferência internacional (a Anthropic e a Meta já são fora do Brasil), a europeia sai mais barata, com latência maior (não relevante para WhatsApp assíncrono). **Quando migrar para B ou C:** quando um servidor deixar de bastar (ver E10) ou o dono quiser alta disponibilidade. **Dimensionamento mínimo:** 2 vCPU, **4 GB de RAM** (o `scrypt` usa ~256 MiB em pico, mais Postgres e Redis), 40 GB de disco SSD.

### D2 Onde fica o site (frontend)

**Recomendação:** o site **estático** continua no **Cloudflare** (Workers com assets ou Pages; hoje já em `workers.dev`), em um domínio próprio, e **a API fica atrás do mesmo hostname** (ver D3). Alternativa: servir o site pelo próprio servidor (proxy reverso estático), simplificando o cookie, sem a CDN.

### D3 Domínio, DNS e como o site fala com a API (decisão de desenho)

O cookie `SameSite=Strict` e o `fetch('/api/...')` pedem **mesmo site**. Opções:

1. **Um hostname só (`app.<domínio>`), recomendado:** a Cloudflare serve o site estático e **roteia `/api/*` para o servidor** (regra de Worker/rota que remove o `/api`, igual ao proxy do Vite). `APP_ORIGIN=https://app.<domínio>`. O **webhook da Meta** usa outro hostname `api.<domínio>` (`https://api.<domínio>/webhooks/whatsapp`) apontando para o mesmo servidor (a Meta não passa pela regra do site).
2. **Dois subdomínios do mesmo domínio** (`app.` e `api.`), com o site chamando a API direto: **exigiria mudar o `fetch`** (base absoluta) e CORS; **não recomendado** (mais código e mais superfície).

**Domínio:** `melhive.com.br` já tem a política e os termos; o e-mail de teste usa `ledware.com.br`. **Recomendação:** escolher **um** domínio para o produto e usar subdomínios dele (`app.`, `api.`, `status.`), com os cadastros na Meta e no SMTP apontando para esse domínio (**trocar depois é trabalhoso**: Allowed domains, redirect URIs, SPF/DKIM). **[DONO]** decide o domínio e cria os registros DNS (o registro `.com.br` é no Registro.br; DNS pode ficar na Cloudflare).

### D4 HTTPS, proxy e `TRUST_PROXY`

- **Recomendação:** **Cloudflare Tunnel (`cloudflared`)** no servidor, sem abrir portas 80 e 443 ao mundo (o servidor só aceita SSH restrito e a saída do túnel); TLS é do Cloudflare. A API escuta só em `127.0.0.1`. **`TRUST_PROXY=127.0.0.1,::1`**, e o **E0 confirma por teste** com `curl` forjando `X-Forwarded-For` que o IP visto pela API é o de quem chamou de verdade e não o forjado (a Cloudflare **acrescenta** ao cabeçalho; suposição **S4**, a mesma pendência já registrada nas 011 e 005). **Alternativa:** Caddy ou nginx no servidor com certificado automático (Let's Encrypt), Cloudflare só como DNS: **`TRUST_PROXY` deve listar o IP do proxy e o firewall não pode permitir acesso direto à porta da API** (senão qualquer um forja o IP e esvazia o rate limit).
- **Cookie:** `Secure` já é automático com `APP_ORIGIN` HTTPS; `SameSite=Strict` continua; **não** adotar `__Host-` agora (pendência da 017).
- **Teste obrigatório depois de subir:** (a) cookie chega com `Secure; HttpOnly; SameSite=Strict`; (b) `POST` com `Origin` errado = recusado; (c) rate limit contando por IP real.

### D5 E-mail transacional real e entregabilidade

A 019 já fala SMTP genérico. **Recomendação:** um provedor transacional com SMTP (Amazon SES região São Paulo ou Europa, Brevo, Mailgun, Postmark, Resend; S5 confirma preço e limites; ordem de grandeza **R$ 0 a 50 por mês** no volume inicial) com **domínio de envio próprio** (`noreply@<domínio>`). **[DONO]:** criar a conta, verificar o domínio e publicar **SPF, DKIM e DMARC** (comece `p=none` e suba para `quarantine` depois de ver os relatórios); sair do modo de teste do provedor (SES começa limitado); tratar **bounces e reclamações** (parar de enviar a endereço que rejeitou, evita reputação ruim). `EMAIL_PROVIDER_SECURE=true`/STARTTLS e usuário e senha (a config aceita só "tudo ou nada"). **[CÓDIGO, opcional]:** webhook de bounce fica **fora de escopo** (só monitorar no painel do provedor no piloto).

### D6 Segredos: onde ficam e como rotacionar

- **Recomendação:** arquivo de ambiente **só no servidor** (`/etc/soprei/backend.env`, dono root, modo `0600`, lido pela unidade `systemd` com `EnvironmentFile`), **nunca** no repositório nem escrito pelo pipeline; cópia do conteúdo em um **gerenciador de senhas** do dono (se o servidor morrer, os segredos não morrem junto). O CI de deploy só tem a **chave SSH de deploy** (sem outros segredos). **Alternativa:** SOPS/age ou Doppler (mais ferramenta).
- **Rotação (documentada no runbook, E9), com o efeito de cada uma:**
  - `JWT_SECRET`: derruba **todas as sessões** e **mata** códigos de e-mail, de recuperação e **convites pendentes** (os HMAC derivam dele); só em incidente; avisar e reenviar convites depois.
  - `CHANNEL_CREDENTIALS_KEYS`: **suportada** (chave nova ativa, a antiga continua na lista até regravar com novo `PUT` do canal); **perder a lista = todas as empresas precisam reconectar o WhatsApp**: backup obrigatório.
  - `WHATSAPP_APP_SECRET`: trocar no app da Meta e no `.env` **ao mesmo tempo** causa uma janela de 401 no webhook (a Meta reenvia; mensagens podem atrasar); **[CÓDIGO, opcional, E7]** `WHATSAPP_APP_SECRET_PREVIOUS` aceita os dois durante a troca.
  - `ANTHROPIC_API_KEY`, SMTP, `METRICS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`: troca simples com reinício (o verify token precisa mudar também no painel da Meta).
- **Gerar segredos fortes** com o comando que já está no `.env.example`; **nunca** colar em chat.

### D7 Staging

**Recomendação:** um ambiente de **staging** no **mesmo servidor** (porta, banco `soprei_staging` e **instância Redis separada**, não só outro índice, para o `FLUSH` nunca atingir produção), com **`LLM_PROVIDER=mock`**, e um **segundo app da Meta em modo de desenvolvimento** (a Meta só permite **um webhook por app**; o app de produção não pode apontar para staging). **Alternativa (mais barata):** sem staging separado: testar no PC do dono e usar produção só com a empresa do próprio dono como piloto (mais risco, adequado ao começo). O dono decide se vale o custo de manter o segundo app.

## E1 — Homologação mínima no código [CÓDIGO]

- **Versão do build:** `APP_VERSION` (injetada no build com o SHA do commit; **não** é segredo) aparece em `GET /health` (`{ status, version }`) e na métrica `soprei_build_info{version} 1`; o deploy (E4) compara a versão depois de subir. Sem a variável, `unknown`.
- **`pnpm config:check`** (script novo): carrega e valida o `.env` de produção com o **mesmo** schema Zod do boot, **sem** abrir conexão e **sem** imprimir valores (só "ok" ou o nome das variáveis inválidas); o pipeline o roda antes de trocar a versão. Regras extras só em produção: recusa `LOG_LEVEL=debug`/`trace`, exige `METRICS_TOKEN`, `APP_ORIGIN` HTTPS e `TRUST_PROXY` explícito. **Cuidado:** não duplicar regra; reaproveitar o `superRefine`.
- **Gauges:** `queue_jobs_waiting` e `queue_jobs_delayed` (por contagem da fila `channel-inbound`, amostradas a cada 15 s ou na leitura de `/metrics`, sem label com id), `queue_oldest_waiting_age_seconds` (idade do job esperando mais antigo, **o** sinal de "fila parada") e `redis_memory_used_bytes` (do `INFO memory`, melhor esforço). Fila e Redis fora = gauge omitido e métrica de erro, **sem** derrubar `/metrics`.
- **Cabeçalhos da API** (hook `onSend`, **sem dependência nova**): `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin` (a API é JSON, não é incorporada) e `Cache-Control: no-store` nas respostas que ainda não declaram cache; `Strict-Transport-Security` **só** com `NODE_ENV=production` (e se o dono não preferir tê-lo na Cloudflare, D4). O webhook e o `/health` não mudam de comportamento.
- **Prisma em produção:** a decisão é **onde rodar `migrate deploy`** (ver E4). Se for no servidor, `prisma` (CLI) precisa estar no artefato: **mover `prisma` para `dependencies`** ou empacotá-lo à parte; o implementer confere o que `prisma.config.ts` exige em tempo de execução (S6).

## E2 — CSP e cabeçalhos do site [CÓDIGO]

- **Script do tema fora do HTML:** mover o script inline de `frontend/index.html` para `frontend/public/theme-init.js` (mesma lógica; continua **síncrono** no `<head>`, antes da primeira pintura), para o CSP não precisar de `'unsafe-inline'` nem de hash. O teste de tema (`theme.spec.ts`) tem de continuar verde.
- **`frontend/public/_headers`** (formato do Cloudflare para assets estáticos, **suposição S7**: confirmar que o recurso escolhido, Workers com assets ou Pages, o lê): `Content-Security-Policy` com `default-src 'self'`, `script-src 'self' https://connect.facebook.net`, `frame-src https://www.facebook.com https://web.facebook.com https://staticxx.facebook.com`, `connect-src 'self'` (mais os endereços do SDK da Meta que o e2e mostrar necessários), `img-src 'self' data: https:` (o SDK usa imagens; confirmar), `style-src 'self'` (`'unsafe-inline'` só se o e2e provar necessidade: estilos feitos por JavaScript não violam o CSP, atributos `style` no HTML sim), `frame-ancestors 'none'` (**só funciona como cabeçalho, não `<meta>`**), `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`; mais `Referrer-Policy`, `X-Content-Type-Options`, `Permissions-Policy` (tudo negado, sem câmera nem microfone) e `Strict-Transport-Security`. Os valores de `script-src`/`frame-src` do SDK vêm da 023 (**já registrados** em "Riscos aceitos"); o `connect-src` do SDK da Meta **não foi medido**: é o que o E2 mede.
- **Implantação em duas fases:** primeiro `Content-Security-Policy-Report-Only` (sem coletor de relatório: o teste e2e e o console de uma sessão do dono mostram as violações), depois o modo que bloqueia.
- **Fora do CSP, mas no mesmo pacote:** a página de exclusão de dados (032, E6) e o `/convite` continuam funcionando.

## E3 — Infra base [DONO + DOC + CÓDIGO]

[DONO]: contratar a VPS (D1), criar usuário sem privilégio para o serviço, **SSH só com chave e sem root**, firewall do provedor liberando só o SSH (de um IP fixo se possível), instalar PostgreSQL 18 e Redis 8, Node 22 ou superior (o mesmo que o CI) e `cloudflared` (D4), criar o banco `soprei` e a role `soprei` (a **extensão `btree_gist` é criada pela própria migration** e é confiável, mas **a role dona do banco precisa poder criá-la**: conferir no primeiro `migrate deploy` em staging), ligar o domínio.

[CÓDIGO] (no repositório, sem segredo): `deploy/systemd/soprei-backend.service` (usuário próprio, `EnvironmentFile=/etc/soprei/backend.env`, `Restart=on-failure`, **`TimeoutStopSec=45`** para caber os 30 s de espera do worker + fechamento, `NoNewPrivileges`, `ProtectSystem=strict`, `MemoryMax` com folga para o `scrypt`), `deploy/redis/redis.conf.example` (`appendonly yes`, `appendfsync everysec`, **`maxmemory-policy noeviction`**: com outra política o Redis pode **apagar** jobs e sessões; suposição **S8** de que o BullMQ exige `noeviction`, conferir na documentação dele) e `deploy/postgres/postgresql.conf.example` (`max_connections` coerente com `DB_POOL_MAX`, `statement_timeout` já vem da aplicação). **Pool e conexões:** `DB_POOL_MAX` (padrão 10) x processos; sem pgbouncer.

**Checagem de HTTPS e cookies (E3):** a lista de testes da D4 faz parte do aceite.

## E4 — Deploy por GitHub Actions [CÓDIGO]

- **Disparo:** manual (`workflow_dispatch`) e por **tag `v*`**, só depois do CI verde na mesma revisão; **ambiente `production` do GitHub com aprovação obrigatória do dono** (ninguém, nem um agente, publica sem aprovação). Staging (D7) publica a cada merge, produção só por tag.
- **Artefato:** o job compila (`pnpm build`, `db:generate`) e empacota `dist/`, `prisma/` (migrations) e as dependências de produção **num `.tar.gz` com o SHA no nome**; copia por SSH (chave de deploy **só para esse usuário e esse comando**, restringida por `command=` e `from=` no `authorized_keys`, S9) para `/opt/soprei/releases/<sha>/`. Alternativa: **Docker**. O dono **não usa Docker localmente**, mas produção **pode**; só se escolher a opção B de D1. **Recomendação:** **sem Docker** na opção A (menos peças).
- **Sequência no servidor** (`deploy/scripts/release.sh`, **com `--dry-run`**): (1) `pnpm config:check`; (2) **backup lógico rápido do banco** (E5) se houver migration pendente; (3) `prisma migrate deploy` **com a versão antiga ainda no ar**; (4) trocar o link simbólico `current` para a release nova e **reiniciar** a unidade (o `SIGTERM` já espera o job ativo); (5) `GET /health/ready` até 200 (prazo de 60 s) e `GET /health` com `version` igual ao SHA; (6) se falhar: **rollback** automático para a release anterior (`deploy/scripts/rollback.sh`) e o job falha. Guardar as últimas 3 releases.
- **Janela de migração sem derrubar (política, no runbook e no CI):** migration **aditiva e compatível com a versão anterior do código** (coluna nova anulável, tabela nova, índice `CONCURRENTLY` quando grande). Mudança **destrutiva** (renomear, apagar, `NOT NULL` sem padrão) em **duas releases** (expandir, migrar o código, contrair). **Verificação automática:** `scripts/check-migrations.mjs` (puro, sem rede) falha se uma migration nova tiver `DROP`, `RENAME` ou `SET NOT NULL` sem o comentário `-- breaking-approved: <motivo>`; só olha migrations **depois de uma linha-base** (a 022 renomeou tudo e está aprovada). **Rollback de migration não existe** (o Prisma não tem `down`): o rollback é do **código**, por isso as migrations são compatíveis; dado destruído se recupera do backup (E5).
- **Sem tráfego perdido no reinício:** a API fica ~alguns segundos fora; o webhook da Meta **retenta**; jobs na fila continuam no Redis. Aceitável no começo; zero downtime (duas instâncias) fica fora.
- **Frontend:** deploy do site na Cloudflare por `wrangler`/integração própria, **versionado junto** (mesmo SHA); a variável de build só muda o que é público (sem segredo no bundle). **Uma release do site e do backend sobem juntos** (já vale na 022 e na 023: mudar contrato exige os dois).

## E5 — Backups e restauração [CÓDIGO + DONO]

- **PostgreSQL (recomendação):** `pg_dump -Fc` **diário** + retenção de **35 dias** (casa com a 032) para um **bucket fora do servidor** (Cloudflare R2, Backblaze B2 ou S3; S10: custo na ordem de R$ 5 a 20 por mês no volume inicial), **criptografado antes de sair** (`age` ou GPG; a chave pública no servidor, a privada **fora**, no gerenciador do dono). **RPO sugerido: 24 h** no começo; **evolução:** arquivamento de WAL/PITR (pgBackRest ou WAL-G) para RPO de minutos quando houver faturamento real. **RTO sugerido: 4 h** (comprar/instalar servidor, restaurar, subir).
- **Redis:** `appendonly yes` no próprio servidor só para **sobreviver a reinício**; **sem backup externo**: sessões se perdem (as pessoas entram de novo) e jobs transitórios são reconstruíveis pelo reenvio da Meta; é decisão consciente (registrar em `docs/context.md`).
- **Segredos:** backup separado, fora do servidor, **incluindo `CHANNEL_CREDENTIALS_KEYS`** (D6).
- **Scripts no repositório:** `deploy/scripts/backup-pg.sh` (dump, criptografia, envio, expiração local, **código de saída e métrica de última execução** em arquivo de texto para o coletor), `deploy/scripts/restore-check.sh` (baixa o último dump, restaura num banco temporário, confere contagens de tabelas e `SELECT 1`, apaga). **Teste de restauração agendado mensalmente e logo no primeiro dia** (um backup que nunca foi restaurado não é backup).
- **Exclusões e backups (032):** ao **restaurar** produção, **rodar `pnpm privacy:replay`** (032, E4) **antes** de reabrir o tráfego, para reaplicar apagamentos do `erasure_ledger`.
- **Alerta de backup parado:** se o arquivo de última execução tem mais de 36 h, alerta (E6).

## E6 — Monitoramento e alertas [CÓDIGO + DONO]

- **Métricas:** Prometheus (do próprio servidor) ou **Grafana Cloud (faixa gratuita, S11)** raspando `GET /metrics` com o `METRICS_TOKEN`; **recomendação:** serviço gerenciado gratuito para não manter Prometheus. **Logs:** o processo escreve JSON no `stdout` (`journald`); enviar para um destino central (Grafana Loki, Better Stack, ou só `journalctl` com retenção de 30 dias para começar). **Não há dado pessoal em log por desenho** (a 032 acrescenta rede de segurança); revisar o destino (retenção e região) no E0.
- **Disponibilidade externa:** um monitor de uptime (UptimeRobot, Better Stack, Cloudflare Health Checks; S12) em `https://app.<domínio>/` e `https://api.<domínio>/health/ready`, **também alerta de certificado a vencer** (< 14 dias).
- **Alertas mínimos (`deploy/alerts/soprei-alerts.yml`, formato Prometheus, **validado com `promtool` no CI** se o dono escolher Prometheus; senão a lista serve de roteiro):**
  1. API fora: `up == 0` por 2 min ou o monitor externo.
  2. **Fila parada:** `queue_oldest_waiting_age_seconds > 120` por 5 min (janela de 5 s + LLM; folga) **ou** `queue_jobs_waiting` crescendo sem `queue_jobs_total{result="completed"}`.
  3. **Falha de webhook:** `rate(webhook_requests_total{result=~"invalid_signature|error"})` acima do normal por 10 min (assinatura inválida em massa = segredo trocado ou ataque).
  4. **Taxa de erro do LLM:** `llm_requests_total{result!="ok"}` / total > 20% por 10 min; fallbacks (`attendance_fallbacks_total`) subindo.
  5. **Envio à Meta falhando:** `channel_send_total{result!="ok"}` alta; `TOKEN_INVALID` (`channel_state_transitions_total{to="TOKEN_INVALID"}`).
  6. **5xx:** `http_requests_total{status_class="5xx"}` > 2% por 5 min; `db_pool_connections{state="waiting"}` > 0 por 5 min.
  7. **Redis:** `redis_memory_used_bytes` > 70% do `maxmemory`; **Redis fora** (o `/health/ready` já cobre).
  8. **Disco e memória do servidor:** pelo próprio provedor ou `node_exporter` (disco > 80%; memória livre baixa; `OOM` no `journalctl`).
  9. **Backup** (E5), **certificado** (acima) e **expurgo** (032: `retention_purge_runs_total{result="error"}`).
  10. **Custo:** `llm_tokens_total` por hora acima do esperado (teto de segurança) e, depois da 031, uso por assinatura.
- **Custo da Anthropic e da Meta:** (a) **limite de gasto mensal** definido na Console da Anthropic **antes** de usar chave real (já exigido em AGENTS.md) e alerta de e-mail do provedor; (b) `llm_tokens_total` x preço (a 031 já grava `usage_counters`); (c) Meta: as empresas pagam o próprio WABA no modo C da 031; no modo S, acompanhar a fatura no Gerenciador de Negócios. **[CÓDIGO, opcional]:** `pnpm ops:usage-report` (consulta só leitura dos contadores da 031, sem dado pessoal), cortável.

## E7 — Segurança de produção [CÓDIGO + DONO]

- **[CÓDIGO]** `.github/dependabot.yml` (semanal, pnpm e GitHub Actions, atualizações de **segurança** primeiro) e um passo `pnpm audit --prod --audit-level=high` no CI (**bloqueia** só `high` e `critical`; falso positivo vira exceção registrada, nunca o passo desligado); **SBOM** (CycloneDX) **opcional** e cortável (dependência de ferramenta nova, justificar no PR).
- **[CÓDIGO]** `WHATSAPP_APP_SECRET_PREVIOUS` (D6), **opcional**; `pnpm audit` e cabeçalhos já listados.
- **Checklist (verificado em staging, E8):** HTTPS ponta a ponta e HSTS; cookie `Secure/HttpOnly/SameSite=Strict`; CSP em modo que bloqueia; `RATE_LIMIT_ENABLED=true` (recusa de `false` em produção já existe) e `fail-closed` dos perfis `login` e `refresh` provado com o Redis do limiter derrubado; `TRUST_PROXY` provado com cabeçalho forjado; `/metrics` só com token (e idealmente **fora** da internet pública: regra no Cloudflare/no proxy ou só pela rede privada); porta do Postgres e do Redis **fechadas** ao mundo (`bind 127.0.0.1`); `CHANNEL_MANUAL_CONNECT_ENABLED` **ausente/`false`**; `NODE_ENV=production`; `LOG_LEVEL=info`; atualizações automáticas de segurança do sistema operacional; usuário do serviço sem shell; permissões `0600` do arquivo de ambiente; backups criptografados.
- **[DONO]** **2FA em tudo:** GitHub, Cloudflare, Registro.br, provedor da VPS, Meta (Business Manager e conta de desenvolvedor), Anthropic Console, provedor de e-mail, gerenciador de senhas, InfinitePay. **SSH** só por chave (sem senha), idealmente atrás de IP fixo ou da própria Cloudflare Access. Chaves de deploy e de pessoa **separadas**.

## E8 — Staging, carga e lançamento gradual [DONO + CÓDIGO]

- **[CÓDIGO] Teste de carga simples:** `scripts/loadtest/webhook.mjs` (Node puro, **sem dependência**), que manda `POST /webhooks/whatsapp` **com assinatura HMAC correta** (o segredo do **staging**), para N contatos fictícios e taxa configurável, contra o **staging com `LLM_PROVIDER=mock`** e o Graph **falso** (reusa a ideia do `fake-graph-api`); mede tempo até a resposta chegar ao Graph falso e a profundidade da fila. **Metas sugeridas (a confirmar com o dono):** 20 mensagens/s por 5 min sem perda e **p95 de espera da fila abaixo de 30 s**; depois, **uma** rodada curta com o LLM real (poucas mensagens, com limite de gasto) para medir latência de verdade. **Nunca** rodar o teste contra produção nem contra a Meta real.
- **Capacidade (cálculo de ordem de grandeza, S13):** o worker tem **concorrência 1**: uma resposta leva a janela de agrupamento (5 s, mas **a janela não ocupa o worker**, só o agendamento) + a chamada do LLM (~2 a 10 s, `LLM_TIMEOUT_MS`) + o envio; então o worker processa **~6 a 30 respostas por minuto**. Com 10 empresas ativas de 30 conversas/dia cada, o pico é bem menor. **Quando separar o worker (E10):** `queue_oldest_waiting_age_seconds` acima de 30 s de forma recorrente, ou CPU da API afetando latência HTTP, ou o servidor perto de 70% de CPU.
- **E10 (opcional) [CÓDIGO]:** `WORKER_MODE=all|api|worker` (padrão `all`, **igual ao de hoje**): `api` não sobe o worker, `worker` não sobe as rotas (só `/health` e `/metrics` para a unidade); duas unidades `systemd`; a concorrência vira variável `QUEUE_WORKER_CONCURRENCY` (cuidado: a ordem por contato é garantida pelo `flush` por `(companyId, contactRef)`, mas **a concorrência > 1 muda garantias** documentadas na 011 e 013, então só com spec/revisão própria). **Recomendação:** **não fazer agora.**
- **Lançamento gradual (plano):**
  1. **Staging verde** (E4 a E8), segredos de produção só no servidor.
  2. **Produção com a empresa do próprio dono** (piloto zero): `BILLING_ENABLED=false`, `SCHEDULE_AI_ENABLED=false`, `LLM_PROVIDER=anthropic` com **limite de gasto**, `RETENTION_ENABLED=true` em `dry-run` (032). Observar 1 semana: fila, erro do LLM, e-mails, backups, restauração.
  3. **E0 da 028** (teste manual com a chave real) e só então `SCHEDULE_AI_ENABLED=true` para a empresa do dono, depois a opção por empresa.
  4. **1 a 3 empresas piloto** (conhecidas, com o aviso de IA ligado, 032): suporte direto, volume baixo. Critério de entrada: política e termos publicados, exclusão de dados e Privacidade prontos, backup restaurado com sucesso **uma vez**, alertas testados.
  5. **`BILLING_ENABLED=true`** só depois do **E0 da 031** (InfinitePay) e de o dono conferir o webhook de pagamento em produção; migração de contas existentes conforme a D8 da 031 (trial).
  6. **Abrir** o cadastro. **Critérios de recuo (rollback do lançamento):** taxa de erro do LLM > 20%, fila parada, incidente de dados, ou fatura da Anthropic/Meta fora do previsto: desligar chaves, `ACCOUNTS_ENABLED`/cadastro conforme o caso e voltar a release.
- **Meta em produção [DONO]:** webhook do app em `https://api.<domínio>/webhooks/whatsapp` com o `verify token` de produção e os campos `messages` e `account_update`; domínio do app (`app.<domínio>`) em **Allowed domains** e em **Valid OAuth redirect URIs**; `config_id` do Embedded Signup; **URL de instruções de exclusão de dados** = a página da 032 (E6); URLs de privacidade e termos já preenchidas (`melhive.com.br`); **remover o `workers.dev`** das listas depois da troca (não deixar domínio de teste autorizado em produção).

## E9 — Runbook [DOC]

`docs/ops/runbook.md` (documento, **sem** código): **subir** (checagem de Postgres, Redis, `config:check`, unidade), **derrubar** (`systemctl stop` espera o job ativo até 45 s), **deploy e rollback** (E4), **restaurar o banco** (E5, incluindo `privacy:replay` e a proibição de reabrir o tráfego antes), **trocar cada segredo** (D6, com o efeito de cada um), **reprocessar fila** (job falho de `channel-inbound`: ver, repetir ou descartar; mensagens pendentes sem resposta: a limitação da 013), **fila parada**, **Redis cheio**, **certificado a vencer**, **disco cheio**, **desligar a IA** (`LLM_PROVIDER=mock`, só em emergência: responde `[mock]`; melhor `SCHEDULE_AI_ENABLED=false`), **suspender uma empresa** e **incidente de segurança** (aponta para `docs/lgpd/plano-de-incidente.md`). Contatos, quem faz o quê e senhas **não** entram no documento.

## Critérios de aceite

Cada item tem teste automatizado quando é código; o que é passo do dono tem **verificação** manual registrada no "Registro da implementação" da spec (com data e o resultado, sem segredo).

**E1**
- [ ] `GET /health` devolve `version` igual ao `APP_VERSION` (ou `unknown`) e **nenhum** outro dado; `soprei_build_info` existe em `/metrics`.
- [ ] `pnpm config:check` com `.env` válido sai com código 0 e **não** imprime valores; com variável inválida ou ausente sai com código 1 e lista só os **nomes**; com `NODE_ENV=production` recusa `LOG_LEVEL=debug`, `APP_ORIGIN` sem HTTPS, `METRICS_TOKEN` ausente e `TRUST_PROXY=true`.
- [ ] Os gauges `queue_jobs_waiting`, `queue_jobs_delayed` e `queue_oldest_waiting_age_seconds` refletem uma fila real com Redis `/15` e prefixo único (com um job esperando e um atrasado); fila fora **não** derruba `/metrics` e conta erro.
- [ ] Respostas da API levam `X-Content-Type-Options: nosniff` e `Referrer-Policy: no-referrer`; `Strict-Transport-Security` só com `NODE_ENV=production`; o corpo e os códigos de status dos testes existentes não mudam.

**E2**
- [ ] O build do site **não contém** `<script>` inline (teste sobre `dist/index.html`) e o tema continua aplicado antes da primeira pintura (e2e).
- [ ] Um servidor estático de teste aplica `_headers` ao `dist/` e a suíte Playwright (desktop e celular, claro e escuro) roda **com o CSP que bloqueia** sem nenhum evento `securitypolicyviolation` nas telas cobertas, inclusive login, painel, equipe e convite (o fluxo do SDK da Meta usa `window.FB` falso nos e2e; o carregamento real do SDK é verificação manual do dono, E8).
- [ ] O `_headers` contém `frame-ancestors 'none'` e **não** contém `unsafe-eval`; a lista de origens da Meta é exatamente a da 023 (teste de texto).

**E3**
- [ ] `soprei-backend.service` passa em `systemd-analyze verify` (se disponível no CI; senão, revisão) e declara `TimeoutStopSec` >= 45 s, usuário sem privilégio e `EnvironmentFile` fora do repositório; nenhum arquivo em `deploy/` contém segredo (teste de varredura por padrões como `JWT_SECRET=` com valor).
- [ ] **Verificação do dono em staging:** cookie `Secure; HttpOnly; SameSite=Strict`; `Origin` errado recusado; rate limit contando pelo IP real com `X-Forwarded-For` forjado **ignorado**; `GET /metrics` sem token = 404 e com token = 200; portas do Postgres e do Redis fechadas a partir de fora.

**E4**
- [ ] `scripts/check-migrations.mjs` tem teste unitário com fixtures: `DROP COLUMN`, `RENAME`, `SET NOT NULL` sem marca falham; migration aditiva passa; migrations anteriores à linha-base são ignoradas.
- [ ] `release.sh --dry-run` e `rollback.sh --dry-run` imprimem a sequência esperada sem executar (teste em shell com `bats` ou em Node, S14); `shellcheck` passa nos scripts; `actionlint` passa no workflow.
- [ ] O workflow de deploy exige o ambiente `production` com aprovação, roda **depois** do CI verde da mesma revisão e **não** tem nenhum segredo além da chave SSH.
- [ ] **Verificação em staging:** uma release com migration aditiva sobe com o código anterior respondendo durante a migration; uma release **com falha proposital** no `health` volta sozinha à anterior e o job termina vermelho.

**E5**
- [ ] `backup-pg.sh` termina com código 0 e gera arquivo **criptografado** (o teste tenta abrir sem a chave e falha) com banco de teste descartável; apaga cópias locais com mais de N dias; escreve o arquivo de status com a hora e o resultado.
- [ ] `restore-check.sh` restaura esse arquivo num banco temporário e confere a contagem de linhas de uma tabela-semente; remove o banco temporário.
- [ ] **Verificação do dono:** restauração completa do último backup real em máquina separada concluída **uma vez antes do piloto**, com o tempo medido registrado (RTO real).

**E6**
- [ ] O arquivo de regras de alerta é válido (`promtool check rules`, se Prometheus for a escolha) e cada alerta referencia uma métrica **existente** (teste que cruza nomes do arquivo com o `/metrics` de um servidor de teste).
- [ ] Nenhuma métrica nova tem label com id, e-mail, telefone ou IP (teste do conjunto de labels, como nas specs 004 e 005).
- [ ] **Verificação do dono:** cada alerta foi **disparado de propósito** em staging (parar o worker, parar o Redis, parar o backup) e chegou ao canal escolhido (e-mail ou aplicativo de mensagens).

**E7**
- [ ] `pnpm audit` roda no CI e o passo falha com vulnerabilidade `high` de fixture (teste do script, não da rede); Dependabot válido (`dependabot.yml` passa na validação do GitHub).
- [ ] Se `WHATSAPP_APP_SECRET_PREVIOUS` for implementada: uma assinatura calculada com o segredo anterior é aceita só enquanto a variável existir; com um terceiro segredo é 401; tempo constante preservado; a variável sai por `redact`.
- [ ] **Verificação do dono:** o checklist de segurança está marcado por item no Registro, com 2FA confirmado em cada serviço.

**E8**
- [ ] O script de carga manda mensagens assinadas e recusa rodar se `BASE_URL` não for `localhost`/staging declarado (trava contra produção); contra o servidor de teste, entrega o relatório (taxa, perdas, p95) sem imprimir texto de mensagem.
- [ ] **Verificação do dono:** metas de carga atingidas em staging; piloto zero concluído 7 dias sem incidente; critérios de entrada do piloto externo marcados no Registro.

## Casos de borda e erros

- **`SIGTERM` com job ativo longo:** o worker espera até 30 s e o `systemd` dá 45 s; um job de agenda com ferramentas (até 30 s de prazo total) pode ser cortado: o BullMQ o retenta (entrega at-least-once, como na 011).
- **Migration lenta ou travada:** o passo (3) tem prazo e, se estourar, **não** troca a release; o runbook diz como cancelar com segurança (`pg_cancel_backend`, nunca `kill -9`).
- **Disco cheio do Postgres:** alerta de disco; o backup local expira sozinho; o runbook lista o que apagar.
- **Redis reiniciado sem persistência:** sessões e jobs somem: sessões = novo login; jobs = a Meta reenvia o webhook não confirmado, mensagens já aceitas e ainda sem resposta ficam **pendentes** (limitação 013, sem varredura).
- **Certificado ou DNS errado no webhook:** a Meta desativa o webhook depois de falhas repetidas (S15): alerta de `webhook_requests_total` zerado em horário comercial.
- **`TRUST_PROXY` errado:** IP real indisponível = todo mundo compartilha a cota do rate limit; o teste de cabeçalho forjado e o alerta de 429 em massa cobrem.
- **Chave de deploy vazada:** a chave só consegue executar o script de release (S9); trocar a chave e as releases ficam; sem acesso a segredos.
- **Dois deploys ao mesmo tempo:** `concurrency` do workflow e um `flock` no `release.sh`.

## Isolamento entre empresas

Esta spec **não adiciona acesso a dados** de empresa: o código novo são rotas de sistema (`/health` com `version`), métricas **sem** label com `companyId`, cabeçalhos, scripts e configuração. O gauge da fila **não** distingue empresa. Onde há dado de empresa (backup e restauração), o dump é do banco inteiro e **criptografado**; quem restaura é o dono (acesso ao servidor equivale a acesso a todos os dados, daí 2FA, SSH por chave e o mínimo de pessoas). O teste de carga usa empresas fictícias **só do staging**. Com isso, "não se aplica" ao isolamento por `CompanyId`, **mas** o `reviewer` confere os itens de segurança (cabeçalhos, deploy, segredos).

## Fora de escopo

- **Alta disponibilidade**, duas instâncias, balanceador, deploy sem nenhuma interrupção e PITR automático desde o começo (evolução).
- **Kubernetes**, Terraform e infraestrutura como código completa; **Docker** só se o dono escolher a opção B (D1).
- **WAF**, DDoS além do que a Cloudflare dá por padrão, e **pentest** externo (recomendado antes de escala, mas é serviço contratado, não código).
- **RLS** do Postgres e criptografia de campo de mensagens (pendências já registradas).
- Webhook de **bounce** de e-mail, painel de status público (`status.<domínio>`) e SLA/SLO formais.
- **Separar o worker** (E10, só se a carga pedir) e **fila de prioridade/limite por empresa** (spec própria).
- Observabilidade distribuída (traces), APM pago e `Sentry` (decisão de outra spec; o log estruturado e as métricas bastam para o piloto).
- **Redis alto disponível** (Sentinel) e réplica de leitura do Postgres.
- Fatura, nota fiscal e contabilidade (031 e o contador do dono).

## Riscos

- **Servidor único = ponto único de falha** (aceito no piloto; RTO sugerido 4 h; RPO 24 h até o PITR).
- **Domínio errado hoje, trabalho amanhã** (Meta, SMTP, cookie): decidir D3 **antes** do E3.
- **Erro de `TRUST_PROXY` ou de firewall** esvazia o rate limit (teste obrigatório).
- **Perda do `CHANNEL_CREDENTIALS_KEYS`** inutiliza todas as conexões (backup separado obrigatório).
- **O pipeline de deploy é um caminho para o servidor:** chave restrita, ambiente com aprovação, sem segredos no CI.
- **Preço e limites de terceiros mudam** (S1 a S15): por isso o E0.
- **CSP pode quebrar o SDK da Meta** (origens extras desconhecidas): por isso o modo `Report-Only` primeiro e a verificação manual do Embedded Signup.
- **Custo da Meta e da Anthropic** é variável e pode passar do previsto: limite de gasto, alertas e o modo C da 031.

## E0 — Passo zero (conferência; **sem código; o dono confere ou me passa os textos**)

Nada abaixo foi verificado (sem rede). Conferir **antes** de qualquer etapa:

- **S1** preços e regiões de VPS (Hetzner, Hostinger, Locaweb, Magalu Cloud etc.) e o que cada um permite (extensões do Postgres, `noeviction` no Redis, snapshots).
- **S2** PaaS e banco gerenciado (suporte a `btree_gist`, cobrança do Redis por comando com BullMQ).
- **S3** faixa gratuita da Oracle (disponibilidade e termos) e preços de São Paulo na AWS/GCP.
- **S4** que a Cloudflare (Tunnel e proxy) **acrescenta** o IP de quem chama ao `X-Forwarded-For` e que a API vê o IP certo (teste com `curl`).
- **S5** SMTP/e-mail transacional: preço, limites, região e saída do modo de teste.
- **S6** o que `prisma migrate deploy` exige no ambiente (`prisma.config.ts`, `DATABASE_URL`, `prisma` como dependência).
- **S7** se Workers com assets ou Pages leem `_headers` e se a rota `/api/*` para um origin externo é suportada no plano gratuito.
- **S8** a exigência do BullMQ de `maxmemory-policy noeviction` e a configuração de persistência recomendada por ele.
- **S9** `authorized_keys` com `command=` e `from=` para a chave de deploy, e o modo seguro do `appleboy/ssh-action` ou de `ssh` direto.
- **S10** preço de object storage (R2, B2, S3) para backup e a política de retenção do provedor.
- **S11** faixa gratuita de métricas hospedadas (Grafana Cloud) e de logs.
- **S12** monitor de uptime gratuito e alerta de certificado.
- **S13** latência real do LLM e do envio na Meta (medir no E8; os números aqui são chute).
- **S14** ferramenta de teste de shell no CI (`bats`) ou alternativa em Node.
- **S15** a regra da Meta para desativar webhook após falhas repetidas e o prazo.
- **S16** termos do Cloudflare Workers/Pages para tráfego e o limite de requisições do plano gratuito.

## Passos do DONO (separados do código)

1. Escolher D1 a D7 e responder à 032 (prazos).
2. Domínio e DNS (D3): registrar/escolher, apontar para a Cloudflare, criar `app.`, `api.`.
3. Contas e cartão: VPS, object storage de backup, provedor de e-mail, monitor de uptime, Grafana Cloud (opcional), segundo app da Meta (staging, D7), InfinitePay (031).
4. **2FA** em todas as contas (E7); gerenciador de senhas.
5. Gerar os segredos de produção (comandos do `.env.example`) e guardá-los **fora** do servidor também.
6. Painel da Meta (Embedded Signup, webhook, domínios, URL de exclusão, `config_id`) e remover `workers.dev`.
7. Painel da Anthropic: **limite de gasto**, chave de produção, termos de dados (032, E0).
8. SPF, DKIM e DMARC; sair do modo de teste do e-mail.
9. Aprovar o ambiente `production` no GitHub e guardar a chave de deploy.
10. Executar os testes manuais (alertas, restauração, Embedded Signup real, carga) e registrar o resultado.

## Decisões e dependências novas

Dependências de pacote: **nenhuma** prevista (cabeçalhos, `config:check`, gauges e script de carga usam o que já existe e o Node). Ferramentas externas no CI (sem entrar no `package.json`): `shellcheck`, `actionlint`, `promtool` (opcional). Mudanças de configuração: `APP_VERSION` (opcional) e, se o dono escolher, `WORKER_MODE`/`QUEUE_WORKER_CONCURRENCY` (E10) e `WHATSAPP_APP_SECRET_PREVIOUS` (E7). Mover `prisma` para `dependencies` **só se** o `migrate deploy` for no servidor (S6). Registrar D1 a D7 em `docs/context.md` depois da resposta do dono. **Registro do que foi decidido** (hospedagem, domínio, staging) deve ir ao `docs/context.md`, **não** só a esta spec.
