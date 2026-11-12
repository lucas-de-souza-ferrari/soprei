# Roteiro: implementer

Implementa uma spec **já aprovada** (status `aprovada`) em uma branch própria. Se a spec não está aprovada, pare e avise.

Antes de começar:
1. Leia `AGENTS.md`, `docs/context.md`, `docs/handoff.md` e a spec inteira (inclusive "Decisões" e o Registro de specs vizinhas que ela cita).
2. Confira `git status`. Crie a branch `spec/NNN-nome` a partir da `main` atualizada; se houver mudanças de docs não commitadas, o primeiro commit da branch leva só elas.

Execução:
- Escreva o teste de cada critério de aceite e faça passar; teste antes do código quando der.
- Implemente só o que a spec pede. O que for necessário e estiver fora de escopo vai para a spec ("Decisões e dependências novas") ou vira nova spec.
- Siga as regras invariantes de `AGENTS.md`: isolamento entre empresas, Zod nas entradas, Pino sem conteúdo de mensagem, `LlmProvider` para modelo, convenções de pastas.
- Migration: aditiva; nunca `migrate reset`, `DROP`, nem apagar dado que você não criou; nunca criar ou alterar roles e bancos. Testes de integração só tocam `soprei_test` e Redis `/15`, com prefixo único por teste, sem `FLUSHALL`/`FLUSHDB`.
- Testes sensíveis a tempo: relógio injetável (`src/test-support/clock.ts`), esperas com prazo (sondagem) em vez de `sleep` fixo, margens folgadas; **repita as suítes novas várias vezes** (o CI já falhou por flake).
- Nunca logue conteúdo de mensagem, contato, persona, tokens nem o objeto de erro inteiro do ioredis/BullMQ (carrega `command.args`).
- **Validação em níveis** (cada nível pega o que o anterior não alcança; nenhum substitui o final):
  1. **A cada passo, durante o trabalho:** `pnpm typecheck` completo (segundos) e só o arquivo de teste que acabou de tocar (`node --import tsx --test <arquivo>`; os de integração com `--env-file-if-exists=.env.test`). Uma versão do Node basta aqui.
  2. **Antes de cada commit:** `pnpm lint`, `pnpm format:check` e as suítes da área tocada mais as que importam o código alterado. Se mexeu numa porta ou serviço compartilhado (`LlmProvider`, `AttendanceService`, repositórios, config), rode **todos** os unitários (`pnpm test`).
  3. **Suíte nova que ficou verde:** repita-a de 4 a 5 vezes na hora, para pegar teste intermitente cedo (relógio, janelas, ordem) antes de copiarem o padrão frágil.
  4. **Só no final, antes de reportar:** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:integration` na **versão do Node do `.nvmrc`** (a do CI; spec 036), repetição das suítes novas e alteradas, `rm -rf dist && pnpm build` e o smoke do processo compilado com valores falsos. Uma validação por vez (nunca duas ao mesmo tempo). Só está pronto com tudo verde; consertar a causa, nunca desativar regra nem pular teste. **Nunca declare "pronto" sem o nível 4.**
- Atualize a spec: critérios marcados `[x]` só os que têm teste passando, e um "Registro da implementação" (decisões, desvios com motivo, pastas finais, fontes consultadas). **Não marque a spec como `concluída`**: o dono faz isso depois do CI verde e do merge.
- Atualize `.env.example`, `.env.test.example` (placeholders, nunca segredo) e `AGENTS.md` se comandos, variáveis ou regras mudaram.
- Commits pequenos e descritivos. Sem push, sem merge, nada na `main`, sem `--force`.

Entrega: lista de commits, arquivos por pasta, critérios cobertos e não cobertos, desvios da spec, resultado de cada comando (com contagens e a versão do Node usada), riscos e dúvidas. Atualize `docs/handoff.md`.
