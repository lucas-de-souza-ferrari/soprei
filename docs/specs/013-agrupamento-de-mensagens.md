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
- [ ] Teste: três mensagens do mesmo contato dentro da janela geram **uma** chamada ao LLM e **uma** resposta; o `LlmProvider` recebe um único turno `user` com os três textos em ordem, separados por quebra de linha, e o histórico anterior à primeira mensagem (inspeção do mock).
- [ ] Teste: a janela é **deslizante**: uma nova mensagem dentro da janela adia a resposta; só depois de a janela passar sem mensagem nova a resposta sai.
- [ ] Teste: o **teto de espera** vale: um contato que escreve continuamente recebe resposta ao completar o teto, e as mensagens seguintes viram o turno seguinte.
- [ ] Teste: mensagens separadas por mais que a janela geram duas respostas, na ordem.
- [ ] Teste: `CHANNEL_BATCH_WINDOW_MS=0` responde sem espera (e agrupa só o que já estava pendente).
- [ ] Teste: mais pendentes que `CHANNEL_BATCH_MAX_MESSAGES` ou `CHANNEL_BATCH_MAX_CHARS` geram respostas em turnos sucessivos, sem perder nenhuma mensagem e sem nova espera.
- [ ] Teste: uma mensagem que chega **durante** a chamada ao LLM (job `flush` ativo) recebe a sua própria resposta depois (não fica sem resposta) e não é incluída no lote em andamento.
- [ ] Teste: aviso constante (áudio, imagem) não espera e não entra no lote; um texto pendente continua esperando a janela.
- [ ] Teste: o simulador `POST /admin/clients/:clientId/messages` continua síncrono, uma resposta por mensagem, com o comportamento da 010 (suítes existentes sem alteração).

**Dados e idempotência**
- [ ] Teste de integração (banco): todas as mensagens do lote ficam com `answeredById` = a resposta, a resposta tem `replyToId` = a última mensagem do lote, e uma segunda chamada de `respondToPending` não encontra pendentes.
- [ ] Teste: reentrega da Meta de mensagem já respondida (mesmo `wamid`) não grava nem responde de novo; de mensagem ainda pendente apenas reagenda sem duplicar.
- [ ] Teste: queda simulada entre gravar a mensagem e agendar o `flush` (retentativa do job `text`) termina com a mensagem respondida uma vez.
- [ ] Teste: `flush` repetido depois da resposta gravada e antes do `sentAt` só reenvia, sem nova chamada ao LLM; depois do `sentAt`, não envia de novo.
- [ ] Teste: falha do LLM no lote grava o fallback (`isFallback`) que marca **todas** as mensagens do lote como respondidas e envia o texto padrão uma vez.
- [ ] Teste: erro transitório do Graph no envio é retentado sem nova chamada ao LLM; erro permanente deixa a resposta gravada sem `sentAt` (regras da 011).
- [ ] Teste: cliente suspenso (decisão do dono na 011) não recebe nada, e o `flush` é descartado; número do cliente trocado descarta o job.

**Isolamento entre clientes (o centro da spec)**
- [ ] Teste: dois contatos do mesmo cliente escrevendo ao mesmo tempo nunca se misturam (cada um tem o seu lote, o seu `flush` e a sua resposta).
- [ ] Teste: o mesmo `contactRef` em dois clientes diferentes nunca se mistura (lotes, histórico e persona de cada um; `jobId` do `flush` inclui o `clientId`).
- [ ] Teste de repositório (modelo de `message.repository.integration.test.ts`): `listPending` e `markAnswered` só enxergam e alteram mensagens do `clientId` informado; `markAnswered` com ids de outro cliente não altera nada.
- [ ] Teste de integridade no banco: tentar gravar `answeredById` apontando para mensagem de outro cliente falha pela chave estrangeira composta; `answeredById` em mensagem do assistente falha no `CHECK`.
- [ ] `tenant-scope` e `MODEL_SCOPES` continuam passando (nenhuma consulta sem `clientId`).

**Privacidade, observabilidade e geral**
- [ ] Teste de captura de log: texto, contato, destinatário, persona e tokens não aparecem em nenhuma linha de log nem em label de métrica em todo o fluxo (aceitar, esperar, responder, falhar); o job `flush` não contém texto.
- [ ] `attendance_batch_size` e `attendance_batches_total` aparecem em `/metrics`.
- [ ] Config: valores inválidos falham no boot; `CHANNEL_BATCH_MAX_WAIT_MS` menor que a janela é rejeitado.
- [ ] Migration aplicada em `soprei` e `soprei_test` (aditiva, sem `reset`/`DROP`); `typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes em Node 22 e 24; as suítes novas repetidas várias vezes sem falha; CI verde e revisão do `reviewer`.

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
