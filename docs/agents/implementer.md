# Roteiro: implementer

Implementa uma spec **já aprovada** (status `aprovada`) em uma branch própria. Se a spec não está aprovada, pare e avise.

Antes de começar:
1. Leia `AGENTS.md`, `docs/context.md`, `docs/handoff.md` e a spec inteira (inclusive "Decisões" e o Registro de specs vizinhas que ela cita).
2. Confira `git status`. Crie a branch `spec/NNN-nome` a partir da `main` atualizada; se houver mudanças de docs não commitadas, o primeiro commit da branch leva só elas.

Execução:
- Escreva o teste de cada critério de aceite e faça passar; teste antes do código quando der.
- Implemente só o que a spec pede. O que for necessário e estiver fora de escopo vai para a spec ("Decisões e dependências novas") ou vira nova spec.
- Siga as regras invariantes de `AGENTS.md`: isolamento entre clientes, Zod nas entradas, Pino sem conteúdo de mensagem, `LlmProvider` para modelo, convenções de pastas.
- Migration: aditiva; nunca `migrate reset`, `DROP`, nem apagar dado que você não criou; nunca criar ou alterar roles e bancos. Testes de integração só tocam `soprei_test` e Redis `/15`, com prefixo único por teste, sem `FLUSHALL`/`FLUSHDB`.
- Testes sensíveis a tempo: relógio injetável (`src/test-support/clock.ts`), esperas com prazo (sondagem) em vez de `sleep` fixo, margens folgadas; **repita as suítes novas várias vezes** (o CI já falhou por flake).
- Nunca logue conteúdo de mensagem, contato, persona, tokens nem o objeto de erro inteiro do ioredis/BullMQ (carrega `command.args`).
- Valide: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:integration` em Node 22 e na LTS mais recente, mais `rm -rf dist && pnpm build`. Só está pronto com tudo verde; consertar a causa, nunca desativar regra nem pular teste.
- Atualize a spec: critérios marcados `[x]` só os que têm teste passando, e um "Registro da implementação" (decisões, desvios com motivo, pastas finais, fontes consultadas). **Não marque a spec como `concluída`**: o dono faz isso depois do CI verde e do merge.
- Atualize `.env.example`, `.env.test.example` (placeholders, nunca segredo) e `AGENTS.md` se comandos, variáveis ou regras mudaram.
- Commits pequenos e descritivos. Sem push, sem merge, nada na `main`, sem `--force`.

Entrega: lista de commits, arquivos por pasta, critérios cobertos e não cobertos, desvios da spec, resultado de cada comando em cada Node (com contagens), riscos e dúvidas. Atualize `docs/handoff.md`.
