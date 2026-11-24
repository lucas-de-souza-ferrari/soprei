# 039 — Conexão do WhatsApp por coexistência (o cliente continua usando o aplicativo WhatsApp Business no celular)

- **Status:** concluída (na `main`; testada pelo dono com o número real em 2026-11-12; status normalizado em 2026-11-23, spec 042). Antes: aprovada pelo dono em 2026-11-12, com D1 a D9 como recomendadas ("Aprovo todas"). **E0 feito em 2026-11-12** (ver "Registro do E0"; critério para seguir atendido). **E1 a E4 implementadas em 2026-11-12** (ver "Registro da implementação"); falta o CI, o `reviewer` e o teste manual do dono. Antes era: **nada de código antes do E0** (teste real do dono com um número do aplicativo WhatsApp Business).
- **Branch:** `spec/039-conexao-por-coexistencia`
- **Depende de:** 011, 013 e 034 (canal, agrupamento e ordem por `receivedAt`), 015 e 023 (credencial por empresa e Embedded Signup), 024 (painel de conversas e `describeContact`), 028 e 038 (ferramentas da IA e atendimento humano), 031 (Modo C: o cliente paga a Meta)
- **Segurança:** mexe em credencial do canal, em endpoint de tenant e no webhook público. **Passa pelo `reviewer` antes do merge.**

> **Aviso de método.** Esta spec foi escrita **sem acesso à rede**: nenhuma afirmação sobre a Meta foi lida na fonte oficial. Tudo que vem da Meta está marcado **(S#)** e é **suposição até o E0** (passo zero do dono). O roteiro da spec-writer manda registrar a fonte oficial: a fonte a conferir é a página "Onboarding WhatsApp Business app users" da documentação do Embedded Signup (developers.facebook.com, seção Business Messaging, WhatsApp, Embedded Signup; vista em busca como atualizada em abril de 2026, **não lida**). O implementador **não escreve código de produção antes de o E0 estar registrado** e de cada S# estar confirmado, corrigido ou descartado.

## Objetivo

Quem procura o Soprei quase sempre **já atende pelo WhatsApp, à mão, no celular**. O fluxo atual (015 e 023) pede para tirar o número do aplicativo, criar portfólio na Meta, cadastrar pagamento e virar administrador: para esse perfil é pesado e assusta. A **coexistência** (S1) deixa **o mesmo número** funcionar ao mesmo tempo no aplicativo **WhatsApp Business** do celular e na Cloud API. Esta spec (1) oferece esse caminho no site, com uma escolha clara e uma lista de pré-requisitos que **previne e explica** erros como "Não tens permissões para ver este ativo" (visto em teste real: portfólio onde a pessoa não é administradora, ou número já em uso), e (2) decide o que acontece quando **a pessoa e a IA respondem no mesmo chat**.

## Estado atual (lido no código em 2026-11-12)

- **Site:** `frontend/src/company/facebook-sdk.ts` (`FacebookLoginOptions` tem só `config_id`, `response_type: 'code'`, `override_default_response_type: true` e `extras: { setup: {} }`), `embedded-signup-event.ts` (só `FINISH` com `phone_number_id` e `waba_id` numéricos é sucesso; **qualquer outro `FINISH_*`, inclusive o de coexistência, já cai em `unsupported`**; `CANCEL` e `ERROR` viram `cancel` e `error`), `embedded-signup-state.ts` (máquina pura: só envia com `code` **e** ids, `code` com no máximo 20 s, outra metade em 10 s), `ChannelPage.tsx`.
- **Servidor:** `ChannelConnectionService.embeddedSignup` troca o `code`, faz a prova de posse (`debug_token`, números da WABA, `subscribed_apps`), confere `findByWhatsappPhoneNumberId` (409 se for de outra empresa), **registra o número no `/register` com PIN aleatório** guardado cifrado em `ChannelConnection.registrationPinCiphertext` e persiste numa transação com auditoria. `CHANNEL_ERRORS` tem sete códigos fixos.
- **Modelo:** `ChannelConnection` (uma por empresa; `status` `CONNECTED`/`TOKEN_INVALID`; **não há atributo do modo de conexão**). `MessageRole` tem só `USER` e `ASSISTANT`. `Conversation` não tem nenhum estado de atendimento.
- **Webhook:** `parseWebhookBody` (`whatsapp-webhook.schemas.ts`) **ignora todo campo diferente de `messages`** e do `messages` só lê `messages[]` (de entrada) e `statuses[]`. Não existe tratamento de mensagem enviada pelo próprio negócio.
- **Atendimento:** `acceptInboundMessage` + job `flush` + `respondToPending` (013); a ordem vem de `receivedAt` (034); a pendente é `USER` sem `answeredById` e sem resposta por `replyToId`; a IA pode pedir humano por ferramenta (038, `Notification` `HUMAN_HANDOFF`, a IA **continua** respondendo).
- **Painel:** o telefone nunca chega ao navegador (024); mensagem tem `role` `USER`/`ASSISTANT`; o painel **não** envia mensagem ao contato.

## Suposições sobre a Meta (todas a confirmar no E0)

- **S1.** Coexistência: o mesmo número funciona no aplicativo WhatsApp Business e na Cloud API. No `FB.login`, `extras.featureType = 'whatsapp_business_app_onboarding'`, na versão 3 do Embedded Signup (o valor antigo `coexistence` não vale).
- **S2.** O fim do fluxo manda ao popup o evento `WA_EMBEDDED_SIGNUP` com `event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'` e `data.waba_id`. **Não se sabe se vem `phone_number_id`.** Se não vier, o número se obtém listando os números da WABA com o token trocado (S12).
- **S3.** O número **já está registrado** (vem do aplicativo): na coexistência **não** se chama `/register` e **não** há PIN nosso.
- **S4.** Só vale para o aplicativo **WhatsApp Business**; o WhatsApp pessoal precisa migrar antes. A pessoa escaneia um QR code no celular durante o fluxo.
- **S5.** Pré-requisitos de terceiros, não confirmados na Meta: aplicativo em versão recente e número ativo no aplicativo há cerca de 7 dias; conta criada pelo app de desenvolvedor não entra.
- **S6.** Disponibilidade no **Brasil** não confirmada.
- **S7.** Webhooks adicionais da coexistência: **eco de mensagem enviada pelo aplicativo** (campo visto como `smb_message_echoes`), **sincronização do estado do aplicativo** (`smb_app_state_sync`) e **histórico** (`history`). Nomes, formato (`from`, `to`, `id`, `timestamp` em segundos, `type`, `text.body`) e se exigem assinatura própria no app: **a confirmar**.
- **S8.** A resposta que **nós** enviamos pela Cloud API **não** volta como eco (ou volta e é reconhecível pelo id que já gravamos em `channelMessageId`).
- **S9.** O histórico das conversas é importado se a pessoa permitir no popup, por webhook, com limite e continuidade que as fontes divergem em dizer.
- **S10.** Restrições no aplicativo durante a coexistência (grupos, listas de transmissão, mensagens temporárias, "ver uma vez"...) e a regra de abrir o aplicativo periodicamente (citada como a cada 14 dias) sob pena de a conexão cair.
- **S11.** Limites de vazão e de mensagens para número novo na Cloud API.
- **S12.** O `code`, a troca por token, o `debug_token` (app e escopos), `GET /{waba}/phone_numbers` e `subscribed_apps` funcionam como no fluxo atual.
- **S13.** O que o popup informa ao site em `CANCEL` (campo `current_step`) e em `ERROR` (códigos); **o texto "Não tens permissões para ver este ativo" aparece dentro do popup e talvez o site não receba nada**.
- **S14.** A mesma configuração (`config_id`) do Login do Facebook para Empresas serve ao `featureType` de coexistência, ou é preciso uma configuração própria.
- **S15.** Para escolher um portfólio de negócios no popup, a pessoa precisa ser **administradora** dele (a causa mais provável do erro de ativo sem permissão).
- **S16.** A cobrança da Meta (cartão no portfólio do cliente) é igual à do fluxo atual (Modo C da 031).
- **S17.** O que acontece com o número e com o aplicativo ao desconectar pelo Soprei (`DELETE .../channel`): o número volta a ser só do aplicativo, ou precisa ser refeito.

## Comportamento esperado

### E0 — Passo zero (DONO): teste real com um número já usado no aplicativo

**Nada de código de produção antes deste registro.** Com um número **de teste do dono**, ativo no aplicativo WhatsApp Business (não o pessoal) há alguns dias, em celular com o aplicativo atualizado, no app da Meta em desenvolvimento (só administradores, desenvolvedores e testadores do app concluem o fluxo), com o canal desligado em `main` e o `FB.login` alterado **só em um branch de laboratório, descartável** (acrescentar `featureType` ao `extras` e registrar no console, sem gravar). Anotar na seção "Registro do E0" desta spec, **sem telefone, token, `code`, `Session ID` nem nome de pessoa**:

1. Versão do aplicativo, dias de uso do número, país (Brasil confirmado?) e se o fluxo abre ou recusa (S5, S6).
2. O que o popup pede, em ordem (login, portfólio, WABA, número, QR, permissão de histórico) e **qual tela mostra "sem permissão"** quando o portfólio escolhido não é do usuário (S13, S15). Repetir de propósito com um portfólio onde o usuário **não** é administrador e anotar se o site recebe algum evento (`CANCEL`, `ERROR`, `current_step`).
3. O corpo exato do `FB.login` (`authResponse.code`?) e **todos** os eventos `message` (`event`, chaves de `data`, ordem relativa ao callback) (S1, S2, S14).
4. Se `data` traz `phone_number_id`; se não, o resultado de `GET /{waba}/phone_numbers` com o token trocado (S2, S12).
5. Se o `/register` é **recusado ou desnecessário** (não chamar de verdade se houver risco de desligar o aplicativo: só consultar o estado do número) (S3).
6. Que webhooks chegam e **quando**, com o endpoint de laboratório em modo "só registrar o nome do campo, as chaves e o tamanho" (S7, S9): eco de mensagem enviada pelo celular, sincronização de contatos/estado, histórico; o formato do eco (`to`, `id`, `timestamp`, `type`); se são exigidos campos novos assinados no app.
7. Mandar uma mensagem **pelo celular** a um contato de teste e uma **pela Cloud API** (envio do Soprei) e anotar se cada uma gera eco (S8).
8. O que o cliente perde ou muda no aplicativo (grupos, listas, mensagens temporárias, chamadas) e a regra de abrir o aplicativo (S10); limites de vazão (S11).
9. Desconectar pelo `DELETE` atual e anotar o estado do número e do aplicativo (S17).
10. Que o cartão/forma de pagamento a Meta pede e quando (S16).

Cada S# do quadro acima termina como **confirmado**, **corrigido** (com o valor real) ou **descartado** neste registro. **Critério para seguir:** S1 a S3, S7 e S8 confirmados (ou corrigidos) e coexistência disponível no Brasil (S6). Se S3 ou S7 falharem, a spec é reescrita.

### E1 — Site: escolha, lista de pré-requisitos e mensagens (sem backend novo)

Só aparece com a flag do servidor (ver "Configuração") e para quem tem `channel:manage`.

- **Escolha no início da tela do Canal**, em texto simples e dois cartões: **"Uso o WhatsApp Business no celular e quero continuar usando"** (coexistência; recomendado, cartão em primeiro lugar) e **"Vou usar um número novo, só para o Soprei"** (o fluxo atual, sem mudança). O texto da primeira diz, em linguagem comum, que o número continua no aplicativo, que a pessoa pode responder pelo celular e que a IA pausa quando isso acontece (E3). Quem usa o **WhatsApp pessoal** (não o Business) recebe a orientação "instale o WhatsApp Business e migre o número antes" (S4), sem automação (fora de escopo).
- **Lista de pré-requisitos antes de abrir o popup** (caixas de confirmação; o botão "Conectar com a Meta" só habilita com todas marcadas; o estado das caixas vive só em memória): (a) o aplicativo **WhatsApp Business** está atualizado e **aberto no celular, com a câmera liberada** (vai ler um QR code) (S4, S5); (b) o número está ativo no aplicativo há alguns dias (S5; texto condicionado ao E0); (c) **você é administrador do portfólio de negócios** que vai escolher ou vai criar um novo no fluxo; como conferir (passo a passo curto na tela, redação final depois do E0, S15); (d) o número **não está conectado a outra plataforma de atendimento** (outro provedor de API) e não é de outra empresa do Soprei; (e) você tem uma forma de pagamento da Meta para cadastrar quando pedirem (S16, Modo C).
- **Depois do clique 1** o SDK é carregado como hoje (`facebook-sdk.ts`) e o popup abre no clique 2, **síncrono**, como na 023. `FacebookLoginOptions` ganha `extras.featureType` opcional, **só** na coexistência; o fluxo atual não muda.
- **Evento:** `embedded-signup-event.ts` ganha a variante `finish_coexistence` (`wabaId` obrigatório, `phoneNumberId` opcional; mesma origem estrita, mesmo limite de 8 KiB, mesmos ids `^[0-9]{1,32}$`). `FINISH` simples continua sendo o do fluxo atual. A máquina de estados (`stepSignup`) ganha o `mode` da tentativa e aceita ids com `phoneNumberId` nulo; o resto (descartar `code` com mais de 20 s, nada parcial enviado) é igual.
- **Se o popup for fechado sem terminar** (`cancel` ou `code` nulo), a tela mostra a mensagem "A conexão não terminou" **mais** o texto de ajuda fixo com as três causas mais prováveis, sem afirmar qual foi: "você não é administrador do portfólio escolhido", "o número já está em uso em outra plataforma", "o aplicativo no celular está desatualizado ou fechado". Mensagens **escolhidas pelo site a partir do código** (`status`, `error.code` e o tipo de falha da máquina), nunca pelo texto da Meta nem do servidor (regra da 023); `current_step` e qualquer valor de `data` **não** vão a log, a tela nem a storage. Se o E0 mostrar que `current_step` é útil e seguro, ele só **escolhe entre mensagens fixas** (lista fechada, Zod).
- **Sem armazenamento no navegador:** `localStorage` continua só com o tema; nada de `code`, id, número ou escolha em `localStorage`, `sessionStorage`, URL, título ou `console`.
- Cores só por tokens; pares novos em `theme/contrast.test.ts`; botões com texto; `aria-live` para o resultado.

### E2 — Backend: conectar por coexistência

- **Configuração:** `WHATSAPP_COEXISTENCE_ENABLED` (padrão `false`, `true`/`false` literais, exige `WHATSAPP_ENABLED` e `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` ou a variável abaixo) e `WHATSAPP_COEXISTENCE_CONFIG_ID` (opcional, dígitos; só existe se o E0 mostrar que a configuração atual não serve, S14; vazia = usa a do Embedded Signup). `GET .../channel/setup` ganha `coexistence: { available: boolean, configId: string | null }` (só valores públicos).
- **Modelo:** enum `channel_connection_mode` (`API_ONLY`, `COEXISTENCE`) e coluna `ChannelConnection.mode` **`NOT NULL DEFAULT 'API_ONLY'`**. Migration **aditiva e compatível com a versão anterior do código** (regra da 037). `GET .../channel` devolve também `mode` (aditivo). `ChannelConnection` já é model de tenant com `companyId @unique`; nenhuma FK nova. Auditoria: `AuditAction` ganha `CHANNEL_CONNECTED_COEXISTENCE`? **Não:** o `audit_events` já tem `CHANNEL_CONNECTED`/`CHANNEL_TOKEN_REPLACED`, e o modo fica na própria conexão (a trilha guarda só ids e a ação; sem texto livre). Decisão simples: reaproveitar as ações existentes.
- **Rota:** o mesmo `POST /admin/companies/:companyId/channel/embedded-signup`, corpo `strict` `{ code, wabaId, phoneNumberId?, mode?: 'api_only' | 'coexistence' }` (padrão `api_only`: o contrato atual não muda; `phoneNumberId` só é opcional em `coexistence`). Mesmas permissões (`channel:manage`), perfil `admin`, mesma ordem 401 -> 403 -> 404 -> 403.
- **Serviço (`ChannelConnectionService.embeddedSignup`, ramo `coexistence`):** (1) troca o `code`; (2) **prova de posse igual à da 015** (`debug_token`: app e escopos; a WABA nos `target_ids` quando vierem; os ids do navegador **nunca** são confiados); (3) sem `phoneNumberId`, lista os números da WABA com o token e, se houver **exatamente um**, usa-o; zero ou vários = 400 `CHANNEL_NUMBER_AMBIGUOUS` (mensagem fixa; "escolha o número no aplicativo e tente de novo"; nenhum id na resposta); (4) o `phoneNumberId` precisa constar na lista da WABA (`CHANNEL_NUMBER_NOT_IN_WABA`); (5) 409 `CHANNEL_NUMBER_IN_USE` se for de outra empresa, **antes** de qualquer gravação; (6) `subscribed_apps`; (7) **sem `/register` e sem PIN** (S3; se o E0 mostrar que é necessário, esta decisão é refeita), `registrationPinCiphertext` fica nulo; (8) grava numa transação com `lockCompany`, `mode = COEXISTENCE`, token cifrado (AAD `companyId|keyId`), `Company.whatsappPhoneNumberId` e auditoria, como o `PUT`. Falha antes da transação não grava nada. Um `PUT` manual ou um Embedded Signup `api_only` posterior **troca o modo** conscientemente (`mode` sempre explícito na gravação).
- **Erros:** os sete códigos atuais mais `CHANNEL_NUMBER_AMBIGUOUS`; mensagens constantes; a Meta fora do ar = 502. Métrica `channel_connections_total{action,result}` ganha o valor `coexistence` em `action` e `ambiguous` em `result` (conjuntos fixos). `redact` continua cobrindo `oauthCode`, token e PIN; **nada de token, `code`, número, WABA ou PIN em log, resposta ou métrica**.
- **Webhook (assinatura dos campos novos é passo do DONO):** `parseWebhookBody` passa a reconhecer, **só** pelo nome do campo confirmado no E0 (S7), o eco de mensagem enviada pelo aplicativo e a sincronização de estado; o resto (inclusive `history`) continua ignorado, com a métrica `channel_inbound_messages_total` em `ignored_type`/campo ignorado e **sem gravar nada**. Assinatura HMAC, rate limit `webhook`, corpo cru e 200 rápido **não mudam**.
- **Isolamento:** o `CompanyId` do eco nasce **só** de `phone_number_id` -> empresa (`findByWhatsappPhoneNumberId`), como hoje; empresa sem número associado = `unknown_number`, sem efeito.

### E3 — A IA e a pessoa no mesmo chat: eco, pausa e ordem

**Regra de produto (D1):** quando a pessoa responde **pelo aplicativo** (eco, S7), **a IA para de responder aquele contato** até acabar a pausa ou a pessoa reativar. A IA não disputa a conversa com o humano.

- **Modelo (migration aditiva, junto com a da E2 ou separada):**
  - `message_role` ganha o valor **`HUMAN`** (mensagem enviada pela equipe, pelo aplicativo). Observação: valor de enum novo **não pode ser usado na mesma transação da migration** (já ocorreu na 025) e **uma linha `HUMAN` quebra a leitura da versão anterior do código** (o Prisma não conhece o valor), então o rollback do deploy (037) depois do primeiro eco exige cuidado: registrar em `docs/ops/deploy.md`. `MessageRole.USER` continua sendo a mensagem do contato.
  - `Conversation.aiPausedUntil timestamptz NULL` e `Conversation.aiIgnoreBefore timestamptz NULL` (colunas aditivas; modelo de tenant existente; sem FK nova). **Relógio de quem decide é o do banco** nas regras de pausa; o relógio dos testes é injetado.
  - Eco de mensagem de **mídia** (S7: `type` `image`, `audio`, `video`, `document` ou `sticker`): grava um texto fixo do servidor (`[mídia enviada pelo atendente]`), nunca baixa nem guarda a mídia. Qualquer outro tipo (`reaction`, `system`, `unsupported`, desconhecido ou ausente) é **ignorado**: não grava nem pausa a IA (`channel_echo_events_total{result="ignored_type"}`; decisão do dono na revisão, 2026-11-12).
  - **Contato do eco:** com **exatamente um** eco no `value` e **exatamente um** `contacts[].wa_id` válido, o contato é o `wa_id`; senão, o `to` (decisão do dono na revisão, 2026-11-12: no Brasil o `wa_id` pode vir sem o 9 enquanto o `to` vem com ele, e o `wa_id` é o `from` das mensagens do contato).
- **Job `echo` (entrada):** novo tipo de job da fila `channel-inbound` (`companyId`, `phoneNumberId`, `contactRef` do campo `to`, `externalId`, `receivedAt` do timestamp do eco com a mesma faixa de 24 h/1 min da 034, `kind` `text` ou `media`, texto), com `jobId` determinístico `<companyId>_<externalId codificado>`. O worker, em transação:
  1. **Eco duplicado:** `externalId` já gravado na empresa (índice único existente) = nada muda (idempotente); eco cujo id é o `channelMessageId` de uma resposta **nossa** (S8) = ignorado (`own`).
  2. Acha ou cria a conversa pelo `contactRef` (`findOrCreateByContact`) e grava a mensagem `HUMAN` com `createdAt = receivedAt` (a ordem vem do instante de recebimento, como na 034).
  3. **Pausa:** `aiPausedUntil = GREATEST(aiPausedUntil, receivedAt + duração)` e `aiIgnoreBefore = GREATEST(aiIgnoreBefore, receivedAt)` (`updateMany` com `companyId`; nunca para trás). A **duração** é a constante `AI_TAKEOVER_PAUSE_MINUTES` em `domain/` (D1: 12 h), sem variável de ambiente.
  4. **Mensagens pendentes do contato anteriores ao eco são consideradas respondidas pelo humano**: `aiIgnoreBefore` as exclui de `listPending`. Sem apagar nada e sem alterar `answeredById`.
  5. **Notificação 038:** o eco **não** resolve sozinho um `HUMAN_HANDOFF` aberto (o CHECK exige um vínculo em `RESOLVED`); a equipe marca como resolvido (D4).
- **Atendimento (`AttendanceService.respondToPending`, E3):** `listPending` passa a considerar só mensagens com `createdAt > aiIgnoreBefore`. Antes de chamar o LLM, se a conversa está **em pausa** (`aiPausedUntil > agora do banco`), o `flush` **não chama o LLM, não grava resposta e não envia**: marca `aiIgnoreBefore` até a última pendente (a mensagem do contato durante a pausa é do humano), resultado `paused` (log só com ids, métrica `attendance_paused_turns_total`). A pausa é **relida dentro da transação** que grava a resposta (corrida eco x `flush`): se pausou depois da chamada ao LLM, a transação desfaz a resposta (mesmo mecanismo do `ConflictError` do lote) e o resultado é `paused`; uma segunda leitura imediatamente antes do `sendText` descarta o envio se a pausa começou entre a gravação e o envio (a resposta fica gravada sem `sentAt`, igual a uma falha de envio, e entra em `attendance_unsent_replies_total`). **Limitação aceita:** um eco que chega **durante** o `sendText` pode deixar uma resposta da IA a mais.
- **Histórico para o LLM:** a mensagem `HUMAN` entra como turno do **assistente** (é o lado da empresa) em `listBefore`; o texto do contato continua só no turno `user`; o `systemPrompt` não muda. Os turnos seguidos do assistente seguem a adaptação já feita pelo provedor Anthropic.
- **Ferramentas (028, 038):** em turno pausado nenhuma ferramenta é oferecida (não há turno). Reativada a IA, valem as regras de sempre.
- **Contrato do painel (024, só acrescenta):** `role` da mensagem pode ser `HUMAN`; a lista e o histórico ganham `aiPausedUntil` (ISO UTC ou `null`; o servidor devolve `null` se já passou). `contactRef`, `externalId` e telefone **continuam fora** da resposta (sentinelas nos testes existentes). Na bolha (029): a mensagem `HUMAN` fica **do lado da empresa**, com o rótulo "Equipe (pelo celular)" (texto, não só cor); no topo da conversa, faixa "A IA está pausada neste contato até HH:mm de dd/MM porque a equipe respondeu pelo celular" com "Reativar a IA" (E4).

### E4 — Reativar a IA e painel

- **Permissão** `conversation:takeover` (OWNER, ADMIN e AGENT, no mapa fixo de `domain/permissions.ts`; VIEWER vê a faixa e não o botão; `PlatformAdmin` 403).
- **Rota** `POST /admin/companies/:companyId/conversations/:conversationId/ai/resume` (perfil `admin`, `requirePermission('conversation:takeover', { companyParam })`: 401 -> 403 plataforma -> 404 -> 403): `aiPausedUntil = NULL` (`updateMany` com `companyId`), **204 idempotente**; `:conversationId` malformado, inexistente ou de outra empresa = o mesmo 404. **Não** mexe em `aiIgnoreBefore` (o que o humano já tratou não é respondido depois). Métrica `conversation_ai_resumes_total`; log só com ids e ação (sem auditoria: D5).
- **Site:** botão "Reativar a IA" na faixa (com `ConfirmDialog`? **não**: a ação é reversível pelo próximo eco); selo "IA pausada" (texto e ícone) na lista de conversas ao lado do "Humano" da 038; erros por `status` e `error.code`. Na tela do Canal, quando `mode = COEXISTENCE`: bloco "Conectado pelo aplicativo" com a explicação da pausa e das restrições do aplicativo (texto final depois do E0, S10).
- **Histórico importado (S9):** **não** é gravado nem usado pela IA neste corte. O webhook `history` continua ignorado. Se o dono quiser (D6), é spec própria com LGPD (spec 032): histórico traz conversas de pessoas que nunca falaram com o Soprei.

## Critérios de aceite

Os testes **usam só** `FakeGraphApi`, `window.FB` falso e relógio injetado; nenhuma chamada real à Meta. O E0 e o teste com o número real são do dono.

- [x] **E0:** o "Registro do E0" desta spec está preenchido, com S1 a S17 marcados como confirmado, corrigido ou descartado, **antes** de qualquer commit de código de produção. [manual, dono]
- [x] Parser do site: `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` válido vira `finish_coexistence` (com e sem `phone_number_id`); id não numérico, origem fora da lista (inclusive `evilfacebook.com` e `facebook.com.evil.com`), texto acima de 8 KiB e tipo errado são ignorados; `FINISH` simples continua sendo `finish`.
- [x] Máquina de estados: tentativa de coexistência envia só com `code` novo (<= 20 s) **e** `waba_id`, com `phoneNumberId` nulo aceito; `code` velho, outra metade fora de 10 s, cancelamento e popup bloqueado não enviam nada; o `code` e os ids não sobrevivem ao envio.
- [x] Site (unitário e e2e, desktop e celular, claro e escuro, `window.FB` falso): a escolha aparece; o botão fica desabilitado até todas as caixas; `FB.login` recebe `featureType` **só** na coexistência e **não** o recebe no fluxo atual; o popup abre de forma síncrona; sem a flag a escolha não aparece; falha mostra a mensagem fixa e as três causas; nada de texto do servidor/Meta, de `code` ou de id em log, DOM, URL ou storage (varredura com sentinelas).
- [x] `POST .../channel/embedded-signup` sem `mode` mantém exatamente o comportamento e o contrato atuais (os testes de integração existentes passam sem alteração).
- [x] Coexistência (integração, Postgres real e `FakeGraphApi`): com `code` válido e prova de posse, grava `mode = COEXISTENCE`, número, token cifrado e auditoria; **o `/register` não é chamado** e `registrationPinCiphertext` fica nulo; sem `phoneNumberId` resolve pelo número único da WABA; zero ou vários números = 400 `CHANNEL_NUMBER_AMBIGUOUS` sem gravar; `app_id` ou escopo errado, número fora da WABA e `code` inválido dão os códigos de sempre e **nada é gravado**; número de outra empresa = 409 antes de gravar; Meta fora = 502.
- [x] Privacidade do canal: o `FakeGraphApi` **ecoa** `code`, token e ids nos erros de propósito e nada disso aparece em log, métrica nem resposta (captura de log com sentinelas).
- [x] Isolamento: a empresa B não lê nem altera a conexão da A; `:companyId` alheio = 404 antes da permissão; `AGENT`, `VIEWER` e `PlatformAdmin` = 403 (matriz); o eco de `phone_number_id` da A nunca grava mensagem na B; `phone_number_id` desconhecido ou de empresa removida = `unknown_number`.
- [x] Migration: aditiva (`mode` com default, três colunas anuláveis, valor de enum `HUMAN`); teste de migração com schema temporário; `MODEL_SCOPES` inalterado; a varredura de texto do deploy (037) passa sem `breaking-approved`.
- [x] Webhook: o eco com assinatura inválida é 401 e nada é processado; com assinatura válida e corpo inválido é 200 + `invalid_payload`; campos ignorados não geram job nem gravação (inclusive `history`); `channel_echo_events_total{result}` (`recorded`, `duplicate`, `own`, `unknown_number`, `invalid`) com rótulos fixos.
- [x] Eco: grava uma única mensagem `HUMAN` com `createdAt = receivedAt`; o mesmo `externalId` duas vezes não duplica nem muda `createdAt`; eco de resposta nossa (S8) é ignorado; mídia vira o texto fixo; `receivedAt` fora da faixa usa o relógio do banco com `warn` só do `companyId`.
- [x] Pausa (relógio injetado): depois de um eco, `aiPausedUntil = receivedAt + duração`; um segundo eco só estende (nunca encurta); mensagem do contato durante a pausa **não** chama o LLM, **não** grava resposta e **não** envia (resultado `paused`) e fica fora de `listPending` depois; pausa vencida volta a responder só o que chegou **depois**; mensagens pendentes anteriores ao eco **não** são respondidas.
- [x] Corrida eco x `flush` (integração, Postgres e fila reais): eco que chega durante a chamada ao LLM desfaz a resposta (sem mensagem da IA gravada, sem envio); eco que chega com o `flush` agendado impede a resposta; nenhum cenário perde a mensagem do contato nem duplica a do humano.
- [x] Ordem (034): eco e mensagens do contato entram ordenados por `receivedAt`, não pela ordem dos jobs.
- [x] 038: pausa não gera nem resolve notificação; um pedido de humano aberto continua aberto depois do eco; o teste prova que em turno pausado a ferramenta de atendimento humano **não** é oferecida.
- [x] Histórico do LLM: a mensagem `HUMAN` vai como turno do assistente; o texto do contato **só** no turno `user` (teste com provedor falso).
- [x] Painel (contrato 024): `role: 'HUMAN'` e `aiPausedUntil` aparecem; `contactRef`, `externalId` e telefone **não** (sentinelas em `attendance.controller.test.ts`, `site-bridge.integration.test.ts`); `aiPausedUntil` vencida sai `null`.
- [x] Reativar: `POST .../ai/resume` é 204 idempotente, zera a pausa, mantém `aiIgnoreBefore`; `AGENT` pode, `VIEWER` 403, `PlatformAdmin` 403; conversa de outra empresa = 404 igual ao inexistente; o inventário de rotas (`rate-limit.test.ts`) exige perfil e `requirePermission`; a varredura do `site-bridge` cobre a rota.
- [x] Site (e2e): bolha `HUMAN` do lado da empresa com o rótulo; faixa de pausa e "Reativar a IA" somem e baixam o selo na lista; VIEWER não vê o botão.
- [x] Sem `WHATSAPP_COEXISTENCE_ENABLED`: a escolha não aparece, o `mode` do corpo `coexistence` é recusado (400) e **nada** do eco é tratado (teste de rotas e de config).
- [x] Log do atendimento e do worker em fluxo de eco/pausa: nenhum texto, telefone, `externalId` cru, token ou PIN (`logContains` com sentinelas); só `messageRef`, ids e resultado.
- [ ] `typecheck`, `lint`, `format:check` locais; CI verde (`static`, `tests`, fatias de `browser`).

## Casos de borda e erros

- **Eco chega antes do webhook `messages` do contato** (ordem não garantida): `receivedAt` decide a ordem; a mensagem do contato anterior ao eco já nasce fora de `listPending` (`createdAt <= aiIgnoreBefore`), mesmo se gravada depois.
- **Eco de um contato sem conversa:** cria a conversa; sem mensagem `USER` não há o que responder.
- **A pessoa responde pelo celular a algo que a IA já respondeu:** pausa normal.
- **Pausa e empresa suspensa/removida/token inválido:** valem as regras de sempre (nada é enviado); o eco de empresa suspensa é gravado? **Não**: a regra da 011 é que empresa suspensa não recebe nada; o eco é descartado (`discarded`, `warn`).
- **`TOKEN_INVALID` (190):** o ramo de coexistência reconecta como o `PUT`; o eco continua chegando (o webhook não depende do token).
- **Cliente desconecta no aplicativo ou o aplicativo não é aberto no prazo (S10):** os envios passam a falhar; hoje cai nas regras de erro permanente (texto padrão, `ForbiddenError`...). Fica como limitação: sem detecção própria; o aviso na tela do Canal diz que o aplicativo precisa ser aberto periodicamente.
- **Várias empresas da mesma pessoa e o mesmo número:** 409 `CHANNEL_NUMBER_IN_USE`, como hoje.
- **Número com Embedded Signup `api_only` já conectado e a pessoa refaz por coexistência:** troca o modo; o PIN guardado é mantido (inofensivo) mas não usado.
- **Duas abas fazendo o fluxo:** a máquina de estados já descarta a segunda tentativa com `code` usado (`CHANNEL_CODE_INVALID`).
- **Eco enorme ou lote de ecos:** o corpo do webhook já tem teto de 3 MiB; o texto do eco é cortado no teto de `CONTENT_MAX` do atendimento (como a mensagem do contato) e os jobs seguem a deduplicação por `jobId`.

## Isolamento entre empresas

Toca em dados de tenant (`ChannelConnection`, `Conversation`, `Message`). O `CompanyId` vem **só** da identidade (cookie) nas rotas e **só** da resolução `phone_number_id` -> empresa no webhook; nunca do corpo, de cabeçalho ou do navegador (os ids do Embedded Signup continuam sendo confirmados pela Graph com o token trocado). Escritas novas usam `updateMany`/`createMany`/`create` com `companyId` no `where` ou nos `data` (a `tenant-scope` recusa sem ele); sem SQL cru novo. FKs compostas existentes continuam valendo. Testes: contrato e integração do repositório com duas empresas (eco, pausa, reativar), matriz de rotas com `:companyId` e `:conversationId` alheios (404 igual), fluxo de webhook com duas empresas e o mesmo `externalId`, e a varredura do `site-bridge`.

## Fora de escopo

- **Solution Partner, linha de crédito da Meta e cobrança** (o cliente continua pagando a Meta no cartão dele; Modo C da 031).
- **Pré-verificação automática** do número, da versão do aplicativo, do papel de administrador no portfólio ou de uso em outra plataforma (a spec só **orienta**).
- **Grupos**, listas de transmissão e mensagens temporárias.
- **Importar o histórico** para a IA ou para o painel (decisão D6; LGPD na 032).
- **Migração automática do WhatsApp pessoal** para o Business.
- **Pausar a IA manualmente** pelo painel e **pausa por empresa** ("desligar a IA agora"); duração configurável por empresa.
- **Responder o contato pelo painel** (envio manual pela Cloud API), tempo real (009), auditoria da reativação, notificação ao eco.
- Detectar que o aplicativo ficou fechado por dias e a conexão caiu.
- Expurgo de mensagens `HUMAN` e do histórico (retenção/LGPD, spec 032).

## Riscos

- **Suposições sobre a Meta (S1 a S17):** se S3 (sem `/register`) ou S7 (eco) estiverem erradas, a E2 e a E3 mudam de forma. Por isso o E0 vem antes e a spec é reescrita se preciso.
- **A pessoa responde pelo celular e a IA responde junto** (corrida, limitação do `sendText` acima): pode sair uma resposta a mais da IA; aceito, mitigado pelas duas leituras da pausa.
- **A IA para para sempre** se a pessoa não reativar e o contato voltar depois da pausa: com 12 h o pior caso é o contato esperar até ela vencer; a faixa avisa.
- **Mensagem `HUMAN` e o rollback do deploy (037):** a versão anterior do código não lê linha com o valor novo do enum; ver "E3" (registro em `docs/ops/deploy.md`).
- **Dado pessoal:** o eco guarda o texto que a **equipe** escreveu a um contato; mesma retenção das outras mensagens (032). O texto nunca vai a log, métrica ou URL.
- **Restrições do aplicativo e perda de recurso do cliente (S10):** a promessa "continua usando o aplicativo" precisa de ressalvas na tela; texto final depois do E0.
- **SDK de terceiros** (risco aceito da 023) não muda; `featureType` é só um parâmetro.

## Decisões e dependências novas

**Nenhuma dependência nova.** Duas variáveis opcionais, desligadas por padrão (`WHATSAPP_COEXISTENCE_ENABLED`, `WHATSAPP_COEXISTENCE_CONFIG_ID`), documentadas em `.env.example`. Migration aditiva (`mode`, três colunas de conversa, valor `HUMAN`). Cortes mergeáveis: **E1** sozinha (só o site) não muda o servidor; **E2** conecta mas **não deve ser ligada em empresa real sem a E3** (sem a pausa a IA responde por cima da pessoa); **E3** + **E4** fecham o comportamento. Passa pelo `reviewer` (credencial, webhook público, endpoint de tenant).

**Decisões para o dono (recomendação primeiro, em linguagem simples):**

1. **Quando a pessoa responde pelo celular, o que a IA faz?** (a) **Recomendada:** a IA **para** com aquele contato por **12 horas** (a cada nova resposta pelo celular a contagem reinicia) e a pessoa pode **reativar** a qualquer momento no painel; o que o contato escreveu enquanto a pessoa atendia **não** é respondido depois pela IA. É o comportamento que o cliente espera de "atendo eu, e a IA ajuda quando eu não estou". (b) Pausa mais curta (por exemplo 2 h) ou mais longa (24 h). (c) A IA nunca pausa (responde sempre): arrisca falar por cima da pessoa. (d) Pausa até a pessoa reativar, sem prazo: arrisca o contato ficar sem resposta se ela esquecer.
2. **Escopo do primeiro corte.** (a) **Recomendada:** E0, depois E1 a E4 nessa ordem, **sem ligar em empresa real antes da E3**. (b) Só E1 e E2 (conecta, sem pausa): mais rápido, mas a IA responde por cima da pessoa.
3. **Nome e lugar da mensagem da pessoa no painel.** (a) **Recomendada:** nova origem `HUMAN`, mostrada do lado da empresa com o rótulo "Equipe (pelo celular)". (b) Misturar com a da IA como "assistente": perde a distinção e engana quem lê o histórico.
4. **O pedido de atendimento humano (038) fecha sozinho quando a pessoa responde?** (a) **Recomendada:** não; a equipe marca como resolvido (mantém a regra atual e o banco). (b) Fecha sozinho: exige mudar a regra do banco e decidir quem consta como resolvedor.
5. **Quem pode reativar e se fica registrado.** (a) **Recomendada:** dono, administrador e atendente (não o somente-leitura), sem trilha de auditoria por enquanto (só log e métrica). (b) Só dono e administrador. (c) Com auditoria (mais tabela e regra).
6. **Histórico importado.** (a) **Recomendada:** **não usar** nem gravar neste corte; o webhook de histórico é ignorado. Evita guardar conversas de pessoas que nunca falaram com o Soprei (LGPD, spec 032). (b) Gravar só para exibir no painel (decidir depois do E0 se vale). (c) Usar para a IA conhecer o cliente: spec própria.
7. **Mesma configuração ou configuração própria do Login do Facebook para o fluxo de coexistência.** (a) **Recomendada:** tentar a mesma (`config_id` atual com `featureType`); só criar uma segunda se o E0 mostrar que é preciso. (b) Sempre uma segunda, para não misturar os dois fluxos.
8. **Número com mais de uma opção na WABA ao conectar.** (a) **Recomendada:** recusar com mensagem ("escolha o número no aplicativo e tente de novo"), sem tela de escolha. (b) Mostrar a lista de números mascarados para a pessoa escolher (mais tela e mais dado do cliente na tela).
9. **Texto de ajuda para "sem permissão".** (a) **Recomendada:** texto fixo e curto no passo "ser administrador do portfólio" e na falha ("a conexão não terminou"), sem tentar adivinhar a causa. (b) Tentar distinguir a causa pelo evento da Meta: só se o E0 mostrar que o evento a informa de forma confiável.

## Passos do dono

1. **E0**, como descrito acima, **antes** de qualquer implementação; registrar o resultado (sem telefone, token, `code` ou `Session ID`) em "Registro do E0".
2. **Na Meta (depois do E0):** o fluxo de coexistência no Login do Facebook para Empresas (`config_id`, S14); em **webhooks do WhatsApp**, assinar os campos que o E0 confirmar (eco de mensagens enviadas pelo aplicativo e estado do aplicativo; **não** assinar `history` neste corte); o app em modo **Live** e as permissões (as da 023 valem); URLs de privacidade e de termos.
3. **Na máquina:** `pnpm db:migrate:deploy` (aditiva), `backend/.env` com `WHATSAPP_COEXISTENCE_ENABLED=true` (e, se for o caso, `WHATSAPP_COEXISTENCE_CONFIG_ID`) e `TRUST_PROXY` explícito, reiniciar backend e frontend juntos.
4. **Teste manual com o número real** (E2 a E4): conectar pela tela do Canal, mandar uma mensagem de outro telefone (a IA responde), responder **pelo celular** (a IA para; a faixa aparece), esperar ou clicar "Reativar a IA", conferir que o histórico mostra "Equipe (pelo celular)", e confirmar que nenhuma mensagem do histórico antigo aparece.
5. **Antes de empresa real:** termos de dados da Anthropic e limite de gasto (014), retenção e LGPD (032) e o aviso, na tela, das restrições do aplicativo.

## Registro do E0

Feito pelo dono em **2026-11-12**, das 14:35 às 14:50 (horário do servidor). As ferramentas temporárias ficaram na branch `lab/e0-coexistencia`, que nunca vai para a `main`. Nada foi gravado no banco do Soprei. No fim foram rodados `node lab.mjs limpar` (desassinou o app da WABA e apagou o token) e a remoção da página e de `/root/soprei-lab*`. Sem telefone, token, `code`, ids nem nomes neste registro.

**Ambiente:** app da Meta em desenvolvimento (o dono é administrador); Graph `v26.0`; o mesmo `config_id` do Embedded Signup atual, lido de `GET .../channel/setup`; número de teste do dono no aplicativo WhatsApp Business, com o número exibido no formato brasileiro (13 dígitos com o 55). Não foram anotados a versão do aplicativo nem há quantos dias o número estava em uso.

### Itens do roteiro

1. **Abre no Brasil:** sim, o fluxo abriu e terminou com o número brasileiro. A versão do aplicativo e os dias de uso não foram anotados.
2. **Portfólio:** o dono repetiu o fluxo escolhendo um portfólio em que **não** é administrador e o fluxo **terminou normalmente**, sem a tela "sem permissão". Os eventos dessa tentativa não foram registrados (nem `CANCEL`/`ERROR`, nem `current_step`), e o `code` dela não foi usado.
3. **Evento e `FB.login`:** chegou um único `message` do popup, `type: "WA_EMBEDDED_SIGNUP"`, `event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"`, com `data` = `{ phone_number_id, waba_id, business_id, page_ids: [], catalog_ids: [], dataset_ids: [], instagram_account_ids: [] }` (os ids vêm como **string**). Cerca de 1 s **depois** chegou a resposta do `FB.login`: `status: "connected"`, `authResponse` com `userID`, `expiresIn` e `code`. A ordem é a mesma do fluxo atual: primeiro o evento, depois o callback.
4. **`phone_number_id`:** **veio** no evento. `GET /{waba}/phone_numbers` com o token trocado devolveu um número, o mesmo do evento, com `status: CONNECTED`, `platform_type: CLOUD_API`, `code_verification_status: NOT_VERIFIED`, `quality_rating: UNKNOWN` e nome verificado presente; `GET /{número}?fields=is_on_biz_app` = `true`.
5. **`/register`:** **não foi chamado.** Ele é desnecessário: o número já estava `CONNECTED` na Cloud API sem ele, e o envio do item 7 funcionou.
6. **Webhooks:** no painel do app, os campos `smb_message_echoes`, `smb_app_state_sync` e `history` **apareceram e precisaram ser assinados** (além de `messages`). Formato do eco, campo **`smb_message_echoes`**, com `value` = `{ messaging_product: "whatsapp", metadata: { display_phone_number, phone_number_id }, contacts: [{ wa_id, user_id }], message_echoes: [{ from, to, to_user_id, id, timestamp, type: "text", text: { body } }] }`. Detalhes:
   - `from` é o número da empresa e `to` é o contato, cujo `wa_id` é o mesmo que o contato tem no webhook `messages`;
   - `timestamp` vem em segundos, como texto de 10 dígitos.

   Durante o teste **não** chegaram `smb_app_state_sync` nem `history`.

7. **Eco:**
   - **Pelo celular:** a mensagem enviada gerou um `smb_message_echoes`.
   - **Pela Cloud API:** a mensagem enviada gerou **só** `statuses` no campo `messages` (`sent` e depois `delivered`, este **duas vezes** com o mesmo id) e **nenhum** eco.
   - `pricing.type` da resposta dentro da janela: `free_customer_service`.
   - Todos os webhooks (entrada, eco e status) trazem campos novos de 19 caracteres: `user_id`, `from_user_id`, `to_user_id` e `recipient_user_id`.
8. **Restrições no aplicativo:** não anotadas.
9. **Desconectar:** feito pelo laboratório (`DELETE /{waba}/subscribed_apps` = 200 e apagar o token), **não** pelo `DELETE .../channel` do Soprei, porque a conexão nunca foi gravada nele. O estado do número e do aplicativo depois disso não foi consultado.
10. **Pagamento:** o fluxo não pediu forma de pagamento.

### Estado das suposições

| S#  | Estado                       | Resultado                                                                                                                                                                                                                                                                                |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **confirmada**               | `extras.featureType = 'whatsapp_business_app_onboarding'` abre a coexistência e o mesmo número fica no aplicativo e na Cloud API (`is_on_biz_app: true`, `platform_type: CLOUD_API`).                                                                                                    |
| S2  | **corrigida**                | O evento é o previsto e **traz `phone_number_id`**, além de `business_id` e listas vazias. Os ids vêm como texto de dígitos (o parser previsto aceita). A listagem da WABA continua útil como prova de posse e como alternativa.                                                         |
| S3  | **confirmada**               | O número já estava `CONNECTED` sem `/register`; enviou e recebeu sem PIN nosso.                                                                                                                                                                                                          |
| S4  | em aberto                    | Só foi testado com o aplicativo Business. O QR code e o caso do WhatsApp pessoal não foram anotados.                                                                                                                                                                                     |
| S5  | em aberto                    | A versão do aplicativo e os dias de uso não foram anotados.                                                                                                                                                                                                                              |
| S6  | **confirmada**               | Funcionou com número brasileiro.                                                                                                                                                                                                                                                         |
| S7  | **corrigida**                | O eco existe, no campo **`smb_message_echoes`**, com a lista em **`message_echoes[]`** (não em `messages[]`) e `from`/`to`/`id`/`timestamp`/`type`/`text.body`. O campo **precisa ser assinado** no app. `smb_app_state_sync` e `history` existem no painel, mas nada chegou sem pedido. |
| S8  | **confirmada**               | O envio pela Cloud API gerou só `statuses`, sem eco. O resultado `own` da E3 fica como defesa, não como caminho normal.                                                                                                                                                                  |
| S9  | não observada                | Nenhum `history` chegou. O histórico segue fora deste corte (E4, D6).                                                                                                                                                                                                                    |
| S10 | em aberto                    | As restrições no aplicativo e a regra de abrir o aplicativo periodicamente não foram anotadas.                                                                                                                                                                                           |
| S11 | em aberto                    | Não testada.                                                                                                                                                                                                                                                                             |
| S12 | **confirmada**               | Troca do `code` ok (token `SYSTEM_USER`, sem prazo informado). `debug_token` válido, com o app conferindo, escopos `whatsapp_business_management` e `whatsapp_business_messaging` (um alvo cada) e a WABA em `target_ids`. `phone_numbers` com 1 número; `subscribed_apps` = 200.        |
| S13 | em aberto                    | Não houve falha para observar.                                                                                                                                                                                                                                                           |
| S14 | **confirmada**               | O `config_id` atual serve. `WHATSAPP_COEXISTENCE_CONFIG_ID` não é necessário por ora.                                                                                                                                                                                                    |
| S15 | **descartada** (neste teste) | Com um portfólio em que o dono não é administrador, o fluxo terminou. O "sem permissão" visto antes deve ter outra causa (número em uso em outra plataforma, por exemplo). A lista de pré-requisitos da E1 deve rever o item (c).                                                        |
| S16 | **corrigida** (parcial)      | O fluxo de coexistência não pediu pagamento. A resposta dentro da janela veio como `free_customer_service`.                                                                                                                                                                              |
| S17 | em aberto                    | Só foi desassinado o app. O `DELETE .../channel` do Soprei não foi testado (a conexão não existia nele).                                                                                                                                                                                 |

**Critério para seguir:** S1, S2, S3, S7 e S8 confirmadas ou corrigidas e S6 confirmada: **atendido**. Os itens em aberto (S4, S5, S10, S11, S13, S17) não bloqueiam a implementação. Eles ficam para o teste manual da seção "Passos do dono" e para a redação final dos textos da E1 e da E4.

**Consequências para a implementação** (ajustes desta spec, sem decisão nova):

- **E2 (webhook):** o eco é lido em `value.message_echoes[]`, só do campo `smb_message_echoes`. O contato do eco é o `to` (no `messages` é o `from`).
- **E2 (status):** o mesmo status (`delivered`) pode chegar repetido; o tratamento de `statuses[]` precisa ser idempotente (conferir o atual).
- **E2 (serviço):** com `phoneNumberId` vindo do evento, o caminho `CHANNEL_NUMBER_AMBIGUOUS` vira exceção, mas continua (o evento não é confiável por si e a listagem da WABA é a prova de posse).
- **Passos do dono:** assinar `smb_message_echoes` (e não `history`). O `smb_app_state_sync` só se a E2 passar a ler esse campo.
- **Fora deste corte:** os campos `user_id` e afins são novos e podem afetar o `contactRef` no futuro. Ficam anotados e não são usados agora.

## Registro da implementação

Feito em **2026-11-12** por Claude Code (Opus 5.5, implementer), na branch `spec/039-conexao-por-coexistencia`, em dois commits de código (servidor e site) e um de documentação. Node 24.18 (o do `.nvmrc`). Nenhuma chamada real à Meta nem à Anthropic; testes só contra `soprei_test` e Redis `/15`.

### O que foi feito, por etapa

- **E1 (site):** com `coexistence.available` do servidor, a tela do Canal mostra "Como você quer conectar?" com os dois cartões (coexistência primeiro, com a orientação para quem usa o WhatsApp comum); o cartão de coexistência abre o checklist de 5 caixas (estado só em memória; "Continuar na Meta" só habilita com todas marcadas); `FacebookLoginOptions.extras.featureType = 'whatsapp_business_app_onboarding'` só nesse caminho; parser com a variante `finish_coexistence` (`wabaId` obrigatório, `phoneNumberId` opcional, mesma origem estrita, 8 KiB e ids `^[0-9]{1,32}$`); a máquina (`stepSignup`) guarda o `mode` da tentativa e cada fluxo só aceita o próprio evento de fim (o do outro vira `unsupported`); cancelamento ou falha da coexistência mostram "A conexão não terminou." e o texto fixo com as três causas (D9); mensagens novas por `error.code` (`CHANNEL_NUMBER_AMBIGUOUS`, `CHANNEL_COEXISTENCE_DISABLED`). Conectado em `COEXISTENCE`: bloco "Conectado pelo aplicativo" com a explicação da pausa. Sem a flag, a tela é a da 023.
- **E2 (servidor):** `WHATSAPP_COEXISTENCE_ENABLED` (padrão `false`; exige o canal e um `config_id`) e `WHATSAPP_COEXISTENCE_CONFIG_ID` (opcional; vazio = o do Embedded Signup, S14). `GET .../channel/setup` ganhou `coexistence: { available, configId }`. `POST .../channel/embedded-signup` aceita `mode: 'api_only' | 'coexistence'` (padrão `api_only`; `phoneNumberId` opcional só na coexistência; com a flag desligada, `coexistence` é 400 `CHANNEL_COEXISTENCE_DISABLED`). O ramo de coexistência troca o `code`, faz a mesma prova de posse (`debug_token`, números da WABA, `subscribed_apps`), resolve o número único da WABA quando falta (zero ou vários = 400 `CHANNEL_NUMBER_AMBIGUOUS`), 409 antes de gravar se o número é de outra empresa, **não chama `/register` nem gera PIN** (S3) e grava `mode = COEXISTENCE` na transação de sempre (auditoria `CHANNEL_CONNECTED`/`CHANNEL_TOKEN_REPLACED`). `PUT` manual e Embedded Signup sem `mode` gravam `API_ONLY` (modo sempre explícito). `GET .../channel` devolve `mode`. Métrica `channel_connections_total` com `action="coexistence"` e `result="ambiguous"`. Webhook: `smb_message_echoes` lido de `value.message_echoes[]` (o contato é o `to`), `history` e `smb_app_state_sync` contados como `ignored_type` e ignorados; `statuses[]` só gera métrica e log (nenhuma escrita), então status repetido é idempotente por construção (teste com `delivered` duas vezes).
- **E3 (eco e pausa):** job `echo` na fila `channel-inbound` (id determinístico `<companyId>_<externalId>`); `AttendanceService.recordHumanEcho` grava a mensagem `HUMAN` (`createdAt` = recebimento) e, na mesma transação, `extendAiPause` (`aiPausedUntil` = recebimento + 12 h, `aiIgnoreBefore` = recebimento, cada um só avança); eco repetido = `duplicate`; eco com o id de uma resposta nossa (`channelMessageId`) = `own` (só defesa, S8); mídia ou texto vazio = `[mídia enviada pelo atendente]`; texto cortado no teto. `listPending` exclui `createdAt <= aiIgnoreBefore`. `respondToPending` em pausa devolve `paused` sem LLM, sem resposta e sem envio e leva `aiIgnoreBefore` até a última pendente; a pausa é relida dentro da transação da resposta (sinal interno desfaz a transação) e o processador relê antes do `sendText` (resposta fica gravada sem `sentAt`). A mensagem `HUMAN` entra no histórico do modelo como turno do assistente. O eco nunca envia nada ao contato (nem o texto padrão); empresa suspensa = descartado. Métricas `channel_echo_events_total{result}`, `attendance_paused_turns_total`.
- **E4 (reativar e painel):** permissão `conversation:takeover` (OWNER, ADMIN e AGENT) e `POST /admin/companies/:companyId/conversations/:conversationId/ai/resume` (perfil `admin`, 204 idempotente, `:conversationId` malformado/inexistente/alheio = o mesmo 404, zera só `aiPausedUntil`, métrica `conversation_ai_resumes_total`, log só com ids, sem auditoria, D5). Lista e histórico ganharam `aiPausedUntil` (`null` se já passou). No site: bolha "Equipe (pelo celular)" do lado da empresa, faixa "A IA está pausada neste contato até HH:mm de dd/MM porque a equipe respondeu pelo celular" com "Reativar a IA" (sem o botão para quem não tem a permissão) e selo "IA pausada" (texto e ícone) na lista. O pedido de humano da 038 não é resolvido pelo eco (D4); o histórico importado não é tratado (D6); WABA com vários números é recusada (D8).

### Decisões tomadas dentro do aprovado

1. **`HUMAN` e o rollback da 037.** Mantido o valor de enum aprovado (D3), sem coluna paralela. Desenho mais seguro dentro disso: **nenhuma linha `HUMAN` é gravada com `WHATSAPP_COEXISTENCE_ENABLED` desligada** (o webhook só repassa ecos com a flag). Então o deploy da 039 com a flag desligada mantém o rollback para a versão anterior seguro; depois do primeiro eco gravado, voltar o código para antes da 039 quebra a leitura de mensagens. Registrado em `docs/ops/deploy.md` (Política de migration) e no cabeçalho da migration. Separar a migration do enum num deploy anterior não resolveria (o problema é o código antigo LER a linha, não a migration). Também: a CHECK `messages_sent_only_assistant_check` impede `sentAt` em mensagem que não é `ASSISTANT`; a `HUMAN` fica com `sentAt` nulo e o site não mostra indicador de envio para ela (mudar a CHECK exigiria `DROP CONSTRAINT`, não aditivo).
2. **`receivedAt` do eco = instante de chegada ao webhook** (o `stampReceivedAt` da 034, mensagens e ecos do mesmo corpo em sequência), e não o `timestamp` do eco. O `timestamp` vem em segundos, e misturar segundos com o carimbo de chegada das mensagens do contato inverteria a ordem dentro do mesmo segundo. A spec diz "a ordem vem do instante de recebimento, como na 034"; o campo do job tem o mesmo significado do job `text`.
3. **Relógio da pausa = relógio da aplicação (injetado)**, não o do banco: "sem SQL cru novo" impede comparar com `now()` do Postgres; a escrita (`extendAiPause`) é `updateMany` condicional, sem SQL cru.
4. **`aiPausedUntil` e `aiIgnoreBefore` como `TIMESTAMP(3)`** (sem fuso), como as outras datas de `conversations` e `messages`, para a comparação com `messages.created_at` ser homogênea. A spec citava `timestamptz`.
5. **Rótulos extras na métrica do eco:** além de `recorded`, `duplicate`, `own`, `unknown_number` e `invalid`, `discarded` (empresa suspensa) e `disabled` (eco recebido com a flag desligada). Conjunto fixo.
6. **Índice novo `messages(company_id, channel_message_id)`** para o teste `own` não varrer as mensagens da empresa a cada eco.
7. **Resolver o número da WABA** fica dentro da prova de posse (mesma listagem `GET /{waba}/phone_numbers`), antes do `subscribed_apps`.
8. **Reativar e pausar mexem em `Conversation.updatedAt`** (o `@updatedAt` do Prisma num `updateMany`): reativar sobe a conversa na lista, como uma atividade. Aceito para não usar SQL cru.
9. **A escolha só aparece no site com o Embedded Signup configurado** (o SDK precisa do `appId` e da versão que vêm de `embeddedSignup`), mesmo que o servidor aceite só o `WHATSAPP_COEXISTENCE_CONFIG_ID`.
10. **Checklist revisto pelo E0 (D9):** o item (c) virou "Você consegue entrar no portfólio de negócios da Meta que vai escolher, ou vai criar um novo", sem afirmar que ser administrador é requisito nem causa certa; o item (e) diz "se ela pedir" (o E0 não pediu pagamento).

### Desvios

- **Um commit de servidor para E2 a E4** (em vez de um por etapa): a migration, o schema e os repositórios atendem as três; separar exigiria `git add -p` interativo. O site é outro commit.
- **Contraste:** nenhum par de tokens novo (selo e faixa usam pares já em `theme/contrast.test.ts`: `foreground` sobre `muted`, variante `info` do `Alert`).

### Arquivos

- Migration `backend/prisma/migrations/20261112100000_channel_coexistence/` e `schema.prisma`.
- Domínio: `domain/takeover.ts` (12 h, texto de mídia, `isAiPaused`), entidades `conversation.ts`, `message.ts`, `channel-connection.ts`, repositórios e `permissions.ts`.
- Aplicação: `attendance/attendance.service.ts` (`recordHumanEcho`, `isAiPausedFor`, `activePause`, `resumeAi`, turno `paused`), `channel/channel-connection.service.ts`, `channel/channel-intake.service.ts` (`acceptEchoes`), `channel/channel-inbound.processor.ts` (job `echo`, releitura antes do envio), `ports/inbound-job-queue.ts`.
- Infraestrutura: `config/env.schema.ts`, `config/whatsapp.ts`, repositórios de conversa, mensagem e conexão, `mappers.ts`, `metrics/metrics.ts`, `http/server.ts`, `index.ts`.
- Apresentação: `admin/channel.controller.ts`, `admin/channel.validators.ts`, `admin/attendance.controller.ts`, `webhooks/whatsapp-webhook.controller.ts` e `.schemas.ts`.
- Site: `ChannelPage.tsx`, `embedded-signup-event.ts`, `embedded-signup-state.ts`, `facebook-sdk.ts`, `company-api.ts`, `conversation-format.ts`, `AiPauseBanner.tsx` (novo), `ConversationPage.tsx`, `ConversationsPage.tsx`, `CompanyArea.tsx`.
- Testes novos: `attendance-takeover.service.test.ts`, `channel-intake-echo.test.ts`, `channel-inbound-echo.processor.test.ts`, `whatsapp-webhook-echo.test.ts`, `channel-coexistence.integration.test.ts`, `whatsapp-coexistence.integration.test.ts`, `conversation-takeover.integration.test.ts`, `coexistence-migration.integration.test.ts`; no site `takeover.test.ts` e `e2e/coexistence.spec.ts`. Ajustados: `attendance.controller.test.ts`, `config.test.ts`, `permissions.test.ts`, `rate-limit.test.ts`, `persona.controller.test.ts`, `site-bridge.integration.test.ts`, `embedded-signup.test.ts`, `company-fixture.ts`, os testes que criam conexão (agora com `mode`) e `test-support` (`in-memory-attendance.ts`, `whatsapp-payloads.ts`).

### Verificação local (resultado real)

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` e `pnpm build` (raiz): verdes.
- `domain-vocabulary.test.ts`: verde (depois do `git add`).
- Unitários do servidor tocados, um arquivo por vez: os 4 novos (repetidos 4 vezes, sem falha), `attendance*.test.ts` (todos os 14 de `application/attendance/`), `attendance.controller.test.ts`, `notifications.controller.test.ts`, `persona.controller.test.ts`, `config.test.ts`, `permissions.test.ts`, `rate-limit.test.ts`, `whatsapp-webhook.controller.test.ts`, `channel-inbound.processor.test.ts`, `channel-intake.service.test.ts`, `inbound-job-queue.test.ts`, `metrics.test.ts`, `deploy-scripts.test.ts`: verdes.
- Integração (`soprei_test`, Redis `/15`; a migration foi aplicada só em `soprei_test`): os 4 novos (os três de fluxo repetidos 4 vezes, sem falha), `channel-embedded-signup`, `channel-connection`, `channel-credentials`, `channel-connection.repository`, `message.repository`, `conversation.repository`, `site-bridge` e `schema-catalog` (drift): verdes.
- Site: `pnpm --filter soprei-frontend test` (174 verdes); Playwright `coexistence.spec.ts` (18, desktop e celular, claro e escuro), `company.spec.ts`, `conversations.spec.ts`, `bubbles.spec.ts`, `notifications.spec.ts`, `onboarding.spec.ts` e `theme.spec.ts`: verdes no Windows (Edge).

### Não verificado

- A suíte completa (`pnpm test`, `pnpm test:integration`, todos os Playwright) e o CI: por decisão do dono, só no GitHub Actions.
- O smoke do processo compilado (não rodado; o `pnpm build` da raiz passou, com o aviso de tamanho de chunk que já existia).
- Nada com a Meta real: o formato do eco e do evento vêm só do E0; o comportamento do `DELETE .../channel` com uma conexão em coexistência (S17), as restrições do aplicativo (S10) e os eventos de falha do popup (S13) seguem em aberto.
- Empresa removida no eco: coberta pela resolução de número já existente (`findByWhatsappPhoneNumberId` não acha empresa removida), sem teste específico de eco para ela; `PlatformAdmin` na rota do Embedded Signup coberto pelos testes existentes da 023, não pelo arquivo novo.
- 360 px sem rolagem horizontal na tela do Canal com os cartões: não medido (o Playwright roda a 390 px).

### Correções da revisão (2026-11-12)

O `reviewer` aprovou para o CI sem bloqueantes. O dono aprovou todas as recomendações ("Aprovo todas"), aplicadas na mesma branch:

- **I-1, contato do eco:** `collectEchoes` usa o `contacts[].wa_id` quando o `value` traz um único eco e um único `wa_id` válido; senão, o `to`. Evita a segunda conversa (e a IA respondendo por cima da equipe) quando o `wa_id` vem com 12 dígitos e o `to` com 13. Teste em `whatsapp-webhook-echo.test.ts`. **O teste manual inclui um contato cujo `wa_id` tenha 12 dígitos.**
- **I-2, tipos que pausam:** só `text`, `image`, `audio`, `video`, `document` e `sticker` gravam a `HUMAN` e pausam (`ECHO_MEDIA_TYPES`); o resto vira `content.kind = 'ignored'` e o intake descarta com `ignored_type` (rótulo novo de `channel_echo_events_total`), sem job. `location` e `contacts` ficaram de fora porque não estavam na lista aprovada. Testes em `whatsapp-webhook-echo.test.ts` e `channel-intake-echo.test.ts`.
- **Rollback:** o dono aceitou que, depois do primeiro eco gravado, o código não volta para antes da 039 (já em `docs/ops/deploy.md`).
- **Texto do checklist:** saiu a frase "a Meta pode desconectar o número se ele ficar muito tempo sem uso" (não confirmada) do bloco "Conectado pelo aplicativo" (`ChannelPage.tsx`).
- **Reativar sobe a conversa na lista** (decisão 8 acima): aceito pelo dono.
- **S1:** a resposta barrada pela pausa logo antes do envio agora conta em `attendance_unsent_replies_total` (`channel-inbound.processor.ts`), como a E3 pede.
- **S2:** `humanEchoContent` remove NUL e os outros caracteres de controle (exceto tabulação e quebra de linha); só controle vira o texto de mídia. Sem isso o Postgres recusaria a gravação e o eco se perderia.
- **S3:** com a pausa já vencida, as pendentes gravadas **antes** do fim dela (`createdAt < aiPausedUntil`) ficam com a equipe (`dropWrittenDuringPause`: `aiIgnoreBefore` avança até a última delas). Depois de "Reativar a IA" (`aiPausedUntil = null`) a regra não se aplica. Teste em `attendance-takeover.service.test.ts`.
- **Não alterados (anotados):** sugestões 4 a 9 da revisão (relógio da pausa, `TIMESTAMP(3)`, releitura sem `FOR UPDATE`, ordem do `subscribed_apps`, eco de empresa removida sem métrica própria, alinhamento do `schema.prisma`, reativar com a assinatura bloqueada).
- **Verificação local:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check` verdes; unitários `attendance-takeover.service`, `attendance.service`, `channel-inbound-echo.processor`, `channel-inbound.processor`, `channel-intake-echo`, `channel-intake.service`, `whatsapp-webhook-echo` e `domain-vocabulary` (179 testes) verdes. Integração não rodada de novo (o CI roda).
