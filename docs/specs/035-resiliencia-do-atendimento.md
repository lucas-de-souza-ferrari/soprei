# 035 — Resiliência do atendimento: retomar o que ficou sem resposta e limpar a fila

- **Status:** rascunho
- **Branch:** `spec/035-resiliencia-do-atendimento` (uma branch por etapa, se o dono preferir PRs menores)
- **Depende de:** 011 (canal e fila), 013 (agrupamento, `flush`), 015 (credencial por empresa, `TOKEN_INVALID`), 031 (retomada depois do pagamento), 034 (concorrência e guarda do processo), 039 (pausa da IA).
- **Numeração:** o número 035 estava reservado para "eficiência do turno". O dono priorizou em 2026-11-23 a parte de **resiliência**; a parte de eficiência (leituras repetidas por job, prompt caching, índice de busca) fica em "Fora de escopo" e ganha número novo quando for a vez.
- **Esta spec passa pelo `reviewer`** antes do merge: há uma leitura que percorre todas as empresas, reenvio de mensagens a contatos e mudança no caminho de falha do canal.

## Objetivo

Hoje, quando uma resposta ao contato não sai, **nada tenta de novo sozinho**: a pessoa escreveu no WhatsApp da empresa e fica sem resposta até escrever outra vez. E os jobs da fila, que carregam o texto e o telefone do contato, podem ficar no Redis por tempo indefinido. Esta spec faz o sistema retomar sozinho, com limites, o que ficou pelo caminho, e limpa a fila de verdade.

## Estado atual (lido no código em 2026-11-23)

Situações em que o contato fica sem resposta e só uma mensagem nova dele destrava:

1. **Falha final do `flush` antes de existir resposta** (`ChannelInboundProcessor.onAttendanceFailure`): esgotadas as tentativas ou em erro permanente, o contato recebe o texto padrão e as mensagens **continuam pendentes**.
2. **Resposta gravada e não enviada** (`sentAt` nulo): o envio falhou de vez, ou o contato escreveu durante o backoff e o `replace` da fila trocou o job em retentativa por um novo (limitação registrada na 013). `respondToPending` só reenvia a resposta anterior quando `resumeUnsent` é verdadeiro, e o processador só o passa em **retentativa** (`attempt > 1`); num `flush` novo a resposta anterior fica para trás, com um `warn` e a métrica `attendance_unsent_replies_total`.
3. **Credencial recusada** (`TOKEN_INVALID`): o `flush` é descartado sem chamar o modelo; depois de a empresa reconectar, nada reagenda.
4. **Job perdido**: queda do processo entre gravar a mensagem e agendar o `flush`, ou perda do Redis. A mensagem está no banco, pendente, e não há job.
5. **Cota ou assinatura** (`outcome: 'blocked'`): este caso **já tem retomada**, pelo `PendingReplyResumer` depois de um pagamento (`application/billing/pending-reply-resumer.ts`), que reagenda o `flush` em modo `ensure`. É o modelo que esta spec generaliza.

O que **não** deve ser retomado:

- resposta gravada e não enviada **de propósito** porque a equipe assumiu a conversa pelo celular (039: pausa relida antes do envio);
- conversas do simulador (`contactRef` que não é telefone; nelas `sentAt` é sempre nulo);
- empresa suspensa ou removida;
- contato cuja última mensagem tem mais de 24 horas: a Meta recusa texto livre fora da janela de atendimento (o processador já trata esse erro como permanente).

Fila (`infrastructure/queue/inbound-queue.ts`): jobs `text` e `notice` usam `removeOnComplete: { age }` e `removeOnFail: { age }`. Isso é retenção **mínima**: o BullMQ só apaga por idade quando outro job termina. Sem tráfego, o último job, com texto e `contactRef`, fica no Redis sem prazo. A spec 032 (D8) fixou 1 hora para concluídos e 24 horas para falhos "com limpeza de verdade".

`attendance.service.ts` tem 1.986 linhas e junta aceitar mensagem, lote, prompt (conhecimento, agenda, ferramentas), chamada ao provedor, cota e medição, pausa e eco da equipe, e pedido de atendimento humano.

## Comportamento esperado

### E1 — Retomada das mensagens pendentes

1. **Varredura periódica** (`AttendanceResumer`, em `application/channel/`), no molde dos timers que já existem (`startPurgeTimer`: sem sobreposição, `unref`, parada e espera no `closeInfrastructure`). Só existe com `WHATSAPP_ENABLED=true`. Intervalo `CHANNEL_RESUME_INTERVAL_MINUTES` (padrão 5; `0` desliga).
2. **O que ela procura:** contatos do canal com mensagem do contato **pendente** (a definição da 013: papel `USER`, sem `answeredById` e sem resposta por `replyToId`) em que:
   - a mensagem pendente mais antiga tem mais de `RESUME_MIN_AGE` (5 minutos: bem acima da janela de agrupamento mais o prazo do modelo, para não disputar com o fluxo normal);
   - a mensagem **mais recente do contato** na conversa tem menos de `RESUME_WINDOW` (23 horas: dentro da janela de 24 horas da Meta, com margem);
   - a empresa está ativa, não removida e com número conectado; a conexão não está em `TOKEN_INVALID`;
   - a conversa não está com a IA pausada (`aiPausedUntil` no futuro);
   - o `contactRef` é um telefone (mesma regra de `describeContact`).
3. **O que ela faz:** para cada contato, agenda o `flush` em modo `ensure`, sem espera, com a marca `resume: true` no job (campo novo e **opcional**: job antigo sem o campo continua válido). O `flush` relê tudo no banco, como hoje (empresa, número, credencial, cota, pausa); a varredura só acorda.
4. **Limites:** no máximo `RESUME_MAX_ATTEMPTS` (3) retomadas por contato a cada 24 horas (D3) e `RESUME_MAX_CONTACTS_PER_RUN` (200) contatos por execução, percorrendo as empresas em rodízio para nenhuma monopolizar. Estourado o limite do contato, ele não é mais retomado sozinho (conta `skipped_limit`) e segue visível no painel.
5. **`flush` de retomada que falha não manda o texto padrão.** Quem já recebeu "tive um problema" não recebe a mesma frase a cada tentativa. Em `onAttendanceFailure`, job com `resume: true` só registra e conta.
6. **Isolamento:** a leitura parte da lista de empresas (model global) e, para cada uma, consulta conversas e mensagens **com o `companyId` no `where`**, pela barreira de tenant, sem SQL cru, exatamente como `PrismaPendingReplyReader`. O `companyId` do job vem dessa leitura; o `phoneNumberId` é o que o banco associa à empresa.

### E2 — Resposta gravada e não enviada

1. A mesma varredura procura respostas do assistente com `sentAt` nulo, criadas há mais de `RESUME_MIN_AGE`, com a mensagem mais recente do contato dentro de `RESUME_WINDOW`, nas mesmas condições de empresa, credencial e telefone, **e que não tenham sido seguradas de propósito**: fica de fora a resposta com `createdAt` menor ou igual ao `aiIgnoreBefore` da conversa, e toda conversa com a IA pausada.
2. O `flush` de retomada chama `respondToPending` com `resumeUnsent: true`: a resposta gravada sai **sem nova chamada ao modelo**, e as pendentes que houver são respondidas no turno seguinte, como já acontece na retentativa.
3. **Correção da limitação da 013 (D6):** um `flush` **novo** (primeira tentativa) que encontra a resposta anterior sem `sentAt` passa a reenviá-la **antes** de responder as novas, com as mesmas regras de exclusão do item 1 e só se ela tiver menos de `RESUME_WINDOW`. A ordem das mensagens no WhatsApp fica a certa. `attendance_unsent_replies_total` passa a contar só o que ficou de fora dessas regras.
4. **Duplicata aceita (D5):** se o envio deu certo e só a gravação de `sentAt` falhou (banco fora logo depois do envio), a retomada reenvia uma resposta que o contato já recebeu. É a regra "pode duplicar, nunca perder" da 011, que hoje só valia em queda do processo.

### E3 — Limpeza de verdade dos jobs

1. Na mesma execução periódica, a fila apaga os jobs **concluídos** com mais de `QUEUE_KEEP_COMPLETED_SECONDS` e os **falhos** com mais de `QUEUE_KEEP_FAILED_SECONDS` (limpeza por idade do BullMQ, em lotes de até 1.000 por estado e por execução), independentemente de haver tráfego.
2. Porta: `InboundJobQueue.cleanOldJobs()` devolve as contagens; `application` continua sem importar o BullMQ.
3. A regra cruzada que já existe (`QUEUE_BACKOFF_MS x (2^(QUEUE_ATTEMPTS - 1) - 1)` maior que `ATTENDANCE_IN_FLIGHT_TIMEOUT_MS`) não muda. A limpeza nunca toca job ativo, em espera ou atrasado.

### E4 — Fatiar `attendance.service.ts` (sem mudança de comportamento)

Depois de E1 a E3, num PR só de movimentação, no molde da 012: nenhuma asserção de teste muda, as suítes rodam com os mesmos nomes e contagens.

| Arquivo novo em `application/attendance/` | O que recebe |
| --- | --- |
| `attendance.types.ts` | tipos e constantes exportados (`AttendanceDeps`, `AttendanceResult`, `PendingResponse`, limites) |
| `attendance-prompt.ts` | `buildSystemPrompt`, `buildPrompt`, `knowledgePart`, `schedulePart`, `toolsPart` |
| `attendance-llm.ts` | `callProvider`, `loadHistory`, `finalizeReply`, leitura de cota e medição (`readEntitlements`, `blockedBy`, `recordUsage`) |
| `attendance-takeover.ts` | eco da equipe e pausa da IA (`recordHumanEcho`, `pausedResponse`, `dropWrittenDuringPause`, `resumeAi`) |

`AttendanceService` continua sendo a única classe que o resto do sistema conhece (mesmos métodos públicos) e passa a delegar. Meta: menos de 900 linhas no serviço. O teste de vocabulário e os de camadas continuam valendo.

### Configuração e métricas

- `CHANNEL_RESUME_INTERVAL_MINUTES` (0 a 1.440, padrão 5; `0` desliga a retomada **e** a limpeza), validada no módulo de config e documentada em `.env.example`. Os demais limites são constantes nomeadas em `domain/` (D2 a D4), como nas specs 025 a 028.
- `attendance_resume_runs_total{result}` (`ok`, `error`), `attendance_resume_contacts_total{kind,result}` (`kind`: `pending`, `unsent`; `result`: `scheduled`, `skipped_limit`, `failed`), `queue_cleaned_jobs_total{state}` (`completed`, `failed`). Nenhum label com empresa, contato ou id.
- Log só com contagens e o resultado da execução; por contato, nada (o `contactRef` existe só dentro do job, como hoje).

## Critérios de aceite

E1 (integração com Postgres, BullMQ e Graph falso reais, relógio injetado, sondagem com prazo; padrão de `channel-batching.integration.test.ts`):

- [ ] Mensagem pendente sem job na fila (job apagado à mão) é respondida depois de uma execução da varredura; a resposta chega ao Graph falso uma única vez.
- [ ] Depois de uma falha final do `flush` (modelo falhando), a varredura retoma; com o modelo de volta, o contato recebe a resposta. Com o modelo ainda falhando, o `flush` de retomada **não** envia o texto padrão (o Graph falso recebe o texto padrão uma única vez, o da falha original).
- [ ] Empresa em `TOKEN_INVALID` não é retomada; depois de reconectar (`PUT` do canal), a execução seguinte retoma.
- [ ] Não são retomados: empresa suspensa, empresa removida, conversa com a IA pausada, conversa do simulador, pendente com menos de `RESUME_MIN_AGE`, contato cuja mensagem mais recente passou de `RESUME_WINDOW`.
- [ ] O mesmo contato é retomado no máximo `RESUME_MAX_ATTEMPTS` vezes em 24 horas; a tentativa seguinte conta `skipped_limit` e não agenda.
- [ ] **Isolamento:** com duas empresas com pendentes, cada `flush` agendado leva o `companyId` e o número da própria empresa; a resposta de uma nunca sai pelo número da outra; a consulta de cada empresa não devolve contato da outra.
- [ ] Mais contatos que `RESUME_MAX_CONTACTS_PER_RUN`: a execução agenda só o limite e a seguinte continua de onde parou (rodízio).
- [ ] Duas execuções seguidas sem o `flush` ter rodado não criam dois jobs para o mesmo contato (deduplicação da fila).
- [ ] Job de `flush` sem o campo `resume` (formato antigo) continua válido.
- [ ] O texto das mensagens, o `contactRef` e o telefone não aparecem em log nem em `/metrics` (captura de log com sentinelas).
- [ ] Com `CHANNEL_RESUME_INTERVAL_MINUTES=0` ou com o canal desligado, o timer não existe; o `closeInfrastructure` para o timer e espera a execução ativa.

E2:

- [ ] Resposta gravada sem `sentAt` (envio recusado de forma permanente) é reenviada pela varredura sem nova chamada ao modelo (o contador de chamadas do provedor de teste não muda) e ganha `sentAt`.
- [ ] Resposta segurada pela pausa da 039 **nunca** é reenviada, nem depois de a pausa vencer.
- [ ] `flush` novo com resposta anterior sem `sentAt`: a anterior chega ao Graph falso **antes** da nova, e as duas ganham `sentAt`.
- [ ] Resposta sem `sentAt` de conversa do simulador nunca é enviada ao canal.
- [ ] Envio que deu certo com gravação de `sentAt` falha: a retomada reenvia uma vez (duplicata aceita, D5) e para.

E3:

- [ ] Job concluído mais velho que o prazo é apagado por uma execução sem nenhum outro job ter terminado; o mais novo que o prazo fica.
- [ ] Job falho idem, com o prazo dos falhos.
- [ ] Jobs ativos, em espera e atrasados nunca são apagados.
- [ ] Depois da limpeza, nenhuma chave do Redis sob o prefixo da fila de teste contém o texto ou o `contactRef` dos jobs apagados.

E4:

- [ ] `attendance.service.ts` tem menos de 900 linhas e as mesmas assinaturas públicas (teste de texto).
- [ ] `pnpm test` e `pnpm test:integration` no CI com as mesmas contagens de antes da E4; nenhum arquivo de teste alterado além de imports.

Todas: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`; inventário de variáveis em `.env.example`; `docs/areas/canal-whatsapp.md` atualizado.

## Casos de borda e erros

- **Redis fora:** a varredura falha ao agendar, conta `error`, não derruba o processo e tenta na execução seguinte. O contador de tentativas (D3) fica no Redis: se ele se perder, o contato pode ganhar tentativas a mais, nunca a menos.
- **Banco fora:** a execução falha inteira e conta `error`.
- **Cota esgotada ou assinatura inativa:** o `flush` de retomada devolve `blocked` sem chamar o modelo, como hoje; consome uma tentativa. Depois do pagamento, a retomada da 031 continua valendo.
- **Mensagens tratadas pela equipe** (`createdAt` até o `aiIgnoreBefore`): a consulta da varredura pode listá-las como pendentes, mas o `flush` as descarta (`listPending` já as exclui). Custa uma tentativa, sem chamar o modelo nem enviar nada.
- **Pendências antigas no dia em que isto entra no ar:** a janela de 23 horas impede que mensagens de dias atrás recebam resposta agora.
- **Vários processos no futuro** (`PROCESS_ROLE`, 034 E4): duas varreduras simultâneas agendam o mesmo `flush` e a deduplicação da fila deixa um só; o contador de tentativas pode contar em dobro (erra para o lado seguro).
- **Contato escreve enquanto a retomada roda:** o `flush` é único por contato; a mensagem nova entra no mesmo turno ou no seguinte, como hoje.
- **Limpeza apaga um job falho que alguém queria inspecionar:** o prazo dos falhos é configurável (`QUEUE_KEEP_FAILED_SECONDS`, padrão 24 horas).

## Isolamento entre empresas

A varredura é o segundo ponto do sistema que percorre todas as empresas com o canal ligado (o primeiro é a retomada por assinatura). Ela lista empresas pelo model global e consulta os dados de cada uma com o `CompanyId` no `where`, pela camada de tenant, sem SQL cru. O `companyId` e o `phoneNumberId` do job vêm só do banco. O `flush` continua enviando pelo número que o banco associa ao `companyId` e descartando se o número mudou. Teste: o critério de isolamento da E1, com duas empresas.

## Fora de escopo

- Eficiência do turno: leituras repetidas por job, prompt caching, índice de busca com `company_id` (spec futura).
- Avisar a empresa no painel de que um contato ficou sem resposta (notificação nova): hoje a conversa mostra "Não enviada ao WhatsApp"; uma notificação própria é spec à parte.
- Responder fora da janela de 24 horas com mensagem de modelo (template) da Meta.
- Contatos por nome de usuário do WhatsApp (BSUID), que hoje são descartados.
- `PROCESS_ROLE` e o limite do webhook (034, E4 e E5).
- Retenção de conversas e exclusão de dados (032).

## Decisões e dependências novas

Nenhuma dependência nova. Com a D3 recomendada, **nenhuma migration**. Decisões para o dono:

- **D1 — Janela de retomada: 23 horas desde a última mensagem do contato.** Recomendado (a Meta só aceita texto livre por 24 horas). Alternativa: janela menor (por exemplo 6 horas), para não responder de madrugada algo da manhã anterior.
- **D2 — Idade mínima: 5 minutos**, e varredura a cada 5 minutos. Recomendado. O contato que caiu num buraco espera de 5 a 10 minutos pela resposta. Alternativa: 2 minutos e 2 minutos (mais rápido, mais consultas).
- **D3 — Limite de 3 retomadas por contato em 24 horas, contado no Redis** (chave derivada do `companyId` e do hash do contato, sem telefone, TTL de 24 horas). Recomendado: sem migration. Alternativa: coluna de tentativas na conversa (sobrevive à perda do Redis, exige migration).
- **D4 — `flush` de retomada não manda o texto padrão.** Recomendado. Alternativa: mandar o texto padrão só na última tentativa.
- **D5 — Aceitar a duplicata rara** quando o envio deu certo e a gravação de `sentAt` falhou. Recomendado (a alternativa é nunca reenviar resposta gravada, que é o problema de hoje).
- **D6 — `flush` novo reenvia antes a resposta anterior não enviada.** Recomendado: corrige a ordem e a limitação da 013. Alternativa: deixar só para a varredura (a resposta antiga chegaria depois da nova).
- **D7 — Limpeza com os prazos que já existem** (`QUEUE_KEEP_COMPLETED_SECONDS` 1 hora, `QUEUE_KEEP_FAILED_SECONDS` 24 horas, os da D8 da 032). Recomendado.
- **D8 — E4 (fatiar o serviço) nesta spec, por último e em PR próprio.** Recomendado: é só movimentação e fica mais barato de revisar separado. Alternativa: tirar da spec e fazer depois.
- **D9 — Reconexão do canal não dispara retomada imediata**; a varredura pega em até 5 minutos. Recomendado (menos código). Alternativa: o `PUT` do canal acorda as pendentes na hora, como o pagamento faz.

A conferir na implementação (não muda o desenho): se a consulta de pendentes por empresa usa o índice parcial `messages_pending_idx` da 013; se a limpeza por idade do BullMQ 6.4 remove também as chaves de deduplicação dos jobs apagados.
