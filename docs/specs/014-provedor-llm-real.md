# 014 — Provedor real de LLM (Claude Haiku 5.5)

- **Status:** concluída (CI verde e merge confirmados pelo dono; teste manual com a chave real ainda por fazer). Aprovada pelo dono em 2026-10-28, com todas as recomendações (Claude Haiku 5.5, esforço `low`, 1 024 tokens de saída, instrução de estilo, métricas de tokens, 1 repetição, `reviewer`); a base legal LGPD (decisão 7) o dono confere antes de clientes reais
- **Branch:** `spec/014-provedor-llm-real`
- **Depende de:** 010 (atendimento, `LlmProvider`) e 011/013 (canal e agrupamento, para o teste de ponta a ponta)

## Objetivo

Trocar o `mock` por um modelo de verdade: uma implementação de `LlmProvider` para a API da Anthropic (Claude Haiku 5.5), escolhida por configuração (`LLM_PROVIDER=anthropic`), sem mudar regra de negócio. Junto vêm as duas pendências da 010 que o provedor real exige: **cancelamento da chamada ao estourar o prazo** (`AbortSignal`) e a garantia de que **nenhum erro do provedor carrega texto do contato**. O `mock` continua sendo o padrão de testes, do CI e do desenvolvimento offline.

## Estado de partida (herdado)

- `LlmProvider.generate(input): Promise<Result<LlmReply, ExternalServiceError>>` (`src/application/ports/llm-provider.ts`), com `input = { systemPrompt, history, userMessage }` e `name` (label de métrica). O `AttendanceService` chama o provedor dentro de `withTimeout` (`LLM_TIMEOUT_MS`, padrão 15 000 ms) e trata erro, prazo, resposta vazia, maior que 4 000 caracteres ou com NUL como falha, gravando o texto padrão (`isFallback`).
- A chamada **não é cancelada** depois do prazo: o provedor segue rodando e consumindo cota (pendência registrada na 010).
- `LLM_PROVIDER` só aceita `mock` (`src/infrastructure/config/env.schema.ts`); a fábrica é `createLlmProvider` (`src/infrastructure/external-apis/llm/`). Métricas: `llm_requests_total{provider,result}` e `llm_request_duration_seconds{provider}`. O contrato diz que a mensagem e o `context` do erro nunca contêm texto do contato nem persona.
- O histórico enviado ao modelo é cortado do mais antigo para o mais novo e **pode começar por uma mensagem do assistente**.

## Fatos sobre o provedor (conferidos em 2026-10-28; o implementer reconfere na documentação oficial antes de fixar valores)

- **Claude Haiku 5.5** (`claude-haiku-5-5`): US$ 0,10 por milhão de tokens de entrada e US$ 0,50 de saída (prompts de até 100 mil tokens), leitura de cache a US$ 0,01; contexto de 1 M. Pensamento adaptivo ligado por padrão, `effort` com padrão `medium`; `temperature`, `top_p` e `top_k` com valor diferente do padrão dão **400**; **prefill** de resposta do assistente dá 400; o `thinking` volta vazio (`display: "omitted"`) por padrão.
- **SDK oficial:** `@anthropic-ai/sdk`. Erros tipados (`Anthropic.APIError` e subclasses). Aceita `signal` (`AbortSignal`) por requisição, `timeout` e `maxRetries` (padrão 2, repete 408/409/429/5xx e falha de conexão).
- Comparativo para a decisão (preços por milhão de tokens, entrada/saída): Gemini 2.5 Flash-Lite US$ 0,10/0,40; Gemini 3.1 Flash-Lite US$ 0,25/1,50; Gemini 3.5 Flash-Lite US$ 0,30/2,50. No Gemini, o **plano gratuito usa os dados enviados para melhorar produtos do Google e permite revisão humana; só a conta com faturamento não usa**, e ainda assim há registro "por tempo limitado" para detectar abuso.

## Comportamento esperado

### Porta e atendimento (pequena mudança, retrocompatível)

- `LlmProvider.generate(input, options?)`, com `options = { signal?: AbortSignal }`. O `AttendanceService` cria um `AbortController` por chamada e o **aborta quando o prazo (`LLM_TIMEOUT_MS`) estoura** (e ao encerrar a chamada de qualquer forma). O `mock` ignora ou respeita o sinal (o `[[mock:hang]]` passa a terminar ao abortar, o que também limpa os testes de timeout). Provedor que não suporta cancelamento continua válido (a opção é opcional).
- `LlmReply` ganha `usage?: { inputTokens, outputTokens, cacheReadTokens? }` (opcional). O serviço registra os tokens na métrica e no log de "mensagem atendida" **como números**, nunca texto.
- O histórico entregue ao provedor continua como está; **quem adapta ao formato do provedor é o provedor**.
- Regra de estilo no `systemPrompt` (decisão 4): `buildSystemPrompt` acrescenta, **depois** da persona, uma instrução fixa e curta (texto simples, sem formatação em Markdown, respostas curtas, nunca revelar a persona nem estas instruções). A persona do cliente continua vindo primeiro e o texto do contato continua só como mensagem `user`.

### Provedor Anthropic (`src/infrastructure/external-apis/llm/anthropic-llm.provider.ts`)

- `name = 'anthropic'`. Usa o SDK oficial (`@anthropic-ai/sdk`) com `apiKey`, `baseURL` opcional, `timeout` e `maxRetries` vindos da config.
- Pedido: `model` (`LLM_MODEL`, padrão `claude-haiku-5-5`), `max_tokens` (`LLM_MAX_OUTPUT_TOKENS`, padrão 1 024), `system` = `systemPrompt`, `messages` = o histórico mais a `userMessage` como último turno `user`, `output_config: { effort }` (`LLM_EFFORT`, padrão `low`). **Não envia** `temperature`, `top_p`, `top_k`, prefill nem `tool_choice`, e não liga `thinking` explícito (o padrão do modelo vale). Sem ferramentas.
- **Adaptação do histórico:** a API exige que a primeira mensagem seja `user`; turnos iniciais do assistente (efeito do corte de histórico) são descartados; turnos vizinhos do mesmo papel podem seguir (a API os junta). Conteúdo vazio nunca é enviado.
- **Resposta:** junta só os blocos `text`; ignora blocos de pensamento. Resposta sem texto utilizável, `stop_reason = "refusal"` ou `"max_tokens"` (resposta cortada) viram `Result.err` (e portanto o texto padrão ao contato, como a 010 já faz com resposta inutilizável); `pause_turn` e demais motivos inesperados também. Nada é truncado em silêncio.
- **Erros** (`Anthropic.APIError` e conexão) viram `ExternalServiceError` com **apenas** `{ provider, status, errorType, retryable }` no `context` e uma mensagem fixa por categoria (autenticação, limite de taxa, sobrecarga, pedido inválido, indisponível, rede). O `message` e o corpo do erro do SDK **não** são copiados nem logados (podem citar o pedido). Cancelamento por `AbortSignal` vira o erro de prazo que o serviço já distingue (`timeout`).
- Repetição: o SDK repete até `LLM_MAX_RETRIES` (padrão 1) em 408/409/429/5xx e falha de rede, sempre dentro do prazo total do atendimento (o `AbortSignal` corta a soma de tudo).
- A chave (`ANTHROPIC_API_KEY`) nunca vai a log, métrica, erro nem resposta (o `redact` do logger já cobre `apiKey`; o provedor não a loga de forma alguma).

### Configuração (validada em `src/infrastructure/config/`, documentada nos `.env*.example`)

| Variável | Regra |
| --- | --- |
| `LLM_PROVIDER` | passa a aceitar `mock` (padrão) e `anthropic` |
| `ANTHROPIC_API_KEY` | obrigatória quando `LLM_PROVIDER=anthropic` (mínimo 20 caracteres); nunca em log |
| `ANTHROPIC_BASE_URL` | opcional, só `https://` em produção; os testes apontam para um servidor falso local |
| `LLM_MODEL` | padrão `claude-haiku-5-5`; formato `^[a-z0-9.-]{1,64}$` |
| `LLM_EFFORT` | `low`, `medium`, `high`; padrão `low` |
| `LLM_MAX_OUTPUT_TOKENS` | 64 a 8 192; padrão 1 024 |
| `LLM_MAX_RETRIES` | 0 a 3; padrão 1 |
| `LLM_TIMEOUT_MS` | já existe; passa também ao SDK |

### Métricas (registry da 004; sem `clientId`, texto ou telefone em label)

`llm_tokens_total{provider,type}` com `type` ∈ `input`, `output`, `cache_read`, e o conjunto de resultados de `llm_requests_total` ganha `refusal` e `truncated` (hoje `ok`, `error`, `timeout`); `llm_request_duration_seconds` segue igual. Conjunto fixo de labels.

## Critérios de aceite

(Todos com **servidor falso local**, sem chamar a API real nem usar chave real.)

**Provedor e pedido**
- [x] Teste: o pedido ao servidor falso tem `model`, `max_tokens`, `system` = o `systemPrompt`, `messages` na ordem (histórico e depois a mensagem nova como `user`), `output_config.effort`, e **não** traz `temperature`, `top_p`, `top_k`, prefill nem `tool_choice`; a chave vai no cabeçalho do SDK e em nenhum outro lugar.
- [x] Teste: histórico que começa por turno do assistente é adaptado (turnos iniciais do assistente descartados); histórico vazio envia só a mensagem nova; turnos vizinhos do mesmo papel são aceitos.
- [x] Teste: resposta com blocos `text` (e blocos de pensamento ignorados) vira `LlmReply.text` e `usage`; resposta vazia, `refusal`, `max_tokens` e `pause_turn` viram `Result.err` (e o atendimento grava o texto padrão).
- [x] Teste: 401, 400, 429, 500, 529 e falha de conexão viram `ExternalServiceError` com só `{ provider, status, errorType, retryable }`; 429/5xx/rede são repetidos até `LLM_MAX_RETRIES` e dentro do prazo.
- [x] Teste: **cancelamento** — com o servidor falso demorando mais que `LLM_TIMEOUT_MS`, o atendimento cai no texto padrão com resultado `timeout` **e a conexão com o servidor falso é encerrada** (o provedor não segue rodando); o mesmo vale para o `[[mock:hang]]` do mock.

**Privacidade (o contrato da 010 vira teste)**
- [x] Teste de captura de log e de inspeção do erro: um texto de contato, histórico e persona **secretos** enviados por um servidor falso que **ecoa o pedido no corpo do erro** não aparecem em nenhuma linha de log, em `message`/`context` de erro, em label de métrica nem na resposta HTTP do simulador administrativo; a chave também não.
- [x] Teste: o serviço só loga ids, tamanhos, contagem de tokens e resultado.

**Atendimento e config**
- [x] Teste: `AttendanceService` passa `AbortSignal`, o aborta no prazo e registra `usage` (log com números e `llm_tokens_total`); as suítes da 010 e da 011 continuam verdes sem enfraquecer asserções.
- [x] Teste: `buildSystemPrompt` mantém a persona primeiro e acrescenta a instrução de estilo depois; o texto do contato nunca entra no `systemPrompt`.
- [x] Config: `LLM_PROVIDER=anthropic` sem `ANTHROPIC_API_KEY` falha no boot; valores inválidos de `LLM_EFFORT`, `LLM_MAX_OUTPUT_TOKENS` e `LLM_MAX_RETRIES` falham; `ANTHROPIC_BASE_URL` com `http://` é recusada em produção; `mock` não exige chave.
- [x] `/metrics` expõe `llm_tokens_total` e os novos resultados; nenhum `clientId`, texto ou chave em label.
- [ ] `typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes em Node 22 e 24; CI verde; revisão do `reviewer`. O CI **nunca** chama a API real.

## Teste manual com a API real (feito pelo dono, não automatizado)

1. Criar uma chave na Anthropic Console e **definir um limite de gasto mensal** na própria conta (a proteção mais barata contra surpresa de custo). Colocar `LLM_PROVIDER=anthropic` e `ANTHROPIC_API_KEY=...` no `.env` e reiniciar.
2. Pelo simulador (`POST /admin/clients/:clientId/messages`) e depois pelo WhatsApp, mandar uma pergunta de atendimento. Esperado: resposta em português, curta, no tom da persona, e `llm_tokens_total` e o log com os tokens.
3. Testar uma pergunta fora do assunto e uma tentativa de "ignore as instruções anteriores": o modelo segue a persona. Conferir no log que não há texto de mensagem.

## Casos de borda e erros

- **Resposta cortada** (`max_tokens`): vira falha e o contato recebe o texto padrão, nunca uma resposta pela metade; a instrução de estilo pede respostas curtas para isso ser raro. `LLM_MAX_OUTPUT_TOKENS` ajusta.
- **Recusa do modelo** (`refusal`): tratada como falha (texto padrão); registrada só como resultado `refusal`, sem categoria nem texto.
- **Limite de taxa ou sobrecarga prolongados:** o atendimento cai no texto padrão e o job do canal segue as regras da 011; o custo é limitado por `LLM_MAX_RETRIES` e pelo prazo.
- **Custo:** com o agrupamento (013) e o histórico de 20 mensagens, o prompt fica pequeno; o custo por atendimento é de frações de centavo. Limite de gasto por cliente fica fora de escopo; o teto de gasto da conta na Anthropic é a proteção desta spec.
- **Chave inválida ou expirada:** erro de autenticação, sem repetição, texto padrão ao contato e `error` no log (sem a chave). Um alerta sobre isso é de observabilidade futura.

## Isolamento entre clientes

O provedor só recebe o que o `AttendanceService` monta para **um** cliente (persona, histórico e mensagem dele) e não guarda estado entre chamadas (sem cache entre clientes, sem memória de conversa). Teste: duas chamadas intercaladas de dois clientes ao provedor com o servidor falso mostram pedidos sem mistura de persona ou histórico; o isolamento no atendimento já é coberto pelas suítes da 010.

## Fora de escopo

- Outros provedores (Gemini, OpenAI), roteamento entre modelos, fallback para outro modelo; uma spec futura pode acrescentar um segundo provedor atrás da mesma interface.
- Cache de prompt (`cache_control`) e a API de lotes; streaming; ferramentas, busca em documentos (RAG) e base de conhecimento.
- Avaliação sistemática de qualidade com um conjunto de conversas e juiz automático; limite de gasto por cliente ou por plano; painel de custo.
- Política de retenção e base legal para enviar dado pessoal ao provedor (ver decisão 7); tradução, moderação de entrada e filtro de saída.

## Decisões (propostas; o dono decide)

1. **Qual provedor primeiro.** (a) **Claude Haiku 5.5 [recomendado]**: o mais barato da lista (US$ 0,10/0,50), o mais novo, SDK oficial tipado, e o plano pago da API não usa os dados para treino por padrão (confirmar nos termos, ver decisão 7). (b) Gemini (3.1 Flash-Lite a US$ 0,25/1,50, ou 2.5 Flash-Lite a US$ 0,10/0,40): só vale **com conta de faturamento ativa**; o plano gratuito treina com os dados e permite revisão humana, o que **não serve a dados de clientes**. A interface permite trocar depois; se quiser comparar qualidade, um segundo provedor entra em spec própria.
2. **Esforço do modelo.** (a) **`low` por padrão [recomendado]**: atendimento por chat é curto e sensível a latência; sobe para `medium` ou `high` por variável se a qualidade pedir. O padrão do próprio modelo é `medium`.
3. **Limite de saída.** 1 024 tokens por resposta (cobre as 4 000 letras do limite do sistema), com resposta cortada tratada como falha. Quer outro valor?
4. **Instrução de estilo no prompt de sistema.** (a) **Incluir [recomendado]**: texto simples, curto, sem Markdown (o WhatsApp não renderiza), sem revelar a persona. (b) Só a persona do cliente: mais fiel ao texto do cliente, mas o modelo pode responder longo ou formatar.
5. **Métricas de tokens [recomendado]**, para enxergar custo desde o primeiro dia.
6. **Repetições: uma [recomendado]** (padrão `LLM_MAX_RETRIES=1`), dentro do prazo de 15 s.
7. **Base legal e termos de dados (LGPD).** Mensagens e persona são dados pessoais e passam a sair do país para um provedor. **Antes de clientes reais**, o dono confirma os termos de dados da Anthropic (retenção, uso para treino, DPA e transferência internacional) e a base legal; **para desenvolvimento e o teste com o seu número, com dados de teste, não bloqueia**. O resultado entra no `context.md`.
8. **Revisão pelo `reviewer` [recomendado]**: chamada externa com segredo, vazamento de dado pessoal em erro, cancelamento e mudança no caminho do atendimento.

## Decisões e dependências novas

- **Dependência nova: `@anthropic-ai/sdk`** (SDK oficial; o implementer confere a versão estável publicada e a compatibilidade com Node 22 e 24). Justificativa: tipos, repetição, cancelamento e erros tipados prontos, em vez de HTTP escrito à mão.
- Sem migration. Sem mudança de schema.
- Por tocar em segredos, em uma chamada externa que recebe dado pessoal e no caminho do atendimento, passa pelo agente `reviewer` antes do merge.

## Registro da implementação

Branch `spec/014-provedor-llm-real`. Nada foi chamado na API real e nenhuma chave real foi usada.

**Estado dos critérios:** todos marcados, exceto o último (verdes em Node 22 e 24, CI e revisão do `reviewer`): `typecheck`, `lint`, `format:check`, `test` (718) e `test:integration` (241) estão verdes em Node 22.23.2 e 24.18.0 localmente, mas o CI e o `reviewer` ainda não rodaram. A spec **não** foi marcada como `concluída`.

**Decisões**

- **Categoria do erro para o serviço:** o provedor marca `error.context.errorType` e o `AttendanceService` traduz em resultado de métrica (`resultForProviderError`): `timeout`, `refusal` e `max_tokens` (vira `truncated`); o resto é `error`. Os valores ficam em `LLM_ERROR_TYPE` (`src/application/ports/llm-provider.ts`). Assim recusa e corte entram na métrica sem a porta ganhar um segundo tipo de retorno.
- **Prazo no SDK e prazo do atendimento:** `LLM_TIMEOUT_MS` vai ao SDK como prazo de cada tentativa e é também o prazo total do serviço (o `AbortSignal` corta a soma das repetições). O prazo do serviço vence sempre; um timeout de tentativa do SDK sozinho também vira `errorType: timeout`.
- **Categoria pelo status HTTP, não pelo corpo:** 400/404/413/422 pedido inválido; 401 autenticação; 403 permissão; 408 prazo; 429 limite de taxa; 529 sobrecarga; 409 e 5xx indisponível. O `error.type` do corpo (texto do servidor) nunca é copiado. `status` é `null` em falha de rede ou cancelamento.
- **Log de falha do serviço (`err: cause`):** continua igual; o `cause` é o `ExternalServiceError` seguro do provedor (sem `cause` do SDK). Há teste com servidor que ecoa o pedido provando que log, resposta do simulador e `/metrics` não vazam (`infrastructure/http/anthropic-attendance.test.ts`).
- **Revisão do `reviewer` (sugestões aplicadas):** (1) `fetchOptions: { redirect: 'error' }`: o SDK segue redirects e reenviaria o corpo a outro host; um 301/302/307/308 vira erro de rede seguro e o servidor de destino não recebe nada (teste com dois servidores). (2) Teste de abort durante a espera entre repetições reescrito (retry-after longo, aborta com o primeiro 500 já recebido, exatamente 1 pedido). (3) `ANTHROPIC_CUSTOM_HEADERS`: o SDK o lê de `process.env` e o mescla nos cabeçalhos; `defaultHeaders` explícito não remove chaves que não conhecemos, então a variável é escondida só durante `new Anthropic(...)` e restaurada em seguida (teste prova o cabeçalho ausente e o ambiente restaurado); também documentado no `.env.example`. (4) `LLM_MAX_OUTPUT_TOKENS` conta o pensamento adaptivo: documentado no `.env.example` e no `AGENTS.md`. (6) `create-llm-provider.ts` lança `ValidationError` (com teste) em vez de `Error`.
- **SDK fixo em 1.3.0, sem `^`:** o mapeamento de erros e o comportamento de repetição e cancelamento dependem do SDK (classes de erro, `retry-after-ms`, `signal`); atualizar é decisão consciente, com os testes do provedor rodando. O lockfile já fixa a versão; o `package.json` também.
- **SDK silenciado:** `logLevel: 'off'` e `openTelemetry: false` na criação do cliente (o SDK escreveria no `console`, fora do Pino e do `redact`, e emitiria spans de tracing).
- **`usage`:** `inputTokens` é o `input_tokens` da resposta (não inclui o que veio do cache); `cacheReadTokens` só aparece se a API o informa. A métrica ignora valor não finito ou zero.
- **Mock:** o `[[mock:hang]]` termina com erro `timeout` ao abortar (e ao receber um sinal já abortado); o eco de persona do mock ignora a instrução de estilo (cita só o começo da persona), para os testes antigos manterem o texto esperado.
- **Testes antigos ajustados sem enfraquecer:** asserções que comparavam o `systemPrompt` exatamente com a persona agora comparam com persona mais a instrução fixa (`withStyle`, igualdade exata); a do controlador usa `startsWith` com a persona e a linha em branco.
- **Não coberto por teste automatizado:** o teste de ponta a ponta com o canal (011/013, BullMQ) usa o mock nas suítes existentes (inalteradas e verdes); o provedor Anthropic foi exercitado de ponta a ponta no simulador administrativo (teste `anthropic-attendance.test.ts`) e no processo compilado com servidor falso (smoke manual). O caminho `respondToPending` usa o mesmo `callProvider`.

**Desvios e fontes**

- **Autenticação:** o SDK 1.3.0 instalado envia a chave como `Authorization: Bearer <chave>` (`node_modules/@anthropic-ai/sdk/client.js`, `authHeaders`), não `x-api-key`. A spec só exige "cabeçalho do SDK e em nenhum outro lugar", o que vale; o teste aceita os dois nomes.
- **`LLM_EFFORT`:** o SDK aceita `low`, `medium`, `high`, `xhigh` e `max`; a config aceita só os três primeiros, como a spec manda.
- **Fatos conferidos em 2026-10-28:** id `claude-haiku-5-5` (também no tipo `Model` do SDK), preços (US$ 0,10 entrada e 0,50 saída até 100 mil tokens; cache read US$ 0,01), pensamento adaptivo e `effort` padrão `medium`, contexto de 1 M e saída máxima de 128 K (https://platform.claude.com/docs/en/about-claude/models/overview e https://platform.claude.com/docs/en/models/haiku-5-5/overview). A página do modelo diz para omitir `temperature`, `top_p` e `top_k`; o 400 para valor diferente do padrão e para prefill vem da spec e não foi reconfirmado por chamada real (o provedor simplesmente não os envia). **Novidade:** o Haiku 5.5 usa um tokenizador que conta cerca de 30% mais tokens que o Haiku 4.5 para o mesmo texto; vale ao estimar custo e ao ajustar `LLM_MAX_OUTPUT_TOKENS`.
- **SDK:** `@anthropic-ai/sdk` 1.3.0 (publicado em 2026-10-23, mais de dois dias, Apache-2.0, `latest` do npm). Classes de erro, `stop_reason` (`end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, `model_context_window_exceeded`), `output_config.effort`, `signal`, `timeout`, `maxRetries` e `baseURL` conferidos nos `.d.ts` instalados. Testes verdes em Node 22 e 24; `pnpm-workspace.yaml` não precisou mudar e `minimumReleaseAgeExclude` não foi usado.
- **Variáveis de ambiente do SDK:** com `apiKey` explícita o SDK não lê `ANTHROPIC_API_KEY`; sem `baseURL` ele ainda leria `ANTHROPIC_BASE_URL` do ambiente, que é a mesma variável já validada na config.

**Pastas e arquivos finais**

- `src/application/ports/llm-provider.ts` (porta: `options.signal`, `LlmUsage`, `LLM_ERROR_TYPE`); `src/application/attendance/attendance.service.ts` (`AbortController`, usage, resultados novos, `buildSystemPrompt`).
- `src/infrastructure/external-apis/llm/`: `anthropic-llm.provider.ts` (novo), `create-llm-provider.ts`, `mock-llm.provider.ts`.
- `src/infrastructure/config/env.schema.ts`; `src/infrastructure/metrics/metrics.ts` e `index.ts`.
- Testes novos: `src/application/attendance/attendance-llm.service.test.ts`, `src/infrastructure/external-apis/llm/anthropic-llm.provider.test.ts`, `src/infrastructure/http/anthropic-attendance.test.ts`; servidor falso `src/test-support/fake-anthropic-api.ts`. Testes alterados: config, métricas, mock, atendimento (unitário e de integração) e controlador.
- `.env.example`, `.env.test.example`, `AGENTS.md`, `docs/handoff.md`.

