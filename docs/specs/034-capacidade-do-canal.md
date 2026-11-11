# 034 — Capacidade do canal (worker concorrente e processo robusto)

- **Status:** rascunho
- **Branch:** `spec/034-capacidade-do-canal` (uma branch por etapa, se o dono preferir PRs menores; ver "Etapas")
- **Depende de:** 011 (fila e worker), 013 (agrupamento e `flush`), 005 (rate limit e `TRUST_PROXY`), 004 (métricas). Conversa com a **033** (deploy): esta spec entrega o que a 033 precisa para dimensionar e separar processos; não decide hospedagem.
- **Esta spec passa pelo `reviewer`** antes do merge (mexe em endpoint público, no limite do webhook e no caminho que carrega o `CompanyId` do job).
- **Origem:** auditoria de 2026-11-11 (leitura do código, sem teste de carga). O que está marcado **(S)** é **suposição** a conferir; o resto foi lido no código ou na documentação oficial listada em "Fontes externas".

## Objetivo

Hoje **todas as empresas dividem um único worker que processa um job por vez**, dentro do processo HTTP. Cada resposta segura esse worker durante a chamada ao LLM e o envio à Meta, então um contato lento atrasa todos os outros, de todas as empresas. Esta spec permite processar vários contatos ao mesmo tempo sem perder a ordem das mensagens de cada contato, separa o worker do servidor HTTP quando o dono quiser, e fecha as lacunas que fariam o processo cair ou encerrar mal sob carga.

## Estado atual (lido no código)

- **Concorrência 1 fixa:** `infrastructure/queue/inbound-queue.ts` cria o `Worker` com `concurrency: 1` (comentário: "preserva a ordem de chegada, decisão 2 da spec 011"); o worker é ligado em `src/index.ts` no mesmo processo do Fastify.
- **O que um job segura:** o `flush` chama o LLM (`LLM_TIMEOUT_MS`, ou até 30 s no turno com ferramentas da 028) e depois o envio (`WHATSAPP_SEND_TIMEOUT_MS`). **(S)** Com 2 a 5 s por turno, a vazão do sistema inteiro fica entre 12 e 30 respostas por minuto.
- **De onde vem a ordem das mensagens:** o webhook enfileira os jobs `text` em sequência (`ChannelIntakeService.accept`: "a ordem de chegada do lote é a ordem dos jobs (fila de concorrência 1)"). O `createdAt` de cada mensagem é o instante em que o job `text` a grava. `listPending`, `listBefore` e a janela do lote (013) ordenam por `createdAt` e `id`. **Com concorrência maior, duas mensagens do mesmo contato podem ser gravadas em ordem invertida.**
- **O que já é seguro em paralelo:** o `flush` é único por `(companyId, contactRef)` pela deduplicação do BullMQ no Redis (`keepLastIfActive`), e `markAnswered` desfaz a transação com `ConflictError` se outra execução respondeu parte do lote. `findOrCreateByContact` usa `createMany({ skipDuplicates })`.
- **Timestamp da Meta:** o schema do webhook (`presentation/webhooks/whatsapp-webhook.schemas.ts`) **não lê** o campo `timestamp` da mensagem.
- **Pool do banco:** `DB_POOL_MAX` padrão 10 (`env.schema.ts`).
- **Limite do webhook:** `RATE_LIMIT_WEBHOOK_MAX` padrão 600 por 60 s, por IP. A Meta envia também os eventos de status (`sent`, `delivered`, `read`) de cada resposta.
- **Processo:** não existe handler de `unhandledRejection` nem de `uncaughtException`. `SIGINT`/`SIGTERM` chamam `shutdown` **sem prazo global**. O worker espera o job ativo por 30 s fixos (`DEFAULT_WORKER_CLOSE_TIMEOUT_MS`), menos que um turno com ferramentas (30 s) somado ao envio (10 s).
- **Visibilidade:** `jobCounts()` existe, mas não vira métrica; `/health/ready` só olha banco e Redis. Fila acumulando não aparece em lugar nenhum.

## Etapas (pequenas e cortáveis)

| Etapa | O que entrega |
| --- | --- |
| **E1** | Ordem das mensagens independente da fila (`receivedAt` no job) e concorrência configurável (`QUEUE_CONCURRENCY`) |
| **E2** | Processo robusto: handlers de erro não capturado, prazo global de desligamento, espera do worker derivada da config |
| **E3** | Métricas da fila (profundidade, espera e duração) |
| **E4** | Papel do processo (`PROCESS_ROLE`): API e worker podem rodar separados |
| **E5** | Novo padrão do limite do webhook |

A E1 é a que muda a capacidade. E2 e E3 devem entrar **antes** de subir `QUEUE_CONCURRENCY` em produção. E4 e E5 podem ser cortadas para outra spec sem prejudicar as anteriores.

## Comportamento esperado

### E1: ordem por `receivedAt` e concorrência configurável

- O webhook passa a carimbar cada mensagem com o **instante de recebimento** (`receivedAt`, ISO UTC, relógio do servidor no momento em que o lote é lido). Dentro do mesmo lote, a mensagem de índice `i` recebe `base + i ms`, para que duas mensagens do mesmo lote nunca empatem.
- Os jobs `text` e `notice` ganham o campo **opcional** `receivedAt` no schema do job. Job sem o campo (enfileirado antes do deploy) continua válido e se comporta como hoje.
- `AttendanceService.acceptInboundMessage` grava a mensagem com `createdAt = receivedAt` quando o campo existe. Reentrega do mesmo `externalId` continua idempotente: vale a linha já gravada, o `receivedAt` da reentrega é ignorado.
- `receivedAt` fora da faixa plausível (mais de 24 h no passado ou mais de 1 min no futuro em relação ao relógio de quem processa) é descartado e a mensagem usa o relógio do banco, com `warn` só de `messageRef`.
- Nova variável **`QUEUE_CONCURRENCY`** (inteiro, 1 a 100, padrão conforme a decisão D2). O worker usa esse valor; o log de início informa a concorrência real. Com `1`, o comportamento é o de hoje.
- Regra cruzada na config: `DB_POOL_MAX` precisa ser **maior ou igual a `QUEUE_CONCURRENCY` + 5** (folga para as requisições HTTP e os timers); senão o boot falha com mensagem clara.
- O comentário e o texto do `AGENTS.md` que dizem "concorrência 1" passam a descrever a regra nova (a ordem vem de `receivedAt`, não da fila).
- A janela do lote (013) não muda de regra: continua contando a partir do `createdAt` da mensagem mais antiga pendente, que agora é o instante de recebimento. Efeito: o tempo que a mensagem esperou na fila passa a contar para a janela, o que é o comportamento desejado sob carga.

### E2: processo robusto

- `process.on('unhandledRejection')` e `process.on('uncaughtException')`: log `fatal` só com campos controlados (`describeError`, nunca o objeto inteiro), métrica `process_fatal_errors_total{kind}` e o **mesmo desligamento gracioso** dos sinais, saindo com código 1. Um segundo erro durante o desligamento encerra na hora.
- **Prazo global de desligamento:** nova variável `SHUTDOWN_TIMEOUT_MS` (padrão 60000; 5000 a 300000). Passou disso, log `error` e `process.exit(1)`.
- **Espera do worker derivada da config**, não mais 30 s fixos: `max(LLM_TIMEOUT_MS, prazo do turno com ferramentas quando SCHEDULE_AI_ENABLED) + WHATSAPP_SEND_TIMEOUT_MS + 5 s`. Regra cruzada: `SHUTDOWN_TIMEOUT_MS` precisa ser maior que essa espera.
- Sinal repetido (`SIGTERM` duas vezes) não inicia um segundo desligamento.

### E3: métricas da fila

- `queue_jobs{queue,state}` (gauge; `state` em `waiting`, `active`, `delayed`, `failed`), lido de `jobCounts()` a cada coleta de `/metrics`, com prazo curto; falha na leitura não derruba `/metrics` (o gauge fica sem amostra e conta `queue_metrics_errors_total`).
- `queue_job_duration_seconds{queue,kind}` (histograma; `kind` em `text`, `notice`, `flush`): tempo dentro do handler.
- `queue_job_wait_seconds{queue,kind}` (histograma): do instante em que o job ficou disponível (enfileiramento mais o atraso agendado) até o início do processamento. É o número que diz se falta concorrência.
- Nenhum label com `companyId`, contato, id de job ou `wamid`.

### E4: papel do processo

- Nova variável **`PROCESS_ROLE`**: `all` (padrão, comportamento de hoje), `api` ou `worker`.
- `api`: sobe o HTTP e **não** liga o worker da fila nem os timers periódicos (expurgo, reconciliação de pagamentos, avisos de cobrança).
- `worker`: liga o worker e os timers; do HTTP sobe **só** `/health`, `/health/ready` e `/metrics` (as demais rotas não são registradas, 404).
- Os dois papéis fazem as mesmas verificações de boot (banco, Redis, config). O log de boot informa o papel.
- Várias instâncias `api` e várias `worker` podem coexistir: a deduplicação do `flush` e as travas já ficam no Redis e no banco.

### E5: limite do webhook

- O padrão de `RATE_LIMIT_WEBHOOK_MAX` muda conforme a decisão D4. A variável continua configurável; `.env.example` e `AGENTS.md` explicam a conta (cada resposta gera vários eventos de status) e a relação com `TRUST_PROXY`.

## Critérios de aceite

**E1**

- [ ] O webhook põe `receivedAt` em cada job `text` e `notice`; num lote com três mensagens os valores são estritamente crescentes na ordem do payload (teste do controller).
- [ ] `acceptInboundMessage` grava `createdAt` igual ao `receivedAt` do job; sem o campo, usa o relógio do banco como hoje (teste de integração com Postgres).
- [ ] Dois jobs `text` do mesmo contato processados **na ordem inversa** à de recebimento resultam em `listPending` na ordem de recebimento, e o turno enviado ao LLM traz os textos nessa ordem (teste de integração).
- [ ] Reentrega do mesmo `externalId` com `receivedAt` diferente não altera o `createdAt` gravado.
- [ ] `receivedAt` mais de 24 h no passado ou mais de 1 min no futuro é ignorado, com `warn` sem texto nem contato.
- [ ] Job antigo sem `receivedAt` passa no schema e é processado.
- [ ] Com `QUEUE_CONCURRENCY=4` e quatro contatos cujo LLM falso demora, os quatro `flush` ficam ativos ao mesmo tempo (teste de integração da fila, com sondagem e prazo, sem sleep fixo).
- [ ] Com `QUEUE_CONCURRENCY=4`, dez mensagens seguidas do **mesmo** contato geram respostas sem duplicar nem pular mensagem, e nunca há dois `flush` do mesmo contato ativos juntos.
- [ ] Com `QUEUE_CONCURRENCY=4`, duas empresas com o mesmo `contactRef` são atendidas em paralelo sem que o histórico, a persona ou a resposta de uma apareça na outra.
- [ ] `QUEUE_CONCURRENCY` fora de 1 a 100 e `DB_POOL_MAX < QUEUE_CONCURRENCY + 5` fazem a config falhar com mensagem que cita as duas variáveis (teste de config).
- [ ] Com `QUEUE_CONCURRENCY=1` os testes existentes do canal passam sem alteração de expectativa.
- [ ] O teste de fluxo captura o log e prova que texto e `contactRef` não aparecem.

**E2**

- [ ] Uma promessa rejeitada sem tratamento gera um log `fatal` sem o objeto de erro inteiro, incrementa `process_fatal_errors_total{kind="unhandled_rejection"}`, dispara o desligamento gracioso e o processo sai com código 1 (teste de boot em processo filho).
- [ ] O mesmo para `uncaughtException`.
- [ ] Desligamento que não termina em `SHUTDOWN_TIMEOUT_MS` sai com código 1 e log `error` (teste com recurso falso que nunca fecha).
- [ ] A espera do worker no encerramento é a soma derivada da config (teste unitário da função que calcula) e `SHUTDOWN_TIMEOUT_MS` menor que ela faz a config falhar.
- [ ] Dois `SIGTERM` seguidos executam o desligamento uma vez só.

**E3**

- [ ] `/metrics` expõe `queue_jobs` com os quatro estados e os valores batem com `jobCounts()` (teste de integração da fila).
- [ ] `queue_job_duration_seconds` e `queue_job_wait_seconds` recebem uma observação por job processado, com `kind` correto.
- [ ] Redis da fila fora: `/metrics` responde 200 dentro do prazo e `queue_metrics_errors_total` sobe.
- [ ] Nenhuma série tem label fora dos conjuntos fixos (teste que percorre o registro).

**E4**

- [ ] `PROCESS_ROLE=api`: o worker não é ligado (um job enfileirado continua `waiting`) e nenhum timer periódico é criado.
- [ ] `PROCESS_ROLE=worker`: o job é processado; `/health`, `/health/ready` e `/metrics` respondem; qualquer rota de `/auth`, `/admin`, `/account` e `/webhooks` é 404.
- [ ] `PROCESS_ROLE=all` e ausência da variável: inventário de rotas e comportamento idênticos aos de hoje.
- [ ] Valor desconhecido de `PROCESS_ROLE` faz a config falhar.
- [ ] Um processo `api` e um `worker` contra o mesmo Redis e o mesmo banco completam o fluxo de ponta a ponta (webhook num, resposta enviada pelo outro).

**E5**

- [ ] O padrão novo de `RATE_LIMIT_WEBHOOK_MAX` está na config, no `.env.example` e no teste de config.
- [ ] O perfil `webhook` continua rodando antes da leitura do corpo e da verificação da assinatura (teste existente segue verde).

## Casos de borda e erros

- **Mensagem atrasada que chega depois da resposta:** se `m0` (recebida antes) só é gravada depois de o `flush` já ter respondido `m1`, `m0` entra como pendente com `createdAt` anterior ao da resposta já gravada e é respondida no próximo `flush`. O histórico fica com a resposta de `m0` posicionada logo depois de `m0` (regra "última do lote + 1 ms" da 013), antes de `m1`. Nada se perde nem duplica; a ordem visual das respostas pode não ser a ordem em que foram enviadas. Aceito como limitação (a janela do lote torna o caso raro).
- **Relógios de instâncias diferentes:** com mais de uma instância `api`, o `receivedAt` vem do relógio de quem recebeu o webhook. Diferença de poucos milissegundos entre servidores pode inverter duas mensagens recebidas quase juntas por instâncias diferentes. Aceito; exige NTP nos servidores (registrar na 033).
- **Limite do provedor de LLM:** concorrência alta pode esbarrar no limite de requisições da conta da Anthropic; o SDK repete (`LLM_MAX_RETRIES`) e, esgotado, o contato recebe o texto padrão. Os limites são por organização e por modelo, em requisições por minuto (RPM), tokens de entrada por minuto (ITPM, que **não** conta tokens lidos do cache) e tokens de saída por minuto (OTPM); o tier e os valores da conta aparecem em `platform.claude.com/usage/limits`. Na tabela padrão o Claude Haiku 5.5 tem 4.000 RPM, 2.000.000 ITPM e 400.000 OTPM no tier Start; organização nova pode começar no tier Evaluation, com limites menores que esses. Com `QUEUE_CONCURRENCY=10` e turnos de 2 s ou mais, o pico é de cerca de 300 requisições por minuto, bem abaixo do Start. O dono confere o tier real antes de subir a concorrência.
- **Uma empresa com muito volume ocupa todas as vagas:** não há cota de concorrência por empresa nesta spec (ver "Fora de escopo"). A métrica `queue_job_wait_seconds` mostra o efeito.
- **Pool do banco esgotado:** a regra cruzada da config evita o caso óbvio; esgotamento em pico vira erro transitório e a fila retenta com backoff (regra da 011).
- **Memória:** cada job ativo mantém o histórico e o prompt em memória (até 12.000 caracteres de histórico mais 5.200 de contexto). Com concorrência 100 isso é pequeno perto dos 128 MiB por hash do `scrypt`; sem ação.
- **Erro fatal durante um job:** o desligamento gracioso espera os jobs ativos até o prazo; o que não terminar fica "parado" no Redis e volta no próximo boot (comportamento da 011, entrega at-least-once).
- **`PROCESS_ROLE=api` sem nenhum `worker` no ar:** as mensagens são aceitas e ficam na fila sem resposta. Não há como o processo `api` saber; a defesa é o alerta sobre `queue_jobs{state="waiting"}` e `queue_job_wait_seconds` (033).

## Isolamento entre empresas

Nenhuma consulta nova e nenhum caminho novo para o `CompanyId`: ele continua nascendo só da resolução `phone_number_id` -> empresa no webhook e viajando no job. `receivedAt` é um instante, não identifica empresa nem contato. O que muda é o **paralelismo**, então a prova de isolamento é refeita com concorrência maior que 1: duas empresas com o mesmo `contactRef`, atendidas ao mesmo tempo, não veem histórico, persona, resposta nem credencial uma da outra (critério da E1; estende `whatsapp-channel.integration.test.ts` ou `channel-batching.integration.test.ts`). O contexto de log por job (`runWithContext`) é por `AsyncLocalStorage` e já isola execuções concorrentes; um teste confirma que dois jobs simultâneos de empresas diferentes logam cada um o seu `companyId`.

## Fora de escopo

- **Eficiência do turno** (próxima spec, 035): carregar empresa e credencial uma vez por job, cache curto de plano e cotas, pular a busca de conhecimento em empresa sem base, prompt caching da Anthropic, varredura que retoma mensagens pendentes, limpeza periódica de jobs no Redis, índice de busca com `company_id`.
- Cota de concorrência ou justiça por empresa.
- Teste de carga e dimensionamento de servidor (etapa E8 da 033).
- Outbox para e-mails em segundo plano; deduplicação do webhook da InfinitePay entre instâncias; travas dos serviços de exemplo entre instâncias.
- Mudar o agrupamento de mensagens, o prompt, o provedor de LLM ou o envio.
- Filas separadas por tipo de job.

## Decisões e dependências novas

Nenhuma dependência nova. Decisões para o dono (recomendação primeiro):

- **D1. De onde vem a ordem das mensagens.**
  - **Recomendado:** instante de recebimento no webhook (`receivedAt`, milissegundos, com desempate por posição no lote). Simples, não depende da fila e funciona com várias instâncias.
  - Alternativa A: `timestamp` da Meta. A referência do webhook o descreve como "Unix timestamp indicating when the webhook was triggered", uma string de 10 dígitos (exemplo `1739321024`), ou seja, **segundos** (a página não nomeia a unidade; os 10 dígitos são consistentes com segundos). Além de empatar mensagens enviadas no mesmo segundo, ele marca o disparo do webhook, não o envio pelo contato. Conferido em 2026-11-11.
  - Alternativa B: duas filas, uma de concorrência 1 só para gravar e outra concorrente para responder. Mantém a ordem pela fila, mas cria um novo gargalo global e exige concorrência global do BullMQ ao rodar mais de uma instância.
- **D2. Padrão de `QUEUE_CONCURRENCY`.**
  - **Recomendado:** `10`, com `DB_POOL_MAX` padrão subindo de 10 para `20`. Já multiplica a vazão por dez e fica longe dos limites típicos de banco e do provedor.
  - Alternativa: padrão `1` (nada muda até o dono configurar). Mais seguro no rollout, mas quem esquecer a variável fica com o gargalo.
- **D3. Onde rodam os timers periódicos com `PROCESS_ROLE`.**
  - **Recomendado:** só em `worker` e `all`. As instâncias `api` ficam sem trabalho de fundo.
  - Alternativa: em todos os papéis (já são seguros com várias instâncias, só repetem trabalho).
- **D4. Padrão do limite do webhook.**
  - **Recomendado:** `6000` por 60 s. A defesa real da rota é a assinatura HMAC; o limite só protege contra inundação sem assinatura.
  - Alternativa: isentar a rota do rate limit. Mais simples, mas deixa o cálculo do HMAC (corpo de até 3 MiB) sem freio.
  - Conferido na documentação da Meta em 2026-11-11: diante de resposta diferente de 200, "Meta retries delivery with decreasing frequency until the request succeeds, for up to 7 days", e "these retries can result in duplicate webhook notifications"; o payload pode ter até 3 MB. A documentação **não** diz que a assinatura do webhook é desativada por 429, nem informa os intervalos das retentativas, nem garante ordem de entrega. Consequência: um 429 nosso não perde a mensagem, mas a atrasa por um tempo que não controlamos e pode entregá-la fora de ordem, então o limite deve ficar bem acima do tráfego legítimo.

### Fontes externas (lidas em 2026-11-11)

- Meta, configuração de webhooks (retentativas, duplicatas, tamanho do payload): <https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks>
- Meta, referência do webhook de mensagem de texto (campo `timestamp`): <https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages/text>
- Anthropic, limites de taxa (tiers, RPM, ITPM, OTPM, cabeçalhos): <https://platform.claude.com/docs/en/api/rate-limits>
- **D5. Escopo do PR.** **Recomendado:** E1 a E3 num PR e E4 e E5 em outro. Alternativa: tudo junto.
