# 017 — Conta da pessoa e empresas dentro da conta

- **Status:** rascunho — requisitos de produto decididos; desenho e migração aguardam aprovação
- **Branch:** `spec/017-contas-e-empresas`
- **Depende de:** 007, 008 e 016; preserva o isolamento das specs 010, 011 e 015

## Objetivo

Permitir cadastro e login apenas com e-mail e senha. Depois de entrar, a pessoa poderá criar empresas e acessá-las dentro da própria conta, conforme decisão do dono em 2026-11-03.

Esta mudança substitui o rascunho anterior da 017 (login com `clientSlug` e consulta de conversas). O painel de conversas será uma fatia posterior. Autenticação, endpoint público, autorização e migração passam pelo `reviewer` antes do merge.

## Comportamento esperado

### Experiência decidida pelo dono

1. “Criar conta” pede somente e-mail e senha. Nenhuma empresa, slug, documento ou telefone é exigido nessa etapa.
2. Login pede somente e-mail e senha, mesmo que a pessoa participe de várias empresas.
3. A área autenticada lista exclusivamente as empresas às quais a conta tem acesso. Sem empresas, oferece “Criar empresa”.
4. A própria pessoa pode criar empresas e será `OWNER` de cada uma. Nome e dados da empresa são informados depois do cadastro da conta; identificadores técnicos são gerados pelo servidor e não são credenciais de login.
5. A pessoa seleciona a empresa em que quer trabalhar. Pode ser `OWNER` em A e `VIEWER` em B; empresa pode ter várias pessoas. Conversas, canal, auditoria e permissões permanecem separados por empresa.
6. Frontend segue a identidade da 016; cadastro, login, lista/criação/seleção de empresas, saída e erros são a experiência alvo. O detalhamento pode ser dividido nas fatias descritas em “Decisões”.

### Desenho proposto (aguarda aprovação)

- Separar **conta global** (e-mail normalizado único, hash scrypt e estado) de **participação em empresa** (`accountId`, `clientId`, papel e estado do vínculo). Preferir evoluir o `User` atual para vínculo, preservando seus ids e as FKs compostas da auditoria. Conta global terá repositório restrito à identidade; consultas de negócio continuam exigindo `ClientId`.
- Conta desativada perde acesso a todas as empresas; vínculo desativado perde acesso apenas à respectiva empresa. Empresa suspensa segue as regras existentes. `PlatformAdmin` continua identidade separada, nunca concedida pelo cadastro público.
- Criar empresa e vínculo `OWNER` para a conta autenticada na mesma transação. Falha não deixa empresa sem dono; `ownerId` enviado no corpo não determina a titularidade.
- Administrador de empresa não define nem redefine senha global de outra pessoa. Os contratos atuais de criação/reset com senha devem ser adaptados à gestão de vínculos, sem permitir assumir contas em outras empresas. Não associar vínculo apenas por e-mail não confirmado.
- Recomenda-se separar sessão da conta, sem privilégios de tenant, da credencial da empresa selecionada. O servidor valida vínculo ativo para selecionar/renovar; conhecer um `clientId` não concede acesso. Revogação precisa impedir uso de credenciais antigas conforme contrato final.
- Troca de empresa limpa caches e ignora respostas tardias. Senhas, tokens, códigos, contatos e conteúdo de conversas não entram em logs ou métricas.

### Contratos a detalhar antes da aprovação

`POST /auth/login` passa a receber `{ email, password }`, sem `clientSlug`. Ainda precisam ser definidos endpoints/schemas de cadastro, confirmação de titularidade, identidade global, listagem/criação/seleção de empresas, renovação/logout e gestão de vínculos. Nenhum contrato implícito autoriza implementação.

O desenho final deve especificar armazenamento/transporte da sessão no navegador, claims/tipos de identidade, chaves Redis de conta versus tenant, rotação/reuso e escopo de revogação, hooks, CLI, auditoria, códigos de erro e limites antiabuso. Tokens apenas em memória, propostos no rascunho anterior, não foram aprovados.

## Critérios de aceite

- [ ] Cadastro e login usam apenas e-mail/senha; conta sem vínculo entra e recebe lista vazia, sem privilégios de tenant.
- [ ] E-mail normalizado é único entre contas, inclusive em cadastros concorrentes; hash/política de senha continuam atrás das portas existentes e segredos não aparecem em logs ou métricas.
- [ ] Criação de empresa e vínculo `OWNER` é atômica. Uma conta cria e seleciona duas empresas; falha desfaz ambos os registros.
- [ ] Papéis de A e B são independentes. Conta sem vínculo com C não lista, seleciona ou acessa dados de C, mesmo conhecendo ids.
- [ ] Sessão sem tenant é recusada pelas rotas de negócio; conta/vínculo desativado, empresa suspensa e credenciais anteriores são tratados conforme os contratos aprovados.
- [ ] Administrador de A não altera senha/estado global ou vínculo de B da mesma conta. Último `OWNER`, hierarquia e auditoria continuam protegidos sob concorrência.
- [ ] Testes de navegador cobrem cadastro, login, conta sem empresa, criação, seleção/troca, logout, respostas tardias e teclado em telas estreitas/largas; dados de A não aparecem ao trocar para B.
- [ ] Migração preserva ids/relações da auditoria e dados de negócio; teste cobre e-mails únicos, colisões e vínculos desativados, sem fusão automática ou escolha arbitrária de senha.
- [ ] Sessões antigas são recusadas de forma controlada; CLI, exemplos de ambiente, documentação e testes refletem os novos contratos.
- [ ] Os contratos finais de titularidade, antiabuso, renovação/revogação e falhas têm testes automatizados. Validação completa passa nas duas versões de Node exigidas e a revisão independente é registrada.

## Casos de borda e erros

- Mesmo e-mail em usuários atuais de clientes distintos pode ter senhas diferentes. Não escolher um hash arbitrário nem conceder todos os vínculos apenas porque os e-mails coincidem.
- Cadastro com e-mail existente não substitui senha nem concede vínculos. Evitar enumeração; confirmação deve tratar expiração, uso único, concorrência e abuso. Conta registrada por terceiro não pode apropriar-se de vínculo existente.
- Falha do Redis mantém autenticação fail-closed. Revogação parcial não pode preservar permissões de vínculo removido.
- Nome de empresa inválido e concorrência têm erros controlados. Limites de criação por conta/IP devem ser aprovados antes de expor os endpoints.

## Isolamento entre clientes

Conta global autentica a pessoa, mas não concede acesso automático a empresa alguma. Operações de negócio continuam com `ClientId` de credencial validada e vínculo autorizado pelo servidor. Manter barreiras de repositório, Prisma, FKs compostas e ESLint; classificar models novos em `MODEL_SCOPES`. O repositório global de identidade não deve virar porta genérica para dados de tenants.

Testes com duas contas e três empresas cobrem adulteração de ids, seleção de empresa alheia, tokens antigos, promoção indevida e troca de empresa no navegador. Todo teste de fluxo captura logs e prova ausência de dados secretos.

## Fora de escopo

- Painel de conversas, tempo real, edição de persona e telas do canal/Embedded Signup.
- SSO/login social, cobrança, planos e fusão/transferência de empresas.
- Troca da stack ou alteração do papel de `PlatformAdmin`.
- Deploy e dados reais antes de retenção/LGPD, RLS e recuperação de mensagens pendentes.

## Decisões e dependências novas

**Decidido pelo dono em 2026-11-03:** cadastro/login apenas por e-mail e senha; empresas dentro da conta; pessoa pode criar empresas e será dona delas.

**Pendentes antes de aprovação/implementação:**

1. **Identidade/vínculos:** recomenda-se conta global nova e `User` evoluindo para vínculo, preservando ids da auditoria. Alternativa: model novo para vínculo e migração de todas as FKs. Detalhar schema após escolha.
2. **Titularidade/cadastro público:** recomenda-se confirmar e-mail antes de criar empresa ou receber vínculo, com código de uso único, prazo e limites. Provedor de e-mail ainda não escolhido. Alternativa de desenvolvimento: confirmação operacional pelo dono, sem abertura pública. Não associar contas legadas por e-mail não comprovado.
3. **Migração:** recomenda-se relatório prévio de colisões e resolução explícita aprovada pelo dono; nenhuma fusão automática. Invalidar sessões antigas com versão de identidade. Não recriar bancos nem reescrever migrations existentes.
4. **Sessão:** escolher persistência por cookie HttpOnly e sessão server-side (com CSRF, origem e concorrência detalhados) ou tokens em memória e novo login ao recarregar. Decisão ainda aberta; nenhuma nova dependência está aprovada.
5. **Divisão:** a mudança atravessa identidade, sessão, gestão de usuários e frontend. Recomenda-se detalhar primeiro fundação/migração na 017 e reservar as telas/onboarding completo à próxima fatia se não couber em um PR revisável. Não publicar estado intermediário inseguro.

Esta versão registra a mudança de direção; contratos e limites devem ser completados e aprovados antes de código de produção.
