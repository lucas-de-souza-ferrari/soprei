# 016 — Estrutura do repositório e site de apresentação

- **Status:** rascunho — decisões de escopo e tecnologia aguardam o dono
- **Branch:** `spec/016-frontend-base`
- **Depende de:** backend atual para a reorganização de arquivos

## Objetivo

Preparar o repositório para o frontend e o backend coexistirem em pastas próprias e criar o site de apresentação do Soprei. A primeira entrega do frontend foi escolhida pelo dono; o conteúdo e a identidade aguardam definição.

## Comportamento esperado

- O código e a configuração específicos do servidor ficam em `backend/`; o aplicativo de interface fica em `frontend/`. Documentação, instruções de agentes e CI continuam acessíveis a partir da raiz. O desenho dos comandos e do workspace deve ser decidido antes da implementação.
- A movimentação preserva os contratos, migrations e comportamento do backend. Ajustar caminhos de Prisma, configuração, scripts, exemplos de ambiente, CI e documentação afetada. Arquivos locais ignorados, como `.env`, exigem orientação de migração; não entram no Git.
- O site apresenta o Soprei, seus benefícios e funcionamento, com navegação clara e chamada principal definida com o dono. Textos e demonstrações devem corresponder às capacidades reais do produto e não sugerir funcionalidades ainda não disponíveis.
- A interface deve ter identidade própria para o Soprei, ser responsiva e acessível. Referências indicadas pelo dono: [Beautiful UI](https://www.beautifului.dev/) para exemplos de interfaces de IA; [beUI](https://beui.dev/) para transições e controles; [ObsidianUI](https://www.obsidianui.dev/) para detalhes visuais e interação. Animações respeitam a preferência por movimento reduzido. O dono compartilhará referências de marca, cores e fontes.

## Critérios de aceite

- [ ] Em checkout limpo, instalação, geração do Prisma, build, typecheck, lint, formatação e testes do backend funcionam pelos comandos documentados; CI executa as verificações exigidas em Node 22 e LTS.
- [ ] As migrations existentes são encontradas e aplicadas no banco de teste, sem alterar seu conteúdo ou histórico; exemplos de ambiente e instruções indicam seus novos caminhos.
- [ ] O frontend instala, compila e executa suas verificações pelos comandos documentados, sem exigir credenciais reais nem chamar serviços externos nos testes.
- [ ] O site renderiza as seções e a chamada aprovadas pelo dono; links e navegação funcionam em teste automatizado e não apontam para destinos fictícios.
- [ ] A interface é utilizável por teclado em telas estreitas e largas; controles têm nome acessível e a preferência por movimento reduzido desativa animações não essenciais, com verificações automatizadas adequadas.
- [ ] O site não incorpora credenciais, tokens ou dados reais de conversas; exemplos visuais usam apenas dados fictícios.

## Casos de borda e erros

- Conteúdo e destino da chamada principal dependem da decisão do dono. Se uma integração externa for necessária, seus estados de erro e contrato serão detalhados antes da aprovação.
- Se o movimento reduzido estiver ativado, a navegação e os conteúdos permanecem utilizáveis sem animações essenciais.

## Isolamento entre clientes

O site de apresentação não acessa dados de clientes. A reorganização preserva as barreiras existentes no backend e seus testes de isolamento.

## Fora de escopo

- Login, painel de conversas, cadastro público, recuperação de senha, painel de administração da plataforma e envio humano de mensagens.
- Embedded Signup visual, tempo real, RLS, política de retenção e deploy em produção; cada um requer sua própria definição.
- Alteração de regras de negócio, stack ou contratos do backend, salvo ajuste explicitamente aprovado em spec.

## Decisões e dependências novas

1. **Primeira fatia:** decidido pelo dono em 2026-10-30: site de apresentação do Soprei.
2. **Stack do frontend:** proposta React + TypeScript + Vite, pnpm e Tailwind CSS, com componentes selecionados das referências quando licença e acessibilidade permitirem. Alternativa: Next.js caso seja necessário renderizar páginas no servidor. Dependências e versões serão justificadas após a escolha; nenhuma está aprovada por esta proposta.
3. **Conteúdo e chamada principal:** definir público, mensagem, seções e destino da chamada com o dono; qualquer formulário ou integração depende de contrato e escopo aprovados.
4. **Estrutura do repositório:** recomenda-se workspace pnpm com pacotes `backend` e `frontend` e comandos explícitos na raiz; alternativa: projetos independentes. Preservar lockfile e CI de modo reproduzível. O dono decide.
5. **Identidade visual:** o dono informou que tem referências de marca, cores e fontes e vai compartilhá-las. Usar elementos das bibliotecas apenas após conferir licença, atribuição e compatibilidade de cada componente; não copiar marca ou conteúdo dos sites.
