# Origem dos componentes do painel (spec 029)

## Menu lateral (`AppShell.tsx`, `Sidebar.tsx`, `CompanySwitcher.tsx`): não é de terceiros

O dono escolheu como referência o "Dashboard Shell" da Obsidian UI
(https://www.obsidianui.dev/docs/dashboard-shell). Passo zero, conferido em 2026-11-05: a página e o item
do registro (`https://www.obsidianui.dev/r/dashboard-shell.json`) **não informam licença**, não linkam
repositório nem `LICENSE` (`/LICENSE`, `/license` e `/docs/license` respondem 404). Pela regra da spec
(licença ausente = não copiar), **nada foi copiado**: o shell é **próprio**, escrito neste projeto no mesmo
desenho (barra lateral fixa, seletor de empresa, painel por cima no celular, animação simples),
sem o shadcn CLI e sem nenhuma dependência nova (nem Radix nem `class-variance-authority`: o `<dialog>`
nativo e o padrão de botão de menu fazem o papel dos primitivos).
