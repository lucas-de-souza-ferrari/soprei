# 005 — Rate limiting

- **Status:** aprovada pelo dono em 2026-10-27, com todas as recomendações da seção "Decisões" (reescrita no mesmo dia contra o código real e contra o que a spec 011 exige)
- **Branch:** `spec/005-rate-limiting`
- **Depende de:** 002 e 004 (concluídas); é pré-requisito da 011 (canal WhatsApp, primeiro endpoint público)

## Objetivo

Proteger a API contra abuso e rajada, com limites por perfil guardados no Redis (valem entre várias instâncias), antes de existir qualquer endpoint público. Escopo deliberadamente reduzido ao que existe hoje: rotas `/admin`, rotas de infraestrutura e o futuro webhook. Perfis de usuário autenticado, login e upload ficam para quando existirem (spec 007).

## Estado de partida (herdado)

- O Fastify (`infrastructure/http/server.ts`) não tem `trustProxy`: `request.ip` é sempre o endereço do socket. Atrás de um túnel ou proxy todos os clientes teriam o mesmo IP.
- Não há `RateLimitError`. O `errorHandler` central devolve `{ error: { code, message, requestId, details? } }` e, para `BaseError`, usa `statusCode`/`code`/`message` do erro.
- `registerObservability` (spec 004) registra o `onRequest` que abre o contexto e o log de requisição ao fim (`onResponse`), que já registra 4xx como `warn` com o padrão da rota. O registry de métricas é o `Metrics` da 004; labels sem `clientId`, id de recurso ou URL crua.
- Redis: client `ioredis` singleton (`getRedis`) com `maxRetriesPerRequest: 2` e fila offline ligada, adequado ao resto do sistema mas não a um limiter (um Redis fora seguraria a requisição esperando reconexão). O boot já exige Redis (`verifyInfrastructure`); o `shutdown` fecha as conexões (`lifecycle.ts`).
- Rotas existentes: `/health`, `/health/ready`, `/metrics` (só com token) e `/admin/clients...` (`ADMIN_API_KEY`, hook de auth). O webhook chega na 011.
- Dependências hoje: `fastify` 5.12, `ioredis` 6. `@fastify/rate-limit` **não** está instalado (verificado: a versão 11.2.1 suporta Fastify 5).

## Comportamento esperado

### Plugin e perfis

- Implementação sobre **`@fastify/rate-limit` 11.x** com store Redis (`redis` do plugin) e `global: true`: **toda rota é limitada por padrão**; uma rota nova esquecida cai no perfil `public`, em vez de ficar sem proteção. O plugin roda no hook `onRequest` (padrão), antes de ler o corpo e de autenticar, então requisição acima do limite é recusada barato e tentativa de adivinhar a `ADMIN_API_KEY` também conta.
- Uma rota escolhe o perfil por `config: { rateLimitProfile: 'admin' }` (o tipo da config da rota é ampliado por declaration merging). A camada `presentation` só **nomeia** o perfil; os números vivem na config e são lidos pelo plugin (`max` e `timeWindow` como funções do perfil da rota). Rota sem perfil: `public`. Rota de infraestrutura: `config: { rateLimit: false }` (opt-out do plugin).
- Perfis desta spec, todos **por IP** (não existe contexto de cliente nem de usuário antes da autenticação), com valores iniciais ajustáveis por variável de ambiente:

| Perfil | Rotas | Padrão | Variáveis |
| --- | --- | --- | --- |
| `public` | qualquer rota sem perfil (rede de segurança) | 100 por 15 min | `RATE_LIMIT_PUBLIC_MAX`, `RATE_LIMIT_PUBLIC_WINDOW_SECONDS` |
| `admin` | `/admin/*` | 600 por 1 min | `RATE_LIMIT_ADMIN_MAX`, `RATE_LIMIT_ADMIN_WINDOW_SECONDS` |
| `webhook` | webhook do canal (declarado pela 011) | 600 por 1 min | `RATE_LIMIT_WEBHOOK_MAX`, `RATE_LIMIT_WEBHOOK_WINDOW_SECONDS` |

- Sem limite: `/health`, `/health/ready` e `/metrics`. Rotas inexistentes (404) também ficam fora do limite (o plugin não cobre o handler de 404; custo baixo).
- **Contadores independentes por perfil e por IP**: esgotar `admin` não consome `webhook` do mesmo IP, e um IP não consome a cota de outro. Isso é requisito de segurança da 011: um atacante sozinho não pode esgotar a cota da Meta (outro IP). Se o `keyGenerator` precisar ser próprio para separar por perfil, ele **mantém a normalização do padrão do plugin** (IPv4 mapeado em IPv6 vira IPv4; IPv6 agrupado em `/64`), com teste. A chave (e o namespace) leva o perfil e o IP, nunca `clientId`: antes da autenticação ele não existe, e a regra "chave de rate limit deriva do `ClientId`" passa a valer na 007, quando houver perfis autenticados. O IP em chave do Redis é dado pessoal com TTL de no máximo a janela do perfil.
- Resposta **429** pelo erro central: novo `RateLimitError` (`BaseError`, `statusCode` 429, `code` `RATE_LIMITED`, mensagem em português, `retryAfterSeconds` no contexto) devolvido pelo `errorResponseBuilder`. O `errorHandler` o converte em `{ error: { code: 'RATE_LIMITED', message, requestId, retryAfter } }` (`retryAfter` em segundos, inteiro) e os headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (os do plugin, sem a variante `draft`) chegam na resposta. O resto das respostas de erro não muda de formato.
- **Redis indisponível: fail-open para todos os perfis** (`skipOnError: true`): a requisição passa, com log `error` e a métrica `rate_limit_store_errors_total`. Não há perfil crítico nesta spec (login, refresh etc. entram com a 007, que decide fail-closed para eles). Se o plugin não der como observar a falha do store, o implementer envolve o acesso ao Redis de forma fina para contá-la e registra a escolha aqui; só escreve limiter próprio se o plugin não atender, justificando na spec antes.
- **Conexão Redis dedicada** ao limiter (`src/infrastructure/cache/`), separada do singleton: `enableOfflineQueue: false`, `commandTimeout` curto (`RATE_LIMIT_REDIS_TIMEOUT_MS`, padrão 250), `maxRetriesPerRequest: 1`, mesma estratégia de reconexão e listener de erro em log. Assim, Redis fora custa no máximo o timeout por requisição, não segura a requisição. O boot espera a conexão ficar pronta (limite curto) e, se não ficar, segue com `warn` (fail-open); ela é fechada no `shutdown`.
- **IP atrás de proxy:** `TRUST_PROXY` na config, aplicado ao `trustProxy` do Fastify: `false` (padrão; `X-Forwarded-For` é ignorado), `true` (confia em toda a cadeia; spoofável, só para ambiente fechado), um inteiro (número de proxies confiáveis à frente, ex.: `1` para um túnel) ou uma lista de IPs/CIDRs separados por vírgula. Documentar nos `.env*.example` que `true` não deve ir para produção.
- **Config:** `RATE_LIMIT_ENABLED` (`true`/`false` literais, padrão `true`; `false` é rejeitado com `NODE_ENV=production`, para não desligar a proteção por engano) e as variáveis acima, todas validadas (inteiros positivos, janela de 1 a 86 400 s). `buildServer` recebe um parâmetro opcional `rateLimit`; **sem ele o plugin não é registrado**, e os testes existentes não mudam. O limiter é registrado depois de `registerObservability`, de modo que o `429` entra no log de requisição e nas métricas HTTP como qualquer resposta.
- **Métricas** (registry da 004, label só `profile`, que é um conjunto fixo): `rate_limit_rejected_total{profile}` (requisições recusadas com 429) e `rate_limit_store_errors_total`. O nome `rate_limit_hits_total` do esboço foi trocado por `rate_limit_rejected_total`, que diz o que conta. O IP não vai em label nem em log desta spec (a linha de requisição da 004 já registra o 429 como `warn`, com método, rota e status).
- Rotas existentes ganham o perfil: `/admin/*` → `admin`; `/health`, `/health/ready`, `/metrics` → sem limite. A 011 declara `webhook` nas suas rotas.

## Critérios de aceite

**Comportamento**
- [x] Teste: a requisição seguinte ao limite recebe 429 no formato `{ error: { code: 'RATE_LIMITED', message, requestId, retryAfter } }` e os headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; `retryAfter` e `Retry-After` batem e são inteiros ≥ 1.
- [x] Teste: cada perfil (`public`, `admin`, `webhook`) aplica o seu limite (valores pequenos em teste); rota sem perfil usa `public`.
- [x] Teste: perfis independentes: esgotar `admin` para um IP não limita `webhook` para o mesmo IP.
- [x] Teste: IPs diferentes têm cotas independentes (o `webhook` de um IP esgotado não limita outro IP).
- [x] Teste: `/health`, `/health/ready` e `/metrics` respondem normalmente acima de qualquer limite configurado; 404 de rota inexistente também.
- [x] Teste: `/admin/*` é limitado antes da autenticação (requisições sem credencial contam e, esgotado o limite, a resposta é 429, não 401).
- [x] Teste: IPv4 mapeado em IPv6 e IPv6 do mesmo `/64` compartilham chave; IPv6 de redes diferentes, não.

**Redis e janela**
- [x] Teste de integração (Redis `/15`, namespace único por teste, limpeza só das próprias chaves): a janela expira e o contador volta a zero; **toda chave criada tem TTL** (nenhuma com `PTTL` de -1), inclusive sob várias requisições concorrentes.
- [x] Teste: com o Redis fora (conexão para porta fechada, `src/test-support/closed-port.ts`), requisições de todos os perfis passam, cada uma dentro de um limite de tempo próximo do `RATE_LIMIT_REDIS_TIMEOUT_MS`, com log `error` e `rate_limit_store_errors_total` incrementada; ao voltar o Redis, o limite volta a valer.
- [x] Teste: a conexão dedicada é fechada no `shutdown` (sem handle aberto).

**Proxy**
- [x] Teste: com `TRUST_PROXY=false`, `X-Forwarded-For` é ignorado (dois valores diferentes do cabeçalho compartilham a cota do socket).
- [x] Teste: com `TRUST_PROXY=1`, o IP vem do `X-Forwarded-For` acrescentado pelo proxy; um valor forjado à esquerda no cabeçalho **não** muda a chave (o atacante não escapa do limite nem esgota a cota de outro IP). Com lista de CIDRs, só proxies listados são confiados.
- [x] Teste de config: `TRUST_PROXY` aceita `false`, `true`, inteiro e lista de IPs/CIDRs, e rejeita lixo.

**Config, métricas e geral**
- [x] Teste de config: valores inválidos (zero, negativo, não numérico, janela acima de 86 400) falham no boot; `RATE_LIMIT_ENABLED=false` é rejeitado em produção; `"false"` literal desliga fora de produção (não é tratado como verdadeiro).
- [x] Teste: `rate_limit_rejected_total{profile}` aparece em `/metrics` depois de um 429; nenhum IP, chave ou id em label e nenhum IP em linha de log gerada por esta spec.
- [x] Teste: sem o parâmetro `rateLimit` o `buildServer` não limita nada (suítes existentes continuam verdes sem alteração).
- [ ] `typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes em Node 22 e 24 (verdes localmente nas duas versões, ver o registro abaixo); CI verde (aguardando o PR).

## Casos de borda e erros

- Redis lento ou fora: fail-open limitado pelo `commandTimeout`; nunca derruba nem trava a requisição.
- Rajada legítima da Meta: o limite do `webhook` é folgado e configurável. Recusar com 429 faz a Meta retentar e, em excesso, pode levar à desativação da assinatura do webhook; por isso o valor padrão tem folga grande sobre o tráfego esperado, e o limite existe contra abuso de um único IP, não para dosar a Meta.
- Atrás de túnel/proxy sem `TRUST_PROXY`: todos os clientes parecem um IP só e o `webhook` seria compartilhado entre Meta e qualquer atacante. A documentação da 011 e os `.env*.example` mandam `TRUST_PROXY=1` com túnel.
- Cabeçalho `X-Forwarded-For` malformado ou múltiplo: usa o endereço do socket, nunca lança.
- Chave de IP em IPv6 com porta ou zona: normalizada antes de virar chave.

## Isolamento entre clientes

Não toca em dados de tenant. Os contadores são por perfil e por IP, e o `clientId` não existe nesse ponto; nada aqui lê ou grava dado de cliente. A regra de que chaves de limite derivam do `ClientId` assinado vale para os perfis autenticados da 007.

## Fora de escopo

- Perfis `authenticated`, `critical` (login, refresh, troca de senha, com fail-closed) e `upload`: entram com a 007 e quando houver upload.
- Limite adaptativo por atraso do event loop (`monitorEventLoopDelay`): sem medição que o justifique; entra quando houver carga real.
- `ban`, backoff exponencial, bloqueio permanente de IP, lista de IPs permitidos, WAF, CAPTCHA.
- Limite por cliente, por plano comercial ou por `phone_number_id`; limite de worker/fila.
- Log do IP de requisições recusadas (decisão de privacidade futura).

## Decisões (propostas; o dono decide)

1. **Padrão global com perfil `public` [recomendado]** (rota esquecida fica protegida) em vez de limite só nas rotas que optam. Custo: toda rota nova precisa declarar o perfil certo ou será tratada com `public`.
2. **Só três perfis agora [recomendado]** (`public`, `admin`, `webhook`), sem os perfis de usuário do esboço, porque não existe usuário nem login; evita código sem uso.
3. **Fail-open em todos os perfis [recomendado]**: disponibilidade do atendimento acima da proteção quando o Redis cai. O fail-closed de rotas críticas é decidido na 007.
4. **Conexão Redis dedicada com timeout curto [recomendado]**, em vez de reaproveitar o singleton: evita que um Redis fora segure cada requisição.
5. **Valores iniciais:** `public` 100 por 15 min; `admin` 600 por min; `webhook` 600 por min, por IP. Quer outros? (Tudo é ajustável por variável.)
6. **Limite adaptativo adiado [recomendado]**, e a métrica renomeada para `rate_limit_rejected_total`.
7. **`RATE_LIMIT_ENABLED=false` proibido em produção [recomendado].**
8. **Revisão pelo `reviewer` [recomendado]**, com foco em `trustProxy` (spoofing de `X-Forwarded-For`), fail-open e no isolamento de cotas por IP, embora a spec não toque em dados de tenant.

## Decisões e dependências novas

- **Dependência nova: `@fastify/rate-limit` ^11.2.1** (plugin oficial do Fastify, compatível com Fastify 5; traz `ip-address`, `toad-cache` e `@lukeed/ms`). Justificativa: o guia escreve o limiter à mão com `INCR` + `EXPIRE`; o plugin cobre isso de forma atômica no store Redis e os testes acima provam que não sobra chave sem TTL.
- O `ioredis` já existe; a conexão dedicada não adiciona dependência.
- Atualizar o `CLAUDE.md` (rate limiting, `TRUST_PROXY`, perfis e a regra de que rota nova declara perfil) e os `.env*.example` na implementação.
- Sem migration.

### Registro da implementação (decisões e desvios, 2026-10-27)

Decisões tomadas durante a implementação, dentro do espírito da spec; o dono pode contestar qualquer uma. Verificado no código instalado do plugin (`@fastify/rate-limit` 11.2.1) o que a spec supunha: `max` e `timeWindow` aceitam função `(req, key)`, `keyGenerator` próprio substitui o padrão (a normalização é a função exportada `normalizeIP`, reaproveitada), `errorResponseBuilder` pode devolver um `Error` (é lançado do hook e passa pelo `errorHandler` central, com os cabeçalhos já postos), o script Lua do store Redis faz `INCR` + `PEXPIRE` atômicos, e o `skipOnError` engole a falha do store sem nenhum sinal.

- **Desvio principal: o limiter é um hook `onRequest` da instância raiz, não o hook por rota do `global: true`.** O plugin acrescenta o hook ao array de hooks **da rota**, que o Fastify executa **depois** dos hooks de instância (como o `app.addHook('onRequest', adminAuthHook(...))` dos controllers de `/admin`). Resultado: requisições sem credencial recebiam 401 e nunca 429, contra o critério "limitado antes da autenticação"; o teste de integração pegou isso. Agora o plugin é registrado com `global: false` (só fornece `app.rateLimit()` com os parâmetros globais: store, `max`/`timeWindow` por perfil, `keyGenerator`, `errorResponseBuilder`, `onExceeded`) e `registerRateLimit` adiciona um `onRequest` na raiz, depois do da observabilidade, que o pula para `config: { rateLimit: false }` e para 404. Efeitos: o limiter é sempre o primeiro hook (também antes da assinatura do webhook da 011 e do JWT da 007) e rotas registradas direto na raiz também são limitadas. O opt-out segue sendo a config documentada do plugin (`rateLimit: false`).
- **Falha do store observável por uma casca fina, não por limiter próprio.** `observeStoreErrors` (`src/infrastructure/cache/rate-limit-redis.ts`) é o objeto passado ao plugin como `redis`: delega `defineCommand` ao client real e repassa `rateLimit`/`rateLimitRead` iguais, mas avisa um observador de toda falha de comando (log `error` sem IP nem chave + `rate_limit_store_errors_total`) e roda o callback no contexto assíncrono da requisição (herda `requestId` nos logs). O script Lua e o resultado do plugin não são alterados.
- **Fail-open e cabeçalhos:** com o Redis fora a requisição passa, mas o plugin ainda anexa `X-RateLimit-Limit`, `X-RateLimit-Remaining` (= o máximo) e `X-RateLimit-Reset: 0`, informação enganosa porém inofensiva. Não corrigido (exigiria remover cabeçalhos num `onSend` só para esse caso).
- **`Retry-After`:** o `errorHandler` é a fonte única (`RateLimitError.retryAfterSeconds`, inteiro >= 1, vira o cabeçalho e o campo `retryAfter`), então os dois sempre batem; `X-RateLimit-Limit/Remaining/Reset` continuam os do plugin. O `errorHandler` loga o `RateLimitError` em `debug` (a linha de requisição da 004 já registra o 429 como `warn`, com método, rota e status; assim uma rajada recusada não gera duas linhas por requisição).
- **Perfil e chave:** os nomes dos perfis ficam em `src/shared/rate-limit/profiles.ts` (a config, a presentation e a infraestrutura os usam); a presentation declara por `config: rateLimitProfile('admin')` (helper e declaration merging em `src/presentation/rate-limit.ts`). A chave é `<prefixo>:<perfil>:<ip normalizado>`, com o prefixo `soprei:ratelimit:` por padrão e o parâmetro `keyPrefix` de `registerRateLimit` para os testes usarem um namespace único (não existe variável de ambiente para isso). Um teste percorre as rotas do servidor e falha se uma rota não declarar perfil (só `/health`, `/health/ready` e `/metrics` têm `rateLimit: false`).
- **IP:** `normalizeClientIp` (`src/infrastructure/http/client-ip.ts`) mantém `normalizeIP` do plugin e remove antes colchetes, porta e zona de IPv6; o que não for IP vira `unknown`, e `clientIpOf` usa o endereço do socket quando `request.ip` não é utilizável. Comportamento verificado: com `trustProxy` ligado, o Fastify devolve o texto cru de um `X-Forwarded-For` malformado como `request.ip` (sem lançar); sem o fallback ele viraria uma chave arbitrária.
- **`TRUST_PROXY`:** o `trustProxy` do Fastify 5.12 não lista `number` nos tipos (o runtime aceita); o inteiro `n` é entregue como função `(address, hop) => hop < n`, que é o que o proxy-addr faz com um número. Regras além da spec, para a configuração ser explícita: inteiro de 1 a 32 (`0` é rejeitado; use `false`), palavras-chave do proxy-addr (`loopback`...) rejeitadas, entrada de lista com prefixo `/0` rejeitada (confiaria em qualquer endereço; use `true`). `TRUST_PROXY=true` gera um `warn` no boot. O `trustProxy` é aplicado mesmo com `RATE_LIMIT_ENABLED=false`.
- **Config:** `RATE_LIMIT_*_MAX` aceita 1 a 1 000 000 (a spec dizia só "inteiros positivos"); `RATE_LIMIT_REDIS_TIMEOUT_MS` 1 a 10 000; vazio vale como ausente em `RATE_LIMIT_ENABLED` e `TRUST_PROXY`. `RATE_LIMIT_ENABLED=false` registra `warn` no boot.
- **Conexão dedicada:** `createRateLimitRedis` (`enableOfflineQueue: false`, `commandTimeout`, `maxRetriesPerRequest: 1`, mesma reconexão e listener de erro em log do singleton); o boot espera até 2 s pela conexão e segue com `warn` se não ficar; `Infrastructure.rateLimitRedis` (opcional) é fechada por `closeInfrastructure`. `closeRedisClient` passou a ser exportado de `redis.client.ts` para reaproveitar o fechamento.
- **Testes:** `TestKeyspace.scopedPrefix`/`keysUnder` (prefixo único e limpeza por `SCAN` só das chaves do teste) e `ToggleProxy` (`src/test-support/toggle-proxy.ts`, proxy TCP entre o client e o Redis: `blackhole` simula Redis lento e `stop()`/`start()` simulam queda e volta, sem tocar no servidor real). A janela expira por sondagem com prazo (janela de 2 s), sem dormir tempo fixo. Há ainda um teste de boot do processo real (`src/boot.integration.test.ts`): `TRUST_PROXY=1` com limite `admin` pequeno, `RATE_LIMIT_ENABLED=false` fora de produção e a rejeição em produção; as chaves do Redis desse teste são de IPs aleatórios da faixa de documentação, com janela de 5 s, e só elas são removidas.
- **Validação local (2026-10-27):** `typecheck`, `lint`, `format:check`, `test` (460 testes) e `test:integration` (147 testes) verdes em Node 22.23.2 e em Node 24.18.0; as suítes novas foram repetidas 5 a 6 vezes sem falha. CI ainda não rodou.
- **Para a spec 011:** o webhook registra suas rotas com `config: rateLimitProfile('webhook')` dentro de `app.register(...)`, e o teste de inventário de rotas passa a exigir isso. `TRUST_PROXY=1` atrás de túnel é obrigatório para que a Meta e um atacante não dividam a mesma cota.
