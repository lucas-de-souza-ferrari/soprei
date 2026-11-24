# 035 — Resiliência do atendimento: retomar o que ficou sem resposta e limpar a fila

- **Status:** em implementação (aprovada pelo dono em 2026-11-23, "Aprovo todas": D1 a D9 como recomendadas; E1 a E4 implementadas, revisadas as E1 a E3; aguardando CI)
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
- `attendance_resume_runs_total{result}` (`ok`, `error`), `attendance_resume_targets_total{kind,result}` (`kind`: `pending`, `unsent`; `result`: `scheduled`, `skipped_limit`, `failed`), `queue_cleaned_jobs_total{state}` (`completed`, `failed`). Nenhum label com empresa, contato ou id.
- Log só com contagens e o resultado da execução; por contato, nada (o `contactRef` existe só dentro do job, como hoje).

## Critérios de aceite

E1 (integração com Postgres, BullMQ e Graph falso reais, relógio injetado, sondagem com prazo; padrão de `channel-batching.integration.test.ts`):

- [ ] Mensagem pendente sem job na fila (job apagado à mão) é respondida depois de uma execução da varredura; a resposta chega ao Graph falso uma única vez. *(teste de integração escrito; só roda no CI)*
- [x] Depois de uma falha final do `flush` (modelo falhando), a varredura retoma; com o modelo de volta, o contato recebe a resposta. Com o modelo ainda falhando, o `flush` de retomada **não** envia o texto padrão (o Graph falso recebe o texto padrão uma única vez, o da falha original). *(unitário passando; ver o desvio 3 no Registro: falha do modelo já vira resposta de fallback, então o caso real é erro de banco ou Redis)*
- [ ] Empresa em `TOKEN_INVALID` não é retomada; depois de reconectar (`PUT` do canal), a execução seguinte retoma. *(teste de integração escrito; só roda no CI)*
- [ ] Não são retomados: empresa suspensa, empresa removida, conversa com a IA pausada, conversa do simulador, pendente com menos de `RESUME_MIN_AGE`, contato cuja mensagem mais recente passou de `RESUME_WINDOW`. *(simulador e teste do site: unitário passando; os demais: integração escrita, só no CI)*
- [ ] O mesmo contato é retomado no máximo `RESUME_MAX_ATTEMPTS` vezes em 24 horas; a tentativa seguinte conta `skipped_limit` e não agenda. *(a varredura com contador falso: unitário passando; o contador no Redis: integração escrita, só no CI)*
- [ ] **Isolamento:** com duas empresas com pendentes, cada `flush` agendado leva o `companyId` e o número da própria empresa; a resposta de uma nunca sai pelo número da outra; a consulta de cada empresa não devolve contato da outra. *(teste de integração escrito; só roda no CI)*
- [x] Mais contatos que `RESUME_MAX_CONTACTS_PER_RUN`: a execução agenda só o limite e a seguinte continua de onde parou (rodízio). *(teste unitário passando; corrigido na revisão, S3: a seguinte recomeça na empresa que ficou pela metade)*
- [ ] Duas execuções seguidas sem o `flush` ter rodado não criam dois jobs para o mesmo contato (deduplicação da fila). *(sem teste novo: é a deduplicação do modo `ensure`, já coberta em `inbound-queue.integration.test.ts`, spec 013)*
- [x] Job de `flush` sem o campo `resume` (formato antigo) continua válido. *(teste unitário passando)*
- [x] O texto das mensagens, o `contactRef` e o telefone não aparecem em log nem em `/metrics` (captura de log com sentinelas). *(log da varredura e `/metrics`: unitário passando; o fluxo completo: integração, só no CI)*
- [ ] Com `CHANNEL_RESUME_INTERVAL_MINUTES=0` ou com o canal desligado, o timer não existe; o `closeInfrastructure` para o timer e espera a execução ativa. *(sem teste novo: a ligação no `index.ts` não tem teste; `0` desligar é o comportamento de `startPurgeTimer`, já testado; a variável tem teste de config)*

E2:

- [x] Resposta gravada sem `sentAt` (envio recusado de forma permanente) é reenviada pela varredura sem nova chamada ao modelo (o contador de chamadas do provedor de teste não muda) e ganha `sentAt`. *(unitário passando; o fluxo completo: integração, só no CI)*
- [x] Resposta segurada pela pausa da 039 **nunca** é reenviada, nem depois de a pausa vencer. *(unitário do atendimento passando; a leitura: integração, só no CI)*
- [x] `flush` novo com resposta anterior sem `sentAt`: a anterior chega ao Graph falso **antes** da nova, e as duas ganham `sentAt`. *(unitários do processador e do atendimento passando; a ordem no Graph falso: integração reescrita, só no CI)*
- [x] Resposta sem `sentAt` de conversa do simulador nunca é enviada ao canal. *(teste unitário passando)*
- [ ] Envio que deu certo com gravação de `sentAt` falha: a retomada reenvia uma vez (duplicata aceita, D5) e para. *(sem teste: decorre de `sentAt` nulo virar reenvio; risco aceito na D5)*

E3:

- [ ] Job concluído mais velho que o prazo é apagado por uma execução sem nenhum outro job ter terminado; o mais novo que o prazo fica. *(teste de integração escrito; só roda no CI)*
- [ ] Job falho idem, com o prazo dos falhos. *(teste de integração escrito; só roda no CI)*
- [ ] Jobs ativos, em espera e atrasados nunca são apagados. *(teste de integração escrito; só roda no CI)*
- [ ] Depois da limpeza, nenhuma chave do Redis sob o prefixo da fila de teste contém o texto ou o `contactRef` dos jobs apagados. *(teste de integração escrito; só roda no CI)*

E4:

- [x] `attendance.service.ts` tem menos de 900 linhas e as mesmas assinaturas públicas (teste de texto). *(`attendance-structure.test.ts`, passando: 881 linhas)*
- [ ] `pnpm test` e `pnpm test:integration` no CI com as mesmas contagens de antes da E4; nenhum arquivo de teste alterado além de imports. *(unitários locais: 1.919 verdes e 11 pulados, antes e depois, sem alterar nenhum teste; a integração, só no CI)*

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

Nenhuma dependência nova. Com a D3 recomendada, **nenhuma migration** (a revisão acrescentou uma, aditiva, para o I4: ver o Registro). Decisões para o dono:

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

## Registro da implementação

### E1 a E3 (2026-11-23, Claude Code, branch `spec/035-resiliencia-do-atendimento`, empilhada sobre a 043)

- **Arquivos novos:** `domain/attendance-resume.ts` (limites e `isReplyResendable`), `application/ports/attendance-resume.ts` (`ResumeTargetReader`, `ResumeAttemptStore`), `application/channel/attendance-resumer.ts` (a varredura), `infrastructure/database/repositories/attendance-resume-reader.ts` (`PrismaResumeTargetReader`), `infrastructure/auth/redis-resume-attempts.ts` (`RedisResumeAttemptStore`). **Alterados:** `InboundJobQueue` (campo `resume` opcional no `flush`; porta nova `InboundQueueCleaner`), `createInboundQueue` (`cleaner`), `AttendanceService.respondToPending`, `ChannelInboundProcessor`, `contact-label.ts` (`isPhoneContactRef`), `env.schema.ts` e `.env.example` (`CHANNEL_RESUME_INTERVAL_MINUTES`), `metrics.ts`, `index.ts`. **Sem migration e sem dependência nova.**
- **Desvios, com o motivo:**
  1. **Métrica `attendance_resume_targets_total`** em vez de `attendance_resume_contacts_total`: o teste de métricas do canal proíbe a palavra "contact" no corpo de `/metrics` (é a mesma proteção que obrigou a exceção do contato comercial da 040).
  2. **`RespondToPendingOptions.resumeUnsent` saiu:** com a D6 a resposta anterior não enviada sai em qualquer tentativa, então a opção perdeu o sentido; o processador não a passa mais. A regra única é `isReplyResendable` (dentro da janela de 23 h e não segurada pelo `aiIgnoreBefore`), aplicada também quando não há pendentes.
  3. **O critério "falha do modelo"** estava errado na spec: falha do modelo no lote já grava a resposta de fallback (spec 013), então nada fica pendente. O caso real de "falha final antes de existir resposta" é erro de banco ou de Redis; ele é provado por teste unitário (o `flush` de retomada não repete o texto padrão, nem pelo handler nem pela falha fora dele).
  4. **Limites em `domain/`:** além dos da spec, `RESUME_MAX_COMPANIES_PER_RUN` (50) e `RESUME_MAX_CONTACTS_PER_COMPANY` (50) limitam a leitura por execução; `QUEUE_CLEAN_BATCH` (1.000) a limpeza.
  5. **Empresa sem conexão própria (`LEGACY`, token global) também é retomada**; com conexão, só a `CONNECTED`.
  6. **Contador de tentativas** no Redis da autenticação, com o prefixo `AUTH_REDIS_PREFIX` e a mesma identidade do `flush` (`flushKey`: `companyId` e hash do contato, sem o telefone).
  7. **A varredura e a limpeza rodam no mesmo timer próprio**, parado junto com os outros timers no `closeInfrastructure`, antes de a fila fechar.
- **Verificado localmente (Windows, Node 26.13.1, não o 24 do `.nvmrc`):** `typecheck`, `lint`, `format:check`; **todos os unitários do backend** (1.922 testes: 1.911 verdes, 11 pulados, 0 falhas); as três suítes mais tocadas repetidas 3 vezes (118 verdes em cada).
- **Não rodado (não há Postgres nem Redis de teste nesta máquina):** os testes de integração novos ou alterados: `attendance-resume-reader.integration.test.ts` (10), `redis-resume-attempts.integration.test.ts` (3), a limpeza em `inbound-queue.integration.test.ts` (3), os 4 cenários de ponta a ponta em `channel-batching.integration.test.ts` e o cenário reescrito da limitação da 013 (agora prova o reenvio antes da resposta nova). O CI decide.
- **E4 (fatiar `attendance.service.ts`) não foi feita.** Pela D8 ela é um PR só de movimentação, depois deste.

### Revisão (2026-11-23, `reviewer`; correções aplicadas no mesmo dia)

O `reviewer` não aprovou a primeira versão: três bloqueantes e quatro importantes. Verificou e achou correto: a barreira de tenant da leitura, o contador no Redis, a D4 nos dois caminhos, a semântica do `queue.clean` do BullMQ 6.4.2, o timer e o desligamento, a privacidade e a relação entre a pausa da 039 e o `aiIgnoreBefore`.

- **B1 (aplicado): laço sem fim de reenvio.** Com a D6, um reenvio que falhava de vez (131042, 368, 131026, 190 em empresa `LEGACY`, número trocado) reagendava o turno seguinte, que reenviava de novo, sem espera, por até 23 h, e as mensagens novas do contato nunca eram respondidas (o `reviewer` provou com 50 voltas). Correção: quando o que falhou de vez foi o **reenvio** e há pendentes, o próximo `flush` leva `skipUnsent: true` (campo opcional do job; `RespondToPendingOptions.skipUnsent`) e responde as pendentes sem tentar a resposta antiga. Custo residual: cada mensagem nova do contato tenta o reenvio uma vez. Testes unitários novos.
- **B2 (aplicado):** o teste de limpeza deixava o job recente terminar depois de o antigo vencer, e a própria conclusão do BullMQ apagaria o antigo. Agora o recente termina antes do prazo do antigo.
- **B3 (aplicado):** `channel-credentials.integration.test.ts` (190, reconexão e lote) foi ajustado à D6: o primeiro `flush` depois do token novo reenvia a resposta da primeira mensagem, e o seguinte responde o lote.
- **I2 (aplicado): o reenvio ignorava cota e assinatura (031).** Agora passa pela mesma checagem (`resendOrBlocked`): bloqueado, nada sai.
- **I3 (aplicado):** pendentes já tratadas pela equipe (até o `aiIgnoreBefore`) não entram mais na varredura (antes gastavam as 3 tentativas do contato e ocupavam as vagas por empresa).
- **S1 (aplicado):** `isPhoneContactRef` contava caracteres não numéricos (`/D/` no lugar de `/\D/`).
- **S2 (aplicado):** as consultas filtram `updatedAt` dentro da janela (usa o índice da 024; plano de consulta não verificado, sem banco).
- **S3 (aplicado):** no teto de 200, a execução seguinte recomeça na empresa que ficou pela metade (as já agendadas dela são deduplicadas na fila; podem gastar uma tentativa a mais do contador, risco aceito).
- **S4 (aplicado):** os testes de ponta a ponta filtram chamadas ao modelo e envios pela empresa do teste.
- **S5 (aplicado): o texto padrão de falha (`isFallback`) nunca é reenviado** (coerente com a D4). Um teste unitário antigo de privacidade foi ajustado: o envio bem-sucedido vem da mensagem seguinte.
- **S6 (aplicado):** sem `WHATSAPP_ACCESS_TOKEN`, empresas sem conexão própria (`LEGACY`) ficam fora da varredura (`includeLegacy`).
- **S7 (aplicado):** a área do canal não descreve mais a regra antiga da retentativa.
- **S8 (registrado):** a marca `resume` passa para os `flush` de continuação do mesmo contato, que também não mandam o texto padrão.
- **I1 e I4 (decisão do dono, 2026-11-23: corrigir os dois; aplicados):**
  - **I1, simulador com telefone real:** a retomada (varredura e D6) só reenvia resposta que **atendeu um lote do canal** (alguma mensagem do contato aponta para ela em `answeredById`, spec 013); a resposta do simulador nunca atende lote, então nunca vai ao canal, qualquer que seja o `contactRef`. O simulador não mudou. `MessageRepository.isBatchReply`; na leitura, `answers: { some: { companyId } }`.
  - **I4, envio aceito pela Meta sem id:** migration aditiva `20261123100000_message_delivery_uncertain` (`messages.delivery_uncertain_at`, anulável, com CHECK de só `ASSISTANT`). O processador marca a resposta (`MessageRepository.markDeliveryUncertain`) quando o envio volta com status 2xx e sem id legível; `isReplyResendable` e a leitura excluem a resposta marcada. A decisão da spec 011 (não retentar esse caso) volta a valer.
  - **Testes novos:** unitários (processador: marca e não reenvio; atendimento: resposta do simulador com telefone não é reenviada), `message-delivery.integration.test.ts` (origem, marca, isolamento entre empresas e o CHECK) e um cenário a mais em `attendance-resume-reader.integration.test.ts`.
  - **Desvio declarado:** a spec dizia "nenhuma migration"; a correção do I4 exige uma, aditiva e compatível com a versão anterior do código (o código antigo ignora a coluna).
- **Não verificado:** os testes de integração (só no CI), planos de consulta, o efeito da D6 nos testes de privacidade e de coexistência de `whatsapp-channel.integration.test.ts` (que passam por um reenvio a mais).

### E4 (2026-11-24, Claude Code, Opus 5.5, branch `spec/035-e4-fatiar-atendimento`, empilhada sobre a 035)

- **Só movimentação, sem mudar a lógica.** O `attendance.service.ts` (2.034 linhas) virou cinco arquivos em `application/attendance/`: `attendance.types.ts` (tipos, constantes e contratos), `attendance-prompt.ts` (`buildSystemPrompt`, estilo e a classe `AttendancePrompt`: conhecimento, agenda e ferramentas), `attendance-llm.ts` (classe `AttendanceLlm`: histórico, chamada ao provedor, texto final, cotas, medição e métricas do modelo), `attendance-takeover.ts` (classe `AttendanceTakeover`: eco e pausa da 039 e o pedido de humano da 038) e o serviço, com 881 linhas, que compõe as três classes.
- **Desvios da tabela da E4:** (1) o pedido de humano (038) foi para `attendance-takeover.ts` (atendimento humano), não ficou no serviço: sem isso o serviço passava das 900 linhas; (2) `toReply`, `toResult`, `selectBatch` e o sinal interno da pausa continuam no serviço; (3) o serviço **reexporta** o que exportava (`export *` de `attendance.types.ts`, mais `buildSystemPrompt`, `ATTENDANCE_STYLE_INSTRUCTION` e `humanEchoContent`), então nenhum chamador nem teste mudou de import.
- **Conferência linha a linha:** toda linha não vazia do serviço antigo (1.916) existe, igual, num dos cinco arquivos, descontados `private`, `export`, o prefixo `this.llm.`/`this.prompt.`/`this.takeover.` nas chamadas e os imports. Ausentes: 0.
- **Teste novo:** `attendance-structure.test.ts` (tamanho do serviço, interface pública da classe, reexportações e composição).
- **Verificado localmente (Windows, Node 26.13.1):** `typecheck`, `lint`, `format:check`; todos os unitários do backend com a mesma contagem de antes (1.919 verdes, 11 pulados), mais os 4 do teste novo. **Não rodado:** integração (só no CI).

