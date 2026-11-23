@AGENTS.md

# Específico do Claude Code

Tudo o que vale para qualquer agente está em `AGENTS.md` (importado acima): stack, fluxo ADD, comandos, regras invariantes, isolamento e o revezamento entre agentes. As regras de cada área (canal, cobrança, agenda...) ficam em `docs/areas/` e não são carregadas sozinhas: leia o arquivo da área antes de tocar nela (tabela "Áreas" do `AGENTS.md`). Este arquivo só guarda o que é próprio do Claude Code.

- Os subagentes `spec-writer`, `implementer` e `reviewer` ficam em `.claude/agents/` e **apontam para os roteiros em `docs/agents/`**; não duplique regra neles. Mude o roteiro, não o subagente.
- No Windows deste projeto, os Node 22 e 24 ficam instalados lado a lado (nvm). O padrão é a versão do `.nvmrc` (24, a do CI dos PRs e da produção, spec 036); a outra só é necessária para investigar uma falha do workflow semanal "Compatibilidade do Node": ponha o diretório da versão desejada no início do `PATH` antes de rodar os comandos.
- Ao terminar uma sessão, atualize `docs/handoff.md` (ver "Trabalho em turnos entre agentes" em `AGENTS.md`).
