# 013 — Agrupamento de mensagens rápidas (janela de espera)

- **Status:** aprovada pelo dono em 2026-10-28, com todas as recomendações (espera no banco, janela deslizante de 5 s com teto de 20 s, lote de 10 mensagens e 8 000 caracteres, um turno `user` único, avisos imediatos, simulador síncrono, configuração global, revisão pelo `reviewer`)
- **Branch:** `spec/013-agrupamento-de-mensagens`
- **Depende de:** 011 (canal WhatsApp, mergeada) e 010 (atendimento)

## Objetivo

Quando um contato manda várias mensagens seguidas, hoje cada uma vira um atendimento e uma resposta (duas mensagens em 2 s geram duas respostas). Passa a existir uma **janela de espera**: o sistema espera o contato parar de escrever, junta as mensagens pendentes e responde **uma vez**, como se fosse uma mensagem só. Pedido do dono em 2026-10-28, depois do teste manual da 011.

## Estado de partida (herdado da 010 e da 011)

- No canal, cada mensagem de texto vira um job `text` (`jobId` por `clientId` + `wamid`). O worker (concorrência 1) chama `AttendanceService.handleInboundMessage`, que grava a mensagem do contato, chama o LLM e grava **uma resposta por mensagem** (`replyToId`, com `@@unique([clientId, replyToId])`); em seguida envia a resposta pelo número do banco e marca `sentAt`.
- `Message` é imutável (só `updateMany` com `clientId` é permitido). O histórico enviado ao LLM é o que vem **antes** da mensagem atual (`listBefore`).
- Avisos constantes (áudio, imagem, texto inválido) são jobs `notice` sem gravação.
- O simulador `POST /admin/clients/:clientId/messages` é síncrono, uma mensagem por chamada.
- Redis, BullMQ e o `AttendanceUnitOfWork` já existem. Não há nenhum conceito de "mensagem respondida em grupo".

## Comportamento esperado

### Janela de espera (só no canal; o simulador administrativo continua imediato)

- **Janela deslizante com teto:** cada mensagem de texto nova de um contato (por `clientId` + `contactRef`) **reinicia** a espera de `CHANNEL_BATCH_WINDOW_MS`. A resposta sai quando o contato fica esse tempo sem escrever, ou quando a primeira mensagem pendente completa `CHANNEL_BATCH_MAX_WAIT_MS` (teto: um contato que não para de escrever não fica sem resposta para sempre).
- Limites do lote: no máximo `CHANNEL_BATCH_MAX_MESSAGES` mensagens e `CHANNEL_BATCH_MAX_CHARS` caracteres somados por resposta. Se houver mais pendentes que isso, o excedente vira o **próximo** turno (sem esperar de novo: já passou da janela).
- `CHANNEL_BATCH_WINDOW_MS=0` desliga a espera (a resposta sai assim que o worker processa; as mensagens que já estiverem pendentes ainda são agrupadas).
- Avisos constantes (`notice`) **não** esperam nem agrupam: seguem imediatos como na 011.
- O texto enviado ao LLM é um único turno `user`: os textos das mensagens pendentes, em ordem de chegada, separados por uma quebra de linha. O `systemPrompt` (persona) e o histórico anterior não mudam; o histórico é tudo o que veio **antes da primeira** mensagem do lote.

### Fluxo (substitui o job `text` da 011, que fazia tudo de uma vez)

1. **Aceitar** (job `text`, como hoje enfileirado pelo webhook): o worker grava a mensagem do contato (idempotente por `externalId`, sem chamar o LLM) e **agenda** o job de resposta do contato. Ele só termina depois de agendar; se cair no meio, a retentativa refaz os dois passos (já idempotentes). Uma reentrega da Meta de mensagem já respondida não gera nada.
2. **Responder** (novo job `flush`, atrasado, um por `(clientId, contactRef)`, `jobId` determinístico que inclui o `clientId`): quando dispara, lê as mensagens pendentes do contato, monta o turno único, chama o LLM (com o prazo e o fallback da 010), grava **uma** resposta e marca todas as mensagens do lote como respondidas **na mesma transação** que grava a resposta. Depois envia pelo número do banco e marca `sentAt`, com as regras da 011 (suspenso em silêncio, número trocado, erro transitório/permanente, texto padrão na falha final).
3. **Reagendamento:** ao terminar, o `flush` confere se ainda há mensagens pendentes (chegaram durante a chamada ao LLM, ou excederam o limite do lote) e, se houver, agenda o próximo. Isso é obrigatório porque o BullMQ não aceita um segundo job com o mesmo id enquanto o primeiro está ativo: uma mensagem que chega durante o `flush` não pode ficar sem resposta.
4. O mecanismo da janela deslizante (modo debounce da deduplicação do BullMQ, `changeDelay` do job atrasado, ou remover e readicionar o job atrasado) fica a critério do implementer, que confirma na documentação da versão instalada e registra a escolha. O teto de espera é calculado a partir da mais antiga mensagem pendente (`createdAt`).
5. O job `flush` **não carrega texto**: leva só `clientId`, `phoneNumberId` (que continua só servindo para descartar se o número do cliente mudou), `contactRef` e `requestId`. O texto vive no banco.

### Dados (Prisma + migration aditiva, aplicada em `soprei` e `soprei_test`)

- `Message.answeredById` (UUID opcional): em mensagem do contato, o id da resposta que a atendeu. Chave estrangeira **composta** `(answered_by_id, client_id)` → `messages(id, client_id)` (`ON DELETE NO ACTION`), `CHECK` de que só mensagem `USER` tem o campo preenchido, e índice parcial para a busca de pendentes: `(client_id, conversation_id, created_at, id) WHERE role = 'USER' AND answered_by_id IS NULL`.
- **Pendente** = mensagem `USER` da conversa sem `answeredById` **e** sem resposta por `replyToId` (esta segunda condição cobre o caminho do simulador e as linhas anteriores à migration, sem backfill). A resposta do lote grava `replyToId` = a **última** mensagem do lote (a unicidade `(clientId, replyToId)` segue valendo) e `answeredById` = a resposta em **todas** as mensagens do lote.
- Domínio/repositório: `Message.answeredById`; `MessageRepository.listPending(clientId, conversationId, limit)` (mais antigas primeiro) e `markAnswered(clientId, messageIds, replyId)` por `updateMany` com `clientId`, ids, `role = USER` e `answeredById` nulo no `where` (idempotente). A gravação da resposta e o `markAnswered` entram numa transação do `AttendanceUnitOfWork`; a chamada ao LLM continua **fora** dela.
- `AttendanceService` ganha duas operações (mantendo `handleInboundMessage` e o simulador como estão, para não regredir a 010): `acceptInboundMessage(clientId, input)` (conversa por `contactRef` + mensagem do contato, idempotente por `externalId`, sem LLM) e `respondToPending(clientId, contactRef, limits)` (o passo 2 acima, devolvendo a resposta, o tamanho do lote e se sobraram pendentes).
- Idempotência da resposta: se o `flush` for repetido depois de a resposta gravada, não há pendentes (as mensagens do lote já têm `answeredById`) e a retentativa só reenvia se a resposta ainda não tiver `sentAt`. Dois `flush` do mesmo contato nunca rodam juntos (um job por contato e worker de concorrência 1); mesmo assim, a unicidade da resposta e o `updateMany` idempotente impedem resposta dupla.

### Configuração (validada em `src/infrastructure/config/`, documentada nos `.env*.example`)

| Variável | Regra |
| --- | --- |
| `CHANNEL_BATCH_WINDOW_MS` | padrão 5 000; 0 a 60 000; 0 desliga a espera |
| `CHANNEL_BATCH_MAX_WAIT_MS` | padrão 20 000; 0 a 300 000; precisa ser maior ou igual à janela |
| `CHANNEL_BATCH_MAX_MESSAGES` | padrão 10; 1 a 50 |
| `CHANNEL_BATCH_MAX_CHARS` | padrão 8 000; 1 a 24 000 |

Só valem com o canal habilitado. A regra cruzada da 011 (`QUEUE_BACKOFF_MS × (2^(QUEUE_ATTEMPTS − 1) − 1) > ATTENDANCE_IN_FLIGHT_TIMEOUT_MS`) continua valendo e não depende da janela.

### Métricas (registry da 004, sem `clientId`, telefone nem texto em label)

`attendance_batch_size` (histograma de mensagens por resposta, buckets 1, 2, 3, 5, 10, 25, 50) e `attendance_batches_total{result}` com `result` ∈ `answered`, `empty` (nada pendente: já respondido), `capped` (sobrou excedente). Os contadores de fila da 011 (`queue_jobs_total`) passam a cobrir também o job `flush`.

## Critérios de aceite

**Agrupamento**
- [x] Teste: três mensagens do mesmo contato dentro da janela geram **uma** chamada ao LLM e **uma** resposta; o `LlmProvider` recebe um único turno `user` com os três textos em ordem, separados por quebra de linha, e o histórico anterior à primeira mensagem (inspeção do mock).
- [x] Teste: a janela é **deslizante**: uma nova mensagem dentro da janela adia a resposta; só depois de a janela passar sem mensagem nova a resposta sai.
- [x] Teste: o **teto de espera** vale: um contato que escreve continuamente recebe resposta ao completar o teto, e as mensagens seguintes viram o turno seguinte.
- [x] Teste: mensagens separadas por mais que a janela geram duas respostas, na ordem.
- [x] Teste: `CHANNEL_BATCH_WINDOW_MS=0` responde sem espera (e agrupa só o que já estava pendente).
- [x] Teste: mais pendentes que `CHANNEL_BATCH_MAX_MESSAGES` ou `CHANNEL_BATCH_MAX_CHARS` geram respostas em turnos sucessivos, sem perder nenhuma mensagem e sem nova espera.
- [x] Teste: uma mensagem que chega **durante** a chamada ao LLM (job `flush` ativo) recebe a sua própria resposta depois (não fica sem resposta) e não é incluída no lote em andamento.
- [x] Teste: aviso constante (áudio, imagem) não espera e não entra no lote; um texto pendente continua esperando a janela.
- [x] Teste: o simulador `POST /admin/clients/:clientId/messages` continua síncrono, uma resposta por mensagem, com o comportamento da 010 (suítes existentes sem alteração).

**Dados e idempotência**
- [x] Teste de integração (banco): todas as mensagens do lote ficam com `answeredById` = a resposta, a resposta tem `replyToId` = a última mensagem do lote, e uma segunda chamada de `respondToPending` não encontra pendentes.
- [x] Teste: reentrega da Meta de mensagem já respondida (mesmo `wamid`) não grava nem responde de novo; de mensagem ainda pendente apenas reagenda sem duplicar.
- [x] Teste: queda simulada entre gravar a mensagem e agendar o `flush` (retentativa do job `text`) termina com a mensagem respondida uma vez.
- [x] Teste: `flush` repetido depois da resposta gravada e antes do `sentAt` só reenvia, sem nova chamada ao LLM; depois do `sentAt`, não envia de novo.
- [x] Teste: falha do LLM no lote grava o fallback (`isFallback`) que marca **todas** as mensagens do lote como respondidas e envia o texto padrão uma vez.
- [x] Teste: erro transitório do Graph no envio é retentado sem nova chamada ao LLM; erro permanente deixa a resposta gravada sem `sentAt` (regras da 011).
- [x] Teste: cliente suspenso (decisão do dono na 011) não recebe nada, e o `flush` é descartado; número do cliente trocado descarta o job.

**Isolamento entre clientes (o centro da spec)**
- [x] Teste: dois contatos do mesmo cliente escrevendo ao mesmo tempo nunca se misturam (cada um tem o seu lote, o seu `flush` e a sua resposta).
- [x] Teste: o mesmo `contactRef` em dois clientes diferentes nunca se mistura (lotes, histórico e persona de cada um; `jobId` do `flush` inclui o `clientId`).
- [x] Teste de repositório (modelo de `message.repository.integration.test.ts`): `listPending` e `markAnswered` só enxergam e alteram mensagens do `clientId` informado; `markAnswered` com ids de outro cliente não altera nada.
- [x] Teste de integridade no banco: tentar gravar `answeredById` apontando para mensagem de outro cliente falha pela chave estrangeira composta; `answeredById` em mensagem do assistente falha no `CHECK`.
- [x] `tenant-scope` e `MODEL_SCOPES` continuam passando (nenhuma consulta sem `clientId`).

**Privacidade, observabilidade e geral**
- [x] Teste de captura de log: texto, contato, destinatário, persona e tokens não aparecem em nenhuma linha de log nem em label de métrica em todo o fluxo (aceitar, esperar, responder, falhar); o job `flush` não contém texto.
- [x] `attendance_batch_size` e `attendance_batches_total` aparecem em `/metrics`.
- [x] Config: valores inválidos falham no boot; `CHANNEL_BATCH_MAX_WAIT_MS` menor que a janela é rejeitado.
- [ ] Migration aplicada em `soprei` e `soprei_test` (feito, aditiva, sem `reset`/`DROP`); `typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes em Node 22 e 24 (feito localmente, ver o registro); as suítes novas repetidas várias vezes sem falha (feito, ver o registro); CI verde e revisão do `reviewer` (pendentes: dependem do PR).

## Casos de borda e erros

- **Toda resposta passa a demorar pelo menos a janela** (5 s por padrão) mais o tempo do LLM, inclusive para uma mensagem isolada. É o preço do agrupamento; `CHANNEL_BATCH_WINDOW_MS` ajusta. Um indicador de "digitando" para o contato ficaria bem aqui, mas está fora de escopo.
- **Ordem entre mensagens:** a de chegada dos webhooks (limitação já declarada na 011; a Meta pode entregar fora de ordem).
- **Mensagem longa demais no lote:** cada mensagem já tem até 4 000 caracteres; o lote é cortado por `CHANNEL_BATCH_MAX_CHARS` (o excedente vira o turno seguinte). Uma única mensagem maior que o limite do lote segue sozinha.
- **Perda do job `flush`** (Redis apagado): as mensagens ficam gravadas e pendentes no banco, e a próxima mensagem do contato agenda um novo `flush` que as responde juntas. Sem nova mensagem, ficam sem resposta até alguém notar (visível na API administrativa); varredura periódica de pendentes antigos fica para uma spec própria.
- **Fim do processo no meio do `flush`:** o job parado é retentado; se a resposta já foi gravada, só falta enviar (regra de `sentAt`); se não, o lote ainda está pendente e é respondido.
- **At-least-once** do envio continua como na 011 (uma queda entre o envio e `markSent` pode duplicar a resposta, nunca perdê-la).
- **Cliente removido** durante a espera: o `flush` é descartado sem envio (erro não retentável), como na 011.
- **Várias instâncias do servidor:** o `jobId` único por contato e o lock do BullMQ impedem dois `flush` simultâneos do mesmo contato; o teto de espera usa o `createdAt` do banco, não o relógio local.

## Isolamento entre clientes

Toda consulta de pendentes e toda marcação recebe o `ClientId` como primeiro parâmetro e passa pela `tenant-scope`; o `jobId` do `flush` carrega o `clientId`; a chave estrangeira composta impede, no próprio banco, ligar mensagem de um cliente à resposta de outro. Os testes da seção acima (dois contatos, dois clientes com o mesmo `contactRef`, repositório e banco) são o gabarito.

## Fora de escopo

- Agrupar no simulador administrativo; janela por cliente (configuração por cliente, quando houver painel); janela adaptativa pelo tamanho do texto.
- Indicador de "digitando" e confirmação de leitura para o contato.
- Agrupar avisos constantes, ou agrupar mensagens de tipos diferentes (texto e áudio) numa mesma resposta.
- Varredura periódica de mensagens pendentes antigas; limpeza do Redis e retenção de dados pessoais (continuam como pendência da 011, antes de dados reais).
- Concorrência maior no worker; painel, transferência para humano, provedor real de LLM.
- Reordenar mensagens pela hora da Meta.

## Decisões

Decidida: **1. as mensagens esperam no banco** (dono, 2026-10-28): cada mensagem é gravada ao chegar, como hoje, e a espera é só um job atrasado. O conteúdo não fica no Redis, nada se perde se o Redis cair no meio, e o histórico por mensagem segue disponível para o painel futuro. Custo: uma coluna nova (`answeredById`) e o atendimento do canal dividido em duas etapas. Descartada a alternativa de um buffer no Redis (texto no Redis durante a espera, uma só linha combinada no histórico, dedupe dependente de chaves com TTL e scripts Lua mais frágeis).

Propostas, o dono decide:

2. **Tipo de janela.** (a) **Deslizante com teto de espera [recomendado]**: reinicia a cada mensagem, com um limite total. (b) Fixa, contada da primeira mensagem: mais simples, mas corta quem ainda está escrevendo.
3. **Valores iniciais.** Janela de **5 s**, teto de **20 s**, lote de até **10** mensagens e **8 000** caracteres. Quer outros? (Tudo é ajustável por variável.)
4. **Como as mensagens vão ao LLM.** (a) **Um único turno `user` com os textos separados por quebra de linha [recomendado]**: funciona igual em qualquer provedor. (b) Vários turnos `user` seguidos: alguns provedores exigem alternância e rejeitam ou mesclam por conta própria.
5. **Avisos constantes imediatos [recomendado]**, sem esperar a janela, em vez de entrar no agrupamento.
6. **O simulador administrativo continua síncrono, sem janela [recomendado]**: ele serve de teste e ferramenta do dono.
7. **Configuração global por variável de ambiente [recomendado]**; por cliente quando existir painel.
8. **Revisão pelo `reviewer` [recomendado]**: migration com chave estrangeira composta, mudança na marcação de mensagens respondidas e isolamento entre clientes.

## Decisões e dependências novas

- Dependências novas: nenhuma (BullMQ e Redis já existem).
- Migration aditiva (`messages.answered_by_id`, chave estrangeira composta, `CHECK` e índice parcial), aplicada em `soprei` e `soprei_test` com `prisma migrate deploy`, no mesmo limite da 003: sem `migrate reset`, sem `DROP`, sem apagar dado que o implementer não criou.
- Por tocar em isolamento (novo vínculo entre mensagens de um mesmo cliente, `updateMany` em mensagens de tenant) e no fluxo do atendimento, passa pelo agente `reviewer` antes do merge.

## Registro da implementação (2026-10-28)

Implementada na branch `spec/013-agrupamento-de-mensagens`, com commits por parte (docs, config, banco, atendimento, métricas, fila e processador, testes de ponta a ponta, docs). **Status mantido em `aprovada`**: a conclusão fica para depois do `reviewer` e do CI. Nada foi enviado à Meta real: os testes usam só o servidor Graph falso local, o Postgres `soprei_test` e o Redis `/15` com prefixo único.

**Mecanismo escolhido no BullMQ (6.4.2, conferido no código instalado):** deduplicação com `replace: true` e `keepLastIfActive: true`, não `changeDelay` nem remover e readicionar.

- O id de deduplicação é `flush_<clientId>_<sha256(contactRef)[0..32]>` (`flushKey`): um `flush` por `(clientId, contactRef)`, com o `clientId` na chave e sem o telefone.
- `slide` (mensagem nova): o `flush` que ainda espera (job atrasado) é removido e um novo, com a espera inteira, o substitui (`ZREM` do atrasado em `deduplicateJob.lua`). `ensure` (reentrega, retentativa e excedente de lote): `SET NX` na chave, sem adiar o que já existe.
- `keepLastIfActive` resolve o problema que a spec descreve (o BullMQ não aceita outro job com o mesmo id enquanto o primeiro está ativo) **sem corrida**: agendar enquanto o `flush` do contato está ativo guarda o próximo no Redis (`dn:<id>`, só o último vale) e o `moveToFinished` o cria de forma atômica quando o ativo termina (`requeueDeduplicatedJob.lua`). Por isso o `flush` reagenda o excedente com `scheduleFlush(..., { delayMs: 0, mode: 'ensure' })` ainda ativo. Teste de integração com o `flush` ativo e segurado.
- `changeDelay` descartado: só vale para job atrasado, exige ler o estado e agir (corrida) e trocaria também o atraso de um job em backoff.
- **Desvio:** o `jobId` não é fixo. Em `addDelayedJob-6.lua` o `EXISTS` do `jobId` roda **antes** da deduplicação (`handleDuplicatedJob`), então um `jobId` determinístico faria o `replace` nunca acontecer. A identidade determinística (com o `clientId`) é o id de deduplicação; o `jobId` é `<flushKey>_<uuid>`, único por agendamento (inclui o `clientId`, sem `:`, não é inteiro). O `flush` usa `removeOnComplete: true` (não deixa o `contactRef` no Redis depois de concluir; falhos seguem a `QUEUE_KEEP_FAILED_SECONDS`).

**O que foi feito (arquivos por pasta):**

| Pasta | O que há |
| --- | --- |
| `prisma/` | `schema.prisma` (`Message.answeredById` e relação `MessageAnswer`); migration `20261028120000_message_answered_by` (coluna, chave estrangeira composta, `CHECK` só `USER`, índice parcial `messages_pending_idx`) |
| `src/domain/` | `Message.answeredById`; `MessageRepository.listPending` e `markAnswered`; `ConversationRepository.findByContact` |
| `src/infrastructure/database/repositories/` | implementações e mapper; testes de repositório (isolamento, FK composta, `CHECK`, `tenant-scope`) |
| `src/application/attendance/` | `acceptInboundMessage`, `respondToPending`, `hasPendingMessages`, `batchLimitsSchema`, `contactRefSchema`; `handleInboundMessage` e o simulador **sem alteração** |
| `src/application/ports/` | `inbound-job-queue.ts`: job `flush`, `flushKey`, `FlushSchedule`, `scheduleFlush`, `ChannelJob`, `attempt` no contexto |
| `src/application/channel/` | `channel-inbound.processor.ts` (aceitar, `flush`, reagendamento, retentativa), `batch-window.ts` (`flushDelayMs`), `ChannelIntakeService` só depende de `enqueue` |
| `src/infrastructure/queue/` | `inbound-queue.ts` (`scheduleFlush`, `attempt` no contexto) |
| `src/infrastructure/config/` | `CHANNEL_BATCH_*` (schema, `batchSettings`) |
| `src/infrastructure/metrics/` | `attendance_batch_size`, `attendance_batches_total` |
| `src/index.ts` | ligação (`queue`, `batch` no processador) |
| `src/test-support/` | `in-memory-attendance.ts` (listPending, markAnswered, findByContact, rollback de marca) |

Sem barrels novos nem aliases; `application` e `presentation` não importam `infrastructure/database` nem BullMQ.

**Decisões e desvios (o dono pode contestar):**

- **Pasta nova:** nenhuma. Arquivos novos entram nas pastas da 011/012.
- **Métodos além dos citados na spec:** `ConversationRepository.findByContact` (o `flush` não pode criar conversa) e `AttendanceService.hasPendingMessages` (decidir o texto padrão de um `flush` que falhou sem handler).
- **`createdAt` da resposta do lote = última mensagem do lote + 1 ms** (a 010 usa `max(agora, pergunta + 1 ms)`). Motivo: a resposta precisa ficar **antes** de qualquer mensagem que chegou durante o atendimento ou que sobrou do limite; senão o `listBefore` do turno seguinte não a incluiria no histórico e o modelo veria dois turnos `user` seguidos. O horário gravado da resposta, portanto, não é o de quando ela foi gerada (o de entrega é o `sentAt`). Dentro do mesmo milissegundo a ordem é só por `id`: mensagens do mesmo contato com menos de 1 ms de diferença são irreais no canal, e os testes espaçam as inserções.
- **Retentativa do `flush` (`attempt > 1`):** se a resposta do turno anterior foi gravada e não enviada, ela sai antes de responder o excedente (`resumeUnsent`), sem nova chamada ao LLM. Sem isso, um erro transitório de envio com excedente pularia a resposta. **Limitação:** se o contato escreve durante o backoff de um envio que falhou, o `replace` troca o job em retentativa por um novo e a resposta não enviada fica só gravada (visível na API administrativa); o BullMQ não permite distinguir esse job de um que só espera a janela. Também não cobre `stalled` (a contagem de tentativas não sobe).
- **Falha final do `flush`** (atendimento falhou e esgotou as tentativas): o contato recebe o texto padrão e as mensagens seguem pendentes; a próxima mensagem dele agenda um novo `flush` que as responde juntas. Não há reagendamento automático (evita laço).
- **`attempt` em `InboundJobContext` é opcional** (os testes da 011 continuam sem alteração).
- **`AttendanceMetrics.observeAttendanceBatch` é opcional** (o fake da suíte da 010 continua sem alteração); o `Metrics` real o implementa. `empty` conta `attendance_batches_total` mas não entra no histograma.
- **Número trocado e suspenso no `flush`:** o suspenso é descartado antes de qualquer LLM; o número trocado é conferido na entrega (depois da resposta gravada, como na 011), então a resposta fica gravada sem `sentAt`.
- **Testes da 011 ajustados:** o harness de ponta a ponta usa janela 0 (uma resposta por mensagem), o `wrapAttendance` troca `acceptInboundMessage` no lugar de `handleInboundMessage`, e o teste do `ConflictError` por "em andamento" foi substituído pelo da queda entre gravar e agendar (esse 409 não existe mais no canal). Processador: um helper `flow` roda aceitar e `flush`. O log da falha de envio permanente do `flush` leva `flushRef` no lugar de `messageRef`.
- **`ATTENDANCE_IN_FLIGHT_TIMEOUT_MS`** passa a valer só para o caminho `handleInboundMessage` (simulador); a regra cruzada da 011 com o backoff foi mantida.

**Critérios:** todos marcados `[x]` têm teste passando; o último (CI e `reviewer`) depende do PR.

**Validação local (2026-10-28):**

| Comando | Node 22.23.2 | Node 24.18.0 |
| --- | --- | --- |
| `pnpm db:generate` | ok | (mesmo client) |
| `pnpm typecheck` | verde | verde |
| `pnpm lint` | verde | verde |
| `pnpm format:check` | verde | verde |
| `pnpm test` | 642 testes, 642 ok | 642 testes, 642 ok |
| `pnpm test:integration` | 239 testes, 239 ok | 239 testes, 239 ok |
| `rm -rf dist && pnpm build` | ok (`dist/` com `application/channel/batch-window.js`) | |

Antes da 013 eram 586 unitários e 205 de integração. Suítes novas e alteradas (unitárias: canal, atendimento, métricas e config, 249 por rodada; integração: ponta a ponta do agrupamento, banco do agrupamento, fila, canal da 011 e repositório de mensagens, 107 por rodada) repetidas **4 vezes no Node 22 e 2 no Node 24, todas verdes**. Cuidados contra flake: janelas de 200 a 700 ms por config, sondagem com prazo (`waitFor`), margens de 100 ms ou mais nas asserções de "ainda não respondeu", relógio injetável (`steppingClock`) nos unitários. Um teste novo deixava o processo pendurado (a conexão Redis passada ao `Queue` cru não era fechada); corrigido.

**Smoke do processo compilado:** `node dist/index.js` em diretório vazio (sem `.env`), `NODE_ENV=production`, segredos e tokens **falsos**, banco e Redis de **teste** e `CHANNEL_BATCH_WINDOW_MS=1000`, sem chamar a Meta: sobe e responde `/health` e `/health/ready`; `GET` do webhook com o token certo devolve o challenge e com o errado 403; `POST` sem assinatura 401; `POST` assinado para número sem cliente 200; `/metrics` expõe `attendance_batch_size`, `attendance_batches_total` e `queue_jobs_total`; nenhum segredo, telefone, texto nem query string na saída; o boot loga o canal e o modo `off` do `TRUST_PROXY`. As chaves que o smoke criou no Redis `/15` (`soprei:queue:channel-inbound:*`) foram removidas. O fluxo de agrupamento em si é coberto pelos testes de ponta a ponta (o smoke de produção não tem cliente com número cadastrado).

**Pendente ou incerto:** CI e `reviewer` (esta spec exige); o comportamento de ponta a ponta com a Meta real e o túnel (o dono repete o teste manual da 011 e confere que duas mensagens seguidas geram uma resposta); varredura periódica de mensagens pendentes antigas (fora de escopo); retenção do texto e do `contactRef` nos jobs do Redis (continua pendência da 011; o `flush` não guarda texto e é removido ao concluir).
