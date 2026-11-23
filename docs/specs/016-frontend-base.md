# 016 — Estrutura do repositório e site de apresentação

- **Status:** concluída (na `main`; status normalizado em 2026-11-23, spec 042). Antes: aprovada pelo dono em 2026-10-30; em implementação
- **Branch:** `spec/016-frontend-base`
- **Depende de:** backend atual para a reorganização de arquivos

## Objetivo

Preparar o repositório para o frontend e o backend coexistirem em pastas próprias e criar o site de apresentação do Soprei.

## Comportamento esperado

- O código e a configuração específicos do servidor ficam em `backend/`; o aplicativo de interface fica em `frontend/`. Documentação, instruções de agentes e CI continuam acessíveis a partir da raiz. Workspace pnpm e comandos de raiz encaminham as operações aos pacotes.
- A movimentação preserva os contratos, migrations e comportamento do backend. Ajustar caminhos de Prisma, configuração, scripts, exemplos de ambiente, CI e documentação afetada. Arquivos locais ignorados, como `.env`, exigem orientação de migração; não entram no Git.
- O site apresenta o Soprei, seus benefícios e funcionamento, com navegação clara e chamada principal para conhecer o funcionamento na própria página. Textos e demonstrações devem corresponder às capacidades reais do produto e não sugerir funcionalidades ainda não disponíveis.
- Usar a marca fornecida pelo dono: [logo completo](../brand/soprei-logo.svg) e [ícone](../brand/logo-icon.svg). Os arquivos usam azul `#0078F4` no símbolo e o logo completo usa `#1E1E1E` no nome; preservar proporções e legibilidade. A tipografia do nome está convertida em curvas, portanto os arquivos não identificam uma fonte para o restante do site.
- A interface deve ter identidade própria para o Soprei, ser responsiva e acessível. Referências indicadas pelo dono: [Beautiful UI](https://www.beautifului.dev/) para exemplos de interfaces de IA; [beUI](https://beui.dev/) para transições e controles; [ObsidianUI](https://www.obsidianui.dev/) para detalhes visuais e interação. Animações respeitam a preferência por movimento reduzido.

## Critérios de aceite

- [ ] Em checkout limpo, instalação, geração do Prisma, build, typecheck, lint, formatação e testes do backend funcionam pelos comandos documentados; CI executa as verificações exigidas em Node 22 e LTS.
- [x] As migrations existentes são encontradas e aplicadas no banco de teste, sem alterar seu conteúdo ou histórico; exemplos de ambiente e instruções indicam seus novos caminhos.
- [x] O frontend instala, compila e executa suas verificações pelos comandos documentados, sem exigir credenciais reais nem chamar serviços externos nos testes.
- [x] O site renderiza as seções e a chamada aprovadas pelo dono; links e navegação funcionam em teste automatizado e não apontam para destinos fictícios.
- [ ] A interface é utilizável por teclado em telas estreitas e largas; controles têm nome acessível e a preferência por movimento reduzido desativa animações não essenciais, com verificações automatizadas adequadas.
- [x] O site não incorpora credenciais, tokens ou dados reais de conversas; exemplos visuais usam apenas dados fictícios.

## Casos de borda e erros

- A chamada principal leva à explicação do funcionamento na página; não depende de integração externa.
- Se o movimento reduzido estiver ativado, a navegação e os conteúdos permanecem utilizáveis sem animações essenciais.

## Isolamento entre clientes

O site de apresentação não acessa dados de clientes. A reorganização preserva as barreiras existentes no backend e seus testes de isolamento.

## Fora de escopo

- Login, painel de conversas, cadastro público, recuperação de senha, painel de administração da plataforma e envio humano de mensagens.
- Embedded Signup visual, tempo real, RLS, política de retenção e deploy em produção; cada um requer sua própria definição.
- Alteração de regras de negócio, stack ou contratos do backend, salvo ajuste explicitamente aprovado em spec.

## Decisões e dependências novas

1. **Primeira fatia:** decidido pelo dono em 2026-10-30: site de apresentação do Soprei.
2. **Stack do frontend:** React + TypeScript + Vite e Tailwind CSS, proposta aprovada pelo dono; componentes inspirados nas referências com licença compatível.
3. **Conteúdo e chamada principal:** apresentar o atendimento por IA e WhatsApp existente; a chamada leva à seção de funcionamento, sem formulário ou integração.
4. **Estrutura do repositório:** workspace pnpm com pacotes `backend` e `frontend` e comandos explícitos na raiz, conforme proposta aprovada.
5. **Identidade visual:** logo e ícone fornecidos pelo dono estão em `docs/brand/`; cores complementares, fontes de interface e eventuais versões para fundo escuro permanecem por definir. Usar elementos das bibliotecas apenas após conferir licença, atribuição e compatibilidade de cada componente; não copiar marca ou conteúdo dos sites.

## Registro da implementação

- Backend movido com `git mv`, preservando arquivos de código e migrations. Scripts de raiz encaminham operações ao pacote; configuração de ambiente local passa a `backend/`.
- Frontend React + TypeScript, Vite 6 e Tailwind CSS 4. Vite 6 foi escolhido porque aceita Node >=22.0; Vite 7 exige >=22.12. Dependências de teste: `tsx` e renderização estática do React; ESLint e tipos justificam as dependências de desenvolvimento.
- Interface própria inspirada em navegação e chat do Beautiful UI, transições de controles do beUI e composição visual do ObsidianUI. Nenhum código de terceiros dessas bibliotecas foi copiado. Logo fornecido pelo dono, azul da marca, Manrope e DM Sans via Google Fonts com fallback local.
- Chamada principal aponta para o funcionamento na própria página. Exemplo de conversa fictício e identificado; sem formulários ou integração com dados de clientes.
- CI verifica os dois pacotes. Não houve alteração de contrato, regra de negócio, migration ou configuração de segurança do backend.
- Validação local: Node 22.23.2 e 24.18.0, typecheck, lint, format:check, 994 unitários do backend e 339 de integração, todos verdes. Frontend: 2 testes, repetidos 5 vezes em cada Node; build dos dois pacotes e smoke do compilado recusando ambiente inválido verdes em ambos.
- `migrate deploy` com a configuração de teste encontrou as 8 migrations em `backend/prisma/migrations`, sem pendências nem alteração de histórico.
- Limites de verificação: CI em checkout limpo fica pendente do PR. Navegação e composição foram conferidas na prévia em janela estreita; teste automatizado verifica nomes acessíveis e declaração de movimento reduzido, mas ainda falta cobertura real de navegador para teclado e tamanhos de tela. Esses critérios permanecem desmarcados até essa verificação.
