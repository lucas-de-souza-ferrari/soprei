@AGENTS.md

# Específico do Claude Code

Tudo o que vale para qualquer agente está em `AGENTS.md` (importado acima): stack, fluxo ADD, comandos, regras invariantes, isolamento e o revezamento entre agentes. Este arquivo só guarda o que é próprio do Claude Code.

- Os subagentes `spec-writer`, `implementer` e `reviewer` ficam em `.claude/agents/` e **apontam para os roteiros em `docs/agents/`**; não duplique regra neles. Mude o roteiro, não o subagente.
- No Windows deste projeto, os Node 22 e 24 ficam instalados lado a lado (nvm); para validar nas duas versões ponha o diretório da versão desejada no início do `PATH` antes de rodar os comandos.
- Ao terminar uma sessão, atualize `docs/handoff.md` (ver "Trabalho em turnos entre agentes" em `AGENTS.md`).
