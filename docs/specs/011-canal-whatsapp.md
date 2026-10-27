# 011 — Canal WhatsApp: webhook de entrada e envio da resposta

- **Status:** aprovada pelo dono em 2026-10-27, com todas as recomendações da seção "Decisões" (fila BullMQ, concorrência 1, mapeamento por coluna em `Client`, credenciais por variável de ambiente, resposta constante para mensagem não textual, fallback na falha final, marca de envio na mensagem, canal opt-in, 005 antes). **Só implementar depois da 005 concluída.**
- **Branch:** `spec/011-canal-whatsapp`
- **Depende de:** 010 (concluída) e **005 (rate limiting) concluída antes de implementar**, porque esta spec expõe o primeiro endpoint público. A 005 é um esboço e precisa ser relida contra o código e aprovada primeiro (ver "Requisitos sobre a spec 005").

## Objetivo

Ligar o atendimento da 010 ao WhatsApp real (Cloud API oficial da Meta): a mensagem do contato chega por webhook, é atendida em segundo plano pelo `AttendanceService` (com o LLM ainda `mock`) e a resposta volta ao contato pelo mesmo número. Usa o **número de teste da Meta** e credenciais únicas por variável de ambiente. O onboarding de vários clientes (Embedded Signup, token por cliente cifrado) é a spec seguinte e **não** está aqui.

## Estado de partida

- `AttendanceService.handleInboundMessage(clientId, { contactRef, text, externalId? })` já faz idempotência por `externalId`, histórico, fallback e isolamento. Retoma mensagem sem resposta mais velha que `ATTENDANCE_IN_FLIGHT_TIMEOUT_MS` (60 s); mais nova que isso devolve `ConflictError` (409).
- Não existe endpoint público, fila, rate limit nem canal. Redis é obrigatório no boot. O contexto por requisição (`AsyncLocalStorage`) e o logger com `redact` vêm da 004.
- `Client` é um model global (sem `clientId`), com repositório próprio. `Message` é model de tenant; mensagens são imutáveis (só `updateMany` com `clientId` é permitido na `tenant-scope`).
- O texto do contato aceito pelo service vai até 4000 caracteres; o WhatsApp entrega até 4096.

## Comportamento esperado

### Configuração (validada em `src/infrastructure/config/`, documentada nos `.env*.example`)

O canal é **opt-in**: sem `WHATSAPP_ENABLED=true` as rotas do webhook **não existem** (404), como o `/metrics` sem token. Só `true` e `false` são aceitos (`z.coerce.boolean` trataria `"false"` como verdadeiro; não usar).

| Variável | Regra |
| --- | --- |
| `WHATSAPP_ENABLED` | `true`/`false`, padrão `false` |
| `WHATSAPP_APP_SECRET` | obrigatória se habilitado; segredo do app Meta, usado só para validar a assinatura |
| `WHATSAPP_VERIFY_TOKEN` | obrigatória se habilitado, mínimo 16 caracteres; escolhido por nós, usado só no handshake de verificação |
| `WHATSAPP_ACCESS_TOKEN` | obrigatória se habilitado; token de envio (temporário de 24 h no teste; token permanente de usuário do sistema fora dele) |
| `WHATSAPP_API_BASE_URL` | padrão `https://graph.facebook.com`; `http://` só fora de produção (os testes apontam para um servidor falso local) |
| `WHATSAPP_GRAPH_API_VERSION` | formato `vNN.N`; o implementer confere na documentação da Meta qual é a versão estável vigente e fixa o padrão (não chutar) |
| `WHATSAPP_SEND_TIMEOUT_MS` | padrão 10 000 |
| `QUEUE_ATTEMPTS` / `QUEUE_BACKOFF_MS` | padrões 5 e 10 000 (backoff exponencial: 10, 20, 40, 80 s) |
| `QUEUE_KEEP_COMPLETED_SECONDS` / `QUEUE_KEEP_FAILED_SECONDS` | padrões 3 600 e 86 400 |

Regra cruzada na config: `QUEUE_BACKOFF_MS × (2^(QUEUE_ATTEMPTS − 1) − 1)` precisa ser maior que `ATTENDANCE_IN_FLIGHT_TIMEOUT_MS`; senão uma retentativa depois de queda do processo bateria em 409 até acabar as tentativas. Os três segredos nunca vão para log (`redact`), resposta nem métrica.

### Webhook (`src/presentation/`, rotas finas)

- **`GET /webhooks/whatsapp`** (verificação): com `hub.mode=subscribe` e `hub.verify_token` igual a `WHATSAPP_VERIFY_TOKEN` (comparação em tempo constante), responde 200 `text/plain` com o `hub.challenge` e nada mais; caso contrário 403. O `hub.verify_token` vem na URL: nenhum log pode conter a query string.
- **`POST /webhooks/whatsapp`** (eventos):
  1. Rate limit com o perfil `webhook` da 005, antes de qualquer trabalho.
  2. Corpo lido **cru** (Buffer; parser de `application/json` encapsulado só neste plugin) e limitado a 1 MiB.
  3. Valida `X-Hub-Signature-256` (`sha256=<hex>` = HMAC-SHA256 do corpo cru com `WHATSAPP_APP_SECRET`), em tempo constante e checando o tamanho antes. Cabeçalho ausente, malformado ou errado: **401**, sem processar nada.
  4. Só depois da assinatura o corpo é interpretado, com um schema Zod **tolerante** (ignora campos desconhecidos): usa `entry[].changes[].value` com `metadata.phone_number_id`, `messages[]` (`id`, `from`, `type`, `text.body`) e `statuses[]`. Nada do que não é usado é lido ou guardado (nome de perfil, por exemplo).
  5. Para cada mensagem de entrada: resolve o cliente pelo `phone_number_id` (ver "Dados"); número desconhecido, cliente removido ou `SUSPENDED` → descarta com log e métrica (sem processar).
  6. Texto válido (1 a 4000 caracteres, sem NUL, não vazio depois de `trim`): enfileira um job `text`. Tipo não textual (áudio, imagem, figurinha, localização...) ou texto inválido: enfileira um job `notice` com um texto constante educado (ver decisão 5). Nunca silêncio.
  7. Responde **200** em seguida, sem chamar LLM nem o Graph API no fluxo síncrono. Eventos `statuses[]` não geram resposta: só métrica e, para `failed`, log `warn` com o id da mensagem e o código de erro.
- **Falha ao enfileirar** (Redis fora) → **500**, para a Meta retentar (ela reenvia por dias). O que já foi enfileirado no mesmo lote não duplica: o id do job é determinístico.
- **Depois de assinatura válida**, corpo que não é JSON ou que não bate com o schema → **200** com log `warn` e métrica `invalid_payload` (um 4xx faria a Meta retentar sem chance de sucesso e, com falhas repetidas, ela pode desativar a assinatura).
- Mapeamento: `contactRef` = `from` (o `wa_id` do contato, tal como veio), `externalId` = `messages[].id` (o `wamid`). O `timestamp` da Meta **não** ordena nada: a ordem é a de chegada (limitação conhecida).

### Fila e processamento em segundo plano

- **BullMQ sobre o Redis existente** (decisão 1). Fila `channel-inbound`, `src/infrastructure/queue/`; o código de `application` e `presentation` conhece só uma porta (`InboundJobQueue.enqueue`), nunca o BullMQ.
- Job: `{ kind: 'text', clientId, contactRef, text, externalId, requestId }` ou `{ kind: 'notice', clientId, contactRef, externalId, reason, requestId }`. O `jobId` é `<clientId>_<externalId>` (sem `:`; o implementer confirma as restrições de id da versão do BullMQ), o que dá dedupe de reentregas da Meta. A idempotência definitiva continua sendo a do banco (`externalId`).
- O `requestId` do webhook acompanha o job: o worker roda dentro de `runWithContext` com esse `requestId` e `setClientId(clientId)`, então log do webhook e log do atendimento se correlacionam e todo log do worker leva `clientId`.
- O worker roda **no mesmo processo** da API, com **concorrência 1** (decisão 2), e é encerrado de forma graciosa no `shutdown` (espera o job ativo, antes de fechar Redis e banco).
- **Processamento de um job `text`** (`ChannelInboundProcessor`, em `application`, sobre portas):
  1. `attendance.handleInboundMessage(clientId, { contactRef, text, externalId })`.
  2. Se a resposta já tem `sentAt` (retentativa depois de envio concluído), termina sem enviar de novo.
  3. Resolve o número do cliente **no banco, pelo `clientId` do job** (`Client.whatsappPhoneNumberId`), nunca o do payload; sem número, descarta com log. Envia `reply.text` a `contactRef` por esse número.
  4. Envio com sucesso: `messages.markSent(clientId, replyId, { channelMessageId, sentAt })`. Falha ao gravar a marca só gera log `error` (o contato já recebeu; relançar reenviaria).
- **Classificação de erro:** `ConflictError` (409, em andamento) e erros transitórios (rede, timeout, HTTP 5xx, 429 e os códigos de limite de taxa da Meta) → o job é retentado com backoff. Erros permanentes (token inválido/expirado, janela de 24 h fechada, destinatário inválido, `ForbiddenError`, `NotFoundError`) → sem retentativa (`UnrecoverableError`), log `error` com `clientId`, id da mensagem e código, e métrica.
- **Falha final nunca é silêncio:** se esgotaram as tentativas, ou o erro foi permanente, **antes de existir resposta gravada** (falha do service ou do banco), o worker tenta uma vez enviar o `ATTENDANCE_FALLBACK_TEXT` ao contato (melhor esforço; falhar aqui só gera log). Se a resposta já existe e é o **envio** que falha, nada é reenviado como fallback: a resposta fica gravada sem `sentAt`, visível na API administrativa.
- Job `notice`: envia o texto constante pelo mesmo caminho de envio (mesmas regras de erro e retentativa); não grava mensagem nem chama o LLM.

### Envio (`WhatsappCloudApiClient`, `src/infrastructure/external-apis/whatsapp/`)

- Porta em `application`: `MessageSender.sendText({ phoneNumberId, to, text }): Promise<Result<{ channelMessageId: string }, ExternalServiceError>>`; erro esperado volta como `Result`, nunca exceção.
- `POST {base}/{version}/{phoneNumberId}/messages` com `Authorization: Bearer <WHATSAPP_ACCESS_TOKEN>` e corpo `{ messaging_product: 'whatsapp', to, type: 'text', text: { body } }`, usando `fetch` nativo (sem dependência nova), com `AbortSignal.timeout(WHATSAPP_SEND_TIMEOUT_MS)`.
- O `ExternalServiceError` leva só o status HTTP, o `code` e o `type` do erro da Meta e se é retentável; **nunca** o corpo da requisição, o texto, o destinatário nem o token. A mensagem de erro da Meta (`message`) também não entra no log (pode citar o número).

### Dados (Prisma + migration aditiva, aplicada em `soprei` e `soprei_test`)

- `Client.whatsappPhoneNumberId`: texto opcional, `@unique`, 1 a 32 dígitos (`CHECK`), o `phone_number_id` da Meta (decisão 3). Resolução `ClientRepository.findByWhatsappPhoneNumberId(id)` (model global; é o **único** ponto do sistema que sai de um identificador externo para o cliente, por isso fica no repositório do cliente e é coberto por teste).
- `PATCH /admin/clients/:id` passa a aceitar `whatsappPhoneNumberId` (ou `null` para limpar); número já usado por outro cliente: 409; formato inválido: 400. Aparece nas respostas de `/admin/clients`.
- `Message.channelMessageId` (texto até 128, opcional) e `Message.sentAt` (timestamp opcional), só em respostas do assistente (`CHECK`). `MessageRepository.markSent(clientId, messageId, { channelMessageId, sentAt })` por `updateMany` com `clientId`, `id`, `role = ASSISTANT` e `sentAt` nulo no `where` (idempotente). `AttendanceReply` ganha `sentAt`.
- Pendência da 010 resolvida aqui, porque a fila torna a retomada rotineira: `MessageRepository.listBefore(clientId, conversationId, messageId, limit)` (consulta já "anterior a esta mensagem"), usada por `loadHistory` no lugar do filtro em memória sobre `listRecent(limit + 1)`.

### Métricas (registry da 004, sem `clientId`, telefone nem texto em label)

`webhook_requests_total{channel,result}` (`verification_ok`, `verification_failed`, `ok`, `invalid_signature`, `invalid_payload`, `enqueue_failed`); `channel_inbound_messages_total{channel,result}` (`enqueued`, `unknown_number`, `client_unavailable`, `unsupported_type`, `invalid_text`); `channel_send_total{channel,result}` (`ok`, `error`); `channel_send_duration_seconds{channel}`; `queue_jobs_total{queue,result}` (`completed`, `retried`, `failed`, `discarded`).

## Critérios de aceite

**Verificação e assinatura**
- [ ] `GET` com `hub.mode=subscribe` e token correto devolve 200 com o `hub.challenge` em `text/plain`; token errado, ausente ou `hub.mode` diferente → 403 sem eco do challenge.
- [ ] `POST` com assinatura válida é aceito; assinatura ausente, malformada, de tamanho errado ou calculada com outro segredo → 401 e **nada** é enfileirado nem gravado.
- [ ] A assinatura é conferida sobre os bytes crus: o mesmo JSON com espaços diferentes e a assinatura do original é rejeitado.
- [ ] Corpo acima de 1 MiB é recusado; com `WHATSAPP_ENABLED` ausente ou `false` as duas rotas respondem 404.
- [ ] Nenhum segredo (`WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`) nem a query string do `GET` aparece em log (captura de log, incluindo caso de erro).

**Entrada e roteamento**
- [ ] Mensagem de texto de número mapeado gera job `text` com `contactRef` = `from`, `externalId` = `wamid` e o `clientId` do cliente dono do número; a resposta HTTP é 200 sem esperar o LLM (teste com provider bloqueado em `hold()`).
- [ ] Lote com várias mensagens e vários números: cada uma vai para o cliente certo.
- [ ] Número desconhecido, cliente removido e cliente `SUSPENDED`: 200, nada enfileirado, métrica e log `warn`.
- [ ] Reentrega do mesmo evento (mesmo `wamid`) não gera segundo job nem segunda resposta.
- [ ] Mensagem não textual e texto inválido (vazio, > 4000, NUL) geram job `notice` e o contato recebe o texto constante; nada é gravado como mensagem nem chama o LLM.
- [ ] `statuses[]` não geram job; `failed` loga `warn` com id e código, sem telefone.
- [ ] Assinatura válida com JSON inválido ou formato inesperado → 200 + `invalid_payload`; Redis fora → 500, e a reentrega depois enfileira só o que faltou.

**Processamento e envio**
- [ ] De ponta a ponta (webhook assinado → fila real → worker → `MockLlmProvider` → servidor Graph falso local): o servidor falso recebe `POST /<versão>/<phone_number_id>/messages` com `Authorization: Bearer`, `to` = contato e o texto do mock; a conversa tem a mensagem do contato e a resposta, e a resposta fica com `sentAt` e `channelMessageId`.
- [ ] Retentativa depois de envio concluído (job reexecutado) não envia de novo (`sentAt` preenchido).
- [ ] Falha transitória do Graph (500, 429, timeout) é retentada com backoff e termina em sucesso, com uma só resposta gravada e um só envio bem-sucedido; falha permanente (código de token inválido, janela fechada) não é retentada, a resposta fica gravada sem `sentAt` e a métrica registra `error`.
- [ ] Erro do service antes de existir resposta (ex.: banco indisponível simulado) esgota as tentativas e o contato recebe o `ATTENDANCE_FALLBACK_TEXT`; se esse envio também falha, apenas logam.
- [ ] LLM com falha ou timeout continua resultando em fallback gravado e **enviado** (reaproveita os marcadores `[[mock:fail]]` e `[[mock:hang]]`).
- [ ] `ConflictError` por mensagem "em andamento" é retentado e, passado o prazo, completa o fluxo sem segunda chamada ao LLM para a mesma mensagem ainda viva.
- [ ] O número usado no envio é o do cliente no banco, não o do payload do job (teste com job adulterado).
- [ ] Encerramento do processo espera o job ativo e fecha o worker antes de Redis e banco.
- [ ] `loadHistory` devolve o histórico correto ao retomar uma mensagem antiga com 21 ou mais mensagens mais novas na conversa (`listBefore`).

**Isolamento entre clientes (o centro da spec)**
- [ ] Dois clientes com números diferentes e **o mesmo contato** escrevendo para os dois: conversas distintas, histórico enviado ao LLM sem mistura (inspeção do mock), persona de cada um só na sua conversa.
- [ ] Mensagens e respostas intercaladas dos dois clientes saem cada uma pelo `phone_number_id` do seu cliente (servidor Graph falso registra o par número/destinatário).
- [ ] O mesmo `wamid` não colide entre clientes (jobId e `externalId` são por cliente).
- [ ] `findByWhatsappPhoneNumberId` não devolve cliente removido; dois clientes não podem ter o mesmo `whatsappPhoneNumberId` (409 no PATCH e `@unique` no banco).
- [ ] `markSent` só altera mensagem do cliente informado (teste de isolamento no modelo de `message.repository.integration.test.ts`) e `listBefore` não enxerga outro cliente.
- [ ] Jobs de dois clientes processados em sequência mantêm cada um o seu `clientId` nos logs.

**Privacidade, observabilidade e geral**
- [ ] Texto de mensagem, `from`/`contactRef`, destinatário, nome de perfil, persona e tokens **não aparecem em nenhuma linha de log** nem em label de métrica (captura de log em webhook, worker, sucesso e falhas).
- [ ] As métricas acima aparecem em `/metrics` e as chaves do BullMQ nos testes usam prefixo único no Redis `/15`, sem `FLUSHALL`/`FLUSHDB` (cada teste remove só o que criou).
- [ ] Config: habilitado sem os três segredos falha no boot; `WHATSAPP_ENABLED=false` literal não habilita; a regra cruzada de backoff × `ATTENDANCE_IN_FLIGHT_TIMEOUT_MS` é validada.
- [ ] Migration aplicada em `soprei` e `soprei_test`; `typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes em Node 22 e 24; CI verde e revisão do `reviewer`.

## Teste manual com o número de teste da Meta (feito pelo dono, não é teste automatizado)

1. Expor a porta local com um túnel HTTPS (Cloudflare Tunnel ou ngrok) e subir o servidor com `WHATSAPP_ENABLED=true` e os três segredos no `.env`.
2. No app Meta, em WhatsApp > Configuração: callback `https://<túnel>/webhooks/whatsapp`, verify token igual ao `.env`, e assinar o campo `messages`.
3. Copiar o `phone_number_id` do número de teste e gravá-lo no cliente (`PATCH /admin/clients/:id`).
4. Cadastrar o seu telefone como destinatário permitido do número de teste (a Meta limita a poucos) e mandar uma mensagem. Esperado: resposta `[mock] ...` no WhatsApp e a conversa visível em `GET /admin/clients/:clientId/conversations`.

O token temporário do número de teste expira em cerca de 24 h; para uso mais longo, gerar o token permanente de um usuário do sistema.

## Casos de borda e erros

- **At-least-once:** se o processo cai depois de enviar e antes de `markSent`, a retentativa reenvia a resposta (um duplicado possível, nunca uma perda). Aceito e documentado; `sentAt` reduz a janela ao mínimo.
- **Janela de 24 h:** a resposta sai segundos depois da mensagem do contato, dentro da janela de atendimento. Retomada depois de uma queda longa pode cair fora dela: erro permanente, resposta fica sem `sentAt`.
- **Ordem entre mensagens rápidas do mesmo contato:** com concorrência 1 a ordem é a de chegada dos webhooks; a Meta pode entregar fora de ordem e isso não é corrigido aqui.
- **Dado pessoal no Redis:** o job guarda o texto do contato e o `contactRef` até ser concluído e pelo período configurado (`QUEUE_KEEP_*`). Entra na decisão de retenção e LGPD que precede dados reais.
- **Mensagens de clientes diferentes na mesma fila** esperam umas pelas outras (concorrência 1). Aceito nesta fase; ver decisão 2.
- **`from` ausente** (a Meta vem mudando o formato de identificação de contatos): a mensagem sem identificador de remetente utilizável é descartada com log e métrica, sem erro. O implementer confere o formato vigente na documentação.

## Isolamento entre clientes

O `ClientId` nasce da resolução `phone_number_id` → cliente (assinada pela Meta e conferida no banco), viaja no job e é passado explicitamente a todo repositório, como na 010. Garantias: (1) a resolução é um único método de repositório global, testado; (2) o envio usa o número que o **banco** associa ao `clientId`, não o do payload; (3) `jobId`, idempotência e histórico são por cliente; (4) a rota do webhook nunca aceita `clientId` de header, query ou corpo. Os testes da seção acima são o gabarito.

## Requisitos sobre a spec 005

A 005 (hoje um esboço) precisa, antes de aprovada, cobrir: (a) o perfil `webhook` com limite **folgado e configurável**, porque a Meta entrega rajadas e um 429 aqui significa retentativa dela e, em excesso, risco de desativar a assinatura; (b) chave por IP de origem para o webhook (o `clientId` só existe depois de interpretar o corpo, o que acontece depois da assinatura); (c) `GET` e `POST` do webhook sujeitos ao limite, e `/health` e `/metrics` fora dele; (d) `trustProxy` correto atrás do túnel/proxy. Se a 005 não puder ser feita antes, esta spec pode ser implementada com um limite mínimo provisório declarado, mas isso precisa de decisão explícita do dono.

## Fora de escopo

- Onboarding de vários clientes: Embedded Signup, token por cliente cifrado, tela de onboarding, assinatura de WABA por cliente (spec B; exige autenticação 007/008).
- Provedor real de LLM (spec própria); o `mock` continua.
- Mensagens iniciadas pela empresa e templates, mídia de entrada e saída (áudio, imagem, documento), mensagens interativas (botões, listas), indicador de digitando e confirmação de leitura, persistência de status de entrega, transferência para atendente humano.
- Fila por cliente, vários workers, concorrência maior com trava por contato.
- Base de conhecimento (RAG), painel, RLS, política de retenção e exclusão de dados pessoais, hospedagem e deploy (o webhook roda por túnel em desenvolvimento).
- Ordenação por `timestamp` da Meta e reordenação de eventos fora de ordem.

## Decisões (propostas; o dono decide)

1. **Fila.** (a) **BullMQ sobre o Redis [recomendado]**: durável (o evento sobrevive a queda do processo depois do 200), com retentativa, backoff e atraso prontos, e o Redis já é obrigatório. Dependência nova: `bullmq`. (b) Processar em memória no processo (fire-and-forget): zero dependência, mas uma queda depois do 200 perde a mensagem em silêncio, o que a regra "erro nunca vira silêncio" proíbe. (c) Tabela de saída no Postgres com varredura periódica: sem dependência, mas é uma fila escrita à mão com polling, contra "sem polling".
2. **Concorrência.** (a) **Um worker com concorrência 1 [recomendado]**: preserva a ordem por contato sem trava, e é suficiente para o número de teste e os primeiros clientes. (b) Concorrência maior com trava no Redis por `(clientId, contactRef)`: mais vazão e menos bloqueio entre clientes, ao custo de mais código e testes; entra quando a latência da fila medida pedir.
3. **Onde mora o mapeamento número → cliente.** (a) **Coluna `whatsappPhoneNumberId` em `Client` [recomendado]**: a menor coisa que funciona, um número por cliente, sem token por cliente. (b) Model próprio de canal já agora: prepara a spec B, mas ou vira model global com `clientId` (que a `tenant-scope` não permite consultar sem cliente) ou exige um repositório global novo; melhor decidir com o requisito real do Embedded Signup. A spec B pode migrar a coluna para o model dedicado.
4. **Credenciais.** (a) **Variáveis de ambiente únicas [recomendado]** nesta fase (um app Meta, um token). (b) Cifradas no banco por cliente: é a spec B.
5. **Mensagens não textuais e texto inválido.** (a) **Resposta constante educada [recomendado]**, por exemplo "No momento só consigo ler mensagens de texto." e "Não consegui entender sua mensagem. Envie um texto de até 4000 caracteres.", sem gravar nem chamar o LLM. (b) Ignorar em silêncio: contra a regra de nunca deixar o contato sem resposta.
6. **Falha final do atendimento.** (a) **Tentar enviar o fallback ao contato [recomendado]**. (b) Só registrar a falha: simples, mas o contato fica no vazio.
7. **Marca de envio na mensagem** (`sentAt`, `channelMessageId`; migration aditiva). (a) **Incluir [recomendado]**: evita reenviar a resposta em retentativa e prepara o casamento com eventos de status depois. (b) Não incluir: sem migration, mas a retentativa reenvia sempre que o job rodar de novo.
8. **Habilitação do canal.** (a) **Opt-in por `WHATSAPP_ENABLED` [recomendado]**: rota pública inexistente por padrão. (b) Sempre registrada, falhando só se faltar segredo.
9. **Habilitar a spec antes da 005?** (a) **Não: 005 primeiro [recomendado]**. (b) Seguir com limite provisório e declarado.
10. **Onde o webhook roda** (não bloqueia a spec). Em desenvolvimento, túnel. Para produção, informar se o servidor Hetzner e o domínio do protótipo ainda existem para reaproveitar; entra na spec de deploy.

## Decisões e dependências novas

- **Dependência nova: `bullmq`** (e o `ioredis` que ele usa, na versão compatível com a que o projeto já tem; o implementer verifica e documenta). Conexão própria para a fila e o worker (`maxRetriesPerRequest: null`), separada do client `ioredis` singleton do restante. HTTP de saída com `fetch` nativo: sem outra dependência.
- Migration aditiva (`Client.whatsappPhoneNumberId`, `Message.channelMessageId`, `Message.sentAt`) aplicada em `soprei` e `soprei_test`, com o mesmo limite da 003: sem `migrate reset`, sem `DROP`, sem apagar dado que o implementer não criou.
- Por ser o primeiro endpoint público, tocar em isolamento (resolução de cliente por identificador externo) e guardar segredos, esta spec passa pelo agente `reviewer` antes do merge, com atenção a: assinatura sobre o corpo cru e tempo constante, nenhum `clientId` vindo de fora, envio pelo número do banco, vazamento de dado pessoal em log ou métrica, e o comportamento com Redis ou Graph API fora do ar.
