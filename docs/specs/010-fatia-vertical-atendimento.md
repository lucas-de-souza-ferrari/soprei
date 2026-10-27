# 010 — Fatia vertical: atendimento ponta a ponta com LLM mock

- **Status:** aprovada (o dono aprovou em 2026-10-27 com todas as recomendações da seção "Decisões"). Implementada na branch; segue `aprovada` até o CI confirmar e o `reviewer` revisar (então vira `concluída`)
- **Branch:** `spec/010-fatia-vertical-atendimento`
- **Depende de:** 003 e 004 (concluídas e na `main`)

## Objetivo

Provar o produto de ponta a ponta com a menor peça possível: uma mensagem de um contato entra para um cliente, é guardada numa conversa, passa por um `LLMProvider` (nesta spec, só um `mock`), a resposta volta e também é guardada, com a persona do cliente, histórico da conversa, fallback educado em caso de falha e **isolamento total entre clientes**. Serve para validar o desenho (domínio, pipeline, tabelas, testes de isolamento) antes de ligar canal real, LLM real, autenticação ou fila.

## Estado de partida (herdado das specs 001 a 004)

- `Conversation` é mínima (`id`, `clientId`, timestamps) e sem campos editáveis; `NewConversation` e `ConversationUpdate` são tipos vazios. Não existe `Message`.
- `Client` (model global, sem `clientId`) tem `name`, `slug`, `status`, `deletedAt`; sem persona.
- Base de repositório de tenant (`PrismaTenantRepository`) só expõe `findById`, `list`, `create`, `update`, `delete`, `count`; cada model implementa `TenantModelOps`. A extensão `tenant-scope` exige `clientId` no `where`/`data` e bloqueia `findUnique`, `update`, `delete`, `upsert` em model de tenant. **Todo model novo precisa entrar em `MODEL_SCOPES`.**
- `ClientService` e rotas `/admin/clients` protegidas por `ADMIN_API_KEY` (credencial temporária entre clientes). Não há autenticação de usuário, rate limit, cache nem fila.
- Spec 004 fornece contexto por requisição (`setClientId`), logs com `requestId` e redação, e um registry de métricas onde esta spec registra as suas.
- Camadas: `domain` só importa de `shared`; `application` e `presentation` não importam `infrastructure/database`.

## Escopo da fatia (proposta; as decisões de 1 a 4 mudam este desenho)

O "canal" desta fatia é um **simulador por API administrativa**: quem chama (você, um script ou um teste) envia a mensagem de um contato em nome de um cliente e recebe a resposta na mesma chamada. Não há webhook público, WhatsApp, fila nem usuário autenticado. Por isso rate limit e autenticação de usuário não são necessários agora; a credencial é a `ADMIN_API_KEY` já existente.

### Dados (Prisma + migration aditiva)

- `Client.persona`: texto opcional (até 4000 caracteres), editável via `PATCH /admin/clients/:id`. Sem persona, vale uma persona padrão genérica montada com o nome do cliente.
- `Conversation`: novos campos `contactRef` (texto, 1 a 128 caracteres, identificador do contato definido pelo canal) e `@@unique([clientId, contactRef])`; `@@unique([id, clientId])` para permitir chave estrangeira composta.
- `Message` (**model de tenant**, entra em `MODEL_SCOPES`): `id` UUID, `clientId`, `conversationId`, `role` (`USER` | `ASSISTANT`), `content` (texto, até 4000 caracteres), `isFallback` (boolean), `externalId` opcional (texto até 128; id da mensagem no canal, para idempotência), `replyToId` opcional (a mensagem de contato a que uma resposta responde), `createdAt`.
  - Integridade entre clientes no próprio banco: chave estrangeira **composta** `(conversationId, clientId)` → `Conversation(id, clientId)` e `(replyToId, clientId)` → `Message(id, clientId)`. Assim, é impossível gravar uma mensagem de um cliente numa conversa de outro, mesmo por bug.
  - `@@unique([clientId, externalId])` (permite várias linhas sem `externalId`) e índice `(clientId, conversationId, createdAt, id)` para o histórico.
- A migration é aditiva e aplicada em `soprei` e `soprei_test`, como na 003. Sem dados existentes a migrar.

### Domínio e aplicação

- `src/domain/`: entidade `Message`, tipos `NewMessage`; `ConversationRepository` ganha `findOrCreateByContact(clientId, contactRef)`; `MessageRepository` com `create`, `findByExternalId(clientId, externalId)`, `findReplyTo(clientId, messageId)` e `listRecent(clientId, conversationId, limit)` (as mais recentes, devolvidas em ordem cronológica). Todos com `ClientId` como primeiro parâmetro.
- `src/application/`:
  - Interface **`LlmProvider`**: `generate(input: { systemPrompt: string; history: readonly LlmTurn[]; userMessage: string }): Promise<Result<LlmReply, ExternalServiceError>>`, com `LlmTurn = { role: 'user' | 'assistant'; content: string }` e `LlmReply = { text: string }`. Erro esperado volta como `Result`, nunca como exceção.
  - **`AttendanceService.handleInboundMessage(clientId, { contactRef, text, externalId? })`**, o pipeline:
    1. Verifica idempotência: se há `externalId` e a mensagem já existe, devolve a resposta já gravada (marcada `duplicate: true`) sem chamar o LLM; se existe sem resposta ainda (concorrência), responde `ConflictError` (409).
    2. Em **uma transação** (`runInTransaction` + `forTransaction`): obtém ou cria a conversa por `contactRef` e grava a mensagem do contato. A chamada ao LLM fica **fora** da transação (não se segura conexão do banco durante chamada externa).
    3. Carrega o histórico (últimas N mensagens da conversa, ver decisão 5) e monta o pedido: persona do cliente como `systemPrompt`, histórico e a nova mensagem.
    4. Chama o `LlmProvider` com timeout (`LLM_TIMEOUT_MS`, padrão 15 000 ms, reaproveitando `withTimeout`).
    5. Sucesso: grava a resposta (`ASSISTANT`, `replyToId` = mensagem do contato). Falha ou timeout: grava a resposta de **fallback** educado (`isFallback = true`), registra o erro com contexto e devolve esse texto. O contato nunca fica sem resposta.
    6. Devolve `{ conversationId, messageId, reply: { id, text, isFallback }, duplicate }`.
  - Cliente inexistente, removido ou `SUSPENDED`: `NotFoundError` (404) ou `ForbiddenError` (403) respectivamente, antes de qualquer gravação.
  - Entrada validada por Zod: `contactRef` 1 a 128 caracteres sem caracteres de controle, `text` 1 a 4000 caracteres (não vazio depois de `trim`), `externalId` opcional até 128.

### Infraestrutura

- `MockLlmProvider` em `src/infrastructure/external-apis/llm/`: resposta determinística (ex.: `"[mock] Recebi: <texto>"`, citando a persona usada e quantos turnos de histórico recebeu, para os testes inspecionarem), **modo de falha** acionável por entrada (ex.: texto contendo um marcador que os testes usam) e registro das entradas recebidas, só para testes. Nenhuma chamada de rede.
- Escolha do provider por variável `LLM_PROVIDER` (enum com apenas `mock` por enquanto, validada na config; o provedor real entra em spec própria) e `LLM_TIMEOUT_MS`.
- `PrismaMessageRepository` e extensão do `PrismaConversationRepository`, sobre a base de repositório (filtro por cliente injetado pela base; só as operações permitidas pela `tenant-scope`).
- Métricas registradas no registry da 004: `llm_requests_total{provider,result}` (`ok`, `error`, `timeout`), `llm_request_duration_seconds{provider}` e `attendance_fallbacks_total`. Sem `clientId` em label.

### HTTP (todas sob `ADMIN_API_KEY`, finas, validação Zod)

- `POST /admin/clients/:clientId/messages`: corpo `{ contactRef, text, externalId? }`; `201` com a resposta; `200` quando `duplicate`. Preenche `setClientId` do contexto de log.
- `GET /admin/clients/:clientId/conversations`: lista paginada.
- `GET /admin/clients/:clientId/conversations/:conversationId/messages`: histórico paginado em ordem cronológica.
- `PATCH /admin/clients/:id`: passa a aceitar `persona` (e `null` para limpar).
- `:clientId` e `:conversationId` viram `ClientId`/UUID no validador (inválido: 400); conversa de outro cliente: 404.

## Critérios de aceite

**Pipeline**
- [x] Mensagem nova cria a conversa (por `contactRef`), grava a mensagem do contato e a resposta, e devolve a resposta do mock; a segunda mensagem do mesmo `contactRef` reaproveita a conversa.
- [x] O `LlmProvider` recebe a persona do cliente (ou a padrão), o histórico em ordem cronológica limitado a N e a nova mensagem; teste inspeciona a entrada registrada pelo mock.
- [x] Falha do provider e timeout (provider que não responde) resultam em resposta de fallback gravada com `isFallback = true`, contato recebe o texto e o erro é logado com `clientId` e `requestId`; a métrica `llm_requests_total` registra `error`/`timeout`.
- [x] Idempotência: reenviar o mesmo `externalId` devolve a mesma resposta sem nova chamada ao LLM e sem mensagens duplicadas; dois envios **simultâneos** com o mesmo `externalId` geram uma única chamada ao LLM e uma única resposta (o outro recebe a mesma resposta ou `409`).
- [x] A chamada ao LLM não ocorre dentro da transação do banco (teste: com o provider bloqueado, nenhuma transação fica aberta).
- [x] Cliente inexistente/removido → 404; `SUSPENDED` → 403; nada é gravado nesses casos.
- [x] Entrada inválida (texto vazio ou só espaços, texto > 4000, `contactRef` vazio ou com caractere de controle, `clientId` malformado) → 400.

**Isolamento entre clientes (o centro da spec)**
- [x] Clientes A e B com o **mesmo `contactRef`** têm conversas distintas; mensagens de um nunca aparecem na listagem nem no histórico do outro.
- [x] O histórico enviado ao LLM para o cliente A **nunca contém** mensagens do cliente B (teste inspeciona a entrada do mock com conversas intercaladas dos dois clientes).
- [x] A persona de A nunca é usada numa conversa de B.
- [x] Mesmo `externalId` em clientes diferentes não colide nem devolve a resposta do outro.
- [x] Usar o `conversationId` de B com o `clientId` de A nos GETs → 404.
- [x] Repositório de `Message`: suíte de isolamento no modelo de `conversation.repository.integration.test.ts` (leitura, listagem recente, busca por `externalId`, `replyTo`) com A e B.
- [x] Integridade no banco: tentar gravar uma `Message` com `clientId` de A numa conversa de B falha por chave estrangeira composta (teste de integração com SQL controlado dentro do módulo de testes de database).
- [x] `Message` está em `MODEL_SCOPES` como `tenant` e o teste de cobertura do schema passa; operação de `message` sem `clientId` lança `TenantScopeError`.
- [x] Duas requisições simultâneas de clientes diferentes mantêm cada uma o seu `clientId` nos logs (contexto da 004).

**Observabilidade e privacidade**
- [x] O conteúdo das mensagens e a persona **não aparecem em nenhuma linha de log** nem em labels de métrica (teste com captura de log). Logam-se ids, tamanhos e resultado.
- [x] Métricas do LLM e de fallback aparecem em `/metrics` (com `METRICS_TOKEN`).

**Geral**
- [x] Migration aplicada em `soprei` e `soprei_test` (incremental, sobre a migration inicial) com `prisma migrate deploy`; `migrate dev` reproduz o histórico inteiro no shadow database e confirma "Already in sync"; `typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes localmente em Node 22.23.2 e Node 24.18.0.
- [ ] CI verde no GitHub (Node 22 e LTS mais recente, com `db:migrate:deploy` em banco limpo), revisão do agente `reviewer` e confirmação do dono. Não verificável daqui (sem remoto nem `gh`).

## Casos de borda e erros

- Mensagem do contato gravada mas o servidor cai antes da resposta: a retentativa com o mesmo `externalId` completa o fluxo (gera a resposta que faltava) em vez de devolver 409 para sempre; definir e testar o que significa "em andamento" (ex.: sem resposta e mensagem com mais de um limite de tempo configurável).
- Resposta do provider vazia ou maior que o limite (`4000` caracteres): tratada como falha (fallback) e truncamento nunca silencioso.
- Texto do contato contendo instruções ("ignore as regras anteriores"): vai sempre como mensagem de `user`, nunca concatenado ao `systemPrompt`. Não há ferramentas nem dados externos acessíveis ao modelo nesta fatia.
- Histórico muito longo: sempre limitado a N mensagens e a um teto de caracteres no total; o corte mantém as mais recentes.
- Mensagem não textual (áudio, imagem): fora de escopo; o simulador só aceita texto.

## Isolamento entre clientes

Reúne quatro garantias: (1) o `ClientId` vem do path validado e é passado explicitamente a todo repositório (e ao contexto de log); (2) as barreiras da 003 (base de repositório, `tenant-scope`, lint) cobrem os novos repositórios e o model `Message`; (3) chaves estrangeiras compostas impedem, no banco, mensagem e conversa de clientes diferentes; (4) o pipeline só lê histórico pelo repositório com o `ClientId` do pedido. Os testes de isolamento acima são o gabarito para toda a fase de produto.

## Fora de escopo

- Canal real (WhatsApp, webhook público, assinatura de webhook), fila e processamento em segundo plano, provedor de LLM real, RAG e base de conhecimento, painel, autenticação de usuário, rate limit, cache, tempo real, RLS, envio de áudio e mensagens não textuais.
- Política de retenção e exclusão de mensagens (dado pessoal): decisão 8.
- Janela de 24 horas do WhatsApp e outros limites do canal (spec do canal).
- Cobrança, planos e limites de uso por cliente.

## Decisões (aprovadas pelo dono em 2026-10-27, todas conforme a recomendação)

Decididas: 1(a) simulador por API administrativa; 2(a) síncrono; 3(a) persona em `Client`; 4(a) `contactRef` livre; 5 histórico de 20 mensagens e 12 000 caracteres; 6(a) fallback constante; 7 nunca logar conteúdo; 8 retenção de dados pessoais só antes de dados reais; 9 provedor real de LLM fica para a spec seguinte. O texto abaixo mantém as opções originais como registro.

1. **Canal da fatia.** (a) Simulador por API administrativa **[recomendado]**: valida o produto sem expor endpoint público nem exigir WhatsApp, e dispensa rate limit/auth de usuário agora. (b) Já o webhook real do WhatsApp Cloud API: mais perto do produto final, mas traz verificação de assinatura, janela de 24 h, fila e rate limit juntos, o que volta a ser a base grande de antes.
2. **Síncrono ou em segundo plano.** (a) Síncrono nesta fatia **[recomendado]**: a resposta do LLM volta na mesma chamada do simulador. Isso é uma **exceção consciente** à regra "webhook responde rápido e processa em background", válida só porque não existe webhook ainda. (b) Já introduzir BullMQ: mais código agora, e a decisão da fila fica melhor tomada na spec do canal real.
3. **Onde mora a persona.** (a) Coluna `persona` em `Client` **[recomendado]**, a mais simples. (b) Um model `Assistant` separado, por cliente (nome, persona, parâmetros do modelo), mais flexível para vários assistentes por cliente depois.
4. **Identificação do contato.** (a) `contactRef` texto livre definido pelo canal **[recomendado]**; o canal real depois mapeia telefone para esse valor. (b) Já telefone em formato E.164, com validação.
5. **Tamanho do histórico enviado ao LLM.** Proposta: últimas **20** mensagens, com teto de 12 000 caracteres no total. Você quer outros valores?
6. **Texto de fallback.** (a) Constante em português do Brasil, a mesma para todos **[recomendado]** (ex.: "Desculpe, estou com dificuldades no momento. Tente novamente em instantes."). (b) Configurável por cliente.
7. **Conteúdo das mensagens em logs.** **Nunca** **[recomendado]**, só ids, tamanhos e resultado, porque conversas contêm dados pessoais.
8. **Retenção de dados pessoais (LGPD).** Mensagens e `contactRef` (que pode ser telefone) são dados pessoais. Proposta: **não resolver nesta fatia**, mas decidir política de retenção e exclusão **antes de dados reais de clientes**, junto com a RLS, e registrar isso no roadmap. Concorda?
9. **Provedor de LLM real** (Gemini, Claude ou OpenAI): não bloqueia esta spec, que só usa o mock; precisa ser decidido na spec seguinte, quando você puder avaliar custo, qualidade em português e latência. Se já tiver preferência, me diga.

## Decisões e dependências novas

- **Dependências novas: nenhuma.**
- Esta spec cria migration (aditiva) e exige aplicá-la nos seus bancos `soprei` e `soprei_test`; vale o mesmo limite da 003: sem `migrate reset`, sem `DROP`, sem apagar dados que o implementer não criou.
- Por mexer no isolamento (novo model de tenant, chaves compostas e pipeline que lê histórico), esta spec passa pelo agente `reviewer` antes do merge.

### Registro da implementação (decisões e desvios, 2026-10-27)

Decisões tomadas durante a implementação, dentro do espírito da spec; o dono pode contestar qualquer uma.

- **Migration `20261027120000_messages_persona_contact_ref`:** gerada com `prisma migrate diff` (o `migrate dev --create-only` pede confirmação interativa) e ajustada à mão antes de ser aplicada: `conversations.contact_ref` é criado nulo, preenchido (`legacy-<id>`, só caso houvesse linhas; `soprei` estava vazio) e depois `NOT NULL`; `CHECK`s de tamanho (persona, `contact_ref`, `content`, `external_id`) e `is_fallback` só em resposta do assistente. As chaves estrangeiras de `Message` usam `ON DELETE NO ACTION` (não `RESTRICT`), para que `deleteMany` de todas as mensagens de um cliente numa só instrução (limpeza de teste) não falhe pela auto-referência.
- **`@@unique([clientId, replyToId])` em `Message` (extra à spec):** no máximo uma resposta por mensagem do contato. É o que faz duas retentativas simultâneas de uma mensagem antiga sem resposta gerarem uma só resposta (a perdedora recebe `ConflictError`, lê a resposta vencedora e devolve `duplicate: true`).
- **"Em andamento":** mensagem do contato com `externalId`, sem resposta e com menos de `ATTENDANCE_IN_FLIGHT_TIMEOUT_MS` (padrão 60 000 ms, variável nova validada na config) devolve 409. Mais antiga que isso, a retentativa a retoma (usa o texto já gravado, não o reenviado) e completa o fluxo. O mesmo `externalId` com outro `contactRef` é 409 (erro de quem chama), não duplicata.
- **Corrida na criação:** o `ConflictError` da unicidade de `externalId` dentro da transação desfaz a transação inteira (inclusive a conversa recém-criada, que o outro pedido já criou); o service relê o estado. Dois envios simultâneos: um 201, o outro 200 (mesma resposta, se o primeiro já terminou) ou 409.
- **`findOrCreateByContact`** usa `createMany({ skipDuplicates })` (`ON CONFLICT DO NOTHING`) seguido de `findFirst`, em vez de `create` com captura de erro: dentro de uma transação do Postgres um erro de unicidade aborta a transação. `createMany` é permitido pela `tenant-scope` (cada linha leva `clientId`), mas é uma operação a mais do que as seis que a base de repositório usa; o CLAUDE.md foi atualizado.
- **Repositórios:** `MessageRepository` (domínio) é mais estreito que `TenantRepository` (`create`, `findByExternalId`, `findReplyTo`, `listRecent`, `listByConversation`); `PrismaMessageRepository` estende a base e portanto também tem `findById`, `list`, `count`, `update` (mensagens são imutáveis: só confirma existência) e `delete`. `findByExternalId` e `findReplyTo` devolvem `null` quando não há. `NewMessage.createdAt` é opcional: a resposta usa `max(agora, createdAt da pergunta + 1 ms)`, para a ordem causal nunca depender do desempate por id num mesmo milissegundo. A base ganhou `protected run` (era `private`) e o tipo de `TenantModelOps.create` passou a usar `Omit<TCreate, 'clientId'>`; `NewConversation` e `NewMessage` estendem `WithoutClientId`. `AttendanceUnitOfWork` (domínio) é a porta da transação; `PrismaAttendanceUnitOfWork` a implementa com `runInTransaction` e `forTransaction`.
- **`LlmProvider`:** além de `generate`, tem `readonly name` (label da métrica). O `ExternalServiceError` devolvido nunca deve conter texto do contato nem persona (contrato documentado). Resposta vazia (só espaços) ou com mais de 4000 caracteres, e exceção lançada pelo provider (violação do contrato), contam como `result="error"` e viram fallback; o log de exceção inesperada leva só o nome do tipo. `withTimeout` passou a rejeitar com `TimeoutError` (continua `Error`, mesma mensagem) para distinguir `timeout` de `error`. Sem `AbortSignal`: depois do timeout a chamada do provider segue em segundo plano (a spec do provedor real deve cancelá-la).
- **`MockLlmProvider`:** o registro de entradas (`calls`) é opt-in (`recordCalls`), para o servidor real não acumular dado pessoal em memória. Marcadores no texto do contato: `[[mock:fail]]`, `[[mock:hang]]` (nunca responde, para timeout), `[[mock:empty]]`, `[[mock:huge]]`; `hold()` segura as chamadas (teste "LLM fora da transação"). O eco do texto é cortado em 500 caracteres e a persona citada em 60, para a resposta caber sempre no limite.
- **Histórico enviado ao LLM:** as até 20 mensagens **anteriores** à atual na ordem da conversa (inclui respostas de fallback), cortadas pelo teto de 12 000 caracteres do mais antigo para o mais novo; o teto conta só o histórico, não a mensagem nova nem a persona. "Caracteres" é `String.length` (unidades UTF-16): um emoji conta 2.
- **`setClientId`** é chamado nas três rotas novas (`/admin/clients/:clientId/...`). **Não** foi aplicado nas rotas `/admin/clients/:id` (CRUD de cliente): o teste da spec 004 exige que o id da URL não apareça no log dessas rotas, e elas administram o cliente, não dados dele.
- **`persona`:** aparece nas respostas de `/admin/clients` (só admin); o `PATCH` aceita `persona` com `trim`, 1 a 4000 caracteres, ou `null`; vazia é 400. `NewClient` não ganhou persona (a spec só pede o PATCH).
- **Métricas:** `llm_requests_total{provider,result}`, `llm_request_duration_seconds{provider}` (buckets de 50 ms a 120 s), `attendance_fallbacks_total`. O `AttendanceService` depende de uma porta `AttendanceMetrics` (o `Metrics` da 004 a satisfaz) e de um `AttendanceLogger`, para não importar da infraestrutura.
- **Testes:** os testes de timeout e de `hang` precisam de `keepEventLoopAlive()` (`src/test-support/keep-alive.ts`): o timer de `withTimeout` é `unref()` e, sem nada mais vivo, o runner do Node 22 cancela o arquivo ("Promise resolution is still pending but the event loop has already resolved"). O `tenant-scope.test.ts` usava um model fictício chamado `Message`; foi renomeado para `Ticket`.
- **Exercício manual (curl) contra o servidor compilado com `.env` e o banco `soprei`:** cliente com persona, duas mensagens, duplicata (200), mesmo contato e `externalId` em outro cliente, falha forçada, timeout (`LLM_TIMEOUT_MS=600`), cliente inexistente (404), malformado (400), suspenso (403), conversa de outro cliente (404), sem chave (401) e `/metrics`. Varredura do log em nível `debug`: nenhum texto de mensagem, persona nem `contactRef` apareceu. Os dados criados em `soprei` foram removidos (o banco voltou a ter 0 clientes, conversas e mensagens).
- **Ainda sem política:** retenção e exclusão de mensagens e `contactRef` (dado pessoal), conforme a decisão 8; entra antes de dados reais, junto com a RLS.
