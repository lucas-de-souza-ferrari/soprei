# 023 — Conectar o WhatsApp pelo site (canal, persona e teste do atendimento)

- **Status:** aprovada (2026-11-04, dono: "Aprovo tudo", com as 11 recomendações)
- **Branch:** `spec/023-conectar-whatsapp-no-site`
- **Depende de:** 008 (permissões), 015 (credencial do canal e Embedded Signup no servidor), 017 e 021 (sessão da conta por cookie), 018 (beUI, modo escuro, contraste) e 022 (vocabulário: `Company`, `Membership`, `Account`, `contact`; rota `/admin/companies/:companyId/...`; cabeçalho `X-Soprei-App`; claim `cid`)
- **Passa pelo `reviewer` antes do merge:** sim (endpoint novo, permissão nova, fluxo de credencial no navegador, script de terceiro no site).

## Objetivo

Hoje o backend da 015 já liga o número de uma empresa ao Soprei, mas só por chamada de API. O objetivo do dono é que **quem entrar no site consiga conectar o próprio número** e ver o assistente responder, para ter algo para mostrar. Esta spec entrega, dentro da empresa selecionada: a tela "Canal do WhatsApp" (Embedded Signup da Meta, estado, trocar, desconectar), a edição da persona pela própria empresa e uma caixa "Testar o atendimento" que usa o simulador existente. O painel de conversas é a spec 024.

## O que existe hoje (fatos do código, lidos em 2026-11-04)

**A ponte cookie -> rotas de tenant já existe; esta spec não cria autorização nova.**

- `backend/src/infrastructure/http/server.ts` (hook `onRequest` da raiz, só com `accounts` ligado): para caminhos `/admin/*` e `/auth/me`, **sem** `Authorization` e **com** cookie, chama `accounts.service.tenantIdentity(cookie)` e põe o resultado em `request.auth`. Com `Authorization: Bearer` o Bearer vale e o cookie é ignorado.
- `AccountService.tenantIdentity` (`application/auth/account.service.ts`) lê a sessão no Redis, exige empresa selecionada (sem seleção devolve `null` e a rota responde a 401 de sempre) e **relê no banco a cada requisição** o vínculo ativo da conta na empresa selecionada e a empresa ativa (`AccountRepository.membership`: empresa `ACTIVE` e não removida, vínculo `ACTIVE`; senão 401). Devolve `MembershipIdentity` com o **papel lido do banco agora** (não o de um token antigo). Conta desativada, vínculo desativado e empresa suspensa perdem o acesso na hora.
- A partir daí a rota é a mesma de sempre: `authenticateHook` vê `request.auth` preenchido e segue; `requirePermission('...', { companyParam: 'companyId' })` aplica 401 -> 403 (`PlatformAdmin`) -> **404** (`:companyId` do caminho diferente da empresa selecionada, antes da permissão) -> 403 (papel sem a permissão). O service recebe só o `companyId` da identidade.
- CSRF: toda requisição **não GET/HEAD** com identidade vinda do cookie exige `Origin === APP_ORIGIN` e `X-Soprei-App: web` (403 "Origem inválida" senão). O cookie é `HttpOnly; SameSite=Strict` e as respostas `/admin/*` levam `Cache-Control: no-store`. O perfil de rate limit `admin` vale como nas outras rotas.
- Rotas `/admin/companies` (listar/criar/atualizar empresa, só `PlatformAdmin`) com cookie dão 403 (a identidade é de vínculo).
- Prova existente: `accounts.integration.test.ts` cobre cookie em `/admin/companies/:id/memberships` (próprio 200, empresa alheia 404, sem Origin 403, Redis fora 503). **Não há teste do cookie nas rotas de canal e de atendimento**, mas elas passam pelo mesmo hook.

**O que falta de fato (e é isto que a spec cobre):**

1. `frontend/src/AccountApp.tsx`: a função `api()` só faz GET e POST, descarta o corpo do erro (não lê `error.code`) e mapeia 403 para "Confirme seu e-mail". O canal precisa de PUT e DELETE e dos códigos `CHANNEL_*`.
2. O site não tem nenhuma tela de empresa: `/account/companies` devolve só `{ companyId, membershipId, name, role }` e a tela "Suas empresas" só seleciona. Não há onde o canal, a persona e o teste morem.
3. **Persona:** `PATCH /admin/companies/:id` (`companies.controller.ts`, `requirePlatform()`) é a única rota que grava `persona`, e `GET /admin/companies/:id` a única que a lê; as duas são só do `PlatformAdmin`. Nenhum papel de empresa alcança a persona. Falta permissão, rota e service.
4. **Valores públicos da Meta:** `WHATSAPP_APP_ID` existe só no backend (`env.schema.ts`, `config/whatsapp.ts`); o `config_id` do Embedded Signup não existe em lugar nenhum.
5. O frontend não sabe quais permissões o papel tem (só o nome do papel); o mapa fica em `domain/permissions.ts`.
6. O servidor da 015 já refaz a prova de posse com o token trocado do `code`; **não é preciso confiar nos ids do navegador** e nada disso muda.

## Comportamento esperado

### Navegação

Depois de selecionar uma empresa em "Suas empresas", o site mostra o **menu da empresa** (abas com foco por teclado, beUI `Tabs`): **Canal**, **Persona**, **Testar** e "Trocar de empresa". As abas aparecem conforme as permissões que o servidor devolve para o papel (ver "Contratos"). Rotas do site (History API, sem biblioteca nova, como na 017): `/painel/canal`, `/painel/persona`, `/painel/testar`, **sem ids na URL** (a empresa é a selecionada na sessão). O papel é só conveniência de tela; **o backend continua sendo a barreira** (a aba escondida não protege nada).

Se o servidor responder 404 a uma rota de empresa (a seleção mudou em outra aba, a empresa foi suspensa), a tela recarrega sessão e lista, avisa "A empresa selecionada mudou. Escolha de novo" e volta a "Suas empresas".

### Tela "Canal do WhatsApp" (`channel:read` para ver, `channel:manage` para agir; OWNER e ADMIN)

Mostra o estado de `GET .../channel`, sem nunca receber nem exibir token, texto cifrado ou PIN:

| `state`         | O que a pessoa vê                                                                                                   | Ações                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `NOT_CONNECTED` | "Nenhum número conectado" e o painel explicativo                                                                    | "Conectar com a Meta"; seção "Avançado" (decisão 4)                 |
| `CONNECTED`     | número (ID do número de telefone da Meta, rótulo "ID do número"), "conectado desde" e, se houver, validade do token | "Trocar número ou renovar" (refaz o Embedded Signup), "Desconectar" |
| `TOKEN_INVALID` | alerta "A Meta recusou o acesso. O assistente parou de responder neste número" e a data                             | "Reconectar" (refaz o Embedded Signup), "Desconectar"               |
| `LEGACY`        | "Este número usa a credencial antiga do Soprei. Reconecte para continuar"                                           | "Reconectar"                                                        |

- **Painel explicativo (antes do popup)**: o que acontece ("uma janela da Meta abre; você escolhe a conta e o número"), que o Soprei passa a responder mensagens recebidas nesse número, e **aviso de WABA compartilhada**: "uma conta do WhatsApp Business conecta a uma empresa só; desconectar remove o acesso do Soprei à conta inteira, o que afeta qualquer número dela". Esse aviso aparece também na confirmação de desconectar.
- **Desconectar:** diálogo de confirmação (foco preso, Esc fecha, botão destrutivo, texto do aviso acima). Chama `DELETE` (204 idempotente). Depois, o estado vira `NOT_CONNECTED`.
- Cada ação desabilita os botões enquanto roda (sem duplo envio), e uma resposta tardia de ação anterior (troca de empresa, nova ação) é descartada com o mesmo contador de geração do `AccountApp` (017).
- **Mensagens de erro (pt-BR, escolhidas pelo `code` do corpo; o texto do servidor é ignorado, o site nunca mostra `message` da API nem da Meta):**

| Origem                                                  | Mensagem ao usuário                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `CHANNEL_TOKEN_REJECTED`                                | "A Meta recusou a autorização. Tente conectar de novo."                                         |
| `CHANNEL_WRONG_APP`                                     | "A autorização não veio do aplicativo do Soprei. Tente conectar de novo pela janela do site."   |
| `CHANNEL_MISSING_SCOPE`                                 | "Faltou conceder todas as permissões do WhatsApp. Conecte de novo e aceite todas."              |
| `CHANNEL_NUMBER_NOT_IN_WABA`                            | "Esse número não pertence à conta escolhida. Selecione o número na janela da Meta."             |
| `CHANNEL_NUMBER_IN_USE` (409)                           | "Esse número já está conectado a outra empresa." (sem dizer qual)                               |
| `CHANNEL_CODE_INVALID`                                  | "A autorização expirou ou já foi usada. Tente de novo."                                         |
| `CHANNEL_REGISTRATION_FAILED`                           | "Não foi possível registrar o número na Meta. Tente de novo; se persistir, fale com o suporte." |
| 502, 503                                                | "A Meta ou o serviço está indisponível. Tente novamente em instantes." (nada foi gravado)       |
| 429                                                     | "Muitas tentativas. Aguarde antes de tentar novamente."                                         |
| 403                                                     | "Você não tem permissão para esta ação." (não o texto de "confirme seu e-mail")                 |
| 404                                                     | fluxo "a empresa selecionada mudou" acima                                                       |
| 401                                                     | volta ao login (comportamento atual)                                                            |
| 400 sem código conhecido, rede, resposta fora do schema | "Não foi possível concluir. Tente novamente."                                                   |

Os avisos de erro usam `Alert` com `role="alert"` e o campo/botão relacionado fica com `aria-describedby` (padrão da 018/021).

### Embedded Signup no navegador

> **Fonte e confirmação.** A documentação oficial é [Embedded Signup (Meta for Developers)](https://developers.facebook.com/docs/whatsapp/embedded-signup/) e a [implementação](https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation) (página "Implementation"); o SDK é o [Facebook SDK for JavaScript](https://developers.facebook.com/docs/javascript/). **O agente que escreveu esta spec não conseguiu abrir essas páginas na sessão** (sem acesso à web), então o desenho abaixo vem do que está registrado na 015 e do formato que a documentação trazia até o último contato; **tudo marcado "(a confirmar)" precisa ser conferido contra a documentação atual antes de aprovar**, e a versão da Graph usada é a do projeto (`WHATSAPP_GRAPH_API_VERSION`, hoje `v26.0`).

1. **Carregamento do SDK, só aqui e em dois cliques.** O SDK **não** entra no HTML do site nem no bundle: um módulo `facebook-sdk.ts` injeta `<script src="https://connect.facebook.net/en_US/sdk.js" async>` (a confirmar o locale e o caminho) **uma vez**, quando a pessoa clica em "Conectar com a Meta" e o painel explicativo abre (clique 1). O painel mostra "Carregando…" até `FB.init` terminar e então habilita "Continuar na Meta" (clique 2), cujo manipulador chama `FB.login` **de forma síncrona** (navegadores, em especial o Safari, bloqueiam popup aberto depois de espera assíncrona). Falha ao carregar o SDK (rede, bloqueador de conteúdo): erro "Não foi possível carregar a janela da Meta. Desative bloqueadores e tente de novo" e botão para tentar outra vez (a `<script>` com erro é removida para permitir novo carregamento).
2. `FB.init({ appId, autoLogAppEvents: false, xfbml: false, version })` (a confirmar os parâmetros; a documentação de exemplo usa `autoLogAppEvents: true` e `xfbml: true`, aqui desligados de propósito: não usamos plugins nem queremos eventos enviados à Meta). `appId` e `version` vêm do servidor (ver "Contratos").
3. `FB.login(callback, { config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: '', sessionInfoVersion: '3' } })` (a confirmar `extras` e `sessionInfoVersion` na versão vigente). O callback recebe `authResponse.code` quando concluído; `authResponse` nulo ou sem `code` = cancelamento.
4. **Evento `message` (`WA_EMBEDDED_SIGNUP`).** O popup avisa a janela por `window.postMessage`. O listener é registrado **só enquanto uma tentativa está em andamento** e removido ao terminar. Regras estritas:
   - ignora (sem log nem erro na tela) qualquer evento cujo `event.origin` não seja **exatamente** `https://www.facebook.com` ou `https://web.facebook.com` (a confirmar a lista vigente; comparação por igualdade, nunca `endsWith` nem `includes`);
   - `event.data` pode vir como texto JSON ou objeto: texto acima de 8 KiB é descartado antes do `JSON.parse`; o resultado passa por **Zod estrito** no formato `{ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH' | 'CANCEL' | 'ERROR' ..., data: {...} }` (a confirmar os nomes: `FINISH` traz `data.phone_number_id`, `data.waba_id` e `data.business_id`; `CANCEL` traz `data.current_step`; erro traz `data.error_message`, `data.error_id`, `data.session_id`, `data.timestamp`; a Meta também documenta variantes como `FINISH_ONLY_WABA` e `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, que **não** são suportadas aqui e viram "fluxo não suportado, tente de novo");
   - `phone_number_id` e `waba_id` só valem se casarem com `^[0-9]{1,32}$` (mesma regra do servidor);
   - evento fora de uma tentativa em andamento, repetido ou posterior à conclusão é ignorado.
5. **Correlação e prazo.** O `code` (callback do `FB.login`) e os ids (evento `FINISH`) chegam por canais diferentes e **em ordem não garantida**. A tentativa é uma máquina de estados pura (`embedded-signup-state.ts`, testável sem navegador): `idle -> waiting_popup -> (code?, ids?) -> submitting -> done | failed`. Só envia quando tem os dois. O `code` vale cerca de 30 s e é de uso único: se o `code` chegou e os ids não vêm em 10 s, ou se passaram 20 s desde o `code` sem envio, a tentativa falha com "Tempo esgotado. Tente de novo" e o `code` é descartado **sem enviar** (o servidor responderia `CHANNEL_CODE_INVALID`). O envio é `POST /admin/companies/:companyId/channel/embedded-signup` com `{ code, wabaId, phoneNumberId }`; o servidor **não confia nos ids** e refaz a prova de posse (015).
6. Eventos `CANCEL` e o `authResponse` nulo: volta ao estado anterior com aviso neutro "Conexão cancelada" (não é erro). `ERROR` do evento: "A Meta não concluiu a conexão. Tente de novo." sem mostrar `error_message`. Popup bloqueado (o `FB.login` não chama o callback e nenhuma mensagem chega em 3 s depois do clique 2... a confirmar o comportamento do SDK com popup bloqueado): o site mostra "Seu navegador bloqueou a janela da Meta. Permita pop-ups para este site e tente de novo" e libera o botão. Fechar o popup sem concluir vale como cancelamento.
7. **Segredos e privacidade no navegador:** `appId` e `config_id` são públicos (a Meta os expõe). O `code`, os ids e o telefone **nunca** vão a URL, `localStorage`/`sessionStorage`, `console`, mensagem de erro ou histórico; ficam só em variáveis de memória da tentativa e são zerados ao terminar (sucesso, falha, cancelamento, troca de empresa, desmontagem). O site não loga nada do evento recebido. O número de telefone do cliente final **não existe** aqui (só o ID do número da Meta, que o `GET .../channel` já devolve).
8. Duas abas, ou dois cliques seguidos: o botão fica desabilitado durante a tentativa; o servidor é idempotente (`PUT`/signup refazem a conexão da mesma empresa) e o segundo `code` já usado dá `CHANNEL_CODE_INVALID`. Ao voltar o foco para a aba, o estado é relido (`GET .../channel`).

### Persona (OWNER e ADMIN)

Campo de texto (até **4000** caracteres, `PERSONA_MAX_LENGTH`) com contador, "Salvar" e "Voltar ao padrão" (grava `null`). Dica curta sobre o que escrever (tom, nome do negócio, o que o assistente pode e não pode dizer). Texto em branco ou só espaços não salva; NUL é recusado (400). O conteúdo da persona só trafega na resposta ao dono; **nunca vai a log, métrica, URL ou armazenamento do navegador**.

### Testar o atendimento (`conversation:simulate`; OWNER, ADMIN e AGENT)

Caixa de conversa: a pessoa escreve (até 4000 caracteres) e vê a resposta do assistente. Usa `POST /admin/companies/:companyId/messages` (simulador existente, resposta síncrona, **sem esperar a janela de agrupamento**) com `contactRef` fixo `teste-no-site` (os testes de várias pessoas da mesma empresa compartilham essa conversa; o painel da 024 as mostrará). Mostra o texto devolvido; resposta de fallback (`isFallback`) aparece com a marca "resposta padrão (houve falha ao gerar)". O histórico da caixa vive só na memória da página (recarregar limpa a tela; a conversa continua gravada no servidor). Envio desabilita o botão enquanto espera e cada envio é uma mensagem nova (sem `externalId`). Aviso fixo: "É um teste: a conversa fica gravada no Soprei e, com o modelo real ligado, o texto é enviado ao provedor de IA." Se a empresa tem o canal conectado, o aviso lembra que o teste **não** manda nada ao WhatsApp.

### Contratos novos no backend

Tudo atrás dos mesmos hooks de sempre (cookie ou Bearer, `requirePermission`, perfil `admin`, `:companyId` conferido contra a identidade, 404 uniforme).

1. **`GET /admin/companies/:companyId/channel/setup`** (`channel:manage`; só existe com `WHATSAPP_ENABLED=true`): `{ embeddedSignup: { appId, configId, graphApiVersion } | null, manualConnect: boolean }`. `embeddedSignup` é `null` se `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` não estiver definido. Só valores públicos (nunca `WHATSAPP_APP_SECRET`, token, chave de cifra).
2. **Config nova (em `env.schema.ts` e `.env.example`; um único módulo de config):** `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` (opcional, `^[0-9]{1,32}$`; vazio = Embedded Signup indisponível; exige `WHATSAPP_ENABLED=true` e `WHATSAPP_APP_ID`); `CHANNEL_MANUAL_CONNECT_ENABLED` (`true`/`false` literais, padrão `false`; `true` é **rejeitado com `NODE_ENV=production`**; só decide se a seção "Avançado" aparece, o `PUT` da 015 continua existindo como API). Ver decisões 2 e 4.
3. **Permissão nova `persona:manage`** em `domain/permissions.ts` (OWNER e ADMIN; AGENT e VIEWER não; atualiza o teste de snapshot do mapa). Rotas em `presentation/admin/persona.controller.ts`: `GET /admin/companies/:companyId/persona` -> `{ persona: string | null }` e `PUT /admin/companies/:companyId/persona` com `{ persona: string | null }` (estrito; mesmo schema de `updateCompanyBodySchema.persona`: `trim`, 1 a 4000, sem NUL, `null` limpa) -> 200 com o mesmo corpo do `GET`. Novo método no service de empresa que recebe o `CompanyId` **da identidade** (nunca do caminho) e reaproveita `parsePersona`; `PATCH /admin/companies/:id` do `PlatformAdmin` não muda. Métrica `company_persona_updates_total{action}` (`set`, `cleared`); log `info` só com `companyId`, `membershipId` e a ação, nunca o texto nem o tamanho exato. Auditoria: decisão 6.
4. **`permissions` em `GET /account/companies`** (aditivo): cada item ganha `permissions: Permission[]`, derivado de `ROLE_PERMISSIONS` no servidor (decisão 8). O Zod do site aceita o campo; clientes antigos ignoram.
5. Nenhuma rota de canal, de atendimento ou de empresa existente muda de contrato. O site usa as de sempre: `GET/PUT/DELETE .../channel`, `POST .../channel/embedded-signup`, `POST .../messages`.

### Frontend

- Reuso dos componentes beUI já copiados (`Card`, `Button`, `Input`, `Alert`, `Tabs`, `Loader`); **nenhuma dependência nova**, nenhum pacote do Facebook (o SDK vem por `<script>` sob demanda). Pode ser preciso copiar do registro beUI (`https://beui.dev/r/{slug}`) um diálogo/modal e um campo de texto longo (registrar em `NOTICE.md`; sem aliases); se o diálogo não existir, o aviso de desconectar é um painel em linha com foco movido para ele.
- A função `api()` sai de `AccountApp.tsx` para um módulo (`frontend/src/api.ts`) com GET, POST, PUT e DELETE, leitura do `error.code` (Zod no corpo do erro, sem ecoar o valor) e o mesmo contador de geração; `AccountApp.tsx` só importa dela. Sem mudar o comportamento das telas já cobertas pelos testes da 017/021.
- Cores só dos tokens; **todo par texto/fundo novo entra em `src/theme/contrast.test.ts`** (por exemplo, texto de `Alert` de aviso sobre `card`, estados do canal). Modo claro e escuro, desktop e celular (a 018 já roda os dois no Playwright). Rótulos visíveis, foco visível, ordem de tabulação natural, `aria-live` no resultado das ações, texto em pt-BR.

## Critérios de aceite

Backend (testes unitários e de integração; `FakeGraphApi` existente para a Meta; nenhuma chamada real):

- [x] **Ponte de sessão nas rotas de canal e de atendimento:** com cookie da conta, empresa selecionada e papel `OWNER`, `GET/PUT/DELETE .../channel`, `POST .../channel/embedded-signup`, `GET .../channel/setup`, `GET/PUT .../persona` e `POST .../messages` respondem como com Bearer (teste que percorre as rotas de tenant do inventário com cookie, sem lista manual que envelheça).
- [x] Papéis com cookie: `ADMIN` igual a `OWNER` nas rotas de canal e persona; `AGENT` recebe 403 em canal e persona e 201 no simulador; `VIEWER` recebe 403 em canal, persona e simulador; **a negação usa o papel lido do banco agora** (rebaixar o vínculo no meio da sessão muda a resposta na requisição seguinte).
- [x] Empresa alheia: conta com vínculo só em A, seleção em A, chamando `.../companies/B/channel`, `.../persona`, `.../messages` e `.../channel/setup` recebe 404 **idêntico** ao de empresa inexistente (mesmo corpo, sem `requestId` na comparação); `B` não é alterada. Conta sem seleção recebe 401. Vínculo desativado, conta desativada e empresa suspensa deixam de acessar (401).
- [x] `PlatformAdmin` (Bearer de plataforma) recebe 403 em `.../persona`, `.../channel/setup` e nas de canal; `Authorization` inválido com cookie válido não cai no cookie (Bearer manda).
- [x] CSRF: PUT/DELETE/POST com cookie e sem `Origin` igual a `APP_ORIGIN`, ou sem `X-Soprei-App: web`, dão 403 e **nada é gravado** (canal, persona, mensagem); GET com cookie não exige. Redis das sessões fora = 503.
- [x] `GET .../channel/setup`: com `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` devolve `appId`, `configId`, `graphApiVersion`; sem ele `embeddedSignup: null`; `manualConnect` reflete `CHANNEL_MANUAL_CONNECT_ENABLED`; a resposta serializada **não contém** o segredo do app, o token legado nem as chaves de cifra (teste por busca dos valores sentinela). Sem `WHATSAPP_ENABLED` a rota não existe (404). Config: `CHANNEL_MANUAL_CONNECT_ENABLED=true` com `NODE_ENV=production` falha no boot; `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` inválido falha no boot.
- [x] Persona: `PUT` grava e `GET` devolve; `null` limpa; vazio, só espaços, NUL, 4001 caracteres, campo extra (`companyId`, `name`...) e corpo sem `persona` dão 400; a persona gravada chega ao `LlmProvider` na próxima mensagem do simulador (o teste olha o `systemPrompt` recebido pelo mock). Corpo com `companyId` de outra empresa não tem efeito (o schema estrito recusa).
- [x] **Isolamento da persona:** duas empresas com personas diferentes; o `OWNER` de A lê e grava só a de A (também por cookie); a de B segue intacta depois de tentativas por caminho de B (404) e por corpo adulterado.
- [x] `GET /account/companies` devolve `permissions` coerentes com `ROLE_PERMISSIONS` para cada papel e vínculo da conta (OWNER em A, VIEWER em B retornam listas diferentes); o teste de snapshot do mapa de permissões inclui `persona:manage`.
- [x] **Privacidade (log e métrica):** testes de fluxo capturam o log (`logContains`) e provam que **não** aparecem: texto da persona, texto das mensagens do simulador, `code` do Embedded Signup, token, PIN, texto cifrado, `appId`/`configId`. `/metrics` expõe `company_persona_updates_total` só com o label `action`. Os testes comparam erros por `code` e `message` (nunca `requestId`).
- [x] O inventário de rotas (`rate-limit.test.ts`) passa: rotas novas com perfil `admin` e `requirePermission` (`channel:manage`, `persona:manage`).

Frontend (unitários `node:test`, Playwright com API falsa local, desktop e celular, claro e escuro):

- [x] Máquina de estados do Embedded Signup (unitário, relógio injetável): envia só com `code` **e** ids; aceita as duas ordens de chegada; descarta o `code` com mais de 20 s sem enviar; 10 s sem ids = falha; segunda tentativa não reaproveita ids nem `code` da anterior; estado zerado ao concluir, falhar, cancelar e trocar de empresa.
- [x] Parser do evento (unitário): aceita `FINISH` bem formado das duas origens da Meta; **ignora** origem diferente (`https://evil.example`, `http://www.facebook.com`, `https://www.facebook.com.evil.example`, `null`), tipo diferente de `WA_EMBEDDED_SIGNUP`, JSON inválido, texto acima de 8 KiB, ids não numéricos e evento fora de tentativa; `CANCEL` e erro viram estados distintos.
- [x] O SDK **não é requisitado** antes do clique 1 (a rota `https://connect.facebook.net/**` do Playwright não recebe pedido ao abrir o site, a lista de empresas nem a aba Canal) e é requisitado uma única vez depois (clique 1 duas vezes não duplica o `<script>`). `FB.login` é chamado dentro do clique 2 e recebe `config_id`, `response_type: 'code'`, `override_default_response_type: true` e `extras.sessionInfoVersion: '3'` (a confirmar).
- [x] e2e com `window.FB` falso servido pela rota do SDK e `postMessage` disparado pelo teste: conectar (estado `NOT_CONNECTED` -> `CONNECTED`, o corpo enviado ao servidor tem exatamente `{ code, wabaId, phoneNumberId }`) -> desconectar com confirmação (aviso de WABA visível) -> `NOT_CONNECTED`.
- [x] e2e: evento com origem incorreta **não** conclui a conexão (nenhum pedido ao servidor); `TOKEN_INVALID` mostra o alerta e "Reconectar" refaz o fluxo; `LEGACY` mostra a orientação; cancelar o popup (`authResponse` nulo e evento `CANCEL`) volta ao estado anterior sem erro vermelho; popup bloqueado mostra a mensagem própria e libera o botão; 409 `CHANNEL_NUMBER_IN_USE`, 400 `CHANNEL_CODE_INVALID`, `CHANNEL_REGISTRATION_FAILED`, 502 e 429 mostram a mensagem da tabela e **não** o texto do servidor; `code` expirado (relógio) não é enviado.
- [x] e2e: `AGENT` e `VIEWER` não veem a aba Canal nem Persona (e `VIEWER` não vê Testar); mesmo forçando `/painel/canal` na URL, a tela não chama a API de canal e mostra "sem permissão"; 404 de empresa muda a tela para "A empresa selecionada mudou".
- [x] e2e persona: salvar, limpar ("Voltar ao padrão"), contador de caracteres, erro de 400 acessível (`aria-describedby`); e2e testar atendimento: envio, resposta, resposta de fallback marcada, botão desabilitado enquanto espera, resposta tardia depois de trocar de empresa **não** aparece na outra empresa.
- [x] Nenhuma tela guarda `code`, ids, token ou persona em `localStorage`/`sessionStorage`/URL (teste do Playwright confere os dois storages e `location` ao fim dos fluxos); nenhuma chamada de rede além de `/api/**` e do script do SDK; mensagens de erro nunca contêm o texto do corpo da resposta (a API falsa devolve `message` com um sentinela que não pode aparecer).
- [x] Contraste: pares novos em `contrast.test.ts` nos dois temas (mínimo 4,5:1 texto; 3:1 bordas e foco). Foco por teclado percorre o menu da empresa, o painel e o diálogo; Esc fecha o diálogo e devolve o foco ao botão de origem.

Gerais: `pnpm typecheck`, `pnpm lint`, `pnpm format:check` (raiz) verdes; o CI verde em Node 22 e na LTS mais recente; o gate de vocabulário da 022 (`domain-vocabulary.test.ts`) segue verde (sem os termos antigos).

## Casos de borda e erros

- O `code` expira (~30 s) ou já foi usado: `CHANNEL_CODE_INVALID`; a tela oferece tentar de novo, sem reaproveitar nada da tentativa anterior.
- A pessoa fecha o popup: tratada como cancelamento; nada é enviado. Se o evento `FINISH` chega mas o `code` não (ou vice-versa), falha por tempo, sem enviar parcial.
- Duas abas na mesma empresa: ambas leem o mesmo estado; a segunda conexão é idempotente no servidor. Duas abas em empresas diferentes: a seleção é da sessão (compartilhada); a aba "velha" recebe 404 uniforme e recarrega.
- Número já ligado a outra empresa: 409 uniforme, sem dizer qual; o `subscribed_apps` já feito é inofensivo (015).
- Se o `/register` der certo na Meta e a gravação falhar, o PIN se perde e repetir tende a dar `CHANNEL_REGISTRATION_FAILED` (limitação aceita da 015); o site orienta a usar o suporte ou a alternativa manual (se ligada).
- WABA compartilhada: o `DELETE` desassina o app da WABA inteira (015) e isso aparece no aviso antes de desconectar. Outro número da mesma WABA, se estiver ligado a outra empresa do Soprei, também perde o recebimento.
- Meta em modo desenvolvimento: só administradores, desenvolvedores e testadores do app conseguem concluir o fluxo; os demais veem erro da própria Meta no popup. O site não distingue (o popup é da Meta); o **passo do dono 1** explica.
- Papel rebaixado ou vínculo desativado no meio da tela: a próxima chamada responde 403/401 e a tela reflete (mensagens da tabela).
- Empresa sem canal configurado no servidor (`WHATSAPP_ENABLED=false`): as rotas de canal não existem (404); a aba Canal mostra "O canal do WhatsApp não está habilitado neste ambiente" quando `GET .../channel` ou `.../channel/setup` responde 404 sem a empresa ter mudado (confirmado relendo a sessão).
- `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` ausente: o painel não oferece "Conectar com a Meta"; mostra só o que estiver habilitado (a seção "Avançado" se ligada) ou a mensagem "A conexão pelo site ainda não está configurada".
- Persona muito longa ou com NUL: 400, mensagem fixa na tela. Persona de outra empresa: inalcançável (404). Texto da persona nunca em log.
- Simulador com o provedor de IA fora: o servidor já devolve o texto padrão com `isFallback = true` (010); a caixa mostra a marca.
- Bloqueador de conteúdo impede o SDK: erro com nova tentativa; a tela não quebra.
- Troca de empresa durante qualquer fluxo: invalida o contador de geração, zera o estado da tentativa (code e ids) e descarta respostas tardias.

## Riscos (novos, e o que fazemos)

1. **Script de terceiro (SDK da Meta) no mesmo origin da sessão.** Um SDK comprometido ou adulterado teria o poder de uma XSS nessa página (o cookie é `HttpOnly`, mas ele conseguiria chamar a API com os cabeçalhos certos). Mitigações: carregado só na tela do canal, só para quem tem `channel:manage`, só depois do clique; sem SRI possível (a Meta atualiza o arquivo); sem `xfbml` e sem eventos automáticos. **Risco residual aceito se o dono aprovar a decisão 10**; a CSP (que restringiria a origem do script e dos frames) é pendência conhecida da 018 e deve ser tratada junto com a hospedagem. Registrar o que o SDK exige na CSP: `script-src https://connect.facebook.net`, `frame-src https://www.facebook.com https://web.facebook.com https://staticxx.facebook.com`, `connect-src` e `img-src` dos domínios da Meta (a confirmar), e que o popup usa `window.open`.
2. **`postMessage` forjado** por outra janela ou iframe: a validação estrita de `event.origin` e o schema Zod só aceitam o formato da Meta; mesmo um evento forjado só serve para **tentar** um envio, e o servidor refaz a prova de posse com o token do `code` (o atacante teria de ter um `code` válido do nosso app e do nosso usuário). Sem o `code`, não há envio.
3. **Expiração de 30 s e tentativa dupla**: tratadas pela máquina de estados e pela idempotência do servidor.
4. **Clickjacking**: o painel do canal pede dois cliques e um diálogo para desconectar; o site ainda **não** envia `frame-ancestors`/`X-Frame-Options` (depende de hospedagem, pendência junto da CSP). Registrar na revisão.
5. **Token digitado no navegador (formulário avançado):** é um segredo em memória do navegador e passa pelo proxy; por isso só aparece com a flag, campo `type="password"`, sem autocompletar, limpo depois do envio (sucesso ou erro), nunca em log/armazenamento, e a flag é recusada em produção.
6. **Persona editável pelo cliente:** cliente pode pôr instruções que mudem o comportamento do assistente; o texto é só a persona do próprio cliente (sem acesso a dados de outros, o `ATTENDANCE_STYLE_INSTRUCTION` vem depois). Sem filtro de conteúdo nesta spec.
7. **Simulador e dados pessoais:** o texto digitado vai ao provedor de IA real quando `LLM_PROVIDER=anthropic`; o aviso na tela diz isso; os termos de dados da Anthropic (LGPD) são passo do dono (014).
8. **Dependência do app da Meta** (modo desenvolvimento, análise, Tech Provider): sem os passos do dono, o fluxo só funciona para quem tem papel no app.

## Isolamento entre empresas

Esta spec **toca em dados de empresa** (canal, persona, mensagens do simulador) mas **não cria acesso a dados fora do que a 008, 010 e 015 já garantem**:

- O `CompanyId` nasce **só** da identidade (token Bearer ou, com cookie, do vínculo relido no banco para a empresa selecionada); `:companyId` do caminho é apenas conferido (404 uniforme) e descartado; corpo e query não carregam `companyId` (schemas estritos).
- A persona fica em `Company` (model global, repositório sem `CompanyId` no filtro por design): por isso o service **só** recebe o id da identidade, e o teste de isolamento da persona (acima) é obrigatório. Nenhuma rota nova aceita id de empresa vindo do corpo.
- A ponte de cookie tem teste novo para as rotas de canal, atendimento e persona (conta com A e B, papéis diferentes em cada, seleção de uma só, tentativas pelo caminho da outra).
- Isolamento do lado do navegador: troca de empresa limpa o estado e descarta respostas tardias (teste e2e acima).

## Fora de escopo

- **Painel de conversas** (lista, mensagens, tempo real): spec 024. A caixa de teste só mostra a resposta da mensagem enviada.
- Convites, gestão de equipe e papéis pelo site; reset de senha de outra pessoa.
- Várias WABAs ou vários números por empresa; mover um número entre empresas; "uma WABA = uma empresa" continua.
- Gestão de PIN/2FA do WhatsApp na interface (o PIN é gerado e guardado cifrado pelo servidor; o cliente nunca o vê).
- Cobrança, planos e limites por plano.
- Executar a App Review, a verificação do negócio, o cadastro de Tech Provider ou qualquer configuração no painel da Meta (são passos do dono).
- Tempo real (009), CSP, `frame-ancestors`, e divisão de código do bundle (pendências da 018).
- Fluxos do Embedded Signup que não retornam um número com `code` (apenas WABA, coexistência/app de WhatsApp Business): mostram "não suportado".
- Mudar o contrato do `PATCH /admin/companies/:id` do `PlatformAdmin`; editar nome da empresa pelo cliente.
- Varredura de respostas não enviadas e mensagens pendentes antigas (pendência da 013).
- Qualquer chamada real à Meta, ao Facebook SDK ou à Anthropic nos testes.

## Decisões e dependências novas

**Dependências:** nenhuma no backend nem no frontend (o SDK é um `<script>` carregado sob demanda; não se instala pacote). Possíveis componentes beUI novos (diálogo, texto longo) entram por cópia do registro, como na 018, com registro em `NOTICE.md`.

### Decisões para o dono (recomendação primeiro; o dono decide)

1. **Como o site chama as rotas de tenant (a decisão técnica central).**
   - **Recomendado:** **reaproveitar a ponte que já existe** (cookie da conta -> `tenantIdentity` -> mesmas rotas `/admin/companies/:companyId/...`, mesmas permissões, CSRF por `Origin` + `X-Soprei-App`, 404 uniforme) e **não criar nenhum caminho de autorização novo**. O trabalho é: PUT/DELETE e `error.code` no cliente do site, testes da ponte nas rotas de canal/atendimento/persona e os endpoints novos abaixo.
   - Alternativa: rota de troca "sessão da conta -> access token Bearer de vínculo" para o navegador guardar em memória. Cria segundo caminho de emissão de credencial, token em memória do navegador e revogação extra; a 017 já rejeitou tokens em memória. Não recomendado.
2. **Como o `appId`, o `config_id` e a versão da Graph chegam ao navegador.**
   - **Recomendado:** endpoint autenticado `GET .../channel/setup` (só `channel:manage`), com `WHATSAPP_APP_ID` e `WHATSAPP_GRAPH_API_VERSION` já existentes e a **variável nova** `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` na config validada e no `.env.example`. Um só lugar de verdade (o `appId` que o site usa é o mesmo que o servidor confere no `debug_token`, sem divergir), sem rebuild do frontend para mudar o `config_id`, e só quem pode conectar recebe os valores.
   - Alternativa: variáveis de build do Vite (`VITE_WHATSAPP_APP_ID`, `VITE_WHATSAPP_CONFIG_ID`): mais simples, mas duplica o app id e exige novo build por ambiente.
3. **Nome e obrigatoriedade do `config_id`.** Recomendado: `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` **opcional** (sem ele, o Embedded Signup fica indisponível e o resto do canal segue). Alternativa: obrigatório com `WHATSAPP_ENABLED=true` (quebra quem já roda só com a conexão manual).
4. **Formulário manual (PUT com `phoneNumberId`, `wabaId`, `accessToken`) no site.**
   - **Recomendado:** incluir, numa seção recolhida "Avançado (testes)", **só quando** `CHANNEL_MANUAL_CONNECT_ENABLED=true` (padrão `false`, recusado em produção). Motivo: é o caminho de demonstração **antes** da App Review (número de teste da Meta + token do nosso app) e o único que não depende do popup. O `PUT` da API continua como hoje.
   - Alternativa: deixar fora do site e justificar com "use a API". Torna a demonstração dependente do Embedded Signup, que antes da análise do app só funciona para quem tem papel no app.
5. **Persona pelo cliente.** Recomendado: **permissão nova `persona:manage`** (OWNER e ADMIN) e rotas `GET/PUT /admin/companies/:companyId/persona` (substitui o corpo inteiro; `null` limpa), sem mexer no `PATCH` do `PlatformAdmin`. Alternativa: reutilizar `channel:manage` (mistura duas responsabilidades) ou abrir o `PATCH /admin/companies/:id` a `Membership` (alargaria a rota que também muda nome e **status** da empresa: não).
6. **Auditoria da mudança de persona.** Recomendado **agora**: só log `info` (ids e ação) e a métrica `company_persona_updates_total{action}`, sem migration, porque ainda não há equipe nem convites pelo site. Alternativa: nova ação de auditoria (`COMPANY_PERSONA_CHANGED`, sem o texto) na mesma transação, o que exige `ALTER TYPE ... ADD VALUE`, ajuste do CHECK por ação e um repositório de transação para `Company`; entra quando houver gestão de equipe.
7. **"Testar o atendimento" nesta spec.** Recomendado **incluir**: é uma tela e um `POST` já existente, ajuda a demonstrar o produto (e a testar a persona) sem WhatsApp. O painel de conversas fica na 024. Alternativa: tirar para a 024 se o PR passar de ~2 000 linhas (ordem de corte: caixa de teste, depois formulário manual).
8. **Como o site sabe as permissões do papel.** Recomendado: campo `permissions` aditivo em `GET /account/companies` (mapa continua só em `domain/permissions.ts`). Alternativa: duplicar o mapa no frontend (dois lugares para esquecer de atualizar).
9. **URLs da área da empresa.** Recomendado `/painel/canal`, `/painel/persona`, `/painel/testar`, sem ids (empresa = seleção da sessão, que já é a fonte da verdade). Alternativa: `/painel/empresas/:companyId/canal` (compartilhável, mas expõe o id e divergiria da seleção da sessão).
10. **SDK de terceiros no site e momento do carregamento.**
    - **Recomendado:** aceitar o SDK da Meta apenas na tela do canal, carregado **depois do clique 1** (painel explicativo) e com o popup aberto no **clique 2** (síncrono, para não ser bloqueado); `xfbml: false`, `autoLogAppEvents: false`. Riscos e mitigações em "Riscos" (1).
    - Alternativas: (a) carregar ao abrir a aba Canal (um clique a menos, menos privacidade); (b) não usar o SDK e fazer o fluxo OAuth por redirecionamento (a Meta documenta o Embedded Signup pelo SDK; sai do suportado).
11. **Primeiro cliente real e App Review.** Recomendado: tratar a App Review como pré-requisito **só** para empresas que não sejam do dono e dos testadores; para a demonstração usar testadores do app e o número de teste (passos abaixo). O dono decide quando pedir a análise.

### Passos do dono (a spec e os agentes não os executam)

Do lado da Meta (a conferir contra a documentação atual de cada item; o dono aprova a spec só depois de confirmar):

1. **App em modo Live** (publicado): em modo de desenvolvimento, só administradores, desenvolvedores e testadores do app conseguem concluir o Embedded Signup.
2. **Verificação do negócio** (Business Verification) da empresa dona do app.
3. **Cadastro como Tech Provider** (provedor de tecnologia) e **App Review com acesso avançado** a `whatsapp_business_management` e `whatsapp_business_messaging`.
4. **Configuração do Embedded Signup:** produto "Login do Facebook para Empresas" no app, criação da configuração de login e **`config_id`** (variável `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` no `backend/.env`); `WHATSAPP_APP_ID` já existente.
5. **Domínios:** o domínio do site em "Domínios permitidos para o SDK JavaScript" e nas URIs de redirecionamento OAuth válidas; o login por SDK exige HTTPS fora de `localhost` (a confirmar o que vale para `localhost` em modo de desenvolvimento).
6. **URL de política de privacidade e de termos de serviço** do app (a Meta exige para publicar) e o contato do app.
7. **Webhook** do app apontando para o túnel/URL pública (`/webhooks/whatsapp`), com `TRUST_PROXY` conforme `AGENTS.md`, e o campo `messages` assinado.
8. `backend/.env` com `ACCOUNTS_ENABLED=true`, `APP_ORIGIN` (origem exata do site), `WHATSAPP_ENABLED=true`, `WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `CHANNEL_CREDENTIALS_*`, `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` e, para a demonstração, `CHANNEL_MANUAL_CONNECT_ENABLED=true` (nunca em produção). Reiniciar backend e frontend juntos.
9. Conferir os termos de dados da Anthropic antes de empresas reais (014) e definir limite de gasto na Console se usar `LLM_PROVIDER=anthropic` para a demonstração.

**O que dá para demonstrar antes da App Review:** cadastro, empresa, persona, "Testar o atendimento" (com `mock` ou Claude), e conectar o **número de teste da Meta** pelo formulário avançado (token do nosso app); conectar pelo Embedded Signup **apenas com contas que têm papel no app** (administrador, desenvolvedor ou testador, a confirmar o que o modo de desenvolvimento permite). **Só depois da análise (e do modo Live):** qualquer visitante conectar o próprio número, que é o objetivo final do dono.

## Registro da implementação

**Implementada em 2026-11-04** por Claude Code (Sonnet 5.5) na branch `spec/023-conectar-whatsapp-no-site`. Sem migration, sem dependência nova (backend e frontend). O SDK do Facebook é um `<script>` carregado em tempo de execução.

**Pastas e arquivos finais**

- Backend: `domain/permissions.ts` (`persona:manage`), `infrastructure/config/` (`WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`, `CHANNEL_MANUAL_CONNECT_ENABLED`, `whatsapp.ts`), `presentation/admin/persona.controller.ts` (novo), `presentation/admin/channel.controller.ts` (`GET .../channel/setup`), `presentation/admin/company.validators.ts` (schema da persona compartilhado), `application/companies/company.service.ts` (`getPersona`, `setPersona`), `application/auth/account.service.ts` (`permissions` em `/account/companies`), `infrastructure/metrics/` (`company_persona_updates_total{action}`), `infrastructure/http/server.ts` e `index.ts` (ligação). Nenhum caminho de autorização novo.
- Frontend: `src/api.ts` (GET, POST, PUT, PATCH, DELETE; só `error.code`), `src/company/` (`CompanyArea`, `ChannelPage`, `PersonaPage`, `TestPage`, `company-api`, `company-nav`, `embedded-signup-event`, `embedded-signup-state`, `facebook-sdk`), `src/components/textarea.tsx`, `src/AccountApp.tsx` e `src/account-flow.ts` (rotas e landing), `e2e/company.spec.ts` e `e2e/company-fixture.ts`.
- Docs: `AGENTS.md` (seção da 023), `docs/context.md`, `docs/handoff.md` (passos do dono).

**Testes**

- Backend, unitários: `persona.controller.test.ts` (matriz de papéis, 404 uniforme, isolamento, `systemPrompt`, privacidade de log e métrica, setup), `config.test.ts` (as duas variáveis novas), `permissions.test.ts`, `metrics.test.ts`, `rate-limit.test.ts` (inventário com as rotas novas).
- Backend, integração (Postgres e Redis reais, só `soprei_test` e Redis `/15`): `site-bridge.integration.test.ts` varre **toda rota de tenant registrada** com cookie (a lista vem do `onRoute`, sem lista manual) e confere papel lido do banco agora, 404 antes de 403, CSRF, 503 com Redis das sessões fora, vínculo/conta/empresa desativados, Embedded Signup por cookie com o Graph falso e privacidade do log.
- Frontend, unitários: parser do evento (origem estrita, 8 KiB, ids, variantes), máquina de estados (relógio por parâmetro), mensagens de erro por `code`, menu por permissão, rotas, contraste (pares novos nos dois temas, inclusive o `Alert` de aviso).
- Frontend, Playwright (desktop e celular, claro e escuro no fluxo principal): API falsa, `window.FB` falso servido pela rota do SDK e `postMessage` com origem correta e incorreta.

**Desvios e decisões da implementação**

1. **Correção de um defeito da 022:** o renome tinha trocado o parâmetro OAuth `client_id` da troca do `code` por `company_id`; a Meta o recusaria. Voltou a `client_id` (cliente Graph, servidor falso e testes) e os quatro arquivos entraram na lista de exceções do gate de vocabulário. Nenhuma outra mudança de comportamento na 015.
2. **Menu depois de selecionar:** a seleção em "Suas empresas" **não** navega sozinha (o e2e da 017 espera continuar na lista com "Selecionada ✓"); o botão "Abrir painel" aparece na empresa selecionada, para quem tem alguma tela.
3. **Popup bloqueado:** em vez da heurística de 3 s sem callback (que erraria com quem demora no popup), o site observa o retorno de `window.open` durante a chamada síncrona do `FB.login` (`null` = bloqueado). Sem `sessionInfoVersion` nem `featureType` (não confirmados).
4. **Desconectar:** diálogo nativo `<dialog>` com `showModal()` (foco preso, Esc fecha, foco volta ao botão), sem componente novo do beUI. O campo de texto longo é um `<textarea>` próprio no mesmo visual do `Input` (`components/textarea.tsx`, não copiado do registro, então sem entrada no `NOTICE.md`).
5. **Rede nos testes:** além de `/api/**` e do script do SDK, a página pede só as fontes do próprio site (Google Fonts, spec 018), que o teste admite.
6. **404 de canal:** relê `GET /auth/session`; mesma empresa = "canal não habilitado neste ambiente", outra = "A empresa selecionada mudou".
7. **Tamanho:** o diff de produção ficou em ~2 000 linhas (o total passa de 4 000 com testes). Nenhum corte foi aplicado (a caixa de teste e o formulário manual somam menos de 300 linhas e a demonstração depende deles); o dono pode pedir o corte.
8. O teclado é coberto para o menu (setas) e o diálogo (Esc e foco); a ordem de tabulação do painel explicativo segue a ordem natural do DOM e não tem teste próprio.

**O que rodou localmente (Node 24.18):** ver a tabela de validação abaixo. **Depende do CI:** Node 22 e a LTS mais recente (typecheck, lint, format, unitários, integração, build e Playwright).

**Fontes consultadas:** só a spec ("Confirmações na documentação da Meta", 2026-11-04). Nenhuma chamada real à Meta, ao SDK do Facebook ou à Anthropic.

**Validação local (Node 24.18, em 2026-11-04):** `pnpm typecheck`, `pnpm lint`, `pnpm format:check` verdes; `pnpm test` 1127 backend e 44 frontend, 0 falhas; `pnpm test:integration` 387 de 387; `pnpm build` ok; `pnpm --filter soprei-frontend test:browser` 60 de 60 (desktop e celular). Node 22 e a LTS ficam para o CI, que continua sendo a palavra final.

## Confirmações na documentação da Meta (2026-11-04)

Conferido pelo agente principal em "Embed the Signup Flow" (developers.facebook.com/docs/whatsapp/embedded-signup/embed-the-flow). O que antes estava "(a confirmar)" e foi **confirmado**:

- `FB.init` com `appId`, `autoLogAppEvents`, `xfbml` e `version` (ex.: `v26.0`; só indica a versão da Graph). A spec pode manter `xfbml: false` e `autoLogAppEvents: false` (a documentação usa `true`, mas o fluxo não depende deles; decisão de privacidade nossa).
- `FB.login(callback, { config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {} } })`; o callback lê `response.authResponse.code`.
- Evento `window` `message`: `JSON.parse(event.data)` e `type === 'WA_EMBEDDED_SIGNUP'`, com `event` e `data`. `FINISH` (e variantes `FINISH_ONLY_WABA`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `FINISH_GRANT_ONLY_API_ACCESS`) traz `data.phone_number_id`, `data.waba_id` e `data.business_id`; `CANCEL` traz `data.current_step`; `ERROR` traz `data.error_message`, `error_code`, `session_id` e `timestamp`. Fechar o popup na tela final conta como sucesso; o `code` só é devolvido ao clicar em Finish. Só `FINISH` simples (com `phone_number_id` e `waba_id`) deve ser aceito por esta spec; as variantes e o fluxo multi-WABA ficam fora de escopo e tratadas como erro.
- Origem: o exemplo oficial só verifica que `event.origin` **termina com `facebook.com`**. A spec deve exigir comparação **estrita por lista** (`https://www.facebook.com`, `https://web.facebook.com`), nunca `endsWith` solto (`evilfacebook.com` passaria).
- O `code` vale **30 segundos** e é de uso único.
- Pré-requisitos no App Dashboard (Facebook Login for Business > Settings > Client OAuth settings): Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth Login, Strict Mode for redirect URIs e Login with the JavaScript SDK **ativos**; o domínio do site em **Allowed domains** e **Valid OAuth redirect URIs** (só HTTPS, com certificado válido, inclusive em desenvolvimento). **Sem isso o evento não chega à janela.** Também é preciso assinar o webhook `account_update`.

Continua **não confirmado**: `sessionInfoVersion` e `featureType` (não constam na página consultada; não usar sem confirmar), e o comportamento exato em modo de desenvolvimento do app. Como o túnel de desenvolvimento é HTTPS, o domínio dele precisa estar cadastrado para o teste local com número de teste.
