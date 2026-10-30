# 016 — Estrutura para o frontend do Soprei

- **Status:** rascunho — decisões de escopo e tecnologia aguardam o dono
- **Branch:** `spec/016-frontend-base`
- **Depende de:** backend atual e specs 007, 008, 010 e 015 para os contratos que vierem a ser usados

## Objetivo

Preparar o repositório para o frontend e o backend coexistirem em pastas próprias e estabelecer a primeira fatia visual do painel. O dono escolhe a primeira funcionalidade antes da aprovação; se não couber em um PR pequeno, ela terá spec própria.

## Comportamento esperado

- O código e a configuração específicos do servidor ficam em `backend/`; o aplicativo de interface fica em `frontend/`. Documentação, instruções de agentes e CI continuam acessíveis a partir da raiz. O desenho dos comandos e do workspace deve ser decidido antes da implementação.
- A movimentação preserva os contratos, migrations e comportamento do backend. Ajustar caminhos de Prisma, configuração, scripts, exemplos de ambiente, CI e documentação afetada. Arquivos locais ignorados, como `.env`, exigem orientação de migração; não entram no Git.
- A primeira interface deve ter identidade própria para o Soprei, ser responsiva e acessível, com hierarquia visual clara e estados de carregamento, vazio e erro. Referências indicadas pelo dono: [Beautiful UI](https://www.beautifului.dev/) para navegação, tabelas e chat; [beUI](https://beui.dev/) para transições e controles; [ObsidianUI](https://www.obsidianui.dev/) para detalhes visuais e interação. Animações respeitam a preferência por movimento reduzido.
- A funcionalidade inicial proposta é login do usuário do cliente e leitura de conversas e mensagens, usando as APIs existentes. Ela não promete resposta humana, tempo real ou cadastro público, que não fazem parte do contrato atual. Esta proposta depende da escolha do dono abaixo.

## Critérios de aceite

- [ ] Em checkout limpo, instalação, geração do Prisma, build, typecheck, lint, formatação e testes do backend funcionam pelos comandos documentados; CI executa as verificações exigidas em Node 22 e LTS.
- [ ] As migrations existentes são encontradas e aplicadas no banco de teste, sem alterar seu conteúdo ou histórico; exemplos de ambiente e instruções indicam seus novos caminhos.
- [ ] O frontend instala, compila e executa suas verificações pelos comandos documentados, sem exigir credenciais reais nem chamar serviços externos nos testes.
- [ ] Se o dono escolher o painel proposto: login, listagem paginada de conversas e leitura paginada de mensagens funcionam com respostas simuladas da API; estados vazio, falha e sessão expirada são verificáveis por teste.
- [ ] A interface é utilizável por teclado em telas estreitas e largas; controles têm nome acessível e a preferência por movimento reduzido desativa animações não essenciais, com verificações automatizadas adequadas.
- [ ] Não há conteúdo, credenciais ou tokens em logs ou telemetria do frontend; autorização e isolamento continuam sendo verificados pelo backend.

## Casos de borda e erros

- Falha de rede, 401, 403, 404, 429 e indisponibilidade exibem estados claros sem revelar detalhes internos. Uma sessão inválida exige novo login.
- Um `sentAt` nulo não comprova entrega; a interface não apresenta essa resposta como enviada.
- A API de refresh usa token opaco com rotação e detecção de reuso. Persistência da sessão, concorrência entre abas e estratégia de implantação exigem decisão e revisão de segurança antes de implementar.
- O backend não possui CORS configurado para um frontend separado: origem e proxy precisam ser definidos sem liberar origens indiscriminadamente.

## Isolamento entre clientes

O frontend obtém a identidade da sessão autenticada e usa o `clientId` correspondente nas rotas; ele não constitui barreira de segurança. O backend continua validando o token, a permissão e a correspondência do cliente. Testes de integração devem provar que uma sessão do cliente A não acessa conversas do cliente B; a interface deve tratar a recusa sem exibir dados de B. A solução de autenticação e seus testes passam pelo `reviewer` antes do merge.

## Fora de escopo

- Cadastro público, recuperação de senha, painel de administração da plataforma e envio humano de mensagens.
- Embedded Signup visual, tempo real, RLS, política de retenção e deploy em produção; cada um requer sua própria definição.
- Alteração de regras de negócio, stack ou contratos do backend, salvo ajuste explicitamente aprovado em spec.

## Decisões e dependências novas

1. **Primeira fatia:** recomenda-se login e consulta de conversas para tornar o atendimento visível; alternativa: iniciar pela conexão do WhatsApp ou por um site institucional. O dono decide.
2. **Stack do frontend:** proposta React + TypeScript + Vite, pnpm e Tailwind CSS, com componentes selecionados das referências quando licença e acessibilidade permitirem. Alternativa: Next.js caso seja necessário renderizar páginas no servidor. Dependências e versões serão justificadas após a escolha; nenhuma está aprovada por esta proposta.
3. **Sessão e implantação:** definir modelo de armazenamento e rotação de tokens, comportamento em múltiplas abas e comunicação com API (mesma origem por proxy ou origens separadas com CORS). A escolha altera a segurança e pode exigir uma spec própria para backend; passa pelo reviewer.
4. **Estrutura do repositório:** recomenda-se workspace pnpm com pacotes `backend` e `frontend` e comandos explícitos na raiz; alternativa: projetos independentes. Preservar lockfile e CI de modo reproduzível. O dono decide.
5. **Identidade visual:** definir cores, marca e tipografia com o dono. Usar elementos das bibliotecas apenas após conferir licença, atribuição e compatibilidade de cada componente; não copiar marca ou conteúdo dos sites.
