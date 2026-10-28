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

### Webhook (`src/presentation/webhooks/`, pasta criada nesta spec; rotas finas)

- **`GET /webhooks/whatsapp`** (verificação): com `hub.mode=subscribe` e `hub.verify_token` igual a `WHATSAPP_VERIFY_TOKEN` (comparação em tempo constante), responde 200 `text/plain` com o `hub.challenge` e nada mais; caso contrário 403. O `hub.verify_token` vem na URL: nenhum log pode conter a query string.
- **`POST /webhooks/whatsapp`** (eventos):
  1. Rate limit com o perfil `webhook` da 005, antes de qualquer trabalho.
  2. Corpo lido **cru** (Buffer; parser de `application/json` encapsulado só neste plugin) e limitado a 3 MiB (a Meta documenta payloads de até 3 MB; começou em 1 MiB e subiu na revisão).
  3. Valida `X-Hub-Signature-256` (`sha256=<hex>` = HMAC-SHA256 do corpo cru com `WHATSAPP_APP_SECRET`), em tempo constante e checando o tamanho antes. Cabeçalho ausente, malformado ou errado: **401**, sem processar nada.
  4. Só depois da assinatura o corpo é interpretado, com um schema Zod **tolerante** (ignora campos desconhecidos): usa `entry[].changes[].value` com `metadata.phone_number_id`, `messages[]` (`id`, `from`, `type`, `text.body`) e `statuses[]`. Nada do que não é usado é lido ou guardado (nome de perfil, por exemplo).
  5. Para cada mensagem de entrada: resolve o cliente pelo `phone_number_id` (ver "Dados"); número desconhecido, cliente removido ou `SUSPENDED` → descarta com log e métrica (sem processar).
  6. Texto válido (1 a 4000 caracteres, sem NUL, não vazio depois de `trim`): enfileira um job `text`. Tipo de **conteúdo do contato** que não lemos (`audio`, `image`, `video`, `document`, `sticker`, `location`, `contacts`) ou texto inválido: enfileira um job `notice` com um texto constante educado (ver decisão 5). Nunca silêncio para o que é mensagem do contato. `reaction`, `system`, `unsupported` e qualquer outro tipo (ou desconhecido) **não** são mensagem para atender: descartados sem aviso, com log `info` e a métrica `ignored_type` (ajuste da revisão; ver o registro).
  7. Responde **200** em seguida, sem chamar LLM nem o Graph API no fluxo síncrono. Eventos `statuses[]` não geram resposta: só métrica e, para `failed`, log `warn` com o id da mensagem e o código de erro.
- **Falha ao enfileirar** (Redis fora) → **500**, para a Meta retentar (ela reenvia por dias). O que já foi enfileirado no mesmo lote não duplica: o id do job é determinístico.
- **Depois de assinatura válida**, corpo que não é JSON ou que não bate com o schema → **200** com log `warn` e métrica `invalid_payload` (um 4xx faria a Meta retentar sem chance de sucesso e, com falhas repetidas, ela pode desativar a assinatura).
- Mapeamento: `contactRef` = `from` (o `wa_id` do contato, tal como veio), `externalId` = `messages[].id` (o `wamid`). O `timestamp` da Meta **não** ordena nada: a ordem é a de chegada (limitação conhecida).

### Fila e processamento em segundo plano

- **BullMQ sobre o Redis existente** (decisão 1). Fila `channel-inbound`, `src/infrastructure/queue/`; o código de `application` e `presentation` conhece só uma porta (`InboundJobQueue.enqueue`, em `src/application/ports/`), nunca o BullMQ.
- Job: `{ kind: 'text', clientId, phoneNumberId, contactRef, text, externalId, requestId }` ou `{ kind: 'notice', clientId, phoneNumberId, contactRef, externalId, reason, requestId }` (o `phoneNumberId` é o do negócio que recebeu a mensagem, só para conferência: o envio usa o número do banco). O `jobId` é `<clientId>_<externalId>` (sem `:`; o implementer confirma as restrições de id da versão do BullMQ), o que dá dedupe de reentregas da Meta. A idempotência definitiva continua sendo a do banco (`externalId`).
- O `requestId` do webhook acompanha o job: o worker roda dentro de `runWithContext` com esse `requestId` e `setClientId(clientId)`, então log do webhook e log do atendimento se correlacionam e todo log do worker leva `clientId`.
- O worker roda **no mesmo processo** da API, com **concorrência 1** (decisão 2), e é encerrado de forma graciosa no `shutdown` (espera o job ativo, antes de fechar Redis e banco).
- **Processamento de um job `text`** (`ChannelInboundProcessor`, em `src/application/`, em subpasta de área própria criada nesta spec, sobre portas):
  1. `attendance.handleInboundMessage(clientId, { contactRef, text, externalId })`.
  2. Se a resposta já tem `sentAt` (retentativa depois de envio concluído), termina sem enviar de novo.
  3. Resolve o número do cliente **no banco, pelo `clientId` do job** (`Client.whatsappPhoneNumberId`), nunca o do payload; sem número, descarta com log. Envia `reply.text` a `contactRef` por esse número.
  4. Envio com sucesso: `messages.markSent(clientId, replyId, { channelMessageId, sentAt })`. Falha ao gravar a marca só gera log `error` (o contato já recebeu; relançar reenviaria).
- **Classificação de erro:** `ConflictError` (409, em andamento) e erros transitórios (rede, timeout, HTTP 5xx, 429 e os códigos de limite de taxa da Meta) → o job é retentado com backoff. Erros permanentes (token inválido/expirado, janela de 24 h fechada, destinatário inválido, `ForbiddenError`, `NotFoundError`) → sem retentativa (`UnrecoverableError`), log `error` com `clientId`, id da mensagem e código, e métrica.
- **Falha final nunca é silêncio:** se esgotaram as tentativas, ou o erro foi permanente, **antes de existir resposta gravada** (falha do service ou do banco), o worker tenta uma vez enviar o `ATTENDANCE_FALLBACK_TEXT` ao contato (melhor esforço; falhar aqui só gera log). **Exceção (decisão do dono, 2026-10-28): cliente suspenso não recebe nada**, nem o texto padrão nem o `notice`; o job é descartado com log `warn` e a métrica `discarded`. Se a resposta já existe e é o **envio** que falha, nada é reenviado como fallback: a resposta fica gravada sem `sentAt`, visível na API administrativa.
- Job `notice`: envia o texto constante pelo mesmo caminho de envio (mesmas regras de erro e retentativa); não grava mensagem nem chama o LLM.

### Envio (`WhatsappCloudApiClient`, `src/infrastructure/external-apis/whatsapp/`)

- Porta em `src/application/ports/`: `MessageSender.sendText({ phoneNumberId, to, text }): Promise<Result<{ channelMessageId: string }, ExternalServiceError>>`; erro esperado volta como `Result`, nunca exceção.
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
- [x] `GET` com `hub.mode=subscribe` e token correto devolve 200 com o `hub.challenge` em `text/plain`; token errado, ausente ou `hub.mode` diferente → 403 sem eco do challenge.
- [x] `POST` com assinatura válida é aceito; assinatura ausente, malformada, de tamanho errado ou calculada com outro segredo → 401 e **nada** é enfileirado nem gravado.
- [x] A assinatura é conferida sobre os bytes crus: o mesmo JSON com espaços diferentes e a assinatura do original é rejeitado.
- [x] Corpo acima de 3 MiB é recusado; com `WHATSAPP_ENABLED` ausente ou `false` as duas rotas respondem 404.
- [x] Nenhum segredo (`WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`) nem a query string do `GET` aparece em log (captura de log, incluindo caso de erro).

**Entrada e roteamento**
- [x] Mensagem de texto de número mapeado gera job `text` com `contactRef` = `from`, `externalId` = `wamid` e o `clientId` do cliente dono do número; a resposta HTTP é 200 sem esperar o LLM (teste com provider bloqueado em `hold()`).
- [x] Lote com várias mensagens e vários números: cada uma vai para o cliente certo.
- [x] Número desconhecido, cliente removido e cliente `SUSPENDED`: 200, nada enfileirado, métrica e log `warn`.
- [x] Cliente suspenso entre o enfileiramento e o processamento: o job é descartado sem enviar nada ao contato (nem resposta, nem `notice`, nem texto padrão), com log `warn` e a métrica `discarded` (decisão do dono, 2026-10-28).
- [x] Reentrega do mesmo evento (mesmo `wamid`) não gera segundo job nem segunda resposta.
- [x] Mensagem de áudio, imagem etc. e texto inválido (vazio, > 4000, NUL) geram job `notice` e o contato recebe o texto constante; nada é gravado como mensagem nem chama o LLM.
- [x] `statuses[]` não geram job; `failed` loga `warn` com id e código, sem telefone.
- [x] Assinatura válida com JSON inválido ou formato inesperado → 200 + `invalid_payload`; Redis fora → 500, e a reentrega depois enfileira só o que faltou.

**Processamento e envio**
- [x] De ponta a ponta (webhook assinado → fila real → worker → `MockLlmProvider` → servidor Graph falso local): o servidor falso recebe `POST /<versão>/<phone_number_id>/messages` com `Authorization: Bearer`, `to` = contato e o texto do mock; a conversa tem a mensagem do contato e a resposta, e a resposta fica com `sentAt` e `channelMessageId`.
- [x] Retentativa depois de envio concluído (job reexecutado) não envia de novo (`sentAt` preenchido).
- [x] Falha transitória do Graph (500, 429, timeout) é retentada com backoff e termina em sucesso, com uma só resposta gravada e um só envio bem-sucedido; falha permanente (código de token inválido, janela fechada) não é retentada, a resposta fica gravada sem `sentAt` e a métrica registra `error`.
- [x] Erro do service antes de existir resposta (ex.: banco indisponível simulado) esgota as tentativas e o contato recebe o `ATTENDANCE_FALLBACK_TEXT`; se esse envio também falha, apenas logam.
- [x] LLM com falha ou timeout continua resultando em fallback gravado e **enviado** (reaproveita os marcadores `[[mock:fail]]` e `[[mock:hang]]`).
- [x] `ConflictError` por mensagem "em andamento" é retentado e, passado o prazo, completa o fluxo sem segunda chamada ao LLM para a mesma mensagem ainda viva.
- [x] O número usado no envio é o do cliente no banco, não o do payload do job (teste com job adulterado).
- [x] Encerramento do processo espera o job ativo e fecha o worker antes de Redis e banco.
- [x] `loadHistory` devolve o histórico correto ao retomar uma mensagem antiga com 21 ou mais mensagens mais novas na conversa (`listBefore`).

**Isolamento entre clientes (o centro da spec)**
- [x] Dois clientes com números diferentes e **o mesmo contato** escrevendo para os dois: conversas distintas, histórico enviado ao LLM sem mistura (inspeção do mock), persona de cada um só na sua conversa.
- [x] Mensagens e respostas intercaladas dos dois clientes saem cada uma pelo `phone_number_id` do seu cliente (servidor Graph falso registra o par número/destinatário).
- [x] O mesmo `wamid` não colide entre clientes (jobId e `externalId` são por cliente).
- [x] `findByWhatsappPhoneNumberId` não devolve cliente removido; dois clientes não podem ter o mesmo `whatsappPhoneNumberId` (409 no PATCH e `@unique` no banco).
- [x] `markSent` só altera mensagem do cliente informado (teste de isolamento no modelo de `src/infrastructure/database/repositories/message.repository.integration.test.ts`) e `listBefore` não enxerga outro cliente.
- [x] Jobs de dois clientes processados em sequência mantêm cada um o seu `clientId` nos logs.

**Privacidade, observabilidade e geral**
- [x] Texto de mensagem, `from`/`contactRef`, destinatário, nome de perfil, persona e tokens **não aparecem em nenhuma linha de log** nem em label de métrica (captura de log em webhook, worker, sucesso e falhas).
- [x] As métricas acima aparecem em `/metrics` e as chaves do BullMQ nos testes usam prefixo único no Redis `/15`, sem `FLUSHALL`/`FLUSHDB` (cada teste remove só o que criou).
- [x] Config: habilitado sem os três segredos, ou sem `TRUST_PROXY` definido explicitamente, falha no boot; `WHATSAPP_ENABLED=false` literal não habilita; a regra cruzada de backoff × `ATTENDANCE_IN_FLIGHT_TIMEOUT_MS` é validada.
- [ ] Migration aplicada em `soprei` e `soprei_test` (feito); `typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes em Node 22 e 24 (feito localmente, ver o registro); CI verde e revisão do `reviewer` (pendentes: dependem do PR).

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
- **Dado pessoal no Redis:** o job guarda o texto do contato e o `contactRef` até ser concluído e, depois, por **pelo menos** `QUEUE_KEEP_*` (retenção mínima, não TTL). O BullMQ só remove por idade quando outro job termina e as chaves não têm TTL: sem tráfego, o último job (texto e `contactRef`) pode ficar no Redis **indefinidamente**.
- **Pendência explícita (antes de dados reais):** adicionar limpeza periódica (`queue.clean`) ou TTL nas chaves da fila, junto com a política de retenção e exclusão (LGPD). Não implementado nesta spec.
- **Mensagens de clientes diferentes na mesma fila** esperam umas pelas outras (concorrência 1). Aceito nesta fase; ver decisão 2.
- **`from` ausente** (a Meta vem mudando o formato de identificação de contatos): a mensagem sem identificador de remetente utilizável é descartada com log e métrica, sem erro. O implementer confere o formato vigente na documentação.

## Isolamento entre clientes

O `ClientId` nasce da resolução `phone_number_id` → cliente (assinada pela Meta e conferida no banco), viaja no job e é passado explicitamente a todo repositório, como na 010. Garantias: (1) a resolução é um único método de repositório global, testado; (2) o envio usa o número que o **banco** associa ao `clientId`, não o do payload; (3) `jobId`, idempotência e histórico são por cliente; (4) a rota do webhook nunca aceita `clientId` de header, query ou corpo. Os testes da seção acima são o gabarito.

## Requisitos sobre a spec 005

A 005 (aprovada e implementada em 2026-10-27) já cobre o que segue; a lista fica como registro do que esta spec assume: (a) o perfil `webhook` com limite **folgado e configurável**, porque a Meta entrega rajadas e um 429 aqui significa retentativa dela e, em excesso, risco de desativar a assinatura; (b) chave por IP de origem para o webhook (o `clientId` só existe depois de interpretar o corpo, o que acontece depois da assinatura); (c) `GET` e `POST` do webhook sujeitos ao limite, e `/health` e `/metrics` fora dele; (d) `trustProxy` correto atrás do túnel/proxy: `TRUST_PROXY` aceita só `false`, `true` (nunca em produção) ou lista de IPs/CIDRs (túnel local: `127.0.0.1,::1`); **não existe inteiro** (o Fastify 5.12.7 o trata como fail-closed). Com `WHATSAPP_ENABLED=true`, `TRUST_PROXY` precisa estar **definido explicitamente** na config (mesmo que `false`), porque o valor padrão atrás de um túnel faria a Meta e qualquer atacante dividirem a cota do perfil `webhook`; o boot registra qual modo está ativo (sem IP). O implementer confirma, ao testar com o túnel, que ele acrescenta ao `X-Forwarded-For` em vez de repassar o cabeçalho do cliente. Se a 005 não puder ser feita antes, esta spec pode ser implementada com um limite mínimo provisório declarado, mas isso precisa de decisão explícita do dono.

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

### Registro da implementação (2026-10-28)

Implementada na branch `spec/011-canal-whatsapp`, com commits por parte (dependência, config, banco, métricas, envio, entrada e processador, fila, webhook, ligação no boot, testes, docs). **Status mantido em `aprovada`**: a conclusão fica para depois do `reviewer`, do CI e do teste manual do dono. Nada foi enviado à Meta real: os testes usam só o servidor Graph falso local.

**Pastas e arquivos (convenções da 012):**

| Pasta | O que há |
| --- | --- |
| `src/application/ports/` | `message-sender.ts` (`MessageSender`, `MessageSendError`), `inbound-job-queue.ts` (`InboundJobQueue`, schema do job, `inboundJobId`, `NonRetryableJobError`) |
| `src/application/channel/` (nova) | `channel-intake.service.ts`, `channel-inbound.processor.ts`, `channel-texts.ts`, `describe-error.ts` (+ testes) |
| `src/presentation/webhooks/` (nova) | `whatsapp-webhook.controller.ts`, `whatsapp-webhook.schemas.ts`, `whatsapp-signature.ts` (+ testes) |
| `src/infrastructure/queue/` (nova) | `inbound-queue.ts` (BullMQ), teste de integração |
| `src/infrastructure/external-apis/whatsapp/` (nova) | `whatsapp-cloud-api.client.ts` (+ teste) |
| `src/infrastructure/config/` | `whatsapp.ts` (`whatsappChannelConfig`, `queueSettings`, `trustProxyMode`), schema e `parse-config.ts` ampliados |
| `src/infrastructure/http/` | `server.ts` (`whatsapp?`), `whatsapp-channel.integration.test.ts` (ponta a ponta) |
| `src/test-support/` | `fake-graph-api.ts`, `whatsapp-payloads.ts` |
| `prisma/` | migration `20261027180000_whatsapp_channel` |

Sem barrels novos e sem aliases. `application` e `presentation` não importam `infrastructure/database` nem o BullMQ (o lint segue verde).

**Dependência (`bullmq`):** a última versão publicada é a 6.5.0 (de 2026-10-26, com um dia de idade). O pnpm tentou liberar essa versão com `minimumReleaseAgeExclude`, o que contorna a política de idade mínima do projeto; **desfiz** e fixei a mais nova que passa na política, `bullmq ^6.4.2` (resolvida em 6.4.2). O `ioredis` é dependência de par **opcional** do BullMQ (`>=5`): o `ioredis` 6.0.0 do projeto é o único em uso, sem cópia própria; compatível com o Redis 8.0.1 local (as suítes rodam nele). O script de build do acelerador nativo opcional `msgpackr-extract` ficou desligado em `pnpm-workspace.yaml` (`false`; cai no JavaScript puro). Restrições de `jobId` conferidas no código instalado: não pode conter `:` nem ser um inteiro puro; o id é `<clientId>_<encodeURIComponent(externalId)>`, o que também evita colisão entre `a:b` e `a%3Ab`.

**Fontes da documentação da Meta consultadas (2026-10-28):**

- Exemplos de payload do webhook (mensagem de texto): `developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples`.
- Referência de `statuses[]` (`failed`, `errors[]`): `developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages/status`.
- Envio de mensagens (`POST /{versão}/{phone-number-id}/messages`, corpo e resposta com `messages[].id`): `developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages`.
- Códigos de erro e formato do erro (`error.code`, `type`): `developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes`.
- Webhooks (verificação `hub.mode`/`hub.challenge`/`hub.verify_token` e `X-Hub-Signature-256`): `developers.facebook.com/docs/graph-api/webhooks/getting-started`.
- Identificadores por negócio (BSUID, `from_user_id`, `contacts[].user_id`): `developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids`.
- Versões do Graph API: `developers.facebook.com/docs/graph-api/changelog/versions` (última: **v26.0**, de 2026-07-29, sem data de expiração; a v25.0 expira em 2028-07-29). **`WHATSAPP_GRAPH_API_VERSION` padrão: `v26.0`**, a versão dos exemplos da própria documentação de envio.

O que a documentação confirmou: o webhook leva `entry[].changes[].value.metadata.phone_number_id`, `messages[]` (`id`, `from`, `type`, `text.body`) e `statuses[]` (`id`, `status` entre `sent`, `delivered`, `read`, `played` e `failed`, `errors[]` com `code`); a resposta do envio leva `messages[].id`; o erro do Graph vem em `error.code` e `error.type`; a assinatura é `sha256=` mais o HMAC com o segredo do app (a página não detalha o HMAC nem os bytes crus: HMAC-SHA256 sobre os bytes do corpo é o que a spec e a prática da Meta usam, e os testes calculam a assinatura assim).

**`from` ausente (identificadores por negócio):** a documentação atual diz que `messages[].from` (e `contacts[].wa_id`) só vêm quando o telefone pode ser informado; sempre vêm `from_user_id` e `contacts[].user_id` (o BSUID, ex.: `US.13491208655302741918`), e responder a esse contato exigiria o campo `recipient` no lugar de `to` no envio (a página cita limitações até julho de 2026). **Decisão desta spec, conforme o texto dela:** mensagem sem `from` utilizável (ausente, fora de 1 a 32 dígitos) é **descartada** com log `warn` e a métrica `channel_inbound_messages_total{result="missing_sender"}`, sem erro. **Risco:** contato que adotou nome de usuário e não compartilha o telefone não recebe resposta. Suporte a BSUID (`contactRef` e envio por `recipient`) fica para spec própria.

**Decisões e desvios (o dono pode contestar qualquer um):**

- **`wamid` nunca vai cru a log.** O `wamid` carrega o telefone do contato em base64; logar "o id da mensagem" (spec) vazaria o `from`. Os logs levam `messageRef` (16 primeiros caracteres hexadecimais do SHA-256 do id; `src/shared/utils/message-ref.ts`), mais `clientId`, ids internos (`replyId`), `jobKind`, status HTTP e códigos. Vale para o log `warn` de `statuses[].failed` (referência e código). O `jobId` no Redis ainda contém o `wamid` (exigido pela spec).
- **`phone_number_id` do negócio vai ao log `warn` de "número sem cliente"**, para diagnosticar um cliente sem número gravado; não é dado do contato.
- **Cliente removido libera o número:** `delete` (soft delete) grava `whatsappPhoneNumberId = null`, senão o `@unique` prenderia o número a um cliente que não recebe mais nada; `findByWhatsappPhoneNumberId` também filtra `deletedAt` (testado com o soft delete "à mão" que não libera o número).
- **Config:** a regra cruzada de backoff só vale com o canal habilitado (as variáveis da fila são irrelevantes sem ele); "`TRUST_PROXY` definido explicitamente" é conferido em `parseConfig` (o schema já perdeu a diferença entre ausente e `false`); `WHATSAPP_API_BASE_URL` precisa ser `https` em produção e não aceita usuário, senha, query nem fragmento; `WHATSAPP_VERIFY_TOKEN` com mínimo de 16 caracteres; os segredos ganharam entradas no `redact` do logger (`appSecret`, `verifyToken`, `WHATSAPP_*`).
- **Webhook:** o `hub.challenge` só é ecoado se casar com `^[A-Za-z0-9._~-]{1,256}$` (a Meta manda um inteiro; nada que vire marcação); `content-type` que não é JSON cai no parser padrão do Fastify (texto), o corpo não é `Buffer` e a resposta é **401** sem processar nada (não 415); o webhook ignora outro `object` da Meta e outros `field` além de `messages`; um `value` ou mensagem malformado é ignorado e o resto do lote é aproveitado (a requisição conta `invalid_payload`); falha do **banco** ao resolver o cliente também vira 500 (a Meta reentrega), contada como `enqueue_failed`.
- **Fila:** o schema do job descarta campos desconhecidos (não é `strict`): um job adulterado com `phoneNumberId` no payload é processado com o número do banco (teste). O dedupe por `jobId` dura enquanto o job é retido (`QUEUE_KEEP_*`); depois, a idempotência do banco (`externalId`) e o `sentAt` seguram duplicatas. O `enqueue` tem prazo de 5 s; o `close()` espera o job ativo até 30 s (e, sem conexão pronta, no máximo 2 s e com fechamento forçado, porque o BullMQ memoriza o `close()` e um segundo `close(true)` não adianta; achado quando o Redis fora travava o encerramento).
- **Falha permanente do atendimento** (`NotFoundError`, `ValidationError`/`ZodError`): além de não retentar, segue a spec e tenta o texto padrão (se o cliente foi removido não há número e só loga). **Cliente suspenso (`ForbiddenError`) é exceção, por decisão do dono em 2026-10-28:** nada é enviado (ver abaixo).
- **Métricas acrescentadas à lista da spec:** `channel_status_events_total{channel,status}` ("só métrica" para `statuses[]`) e, em `channel_inbound_messages_total`, os resultados `missing_sender` e `invalid_message`. `unsupported_type` e `invalid_text` contam quando o aviso é enfileirado (no lugar de `enqueued`).
- **`AttendanceReply` tem `sentAt`**, então a resposta de `POST /admin/clients/:clientId/messages` ganhou `reply.sentAt` (nulo no simulador).
- **Ligação no boot:** o worker liga em `src/index.ts` depois da verificação de infraestrutura e antes de `listen`; `closeInfrastructure` fecha a fila **antes** do banco e dos Redis (teste unitário da ordem e teste de integração com um job ativo).
- **Migration:** aplicada com `prisma migrate deploy` em `soprei_test` e em `soprei`; `prisma migrate diff --from-config-datasource --to-schema` não acusa diferença nos dois; nenhum `reset`, `DROP` nem dado alheio tocado. O `prisma format` realinhou colunas de `Client` e `Message` no `schema.prisma` (ruído só de formatação).
- **`to` do envio:** vai o `from` como veio (o `wa_id`, só dígitos). A documentação de envio cita o `+` na frente; o `wa_id` é o identificador que a própria resposta do Graph devolve. **A confirmar no teste manual com o número de teste**; se a Meta exigir o `+`, é um ajuste de uma linha no cliente.

**Critérios:** todos marcados `[x]` têm teste passando (unitário, integração ou ambos, ver abaixo), exceto o último (CI verde e revisão do `reviewer`), que depende do PR; a parte local dele (typecheck, lint, format, testes em Node 22 e 24) está verde.

**Validação local (2026-10-28):**

| Comando | Node 22.23.2 | Node 24.18.0 |
| --- | --- | --- |
| `pnpm db:generate` | ok | (mesmo client gerado) |
| `pnpm typecheck` | verde | verde |
| `pnpm lint` | verde | verde |
| `pnpm format:check` | verde | verde |
| `pnpm test` | 565 testes, 565 ok | 565 testes, 565 ok |
| `pnpm test:integration` | 200 testes, 200 ok | 200 testes, 200 ok |
| `rm -rf dist && pnpm build` | ok (`dist/` com `application/channel`, `presentation/webhooks`, `infrastructure/queue`) | |

Antes da 011 eram 466 unitários e 148 de integração (spec 012). Repetição das suítes novas (unitárias: canal, webhook, cliente do Graph, lifecycle, config, atendimento; integração: fila, ponta a ponta do canal, repositórios de mensagem e cliente, `/admin/clients`): 4 rodadas no Node 22 e 2 no Node 24, todas verdes no fim. A repetição achou **um flake**, corrigido em `53d2bfd`: o teste do `GET` procurava o `hub.challenge` (`777`) no corpo do erro, que carrega um `requestId` UUID aleatório e podia conter a sequência (falhou 3 vezes em cerca de 10 rodadas antes da correção; depois dela, 12 de 12 rodadas do arquivo e todas as seguintes verdes). O teste de encerramento do processo e o de Redis fora também revelaram, na primeira rodada, um defeito real do `close()` da fila (ver "Fila" acima), já corrigido.

**Smoke do processo compilado** (`node dist/index.js`, diretório vazio sem `.env`, `NODE_ENV=production`, segredos e token **falsos**, banco e Redis de **testes**, sem chamar a Meta): com `WHATSAPP_ENABLED=true` e `TRUST_PROXY=false` o processo sobe e responde `GET /health` 200; `GET /webhooks/whatsapp` com o token certo devolve 200 `text/plain` com o challenge e com token errado 403 sem eco; `POST` sem assinatura e com assinatura errada, 401; `POST` assinado com corpo sem eventos, 200; nenhum segredo nem query string na saída do processo; o boot loga o canal e o modo do `TRUST_PROXY` (`off`), sem IP. Com `WHATSAPP_ENABLED=false` as duas rotas dão 404. Habilitado sem `TRUST_PROXY`, sai com código 1 citando `TRUST_PROXY`. Habilitado com o Redis inalcançável, sai com código 1 sem travar. O envio de `SIGTERM` pelo Node no Windows encerra o processo na hora (não há sinal POSIX), então o encerramento gracioso **não** foi exercitado por esse caminho; ele é coberto pelos testes (`lifecycle.test.ts` e o teste de integração que encerra com um job ativo). As chaves que o smoke criou no Redis `/15` (`soprei:queue:channel-inbound:*`) foram removidas.

**Pendente ou incerto:** CI e `reviewer` (esta spec exige, ver "Decisões e dependências novas"); teste manual com o número de teste da Meta (o `to` com ou sem `+`; o túnel acrescentar ao `X-Forwarded-For`); suporte a contatos só com BSUID; retenção do texto e do `contactRef` nos jobs do Redis (LGPD, antes de dados reais); ordem entre mensagens rápidas do mesmo contato segue a de chegada dos webhooks (limitação já declarada).

### Ajustes da revisão do `reviewer` (2026-10-28)

Aplicados em commits novos, depois da revisão (sem bloqueantes). O que mudou em relação ao texto aprovado, com a justificativa:

- **Tipos de mensagem (desvio da spec, que dizia "não textual -> aviso"):** só `audio`, `image`, `video`, `document`, `sticker`, `location` e `contacts` recebem o aviso. `reaction`, `system`, `unsupported` e qualquer outro tipo, inclusive desconhecido, são descartados sem aviso, sem job e sem resposta, com log `info` só com `messageRef` e a métrica `channel_inbound_messages_total{result="ignored_type"}`. Justificativa: reação e evento `system` não são mensagem do contato; responder "só leio texto" a uma reação seria ruído e spam. Testes: unitários (intake e webhook) e de ponta a ponta (reação e `system` não geram job nem envio; áudio e imagem seguem gerando o aviso).
- **Retenção no Redis (documentação corrigida em `.env.example`, `CLAUDE.md` e "Casos de borda"):** `QUEUE_KEEP_COMPLETED_SECONDS` e `QUEUE_KEEP_FAILED_SECONDS` são retenção **mínima**, não TTL. O BullMQ só limpa por idade quando outro job termina e as chaves não expiram, então o último job (texto e `contactRef`) pode ficar no Redis indefinidamente sem tráfego. **Pendência explícita:** limpeza periódica (`queue.clean`) ou TTL, junto com a política de retenção e a LGPD, antes de dados reais. Não implementado.
- **Número do negócio no job (defesa em profundidade):** o job grava o `phoneNumberId` que recebeu a mensagem. No processamento, se o número atual do cliente no banco for diferente, o job é descartado sem enviar (`NonRetryableJobError`, log `error` sem números nem conteúdo, contado em `queue_jobs_total{result="failed"}`). O envio continua usando o número lido do banco, nunca o do payload; vale também para o texto padrão. Testes: número trocado entre enfileirar e processar não envia; job adulterado (campos extras ou `phoneNumberId` de outro cliente) não escolhe o número.
- **Falha de job fora do handler:** `worker.on('failed')` cobre o que não passou pelo handler (ex.: job parado além do limite depois de uma queda): log `error` só com `jobKind` e tentativas (sem id do job, que carrega o `wamid`, e sem o erro inteiro), `queue_jobs_total{result="failed"}` e um gancho que faz o processador tentar o texto padrão ao contato **só se ainda não houver resposta gravada** (se há, nada é enviado). `worker.on('stalled')` loga e conta uma retentativa. Falha já tratada no handler não é contada duas vezes (teste: job que esgota as tentativas conta `failed` uma vez). **Limitação:** se a tentativa que parou chegou a enviar a resposta sem gravar a marca (`sentAt`) e sem gravar a resposta, o contato pode receber o texto padrão além dela; só a tentativa de envio é at-least-once, nunca silenciosa. Testado com um job parado de verdade (um worker que o pegou e perdeu o lock).
- **Lint:** `bullmq` e `ioredis` são proibidos em `src/application/**` e `src/presentation/**` (`no-restricted-imports` em `eslint.config.js`, com teste em `src/eslint-rules.test.ts` que roda o ESLint de verdade).
- **Config:** `WHATSAPP_APP_SECRET` e `WHATSAPP_ACCESS_TOKEN` exigem no mínimo 16 caracteres quando o canal está habilitado (como o verify token); a mensagem nomeia a variável e nunca ecoa o valor. Os valores de teste e os placeholders atendem.
- **Limite do corpo do webhook: 3 MiB.** Confirmado na documentação oficial da Meta: "Webhook payloads can be up to 3 MB." (`developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview`, consultada em 2026-10-28; a mesma página diz que a Meta retenta por até 7 dias quando a resposta não é 200, por isso recusar um payload legítimo seria caro). `WEBHOOK_BODY_LIMIT_BYTES = 3 * 1024 * 1024`; testes de limite e do 413 atualizados.
- **Resposta do Graph com teto:** o cliente lê o corpo em pedaços, para em 64 KiB e cancela a conexão (mantendo o prazo). Corpo sem fim em 2xx vira resposta inválida não retentável (o envio pode ter acontecido); em erro HTTP o status decide. Teste com um servidor falso que despeja corpo até o cliente fechar.
- **Cliente `SUSPENDED` não recebe nada (decisão do dono em 2026-10-28, substitui a nota "aguarda decisão"):** quando o cliente é suspenso entre o enfileiramento e o processamento, o worker descarta o job **sem enviar nada ao contato**: nem a resposta, nem o `notice` (tipo não suportado ou texto inválido), nem o texto padrão de falha, também no caminho de falha final (`handleUnprocessedFailure`). Fica um log `warn` com `clientId` e `messageRef` (sem conteúdo nem telefone) e o job conta no resultado `discarded` que já existia em `queue_jobs_total` (o handler devolve `discarded`; nenhum label novo). A busca do número de envio agora checa o status do cliente antes de qualquer envio. É coerente com o intake, que já descartava mensagem de cliente suspenso. Cliente removido segue sem envio (erro permanente) e as demais falhas permanentes mantêm o texto padrão. Testes: unitários do processador (texto, aviso, retentativa depois da suspensão, falha sem handler, cliente removido e ativo inalterados) e de ponta a ponta com o servidor Graph falso (zero requisições ao Graph, sem texto nem contato em log, métrica `discarded`). Os achados 7, 10, 11 e 13 da revisão não foram tratados aqui.

**Validação local depois dos ajustes (2026-10-28):** `typecheck`, `lint` e `format:check` verdes em Node 22.23.2 e 24.18.0; `pnpm test`: **580 testes, 580 ok** nos dois Node (antes dos ajustes: 565); `pnpm test:integration`: **203 testes, 203 ok** nos dois (antes: 200); `rm -rf dist && pnpm build` ok. Suítes novas e alteradas repetidas 4 vezes no Node 22 e 2 no Node 24 (273 unitários e 91 de integração por rodada), todas verdes. O smoke do processo compilado (valores falsos, banco e Redis de teste) repetiu os mesmos resultados da primeira rodada; o único item "FAIL" é o `SIGTERM` no Windows (o Node mata o processo na hora, sem desligamento gracioso por esse caminho), coberto pelos testes de lifecycle. As chaves do smoke no Redis `/15` foram removidas.
