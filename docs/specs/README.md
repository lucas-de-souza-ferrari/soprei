# Specs do Soprei

Índice das specs (spec 042). Uma linha por arquivo; um teste (`backend/src/docs-structure.test.ts`) falha se uma spec ficar fora daqui ou se a linha de status dela não começar por uma das cinco palavras do [modelo](_template.md): `esboço`, `rascunho`, `aprovada`, `em implementação`, `concluída`.

- A ordem de execução é a do roadmap em [docs/context.md](../context.md), não a numeração.
- `concluída` quer dizer código na `main` com o CI verde, **não** que está publicado: em 2026-11-23 não há servidor de produção. Passos que só o dono faz aparecem em "Pendente".
- Quem cria ou muda o status de uma spec atualiza a linha dela aqui.
- Os títulos das specs 001 a 021 usam o vocabulário anterior à spec 022 (ver a tabela no topo do `AGENTS.md`).

| Spec | Título | Status | Pendente |
| --- | --- | --- | --- |
| [001](001-bootstrap.md) | Bootstrap do projeto | concluída | — |
| [002](002-infra-local-database.md) | Infra local, banco e Redis | concluída | — |
| [003](003-multi-tenant-base.md) | Base multi-tenant e isolamento entre clientes | concluída | — |
| [004](004-observabilidade.md) | Observabilidade: logs com contexto e métricas | concluída | — |
| [005](005-rate-limiting.md) | Rate limiting | concluída | — |
| [006](006-cache.md) | Cache em duas camadas | esboço | sob demanda |
| [007](007-autenticacao-jwt.md) | Autenticação com JWT e refresh token (substitui a `ADMIN_API_KEY`) | concluída | — |
| [008](008-rbac.md) | Autorização por papéis, usuários do cliente pela API e auditoria (RBAC) | concluída | — |
| [009](009-tempo-real.md) | Tempo real: SSE e WebSocket | esboço | sob demanda |
| [010](010-fatia-vertical-atendimento.md) | Fatia vertical: atendimento ponta a ponta com LLM mock | concluída | — |
| [011](011-canal-whatsapp.md) | Canal WhatsApp: webhook de entrada e envio da resposta | concluída | — |
| [012](012-reorganizacao-pastas.md) | Reorganização de pastas (sem mudança de comportamento) | concluída | — |
| [013](013-agrupamento-de-mensagens.md) | Agrupamento de mensagens rápidas (janela de espera) | concluída | — |
| [014](014-provedor-llm-real.md) | Provedor real de LLM (Claude Haiku 5.5) | concluída | termos de dados e limite de gasto da Anthropic (dono) |
| [015](015-onboarding-whatsapp.md) | Onboarding de clientes no canal WhatsApp (credenciais por cliente e Embedded Signup) | concluída | — |
| [016](016-frontend-base.md) | Estrutura do repositório e site de apresentação | concluída | — |
| [017](017-contas-e-empresas.md) | Conta da pessoa e empresas dentro da conta | concluída | — |
| [018](018-frontend-beui-e-modo-escuro.md) | Frontend com componentes beUI e modo escuro | concluída | — |
| [019](019-smtp-generico.md) | Envio de e-mail por SMTP genérico | concluída | — |
| [020](020-codigo-confirmacao-6-digitos.md) | Código de confirmação de e-mail com 6 dígitos | concluída | — |
| [021](021-recuperacao-de-senha.md) | Recuperação de senha e expurgo de contas não confirmadas | concluída | — |
| [022](022-renome-do-dominio.md) | Renome do domínio: `Client` vira `Company` e `User` vira `Membership` | concluída | — |
| [023](023-conectar-whatsapp-no-site.md) | Conectar o WhatsApp pelo site (canal, persona e teste do atendimento) | concluída | teste manual do Embedded Signup real (Fase 3) |
| [024](024-painel-de-conversas.md) | Painel mínimo de conversas no site (lista e histórico, só leitura) | concluída | — |
| [025](025-convites-e-equipe.md) | Convites por e-mail e gestão da equipe pelo site | concluída | — |
| [026](026-conhecimento-e-estoque.md) | Base de conhecimento para a IA e controle de estoque (MVP) | concluída | — |
| [027](027-agendamento.md) | Agendamento (agenda da empresa, horários livres para a IA e painel) | concluída | — |
| [028](028-ia-agenda-tool-use.md) | A IA marca, remarca e cancela horários pelo WhatsApp (tool use) | concluída | E0 (teste com a chave real) antes de ligar a escrita; E5 (teste manual) |
| [029](029-redesign-painel.md) | Redesign do painel: sidebar, empresa sempre aberta, bolhas de mensagem e calendário da agenda | concluída | — |
| [030](030-wizard-onboarding.md) | Primeiros passos: assistente de configuração (wizard) e lista "Configuração" | concluída | — |
| [031](031-planos-e-assinaturas.md) | Planos e assinaturas (cobrança pela InfinitePay) | em implementação | E6 (pacote extra de respostas) |
| [032](032-lgpd-e-retencao.md) | LGPD e retenção de dados | em implementação | E2 em diante (aceite dos termos, retenção, exclusão) |
| [033](033-producao-deploy-e-operacao.md) | Produção, deploy e operação | rascunho | não aprovada |
| [034](034-capacidade-do-canal.md) | Capacidade do canal (worker concorrente e processo robusto) | em implementação | E4 (`PROCESS_ROLE`) e E5 (limite do webhook) |
| [035](035-resiliencia-do-atendimento.md) | Resiliência do atendimento: retomar o que ficou sem resposta e limpar a fila | em implementação | CI (integração); `reviewer` na E4, se o dono quiser |
| [036](036-ci-mais-rapido.md) | CI mais rápido | concluída | — |
| [037](037-deploy-e-staging.md) | Deploy com rollback e staging | concluída | servidor de produção e de staging (dono) |
| [038](038-notificacoes-atendimento-humano.md) | Notificações no painel: a IA pede atendimento humano | concluída | — |
| [039](039-conexao-por-coexistencia.md) | Conexão do WhatsApp por coexistência (o cliente continua usando o aplicativo WhatsApp Business no celular) | concluída | — |
| [040](040-novos-planos-e-enterprise.md) | Novo catálogo de planos, cota de tokens fora da tela e plano Enterprise por contato | concluída | — |
| [041](041-conhecimento-pdf-docx.md) | Conhecimento: ler PDF e DOCX no navegador | concluída | `location` do `.mjs` no nginx e teste manual (dono, conferir) |
| [042](042-organizacao-da-documentacao.md) | Organização da documentação | em implementação | CI e merge da E1 e da E2 |
| [043](043-backup-externo.md) | Backup externo do banco e teste de restauração | em implementação | CI; confirmação da D3; passos do dono parados até existir servidor |
