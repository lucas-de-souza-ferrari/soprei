# 018 — Frontend com componentes beUI e modo escuro

- **Status:** aprovada (2026-11-03, como proposta: site e telas de conta, View Transition do tema ligado; pedido do dono: usar os componentes de https://beui.dev/components/motion e ter modo escuro)
- **Branch:** `spec/018-frontend-beui`
- **Depende de:** 016 (site) e 017 (contas e empresas)

## Objetivo

O site e as telas de conta (entrar, cadastrar, confirmar e-mail, empresas) foram feitos com CSS próprio, sem os componentes do beUI que o dono indicou. Esta spec troca os elementos de interface pelos componentes do beUI (copiados como código-fonte, conforme o modelo da biblioteca) e acrescenta modo escuro (claro, escuro e do sistema), sem mudar o comportamento nem o contrato com o backend.

## Fatos conferidos (2026-11-03)

- O beUI é uma biblioteca de **código copiado para o projeto** (não um pacote npm), feita com React, Motion (`motion/react`) e Tailwind CSS, distribuída por um registro compatível com o shadcn: índice em `https://beui.dev/r`, item em `https://beui.dev/r/{slug}` (JSON com `files` e `dependencies`). **Licença MIT** (repositório `starc007/ui-components`, `LICENSE` conferido).
- Os componentes usam as classes semânticas do shadcn (`bg-primary`, `text-primary-foreground`, `bg-card`, `border-border`, `text-foreground`, `text-muted-foreground`, `bg-muted`, `bg-background`...), então herdam o tema do app: basta definir esses tokens uma vez.
- Dependências por componente (conferidas no registro): `motion`, `clsx`, `tailwind-merge`, `lucide-react`, `react`. O `theme-toggle` do beUI depende de `next-themes` (específico do Next.js, **não** será usado: o controle de tema é nosso, ver abaixo).
- O projeto usa Vite, React 19 e Tailwind 4 (`@tailwindcss/vite`), sem Next.js.

## Comportamento esperado

### Componentes (copiados para `frontend/src/components/motion/` e `frontend/src/lib/`)

Somente o necessário, com os caminhos e arquivos auxiliares do registro (`lib/utils.ts` com `cn`, `lib/ease.ts`, `lib/hooks/use-hover-capable.ts`):

- **Button** (`button-base`: `Button` e `ButtonLink`; variantes `primary`, `secondary`, `ghost`, `outline`): substitui os `button`/links de ação do site e das contas.
- **Input**: campos de e-mail, senha (com o controle de mostrar/ocultar existente), código e nome da empresa; estados de erro e sucesso.
- **Card**: o cartão das telas de conta e da lista de empresas.
- **Tabs**: alternância entre "Entrar" e "Criar conta".
- **Alert**: mensagens de erro, confirmação e "saída não confirmada".
- **Loader**: estado de carregamento (sessão, envio, criação de empresa).
- **Theme Toggle** (adaptado, ver abaixo).
- Se algum desses arquivos do registro depender de outro componente do beUI, copia-se esse também, sem ampliar o uso dele. Nenhum componente é copiado sem uso.

### Modo escuro

- Três escolhas: **Claro**, **Escuro** e **Sistema** (padrão). A escolha fica no `localStorage` (`soprei-theme`, com `try/catch`) e aplica a classe `dark` no `<html>`; "Sistema" segue `prefers-color-scheme` e reage à mudança do sistema.
- Um script mínimo no `<head>` do `index.html` aplica a classe antes da primeira pintura (sem piscar).
- Tailwind 4: `@custom-variant dark (&:where(.dark, .dark *))` e tokens semânticos em `:root` e `.dark`, derivados da identidade visual do Soprei (azul da marca, fundos e bordas) com **contraste mínimo WCAG AA** em texto e controles nos dois temas.
- O controle de tema fica no cabeçalho do site e no cabeçalho das telas de conta, com rótulo acessível e operável por teclado. O efeito de View Transition do beUI é opcional e respeita `prefers-reduced-motion`.
- O logotipo e as ilustrações têm versão legível no escuro (o SVG da marca é verificado nos dois fundos; se preciso, variante clara).

### Estilo existente

O CSS próprio (`style.css`) é reduzido ao que não tem componente (layout da página, hero, seções, a ilustração da conversa); cores fixas viram tokens, para que o modo escuro cubra o site inteiro. Textos, rotas, fluxos e contrato com o backend **não mudam**.

## Critérios de aceite

- [x] Os botões, campos, cartões, abas, alertas e indicadores de carregamento do site e das telas de conta usam os componentes do beUI copiados em `frontend/src/components/motion/` (sem `<button>`/`<input>` estilizados à mão onde há componente equivalente).
- [x] As dependências novas são apenas `motion`, `clsx`, `tailwind-merge` e `lucide-react` (versões fixas no `pnpm-lock.yaml`); **não** entra `next-themes`.
- [x] Existe controle de tema Claro/Escuro/Sistema; a escolha persiste ao recarregar; "Sistema" acompanha `prefers-color-scheme`; a classe `dark` é aplicada antes da primeira pintura (teste de navegador com tema salvo escuro: o `<html>` já tem `dark` no primeiro quadro, sem piscar para claro).
- [x] Em ambos os temas, os pares texto/fundo dos tokens principais têm contraste mínimo de 4,5:1 (teste unitário que calcula o contraste dos pares declarados) e os campos, botões e foco são visíveis.
- [x] Os fluxos de conta continuam passando (cadastro, confirmação, login, criar empresa, sair, "saída não confirmada"), em desktop e celular, nos dois temas (testes de navegador existentes adaptados mais um cenário por tema).
- [x] `prefers-reduced-motion` desliga as animações; o controle de tema e as abas funcionam só pelo teclado.
- [x] Sem `localStorage` além da chave de tema; nenhum dado de conta ou token no armazenamento do navegador.
- [x] `pnpm typecheck`, `lint`, `format:check`, `test`, `test:integration`, `build` e os testes de navegador verdes em Node 22 e 24; o `pnpm-lock.yaml` consistente.
- [x] A licença MIT do beUI e a origem dos arquivos copiados ficam registradas (arquivo `frontend/src/components/motion/NOTICE.md` com a URL do registro, a data e o aviso de copyright do projeto original).

## Casos de borda e erros

- `localStorage` indisponível (janela privada): o tema cai em "Sistema" sem erro.
- Navegador sem View Transition: o tema troca sem a animação.
- Valor inválido salvo em `soprei-theme`: ignorado, vale "Sistema".
- Componente do beUI que use `next/*`, `use client` ou recurso exclusivo do Next.js: adaptado na cópia (sem alterar o comportamento), registrado no `NOTICE.md`.

## Isolamento entre clientes

Não se aplica (só interface; nenhum dado ou rota muda).

## Fora de escopo

- Painel de conversas e novas telas (spec própria).
- Redesenho da identidade visual ou dos textos; troca de fontes.
- Biblioteca de ícones além do que os componentes copiados exigem.
- Internacionalização; publicação; novos componentes do beUI não listados aqui (gráficos, agentes, blocos).
- Alterações no backend.

## Decisões e dependências novas

- **Copiar, não instalar:** o beUI é distribuído como código-fonte (MIT); copiar os arquivos do registro para o projeto é o modelo da biblioteca e permite adaptar ao Vite. Cada arquivo copiado fica rastreável pelo `NOTICE.md`.
- **Dependências novas** (justificadas): `motion` (animações dos componentes), `tailwind-merge` e `clsx` (utilitário `cn` usado por todos os componentes), `lucide-react` (ícones dos componentes). Versões fixas e conferidas pelo implementer como estáveis e com mais de duas semanas.
- **Tema próprio, sem `next-themes`:** um hook e um provedor pequenos (`useTheme`), classe `dark` no `<html>` e script anterior à pintura; o componente de alternância do beUI é adaptado para usá-lo.
- **Padrão "Sistema":** quem não escolhe segue o sistema operacional.
- **Decisão do dono pendente:** quais telas entram agora (esta spec propõe o site e as telas de conta) e se o efeito de View Transition do tema fica ligado.

## Registro da implementação

- **Componentes copiados** (2026-11-03, do registro `https://beui.dev/r`; origem e adaptações em `frontend/src/components/motion/NOTICE.md`): `button` (`base.tsx`, índice reduzido a `Button`/`ButtonLink`), `input`, `card`, `tabs`, `alert`, `loader`, `action-swap` (dependência do Theme Toggle), `theme-toggle` (reescrito) e, em `src/lib/`, `utils`, `ease`, `presence-gate` e `hooks/use-hover-capable`. Não foram copiados botões magnético/metálico/com estado, `checkbox`, `switch`, `magnetic` nem as pré-visualizações.
- **Dependências** (fixas, todas com mais de duas semanas): `motion` 14.4.0 (19/10), `clsx` 2.1.1, `tailwind-merge` 3.7.0, `lucide-react` 1.59.0 (17/10). O lockfile também traz as transitivas do `motion` (`framer-motion`, `motion-dom`, `motion-utils`). Sem `next-themes`.
- **Tema:** `src/theme/theme.ts` (lógica pura), `theme-provider.tsx` (`ThemeProvider`/`useTheme`; `setTheme` aplica a classe de forma síncrona, requisito da View Transition), script no `<head>` do `index.html`, chave `soprei-theme`. O controle é **um botão que alterna Sistema, Claro e Escuro** (ícone por `ActionSwapIcon`, rótulo `Tema: X. Mudar para Y`), com View Transition circular que não roda com `prefers-reduced-motion` nem sem suporte do navegador. Escolha de projeto: três estados em um botão mantêm o cabeçalho enxuto no celular.
- **Tokens:** `:root` e `.dark` em `style.css` (nomes do shadcn mais `border-strong`, `input`, `ring`, `color-success` e superfícies do site), com `@theme inline` e `@custom-variant dark`. O CSS próprio foi para `@layer base/components` (CSS sem camada ganharia das utilidades do Tailwind) e o CSS das telas de conta foi removido (classes utilitárias nos componentes).
- **Desvios com motivo:** (1) `--primary` no tema claro é #0065d0, não o azul de marca #0078f4, que dá só 4,2:1 com texto branco; o azul de marca fica no logotipo. (2) Os cinzas claros de textos pequenos do site (abaixo de 3:1) viraram `muted-foreground` (5,5:1 ou mais): o site ficou um pouco mais contrastado. (3) Bordas de campo usam `--input` (3:1, WCAG 1.4.11); bordas decorativas seguem suaves. (4) Logotipo: nova variante `soprei-logo-dark.svg` (texto #F2F6FA; o original tem texto #1E1E1E), trocada por `dark:hidden`/`hidden dark:block` no componente `Logo`. (5) Mensagens de erro das contas passaram a ter `role="alert"` (Alert destructive) e as informativas `role="status"`; os testes de navegador foram adaptados. (6) Durante a verificação da sessão a tela mostra um `Loader` em vez do formulário desabilitado. (7) O botão de mostrar/ocultar senha usa ícones (Eye/EyeOff) com os mesmos nomes acessíveis. (8) `CardTitle` aceita `as="h1"`; interfaces vazias do `alert` viraram `type`.
- **Testes:** unitários do frontend 18 (`theme/contrast.test.ts`: pares de tokens nos dois temas, 4,5:1 para texto e 3:1 para borda de campo e foco; `theme/theme.test.tsx`: valor inválido, `localStorage` indisponível, sistema, aplicação da classe, script do `index.html`; `App.test.tsx`). Navegador (Playwright, desktop e celular): 24 (fluxos de conta e saída não confirmada nos dois temas; tema escuro salvo aplicado antes de a aplicação carregar, sistema e mudança do sistema, valor inválido, teclado no controle, `localStorage` bloqueado, abas por teclado, View Transition com e sem movimento reduzido). O script de testes do frontend passou a incluir `src/**/*.test.ts`.
- **Validação (Node 24.18.0 e 22.23.2):** typecheck, lint e format:check verdes; 1002 unitários de backend + 18 de frontend; 342 de integração; `pnpm build` e smoke do compilado (recusa ambiente inválido, saída 1). Unitários do frontend repetidos 5 vezes em Node 24; e2e 5 vezes em Node 24 e 4 em Node 22 (24/24 em todas). Verificação visual (capturas no scratchpad, fora do git) em desktop e celular, claro e escuro, de `/`, `/entrar`, erro de cadastro e lista de empresas: legível nos dois temas.
- **Observação:** o bundle do site passou de 500 kB (`motion`), com aviso do Vite; divisão de código fica para spec própria.
