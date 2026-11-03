# 017 — Login e consulta de conversas no painel do cliente

- **Status:** rascunho — aguardando aprovação das decisões abaixo
- **Branch:** `spec/017-painel-cliente`
- **Depende de:** 007 (autenticação), 008 (permissões), 010 (conversas), 016 (frontend e workspace)

## Objetivo

Permitir que uma pessoa de um cliente entre no Soprei e consulte suas conversas pelo navegador. Entregar a primeira fatia funcional do painel sobre as APIs existentes, com revisão obrigatória pelo `reviewer` por envolver autenticação e isolamento.

## Comportamento esperado

### Interface e rotas

- Preservar o site público em `/`; adicionar link “Entrar” para `/entrar`.
- `/entrar`: identificador da empresa (`clientSlug`), e-mail e senha, com labels e autocomplete apropriados. Mostrar erros acessíveis e impedir submissão duplicada; nunca normalizar ou remover espaços da senha. A API continua responsável pela validação definitiva.
- Após login, carregar `/auth/me`, exigir `kind: 'user'` e abrir `/painel/conversas`. Mostrar nome da empresa e e-mail da pessoa, além da ação “Sair”. Não há seleção de outro cliente.
- `/painel/conversas/:conversationId`: lista de conversas e histórico da conversa selecionada; em telas estreitas, navegar entre lista e histórico com ação de voltar. Identificar contatos pelo `contactRef`, pois o contrato atual não oferece nome de perfil nem prévia da última mensagem.
- Exibir mensagens como texto escapado, papel, data/hora e indicação de fallback. Para respostas, `sentAt` preenchido significa envio registrado ao canal; nulo deve aparecer como “Sem envio registrado”, sem afirmar falha, leitura ou entrega ao dispositivo.
- Paginação por cursor usando o contrato atual (`items`, `nextCursor`), com ação “Carregar mais”. Preservar a ordenação retornada pela API e impedir duplicação de itens por id. No histórico, apresentar a sequência cronológica sem inventar timestamps.
- Ação explícita “Atualizar”; nenhuma sondagem automática, SSE ou WebSocket nesta fatia. Sem indicadores de dados que a API não fornece (não lidas, atendente, contagens globais).
- Usar a marca e as referências visuais da 016: sidebar compacta, controles claros e composição de chat. Estados de carregamento, vazio, falha e acesso negado; teclado, foco visível, nomes acessíveis e movimento reduzido. Dados de testes e demonstrações sempre fictícios.

### Contratos existentes

O frontend chama caminhos relativos `/api/...`. Em desenvolvimento, o proxy do Vite retira apenas `/api` e encaminha para o backend local, sem reescrever headers de identidade ou relaxar `TRUST_PROXY`. O destino usa uma variável de configuração do servidor Vite (proposta `BACKEND_PROXY_TARGET`, padrão `http://127.0.0.1:3000`), validada como URL HTTP(S) e documentada em exemplo sem segredos. Ela não vai ao bundle do navegador. A hospedagem futura deve fornecer o mesmo encaminhamento de origem; implantação permanece em spec própria. Não adicionar CORS aberto.

| Operação | API do backend | Uso |
| --- | --- | --- |
| Entrar | `POST /auth/login` com `{ clientSlug, email, password }` | Recebe `accessToken`, `refreshToken`, `tokenType`, `expiresIn` |
| Identidade | `GET /auth/me` com Bearer | `{ kind: 'user', id, email, role, client: { id, name, slug } }` |
| Renovar | `POST /auth/refresh` com `{ refreshToken }` | Substitui os dois tokens |
| Sair | `POST /auth/logout` com `{ refreshToken }` | Revoga a sessão, 204 |
| Conversas | `GET /admin/clients/:clientId/conversations` | `limit` e `cursor`; `conversation:read` |
| Mensagens | `GET /admin/clients/:clientId/conversations/:conversationId/messages` | `limit` e `cursor`; `conversation:read` |

Não criar novos endpoints, tabelas ou migrations. Tipos/schemas de resposta do frontend devem validar os dados recebidos com Zod sem importar infraestrutura nem código do servidor para o bundle.

### Sessão proposta (decisão 1)

- Access e refresh tokens apenas em memória da aba. Não usar localStorage, sessionStorage, IndexedDB, cookies, URL ou logs para armazená-los. Recarregar a página ou abrir nova aba exige login; abas têm sessões independentes.
- Renovar sob demanda, quando a validade calculada por `expiresIn` acabou ou uma consulta autenticada responde 401. Compartilhar uma única Promise de renovação por sessão/aba: requisições concorrentes não podem consumir o mesmo refresh duas vezes.
- Após sucesso, substituir access e refresh juntos e repetir a consulta no máximo uma vez. Recusa de renovação encerra a sessão. Timeout ou falha de rede/503 durante refresh tem resultado ambíguo: não repetir automaticamente o refresh antigo; limpar a sessão e pedir novo login com mensagem de indisponibilidade.
- Logout bloqueia novas consultas, aguarda eventual refresh em andamento, usa o token mais recente para revogar e limpa tokens, identidade, conversas e mensagens em qualquer resultado. Se a revogação falhar, informar que a saída local ocorreu mas a revogação não pôde ser confirmada. Nunca restaurar a sessão após sair.
- Usar uma geração da sessão e cancelamento de requisições para ignorar respostas tardias após logout ou outro login. Ao trocar de conversa, uma resposta atrasada da seleção anterior não substitui o histórico atual.
- Respostas autenticadas e erros que possam conter dados pessoais não entram em caches persistentes, telemetria ou service workers. Solicitações de dados usam `cache: 'no-store'`.

## Critérios de aceite

- [ ] Site público permanece acessível; “Entrar” abre o formulário, e acesso direto às rotas do painel sem sessão leva ao login sem buscar dados privados.
- [ ] Login válido consulta `/auth/me` e abre conversas do cliente correto; credenciais inválidas, 429 e 503 têm mensagens distintas sem ecoar senha/tokens nem indicar existência da conta.
- [ ] Duas consultas com 401 simultâneo geram um único refresh; os tokens são substituídos juntos e cada consulta é repetida no máximo uma vez. Refresh recusado ou ambíguo não entra em loop nem reenvia o token antigo.
- [ ] Recarregar e abrir nova aba não recuperam tokens; armazenamento persistente, URL, logs e métricas não contêm senhas, tokens, texto secreto de mensagem ou contato de teste.
- [ ] Logout durante refresh ou consulta bloqueada limpa todo o estado; respostas tardias não restauram dados. Novo login de B após A não exibe nenhum dado de A, nem por instantes.
- [ ] Conversas e mensagens paginam sem duplicação; seleção rápida A→B não mostra o resultado atrasado de A em B; erro de paginação permite repetir a leitura sem perder itens já obtidos.
- [ ] Mensagem com HTML/script é exibida como texto inerte; fallback e `sentAt` nulo têm os rótulos descritos; lista e histórico vazios possuem estados próprios.
- [ ] Com dois clientes no backend real, token de A e ids de B retornam 404, sem dados de B; teste captura logs e comprova ausência dos textos secretos. A interface trata 403 e 404 e remove dados privados após perda de sessão.
- [ ] Testes de navegador verificam login, navegação, logout, teclado/foco e acesso direto em largura estreita e larga; movimento reduzido não impede leitura ou navegação. CI executa esses testes contra APIs falsas locais, sem serviços externos.
- [ ] Proxy local encaminha `/api/auth/me` para `/auth/me` e preserva recusas de autorização; destino inválido é recusado na configuração. Typecheck, lint, format:check, testes e build passam nas duas versões de Node exigidas pelo projeto.

## Casos de borda e erros

- 401 final: apagar sessão e pedir login; 403: acesso negado, sem tentar renovar; 404: conversa indisponível, sem revelar outro cliente; 429: respeitar `Retry-After`, sem retentativas automáticas em ciclo; rede/5xx nas leituras: permitir repetição explícita.
- `/auth/me` inválido ou `kind: 'platform'`: não abrir o painel nem manter credenciais; login de plataforma e sua interface ficam fora desta spec.
- Dados malformados da API: erro controlado e mensagem genérica; nunca renderizar corpo de erro cru.
- Troca de papel, suspensão e revogação continuam sendo aplicadas pelo backend a cada requisição; o frontend não toma o papel salvo como autoridade.
- Não redirecionar para URLs fornecidas por entrada externa após login; destino fixo do painel evita redirecionamento aberto.

## Isolamento entre clientes

O cliente das rotas vem exclusivamente de `/auth/me` da sessão ativa, nunca de formulário, query, storage ou parâmetro de navegação do painel. Isso organiza o frontend; a barreira de segurança continua sendo o token assinado e os hooks/repositórios do backend. A spec não enfraquece essas validações. Dados em memória são descartados por geração de sessão; testes com A e B cobrem adulteração das URLs da API e troca de usuário no navegador. Nenhum dado de conversa é persistido no dispositivo.

## Fora de escopo

- Cadastro público, recuperação ou troca de senha, administração de usuários e painel de plataforma.
- Conexão visual do WhatsApp/Embedded Signup, edição de persona, simulador, envio humano e reenvio de respostas.
- Tempo real, pesquisa/filtros sem API correspondente, persistência de sessão, BFF/cookies, mudanças no JWT e no refresh do servidor.
- Deploy, RLS, retenção/LGPD e varredura de pendências: continuam pré-requisitos separados antes de dados reais.

## Decisões e dependências novas

1. **Sessão — recomendação a aprovar:** tokens apenas em memória da aba e novo login ao recarregar. Mantém o contrato atual e evita persistência de credenciais no navegador; memória ainda é acessível a JavaScript e não elimina risco de XSS. **Alternativa:** camada de sessão no servidor com cookie HttpOnly, CSRF e armazenamento server-side, a detalhar em spec própria antes do painel se persistência for requisito.
2. **Escopo — recomendação a aprovar:** login e leitura de conversas, atualização manual, sem controles de funções ainda não entregues. Alternativa: começar pelo onboarding do canal, exigindo outro contrato de interface e fluxo Meta.
3. **Dependências propostas:** roteamento React para URLs e guarda de navegação (biblioteca e versão justificadas pelo implementer); Zod no frontend para contratos externos; Playwright como dependência de desenvolvimento para testes de navegador. Usar `fetch` e estado React para esta fatia; nenhuma biblioteca de cache ou estado global é necessária. Novas dependências devem suportar a faixa de Node do projeto.
4. **Segurança:** passa pelo `reviewer` antes do merge. Referência consultada em 2026-11-03: [OWASP HTML5 Security — Storage APIs](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#storage-apis), que desaconselha identificadores de sessão em localStorage e alerta para exposição por XSS. A escolha por memória é uma proposta desta spec, não decisão já tomada pelo dono.
