# Origem dos componentes do painel (spec 029)

## Menu lateral: Dashboard Shell da Obsidian UI (MIT)

- **Origem:** https://www.obsidianui.dev/docs/dashboard-shell (registro `https://www.obsidianui.dev/r/dashboard-shell.json`),
  repositório https://github.com/Atharvsinh-codez/ObsidianUI.
- **Licença:** **MIT**, confirmada pelo dono em 2026-11-05 no `LICENSE` do repositório
  (https://github.com/Atharvsinh-codez/ObsidianUI/blob/main/LICENSE). As páginas do site não informam a licença; o
  texto do aviso, que precisa acompanhar as cópias, está abaixo.
- **Data da cópia:** 2026-11-05. Copiado **à mão** do manifesto do registro; **o shadcn CLI não foi executado**
  (não existe `components.json`).
- **Arquivos copiados** (em `frontend/src/components/dashboard-shell/`) e adaptações:

| Arquivo aqui                      | Origem                                 | Adaptações                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard-shell.tsx`             | `components/block/dashboard-shell.tsx` | sem `"use client"`; `@/lib/utils` virou import relativo; textos em português ("Abrir menu", "Fechar menu", "Redimensionar o menu", "Menu da empresa"); cores literais trocadas por tokens (`text-white` virou `text-background`, `bg-black/40` e `bg-black/50` viraram `bg-foreground/50`, sombras viraram as do projeto); comentários que citavam `next/link` e `duo-icons` reescritos; ponto de docagem de 42 rem (`@2xl`) para 48 rem (`@3xl`), ou seja, 768 px; nova propriedade `sidebarHeader` (abaixo da marca, onde fica o seletor de empresa); marca sem nome mostra só o logotipo; o Esc de um menu em portal não fecha a gaveta (só vale o que acontece dentro dela) |
| `dashboard-shell.css`             | `components/block/dashboard-shell.css` | as variáveis `--obsidian-dashboard-shell-*` apontam para os tokens do Soprei (`style.css`, claro e escuro) e o bloco de modo escuro com cores literais foi removido; sem cor literal, sombras por `var(--shadow)` e `var(--border)`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `../../lib/utils.ts` (já existia) | `lib/utils.ts`                         | idêntico ao do projeto (`cn` com `clsx` e `tailwind-merge`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

- **Dependências novas** (versão exata, autorizadas pela spec 029, D11 alternativa a, e todas importadas pelo
  arquivo copiado): `@radix-ui/react-alert-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-popover`,
  `@radix-ui/react-tabs` e `class-variance-authority` (todas MIT). `clsx`, `tailwind-merge`, `lucide-react` e `motion`
  já existiam. Não foram instalados `next`, `next-themes` nem `@duo-icons`.
- **Uso:** `AppShell.tsx` monta o `DashboardShell` (navegação por permissão, rodapé com e-mail, tema e "Sair",
  gaveta no celular) e `CompanySwitcher.tsx` usa o menu do shell (`DashboardMenu*`) para o seletor de empresa.
  O recolher/redimensionar da barra vale só enquanto a tela está aberta: nada é guardado no navegador.

### Aviso de licença (Obsidian UI)

```
MIT License

Copyright (c) 2026 ObsidianUI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
