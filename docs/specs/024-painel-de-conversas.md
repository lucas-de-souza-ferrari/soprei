# 024 — Painel mínimo de conversas no site (lista e histórico, só leitura)

- **Status:** aprovada (2026-11-04, dono: "Aprovo tudo", com as 10 recomendações)
- **Branch:** `spec/024-painel-de-conversas`
- **Depende de:** 008 (permissões), 010 (rotas de conversas e mensagens), 013 (agrupamento: `replyToId`, `answeredById`, `sentAt`), 017 e 021 (sessão da conta por cookie), 018 (beUI, modo escuro, contraste), 022 (vocabulário: `Company`, `Membership`, `Account`, `contact`; rota `/admin/companies/:companyId/...`; `X-Soprei-App`) e 023 (área `/painel/*`, `request()` com `ApiError`, menu por `permissions`, ponte cookie -> rotas de tenant)
- **Passa pelo `reviewer` antes do merge:** sim (mostra dado pessoal ao navegador, muda o contrato de uma rota de tenant e a máscara do contato é regra de privacidade).

## Objetivo

Depois da 023 a empresa conecta o número e testa o assistente, mas **não enxerga as conversas reais** que ele tem no WhatsApp. Esta spec entrega a fatia mínima e segura para a demonstração: no site, **lista de conversas** e **histórico de uma conversa**, só leitura, para quem tem `conversation:read`, sem nunca levar o telefone do contato ao navegador.

## O que a API atual já entrega e o que falta (fatos do código, lidos em 2026-11-04)

**Já existe e não muda de mecanismo**

- `GET /admin/companies/:companyId/conversations` e `GET .../conversations/:conversationId/messages` (`backend/src/presentation/admin/attendance.controller.ts`), com `requirePermission('conversation:read', { companyParam: 'companyId' })` (OWNER, ADMIN, AGENT e VIEWER; `PlatformAdmin` recebe 403) e perfil de rate limit `admin`. O `companyId` do service vem só da identidade; `:companyId` do caminho é conferido (404 uniforme). Com cookie da conta a ponte da 023 vale (`server.ts` -> `AccountService.tenantIdentity`, papel relido do banco a cada requisição, `Cache-Control: no-store` em `/admin/*`). **Esta spec não cria caminho de autorização novo.**
- Paginação por cursor opaco (`cursor.ts`: base64url de `[createdAt ISO, id]`), `limit` 1 a 200 (padrão 50, `domain/pagination.ts`), query estrita (`listQuerySchema`, `.strict()`), resposta `{ items, nextCursor }`.
- Conversa: `{ id, contactRef, createdAt, updatedAt }`. Mensagem: `{ id, role ('USER' | 'ASSISTANT'), content, isFallback, externalId, replyToId, createdAt, sentAt }`. `channelMessageId` e `answeredById` não saem.
- Uma conversa por contato (`@@unique([companyId, contactRef])`); índice `(companyId, createdAt, id)` em conversas e `(companyId, conversationId, createdAt, id)` em mensagens. Resposta do lote: `replyToId` = última mensagem do contato do lote e `createdAt` = última + 1 ms, então a ordem cronológica já fica correta (013).
- **Aviso (`notice`) nunca é gravado** (`channel-inbound.processor.ts`: "envia o texto constante, imediato, sem gravar mensagem nem chamar o LLM"). Não existe balão de aviso no histórico; só mensagens `USER` e `ASSISTANT`.

**O que falta (e é o que a spec cobre)**

1. **Vazamento do telefone na API atual.** `contactRef` no WhatsApp é o `from` da Meta (o telefone). `externalId` da mensagem é o `wamid`, que **também carrega o telefone em base64** (regra de privacidade do canal em `AGENTS.md`). As duas rotas devolvem os dois campos inteiros. Servir isso ao navegador viola a regra da 011; não basta esconder na tela.
2. **Ordem errada para um painel.** A lista de conversas vem em ordem **crescente** de `createdAt` (a mais antiga primeiro) e a das mensagens também. `Conversation.updatedAt` existe mas **ninguém o atualiza** quando chega mensagem (o `AttendanceService` não toca a conversa), então não serve de "última atividade". Um histórico de 200+ mensagens abriria no começo.
3. **`:conversationId` que não é UUID responde 400** (`conversationParamsSchema`); o padrão uniforme da 008 para ids de caminho é 404.
4. **Sem prévia nem contagem** na lista: nenhuma consulta em lote existe; seriam consultas novas.
5. **Frontend:** `AreaPage` é `'canal' | 'persona' | 'testar'` com caminhos fixos (`company-nav.ts`); não há rota com parâmetro. `failureOf` (`company-api.ts`) trata **todo 404 como "a empresa mudou"**, o que está errado para "conversa não encontrada" (a `ChannelPage` já resolve isso relendo `GET /auth/session`).
6. **"Não enviada":** respostas do simulador (inclusive as da caixa "Testar" da 023) **nunca** têm `sentAt`, porque nada vai ao WhatsApp. Mostrar "não enviada" em toda resposta sem `sentAt` mentiria para as conversas de teste.

## Comportamento esperado

### Navegação (rotas do site, History API, sem biblioteca nova)

- Nova aba **Conversas** no menu da empresa (permissão `conversation:read`), `/painel/conversas`, e `/painel/conversas/:conversationId` para o histórico. Sem `companyId` na URL (a empresa é a selecionada na sessão, como na 023). `AreaPage` ganha `'conversas'`; `areaPageForPath` passa a reconhecer o caminho com parâmetro (um UUID; outra coisa cai em "não encontrada" sem chamar a API).
- Quem tem `conversation:read` (todos os papéis) vê a aba; o menu é conveniência e **o backend continua sendo a barreira**. Forçar a URL sem a permissão mostra "sem permissão" e não chama a API (como na 023). `PlatformAdmin` não tem identidade de vínculo no site e continua sem acesso a conversas (decisão 5 da 007).
- A empresa selecionada é preservada ao entrar, voltar e atualizar a página. Trocar de empresa remonta a área (`key`), descarta respostas tardias (contador de geração da 017/023) e zera o que estava em memória.

### Lista (`/painel/conversas`)

- `<ul>` de **links** (`<a href>` para a conversa, foco visível, navegação sem recarregar), mais recentes primeiro. Cada item: rótulo do contato (ver "Privacidade do contato"), selo "Teste" quando a conversa vem do simulador, e data e hora da **última atividade** (`Intl.DateTimeFormat('pt-BR')` no fuso do navegador, com `<time dateTime>`).
- "Carregar mais" (cursor, 30 por página), com `aria-live="polite"` discreto ("Carregando mais conversas…" e "N conversas carregadas"); o foco não se perde ao anexar a página. Botão **Atualizar** (relê a primeira página e descarta o que estava carregado; sem tempo real e sem *polling*, que é a 009).
- Estados: carregando (`Loader`, texto acessível); **vazio** com orientação ("Ainda não há conversas. Conecte o número em Canal ou use Testar para criar uma conversa de teste", com links para as abas a que a pessoa tem acesso); **erro** com mensagem por `status`/`code` (nunca o texto do servidor) e botão "Tentar de novo". Erro ao carregar mais mantém o que já estava na tela e mostra o aviso com "Tentar de novo" no fim da lista.
- Sem prévia do texto da última mensagem e sem contagem (decisão 5): a lista não carrega conteúdo de mensagem.

### Histórico (`/painel/conversas/:conversationId`)

- Cabeçalho: link "Voltar às conversas", rótulo do contato, selo "Teste" se for simulador, botão **Atualizar** e a data da última atividade.
- Mensagens em ordem **cronológica** (a mais antiga acima, a nova abaixo), em `<ol>` (a leitura por leitor de tela segue a ordem do chat). A tela abre nas **mais recentes** (50 mensagens, buscadas com `order=desc` e invertidas no cliente) e tem "Carregar mensagens anteriores" no topo, que preserva a posição de leitura e o foco (decisão 4). Ao abrir e ao atualizar, rola até a última; ao carregar anteriores, **não** rola.
- Balões diferentes por autor, sempre com **texto** do autor além da cor ("Contato", "Assistente"), nunca só cor:
  - `USER` = contato; `ASSISTANT` = assistente;
  - `isFallback` = marca "Resposta padrão: houve falha ao gerar a resposta";
  - resposta do assistente **de conversa do WhatsApp** com `sentAt` nulo e mais de 2 minutos = "Não enviada ao WhatsApp" (alerta discreto com dica: "Confira o estado do canal em Canal"); com menos de 2 minutos = "Enviando…". Em conversa de simulador **não há** indicador (a resposta nunca vai ao canal). O limite de 2 minutos é constante nomeada, com relógio injetável nos testes;
  - cada balão mostra a hora (e a data quando muda o dia, como separador `<li role="separator">`).
- Mensagem longa (até 4000 caracteres do contato, mais o que o LLM gerar) quebra linha e palavra (`overflow-wrap: anywhere`), preserva quebras de linha (`white-space: pre-wrap`) e **nunca** é interpretada como HTML nem como Markdown (texto puro pelo React). Emoji, RTL e caracteres combinados exibem como vierem; `dir="auto"` em cada balão.
- Estados: carregando, erro com "Tentar de novo", conversa sem mensagens ("Esta conversa ainda não tem mensagens"), **404** (id inexistente, de outra empresa ou malformado): a tela relê `GET /auth/session` como a `ChannelPage`; se a empresa selecionada é a mesma, mostra "Conversa não encontrada" com link para a lista; se mudou, segue o fluxo "A empresa selecionada mudou" da 023. Nunca diz se o id "existe em outra empresa".
- Sem campo de resposta, sem "marcar como lida", sem apagar, sem exportar.

### Privacidade do contato (regra desta spec)

- **O telefone completo nunca chega ao navegador por estas rotas.** A máscara é feita **no servidor** (decisão 1 e 2): as respostas das duas rotas **deixam de trazer `contactRef` e `externalId`** e a conversa ganha:
  - `contactLabel: string`: telefone (de 8 a 15 dígitos, ignorando `+`, espaços, hífen e parênteses) vira `Contato final 1234` (só os 4 últimos dígitos); o `contactRef` fixo `teste-no-site` (constante do site da 023) vira `Teste no site`; qualquer outro texto livre (simulador usado por API) vira `Simulador a1b2` (4 primeiros hexadecimais do SHA-256 de `companyId + ":" + contactRef`, só para distinguir conversas; nunca o texto);
  - `channel: 'whatsapp' | 'simulator'`: `whatsapp` quando o `contactRef` tem forma de telefone, `simulator` nos demais (heurística no servidor; o `contactRef` do canal real é sempre o `from` numérico da Meta). Uma conversa de simulador com `contactRef` numérico via API aparece como `whatsapp` e mascarada: falha para o lado seguro.
- O conteúdo das mensagens é dado pessoal: só trafega nesta resposta, só para quem tem `conversation:read` na empresa. **Nunca** em log, métrica, label, URL, `localStorage`/`sessionStorage`, título da página, mensagem de erro nem histórico de navegação. A URL leva só o id da conversa (UUID v7 da própria empresa; decisão 7). Erros do site são escolhidos por `status` e `error.code`; o texto do corpo da resposta nunca é lido nem exibido (como na 023).

### Contratos no backend (aditivo no que dá; mudanças marcadas)

Tudo atrás dos mesmos hooks de sempre (cookie ou Bearer, `requirePermission('conversation:read')`, perfil `admin`, `:companyId` conferido, 404 uniforme). Nenhuma rota nova.

1. `GET /admin/companies/:companyId/conversations?limit&cursor` -> `{ items: [{ id, contactLabel, channel, createdAt, updatedAt }], nextCursor }`.
   - **Mudança:** `contactRef` sai da resposta (decisão 2).
   - **Mudança:** ordem **decrescente** por `updatedAt` e `id` (última atividade primeiro) e `updatedAt` passa a significar "última atividade": a criação de **qualquer mensagem** da conversa atualiza `updatedAt` na mesma transação em que a mensagem é gravada (`PrismaMessageRepository.create` faz um `updateMany` da conversa com `companyId` no `where`, sem SQL cru; os quatro pontos de gravação do `AttendanceService` passam por aí). Migration **só de índice** `(company_id, updated_at, id)` em `conversations` (decisão 3), com um `UPDATE` de correção que leva `updated_at` das conversas existentes à data da última mensagem. Cursor: a mesma codificação, com a chave `updatedAt` no lugar de `createdAt` (helper novo ao lado de `buildDescPageQuery`).
2. `GET .../conversations/:conversationId/messages?limit&cursor&order=asc|desc` -> `{ items: [{ id, role, content, isFallback, replyToId, createdAt, sentAt }], nextCursor }`.
   - **Aditivo:** `order` (padrão `asc`, o comportamento atual; `desc` usa `buildDescPageQuery`, que já existe). Enum estrito; valor desconhecido é 400.
   - **Mudança:** `externalId` sai (carrega o telefone, ver acima).
   - **Mudança:** `:conversationId` que não é UUID passa a ser **404** uniforme (igual a inexistente e a de outra empresa), não 400.
3. Função pura `describeContact(companyId, contactRef) -> { contactLabel, channel }` em `application/attendance/` (testada sem banco). O mapper da presentation só a chama; o `contactRef` cru não sai da camada de application para a resposta destas rotas.
4. **Sem métrica nova.** Log: o log de requisição já usa o padrão da rota (`routePattern`), nunca a URL crua com o id. Nenhum log novo carrega texto, rótulo, telefone nem `contactRef`.
5. O simulador (`POST .../messages`) e o webhook não mudam. `TestPage` da 023 continua funcionando (só lê `reply.text` e `reply.isFallback`).

### Frontend

- Reuso dos componentes beUI já copiados (`Card`, `Button`, `Alert`, `Tabs`, `Loader`); **nenhuma dependência nova** e nenhum componente novo do registro (balões e lista são `div`/`ul`/`ol` estilizados com os tokens).
- `company-api.ts` ganha `conversations(companyId, { cursor, limit })`, `conversationMessages(companyId, id, { cursor, limit, order })` com Zod estrito (campo desconhecido ou `contactRef`/`externalId` presente na resposta é recusado: o contrato novo é conferido no cliente). O Zod do `role` aceita só `USER` e `ASSISTANT`.
- Páginas novas em `frontend/src/company/`: `ConversationsPage` e `ConversationPage`; `conversation-format.ts` (data/hora, separador de dia, indicador de envio, tudo puro e com `now` e fuso por parâmetro). `company-nav.ts` ganha `'conversas'` e o parâmetro do caminho. A leitura de falha da conversa reutiliza `failureOf` mas trata 404 pelo ramo "relê a sessão" (extrair o helper da `ChannelPage` em vez de copiar).
- Cores só dos tokens (`:root` e `.dark`); balões do contato, do assistente, de resposta padrão e de "não enviada" usam pares **novos em `src/theme/contrast.test.ts`** nos dois temas (mínimo 4,5:1 texto; 3:1 borda e foco). Nenhuma informação só por cor.
- Acessibilidade: lista como `<ul>` de links; foco visível; "Carregando mais" em `aria-live="polite"`; erros em `Alert` com `role="alert"`; títulos em ordem (`h2` da tela, `h3` onde couber); rótulos em pt-BR; sem armadilha de foco ao carregar mais.
- Responsivo: lista e chat em coluna única no celular (balões até ~85% da largura); cabeçalho do histórico quebra linha; botões com alvo mínimo confortável.

## Critérios de aceite

Backend (integração com Postgres real em `soprei_test` e Redis `/15`; unitários para o resto; nenhuma chamada externa):

- [x] **Máscara no servidor:** `describeContact` devolve `Contato final 1234` para `5511999991234`, `+55 (11) 99999-1234` e 8 a 15 dígitos; `Teste no site` para `teste-no-site`; `Simulador <4 hex>` estável (mesmo valor para o mesmo par empresa/ref, valores diferentes entre empresas) para texto livre, e **o texto livre nunca aparece**; `channel` `whatsapp` só para forma de telefone. Caso de borda: 7 dígitos e 16 dígitos viram `Simulador`.
- [x] **Telefone fora das respostas:** com uma conversa de `contactRef` `5511999991234` e mensagens com `externalId` `wamid` derivado do mesmo número, a resposta serializada de **ambas** as rotas não contém o número, os 8 primeiros dígitos, o `contactRef` cru, o `wamid` nem sua forma em base64 (busca de sentinelas), e **não** tem as chaves `contactRef` e `externalId`.
- [x] **Ordem e atividade:** a lista vem por última atividade decrescente; depois que chega mensagem (contato **e** resposta, por `handleInboundMessage`, `acceptInboundMessage` e `respondToPending`), a conversa sobe ao topo; desempate por `id` é estável; o cursor percorre todas as conversas sem repetir nem pular **quando nada muda** e `nextCursor` é `null` na última página. Mensagens com `order=desc` vêm da mais nova para a mais antiga; `order=asc` (e sem `order`) mantém o comportamento atual; `order` inválido, `limit` 0 ou 201 e `cursor` malformado dão 400 com `code`.
- [x] **Migration:** só índice e `UPDATE` de correção do `updated_at`; um teste da migration (como os de 017/020/021) cria conversas e mensagens no schema anterior e confere que `updated_at` vira a data da última mensagem; o teste de drift de schema segue verde.
- [x] **Isolamento entre empresas** (empresa A e empresa B no mesmo banco): a lista de A nunca contém conversa de B (nem com cursor de B usado em A); `GET .../conversations/<id de B>/messages` com a identidade de A responde 404 **idêntico** ao de id inexistente e ao de id malformado (mesmo `status`, `code` e `message`, sem `requestId` na comparação); o `:companyId` de B no caminho com identidade de A responde 404 (por cookie e por Bearer); a escrita do `updatedAt` ao gravar mensagem de A não altera conversas de B (repositório chamado com `companyId` errado não atualiza nada); o teste cobre também a chave estrangeira composta (conversa de A não aceita mensagem de B).
- [x] **Permissão por papel (cookie, ponte da 023):** `OWNER`, `ADMIN`, `AGENT` e `VIEWER` recebem 200 nas duas rotas; `PlatformAdmin` (Bearer de plataforma) recebe 403; vínculo rebaixado ou desativado e empresa suspensa mudam a resposta na requisição seguinte (papel lido do banco agora; 401 quando desativado); conta sem empresa selecionada recebe 401; `GET` com cookie não exige `Origin`; Redis das sessões fora = 503.
- [x] **Inventário de rotas** (`rate-limit.test.ts`) segue verde: as duas rotas mantêm perfil `admin` e `requirePermission('conversation:read')`; nenhuma rota nova.
- [x] **Privacidade (log e métrica):** num fluxo ponta a ponta (webhook falso -> conversa -> leitura pelas duas rotas), o log capturado, comparado com `logContains`, **não** contém o texto de nenhuma mensagem, o telefone, o `contactRef`, o `wamid`, o rótulo nem o `conversationId` cru; `GET /metrics` não ganha série nova e nenhum label tem id, rótulo ou texto; o corpo de erro (404, 400, 403) é comparado só por `code` e `message` e não contém texto de mensagem nem o id enviado.
- [x] Testes existentes que liam `contactRef`/`externalId` da resposta (`attendance.controller.test.ts`, `rbac.controller.test.ts`, repositórios em memória de `test-support/`, ponta a ponta de `infrastructure/http/`) foram atualizados ao contrato novo; o `in-memory-attendance.ts` reproduz a ordem e o toque de `updatedAt` do repositório real.

Frontend (unitários `node:test`; Playwright com `/api` falsa, desktop e celular, claro e escuro):

- [x] Unitários: formatação de data/hora com `now` e fuso injetados (hoje, ontem, outro dia, virada de dia no fuso do navegador); indicador de envio (`sentAt` presente, nulo com menos e com mais de 2 min, conversa de simulador sem indicador); `areaPageForPath` e `canOpen` para `/painel/conversas` e `/painel/conversas/<uuid>` (id inválido não é rota de conversa); Zod do cliente recusa resposta com `contactRef`/`externalId` e papel desconhecido; inversão de `order=desc` mantém a ordem cronológica.
- [x] e2e lista: carregando, **vazia** (orientação com links), uma página, **paginação** ("Carregar mais" anexa sem duplicar nem perder foco; `aria-live` anuncia), **erro com "Tentar de novo"** (e erro ao carregar mais mantém os itens), "Atualizar" relê a primeira página; rótulos mascarados e selo "Teste"; nenhum telefone completo na página (a API falsa devolve só o rótulo; teste procura sentinelas no DOM).
- [x] e2e histórico: abre nas mensagens mais novas e na ordem cronológica; "Carregar mensagens anteriores" preserva a posição; contato, assistente, resposta padrão, "Enviando…" e "Não enviada ao WhatsApp" (só em conversa do WhatsApp; ausente em simulador); conversa sem mensagens; mensagem de 4000 caracteres sem estourar o layout (sem rolagem horizontal da página); emoji e texto RTL; texto com `<script>` e `<b>` aparece literal; 404 (mesma empresa) mostra "Conversa não encontrada"; 404 com empresa trocada mostra "A empresa selecionada mudou"; id malformado na URL não chama a API; erro com "Tentar de novo".
- [x] e2e permissão e navegação: os quatro papéis veem a aba Conversas; sem `conversation:read` (lista de `permissions` sem ela) a aba some e a URL forçada mostra "sem permissão" **sem** chamar a API; trocar de empresa durante o carregamento não mostra a resposta tardia na outra empresa; voltar/avançar do navegador preservam a empresa; a seleção da empresa sobrevive à atualização da página.
- [x] e2e privacidade: ao fim dos fluxos `localStorage`, `sessionStorage` e `document.title` não têm texto de mensagem, rótulo nem telefone; `location` só tem o id da conversa; nenhuma requisição além de `/api/**` e das fontes do site; mensagens de erro nunca contêm o corpo da resposta (a API falsa devolve um sentinela em `message` que não pode aparecer).
- [x] Contraste: pares novos (contato, assistente, resposta padrão, não enviada, separador de dia, texto secundário) em `contrast.test.ts` nos dois temas; foco por teclado percorre menu, lista, "Carregar mais", "Atualizar" e "Voltar"; sem rolagem horizontal em 360 px de largura.

Gerais: `pnpm typecheck`, `pnpm lint`, `pnpm format:check` (raiz) verdes; o gate de vocabulário da 022 segue verde (sem os termos antigos); o CI verde em Node 22 e na LTS mais recente.

**Validação local nesta spec (instrução do dono para a 024):** o agente roda localmente os arquivos de teste novos e alterados e **uma** bateria completa no fim, em Node 24 (um comando por vez, em primeiro plano); o CI continua sendo a palavra final em Node 22 e na LTS. Lições do handoff valem: relógio injetável, `waitFor` com prazo, nada de sleep fixo como asserção, sem `keepEventLoopAlive()`, comparar erro só por `code` e `message`, `logContains` em vez de `includes`.

## Casos de borda e erros

- **Conversa sem mensagens** (criada e sem mensagem gravada por falha, ou futura): histórico vazio com texto próprio; a lista a mostra normalmente.
- **Conversa só com mensagens do contato** (sem resposta ainda: janela de agrupamento, LLM em andamento, empresa suspensa, `TOKEN_INVALID`): a tela mostra só os balões do contato; nada de "digitando". A causa provável fica na dica da aba Canal.
- **Lote respondido de uma vez** (013): várias mensagens do contato seguidas de **uma** resposta; a ordem cronológica já as mostra assim (resposta = última + 1 ms). Sem agrupamento visual extra.
- **Mensagem do contato que chega durante a leitura:** só aparece ao tocar em "Atualizar" (sem *polling*). Mensagem nova entre duas páginas de "Carregar anteriores" não duplica nem apaga nada (a paginação decrescente por `(createdAt, id)` só olha para trás).
- **Paginação sobre dados que mudam (lista):** conversa que recebe mensagem enquanto a pessoa percorre as páginas sobe ao topo; se ainda não estava carregada, **não aparece** nas próximas páginas daquela navegação (fica acima do cursor) e entra na primeira ao "Atualizar". Nunca duplica. Documentado e coberto por teste.
- **Mensagem muito longa, emoji, RTL, quebras e texto que parece HTML:** ver "Histórico". Sem truncar em silêncio no servidor (o limite de 4000 é da entrada, já existente).
- **Conversa do simulador:** selo "Teste", sem indicador de envio; várias pessoas da mesma empresa compartilham `teste-no-site` (023).
- **Conversa de contato numérico via API do simulador:** tratada como WhatsApp (falha para o lado seguro: mascarada e com indicador de envio possivelmente "Não enviada").
- **Resposta presa em "Enviando…":** passa para "Não enviada" depois de 2 minutos; a causa mais comum é a que a 013 já registra como limitação (resposta gravada e não enviada); a tela só torna isso visível.
- **Empresa suspensa ou vínculo desativado no meio da tela:** a próxima chamada responde 401/404 e a tela segue os fluxos da 023 (volta ao login ou "A empresa selecionada mudou"). 429: "Muitas tentativas. Aguarde antes de tentar novamente.", 502/503: indisponível, 403: "Você não tem permissão para esta ação.", outros: mensagem genérica; nenhum mostra texto do servidor.
- **Id de conversa de outra empresa, inexistente ou malformado:** sempre o mesmo 404 e a mesma tela.
- **Aba antiga com seleção de outra empresa:** 404 uniforme e recarga (023).
- **Cursor adulterado:** 400 com `code`; a tela mostra a mensagem genérica com "Tentar de novo" (que recomeça da primeira página).
- **Falha da escrita do `updatedAt` na transação da mensagem:** a gravação da mensagem falha junto (mesma transação); nenhum estado parcial. Fora de transação, o pior efeito é só a ordem da lista.

## Isolamento entre empresas

Toca em dados de empresa (conversas e mensagens) e **não cria acesso novo**: reaproveita as rotas e os repositórios de tenant da 003/010.

- O `CompanyId` nasce só da identidade (Bearer ou, com cookie, do vínculo relido no banco); `:companyId` do caminho é conferido e descartado; `:conversationId` é conferido contra a empresa pelo repositório (`ConversationRepository.findById(companyId, id)`, `NotFoundError` para alheio). Todo método novo ou alterado (lista por atividade, toque de `updatedAt`, `order=desc`) recebe o `CompanyId` como primeiro parâmetro, com `companyId` no `where`, passando pela `tenant-scope`; **sem SQL cru novo** (a migration tem SQL, mas é de esquema).
- O hash do rótulo do simulador inclui o `companyId` (sem correlação entre empresas).
- Testes obrigatórios: os do critério "Isolamento entre empresas" acima (lista, id direto, id malformado, `companyId` de outro no caminho por cookie e por Bearer, escrita do `updatedAt` e FK composta) e o isolamento no navegador (resposta tardia após trocar de empresa).

## Riscos

1. **Dado pessoal no navegador:** o conteúdo das mensagens é visível a qualquer `Membership` com `conversation:read` (inclusive `VIEWER`). É o contrato da 008 e continua; esta spec só garante que o telefone não vai junto. Retenção, anonimização e LGPD seguem pendentes antes de dados reais.
2. **Máscara por heurística:** `contactRef` de forma de telefone vira `whatsapp`. Se o canal passar a entregar outro formato de contato (BSUID, hoje descartado como `missing_sender`), o rótulo cai em `Simulador <hash>` e o indicador de envio some até a regra ser ajustada (pendência registrada).
3. **Mudança de contrato** em duas rotas (campos removidos, ordem e 404): só a 010 e os testes as consomem hoje (produto não lançado). Clientes externos de API que dependiam de `contactRef` ou `externalId` perdem esses campos.
4. **Escrita a mais por mensagem** (`updatedAt` da conversa): um `UPDATE` de coluna sem chave na mesma transação; não bloqueia as chaves estrangeiras (`FOR NO KEY UPDATE`). Registrar a medição se o volume crescer.
5. **Últimos 4 dígitos** são dado pessoal de baixa identificação; o dono pode preferir só rótulo por hash (decisão 1).
6. **Páginas grandes:** mensagens de até 4000 caracteres; com `limit=50` a resposta é de dezenas de KiB. O limite máximo da API (200) continua; o site usa 30 e 50.

## Fora de escopo

- Tempo real (SSE e Socket.IO, spec 009) e *polling* automático; só "Atualizar" manual.
- Busca, filtros, ordenação escolhida, contagem total e prévia da última mensagem na lista.
- Responder manualmente pelo painel, assumir o atendimento (*handoff* humano), marcar como lida, atribuir, etiquetas.
- Exportar, apagar ou anonimizar conversa; retenção e LGPD; auditoria de leitura.
- Métricas de atendimento (tempo de resposta, volume por dia) e notificações.
- Reenviar resposta "não enviada" e varredura de pendentes (pendência da 013).
- Mostrar o telefone completo (nenhum papel) e qualquer rota que o devolva.
- Convites e gestão de equipe pelo site; CSP e `frame-ancestors` (pendências da 018/023).
- Mudar o simulador, o webhook, a fila ou o `AttendanceService` além do toque de `updatedAt`.

## Decisões e dependências novas

**Dependências:** nenhuma no backend nem no frontend; nenhum componente novo do beUI. **Migration:** uma, só índice `(company_id, updated_at, id)` em `conversations` mais o `UPDATE` de correção (aditiva; o dono a aplica no banco de desenvolvimento; o agente a aplica **só** em `soprei_test`).

### Decisões para o dono (recomendação primeiro; o dono decide)

1. **Quanto do contato aparece na lista e no cabeçalho.**
   - **Recomendado:** só `Contato final 1234` (4 últimos dígitos) para telefone, `Teste no site` para o teste da 023 e `Simulador a1b2` (hash curto) para o resto; o número inteiro nunca vai ao navegador; máscara no servidor.
   - Alternativas: (a) só rótulo por hash/estável (`Contato a1b2`), sem nenhum dígito (mais privado, mais difícil de reconhecer); (b) número inteiro (**não recomendado**: dado pessoal exibido e guardado em tela, cache e captura); (c) apelido dado pelo dono (exige tabela e tela de edição: spec própria).
2. **Como entregar a máscara sem quebrar o resto.**
   - **Recomendado:** **trocar no lugar** as duas rotas existentes (tirar `contactRef` e `externalId`, pôr `contactLabel` e `channel`, atualizar os testes). Motivo: se a rota antiga continuasse devolvendo o telefone, qualquer sessão com cookie ainda o alcançaria e a máscara seria enfeite; um só contrato, uma só barreira. O custo é um contrato que muda antes do lançamento.
   - Alternativas: (a) rotas novas (`.../conversations/view`) com máscara e deixar as antigas inteiras (dois contratos, vazamento ainda possível); (b) manter `contactRef` só para Bearer e tirar só para cookie (dois comportamentos na mesma rota, mais difícil de provar).
3. **Ordem da lista de conversas.**
   - **Recomendado:** por **última atividade**, tocando `Conversation.updatedAt` na gravação de cada mensagem (mesma transação, no repositório) + índice + `UPDATE` de correção. Sem coluna nova.
   - Alternativa: ordem decrescente por `createdAt` (quando o contato apareceu pela primeira vez), **sem tocar o fluxo de atendimento** e sem migration de dado (índice atual já serve). Mais simples e menos risco, mas uma conversa antiga e ativa afunda na lista, o que atrapalha a demonstração com poucos contatos recorrentes.
4. **Histórico abre nas mensagens mais novas** com `order=desc` (parâmetro novo, padrão continua `asc`) e "Carregar anteriores". **Recomendado.** Alternativa: manter só `asc` e abrir no começo (a conversa longa abre na primeira página, e o botão fica no fim; pior para ler "o que aconteceu agora").
5. **Prévia e contagem na lista.** **Recomendado: não incluir** (corte): exigiria consulta nova em lote (a última mensagem de cada conversa) com medição, e poria texto de mensagem na lista. Se o dono quiser para a demonstração, vira consulta única por página pelo repositório de tenant (`distinct` por conversa, sem SQL cru) e `lastMessagePreview` truncado em 80 caracteres; entra aqui só se couber no PR.
6. **Indicador "Enviando…/Não enviada ao WhatsApp".** **Recomendado:** mostrar **só** em conversa `channel: 'whatsapp'`, com limite de 2 minutos entre os dois textos (constante nomeada, relógio injetável). Alternativa: mostrar "não enviada" para todo `sentAt` nulo (erra em toda conversa de simulador) ou não mostrar (esconde o risco conhecido da 013).
7. **Id da conversa na URL** (`/painel/conversas/:conversationId`). **Recomendado:** sim. É um UUID v7 da própria empresa (embute só o instante de criação da conversa, não o contato), o servidor reconfere o escopo a cada chamada, o log usa o padrão da rota e as fontes do Google (as únicas requisições externas do site) recebem no máximo a origem (política de referenciador padrão). Alternativa: histórico só em estado (sem URL): perde voltar, atualizar página e compartilhar entre abas.
8. **`:conversationId` malformado = 404** (hoje 400). **Recomendado:** 404 uniforme, como `:userId` na 008; a tela não precisa distinguir. Alternativa: manter 400 (a tela trataria 400 desta rota como "não encontrada").
9. **Posição da aba e página inicial.** **Recomendado:** "Conversas" como **primeira** aba e, para quem tem `conversation:read`, abrir o painel nela (é o que um visitante vê primeiro; Canal e Persona seguem logo ao lado). Alternativa: manter Canal primeiro e Conversas depois de Testar.
10. **Tamanho de página.** **Recomendado:** 30 conversas e 50 mensagens por requisição (o máximo da API continua 200). Alternativa: 50 e 100 (menos cliques, respostas maiores).

### Passos do dono

1. Depois do merge e do CI verde, aplicar a migration no banco de desenvolvimento: `pnpm db:migrate:deploy` (índice e correção do `updated_at`; sem perda de dado), e reiniciar backend e frontend juntos (o contrato das duas rotas mudou).
2. Para ver o painel funcionando: com `ACCOUNTS_ENABLED=true`, entrar no site, ter uma conversa de teste em "Testar" (aparece como "Teste no site") e, com o canal da 023 conectado, mandar uma mensagem pelo WhatsApp (aparece como "Contato final NNNN").
3. Antes de dados reais de empresas: decisão de retenção e LGPD sobre conversas (pendência já registrada).

## Registro da implementação

**Backend**
- `application/attendance/contact-label.ts` (+ teste): `describeContact`. `attendance.controller.ts` e `attendance.validators.ts`: contrato novo, `order`, `:conversationId` malformado = 404. `AttendanceService.listConversations` usa `listByActivity`; `listMessages` aceita `order` e devolve `ConversationHistory` (página mais a conversa).
- `infrastructure/database/repositories/`: `cursor.ts` (`buildActivityPageQuery`, `toActivityPage`), `conversation.repository.ts` (`listByActivity`), `message.repository.ts` (toque de `updatedAt` em `create`, `listByConversation` com `order`). Migration `20261104180000_conversation_activity_index` (aplicada só em `soprei_test`). `in-memory-attendance.ts` reproduz ordem e toque (com rollback).
- Testes novos/alterados: `conversation-activity.integration.test.ts`, `attendance.controller.test.ts`, `site-bridge.integration.test.ts` (bloco da 024), `whatsapp-channel.integration.test.ts` (webhook -> leitura, log e métricas), `attendance-batching.integration.test.ts`, `account-migration.integration.test.ts` (migration).

**Frontend** (`frontend/src/company/`): `ConversationsPage`, `ConversationPage`, `RetryAlert`, `conversation-format.ts`, `company-nav.ts` (`ConversasRoute`), `company-api.ts` (Zod estrito, `isStillSelected`, reaproveitado pela `ChannelPage`), `CompanyArea`/`AccountApp` (rota, `pushState` e `popstate`). Testes: `conversations.test.ts`, `contrast.test.ts`, `e2e/conversations.spec.ts` (desktop e celular, claro e escuro) e `company.spec.ts` ajustado (VIEWER agora vê Conversas).

**Desvios e decisões**
1. `GET .../messages` devolve também `conversation` (mesmo objeto da lista): sem ele o histórico aberto por URL (recarregar a página) não teria rótulo nem canal, e a spec não previa rota nova. Aditivo.
2. Critério de log "sem o conversationId cru": vale para a **leitura** (o log de requisição usa o padrão da rota); o log do atendimento (escrita, desde a 010) segue com ids de conversa, e mudá-lo está fora de escopo. Testado com marcador de posição no log.
3. `updatedAt` só avança (`where updatedAt < createdAt`); a resposta do lote (última + 1 ms) pode, portanto, não passar uma mensagem do contato que chegou depois.
4. A lista de conversas usa `listByActivity`; o `list` genérico (ordem por `createdAt`) continua na base.
5. Fixture e2e: falhas são flags (não contadores), porque o `StrictMode` repete efeitos.
6. Correção de layout pré-existente: a raiz de `CompanyArea` ganhou `grid-cols-[minmax(0,1fr)]` (as 4 abas estouravam 360 px).
7. Sem métrica nova, sem dependência nova.
8. Ajustes da revisão (reviewer): regex dos nomes de métricas do teste ponta a ponta corrigido (barra perdida) com lista afirmada não vazia; testes de `updatedAt` com mensagens simultâneas e de paginação da lista quando uma conversa sobe entre as páginas (a que subiu fica de fora daquela navegação e reaparece ao reler a primeira página); `:conversationId` sem limite próprio no Zod (acima de 100 caracteres o roteador do Fastify já responde 414 antes do handler).

**Validação local (Node 24.18, uma bateria no fim):** `typecheck`, `lint`, `format:check` verdes; `pnpm test` 1138 backend + 51 frontend, 0 falhas; `pnpm test:integration` 405 de 405; `pnpm build` ok; `test:browser` 104 de 104 (desktop e celular). Suítes novas repetidas 3x (atividade e lote) sem flake. Node 22 e a LTS ficam para o CI. A spec continua `aprovada` (o dono marca `concluída` depois do CI e do merge).
