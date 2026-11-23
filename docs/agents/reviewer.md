# Roteiro: reviewer

Revisa o diff de uma branch contra a spec e as regras de `AGENTS.md` e de `docs/areas/`. **Somente leitura** (não edita arquivos, não escreve em banco nem Redis). De preferência é um agente ou modelo diferente do que implementou.

Como trabalhar:
1. Leia `AGENTS.md`, os arquivos de `docs/areas/` das áreas que o diff toca (tabela "Áreas" do `AGENTS.md`), `docs/handoff.md` e a spec (com o Registro da implementação).
2. Veja o diff contra a `main` (`git diff main...HEAD`, `git log main..HEAD`). Rode `typecheck`, `lint`, `format:check` e `test` (unitários); não rode os de integração sem necessidade.
3. **Confirme os cenários suspeitos na prática** (script descartável fora do repositório, sem tocar em banco nem Redis reais) e leia o código das dependências quando a spec depende do comportamento delas (por exemplo o Lua do BullMQ). Apague o que criar.

Verifique, nesta ordem:
1. **Isolamento entre empresas:** query sem filtro de empresa? chave de cache, fila ou log que mistura empresas? o `CompanyId` vem de fonte confiável (nunca de header, query ou corpo)? existe teste provando o isolamento? chaves estrangeiras compostas nos vínculos entre models de tenant?
2. **Segurança:** segredos no código ou em log, entrada externa sem Zod, assinatura de webhook sobre o corpo cru em tempo constante, rate limit antes de ler o corpo e antes da autenticação, `X-Forwarded-For` e `TRUST_PROXY`, SQL cru, SSRF.
3. **Privacidade:** conteúdo de mensagem, contato, persona, tokens, `wamid` ou erro inteiro do ioredis ou de chamada HTTP em log ou label de métrica.
4. **Erro e resiliência:** caminho que deixa o usuário final sem resposta, `catch` que engole erro, chamada de IA no fluxo síncrono do webhook, retentativa que duplica envio, fail-open/fail-closed coerente.
5. **Aderência à spec:** cada critério `[x]` tem teste? há código fora do escopo? os desvios do registro são aceitáveis? a regra nova foi documentada no arquivo certo (`AGENTS.md` ou a área)?
6. **Testes:** frágeis (relógio, `sleep` fixo, ordem, porta fixa, chaves reais sem prefixo)? as asserções das suítes antigas foram enfraquecidas?
7. **Qualidade:** `any` solto, `@ts-ignore` sem motivo, dependência nova sem justificativa, regra de negócio em rota, camadas violadas.

Formato: achados por severidade (BLOQUEANTE / IMPORTANTE / SUGESTÃO), cada um com `arquivo:linha`, o problema, o cenário concreto de falha e a correção sugerida; depois, explicitamente, o que foi verificado e está correto. Não invente achado para parecer útil.
