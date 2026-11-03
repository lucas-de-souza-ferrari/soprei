# 018 — Frontend com componentes beUI e modo escuro

- **Status:** rascunho (pedido pelo dono em 2026-11-03: usar os componentes de https://beui.dev/components/motion e ter modo escuro; aguarda aprovação do escopo)
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

- [ ] Os botões, campos, cartões, abas, alertas e indicadores de carregamento do site e das telas de conta usam os componentes do beUI copiados em `frontend/src/components/motion/` (sem `<button>`/`<input>` estilizados à mão onde há componente equivalente).
- [ ] As dependências novas são apenas `motion`, `clsx`, `tailwind-merge` e `lucide-react` (versões fixas no `pnpm-lock.yaml`); **não** entra `next-themes`.
- [ ] Existe controle de tema Claro/Escuro/Sistema; a escolha persiste ao recarregar; "Sistema" acompanha `prefers-color-scheme`; a classe `dark` é aplicada antes da primeira pintura (teste de navegador com tema salvo escuro: o `<html>` já tem `dark` no primeiro quadro, sem piscar para claro).
- [ ] Em ambos os temas, os pares texto/fundo dos tokens principais têm contraste mínimo de 4,5:1 (teste unitário que calcula o contraste dos pares declarados) e os campos, botões e foco são visíveis.
- [ ] Os fluxos de conta continuam passando (cadastro, confirmação, login, criar empresa, sair, "saída não confirmada"), em desktop e celular, nos dois temas (testes de navegador existentes adaptados mais um cenário por tema).
- [ ] `prefers-reduced-motion` desliga as animações; o controle de tema e as abas funcionam só pelo teclado.
- [ ] Sem `localStorage` além da chave de tema; nenhum dado de conta ou token no armazenamento do navegador.
- [ ] `pnpm typecheck`, `lint`, `format:check`, `test`, `test:integration`, `build` e os testes de navegador verdes em Node 22 e 24; o `pnpm-lock.yaml` consistente.
- [ ] A licença MIT do beUI e a origem dos arquivos copiados ficam registradas (arquivo `frontend/src/components/motion/NOTICE.md` com a URL do registro, a data e o aviso de copyright do projeto original).

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
