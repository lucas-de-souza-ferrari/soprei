# Componentes do beUI (origem e licença)

Os arquivos desta pasta e de `frontend/src/lib/` foram copiados, como código-fonte, do **beUI**
(https://beui.dev/components/motion), distribuído sob a **licença MIT**. O beUI é uma biblioteca de
código copiado (não um pacote npm); o repositório de origem é `starc007/ui-components`.

- **Registro consultado:** índice `https://beui.dev/r`; itens `https://beui.dev/r/{slug}` (e
  `https://beui.dev/r/{slug}/raw`) para `button-base`, `input`, `card`, `tabs`, `alert`, `loader` e
  `theme-toggle`.
- **Data da cópia:** 2026-11-03 (spec 018).
- **Aviso de copyright do projeto original:**

```
MIT License

Copyright (c) 2026 Saurabh Chauhan

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

## Arquivos copiados e adaptações

| Arquivo aqui                           | Origem (caminho no registro)         | Adaptações                                                                                                               |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `button/base.tsx`                      | `components/motion/button/base.tsx`  | imports relativos                                                                                                        |
| `button/index.tsx`                     | `components/motion/button/index.tsx` | reduzido a `Button` e `ButtonLink` (os botões magnético, metálico e com estado não são usados e não foram copiados)      |
| `input.tsx`                            | `components/motion/input.tsx`        | imports relativos                                                                                                        |
| `card.tsx`                             | `components/motion/card.tsx`         | imports relativos; `CardTitle` aceita também `as="h1"`                                                                   |
| `tabs.tsx`                             | `components/motion/tabs.tsx`         | imports relativos                                                                                                        |
| `alert.tsx`                            | `components/motion/alert.tsx`        | imports relativos; as interfaces vazias viraram `type` (regra do ESLint `no-empty-object-type`), sem mudar o tipo        |
| `loader.tsx`                           | `components/motion/loader.tsx`       | imports relativos                                                                                                        |
| `action-swap.tsx`                      | `components/motion/action-swap.tsx`  | imports relativos (dependência do Theme Toggle: só `ActionSwapIcon` é usado)                                             |
| `theme-toggle.tsx`                     | `components/motion/theme-toggle.tsx` | **reescrito**: sem `next-themes`, usa o `useTheme` do projeto; alterna sistema, claro e escuro; mantém a View Transition |
| `../../lib/utils.ts`                   | `lib/utils.ts`                       | nenhuma                                                                                                                  |
| `../../lib/ease.ts`                    | `lib/ease.ts`                        | nenhuma                                                                                                                  |
| `../../lib/presence-gate.tsx`          | `lib/presence-gate.tsx`              | nenhuma                                                                                                                  |
| `../../lib/hooks/use-hover-capable.ts` | `lib/hooks/use-hover-capable.ts`     | nenhuma                                                                                                                  |

Adaptações comuns a todos: removida a diretiva `"use client"` (específica do Next.js), `@/lib/...`
virou caminho relativo (o projeto não usa aliases) e os arquivos foram formatados com o Prettier do
projeto (aspas simples, 100 colunas). Nenhum arquivo usa `next/*`. Os arquivos de pré-visualização
(`*.preview.tsx`) e os componentes que não são usados (`checkbox`, `switch`, `magnetic`, botões
`metallic`, `stateful` e `magnetic`) **não** foram copiados.

Os tokens de cor (`bg-primary`, `text-foreground`, `border-border`...) e o modo escuro vêm de
`frontend/src/style.css`, com a paleta derivada da identidade do Soprei.
