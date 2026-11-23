# 030 — Primeiros passos: assistente de configuração (wizard) e lista "Configuração"

- **Status:** concluída (em produção; status normalizado em 2026-11-23, spec 042). Antes: aprovada (2026-11-06, dono: "Aprovo tudo", com D1 a D13 como recomendadas)
- **Branch:** `spec/030-wizard-onboarding`
- **Depende de:** 018 (beUI, tokens, contraste, `localStorage` só com o tema), 023 (persona, Testar), 025 (papéis e convite), 026 (conhecimento, estoque, exemplo, importação CSV), 027 (agenda e exemplo), 029 (shell do painel, empresa sempre aberta)
- **Observação de numeração:** conferido em `docs/specs/` (existem de 001 a 029; **não há arquivo 030**) e em `docs/context.md` (nenhuma spec 030 reservada; a única ocorrência de "030" é o nome de uma migration). A 028 (a IA marca horários) e a 029 (redesign do painel) já existem e estão concluídas; esta é a **030**. Esta spec **passa pelo `reviewer`** antes do merge (permissão nova, rota nova sobre dados da empresa).

## Objetivo

Hoje, depois de criar a conta, a pessoa cria uma empresa e cai num painel vazio, sem saber o que fazer primeiro. Esta spec acrescenta um **assistente de primeiros passos** (wizard) que leva quem administra a empresa por: persona do atendente, documentos, serviços da agenda (opcional), estoque (opcional) e um teste final do atendente, e uma lista **"Configuração"** que continua lembrando do que falta. Agora porque as specs 026 a 028 deram ao atendente conhecimento, estoque e agenda, mas nada guia a pessoa até eles.

## Estado atual (lido no código)

- **Criar a empresa** é o formulário "Nome da empresa" de `/painel/empresas` (`AccountApp.tsx`, `POST /account/companies`); a spec 029 já faz criar **selecionar e abrir** a empresa (`load(stamp, 'auto')`), que cai na primeira tela permitida (Conversas). Não há nada que diga "o que fazer agora".
- **Telas existentes** (todas em `frontend/src/company/`, cada uma recebe `companyId` e `settle`): `PersonaPage` (`GET`/`PUT .../persona`; `persona: null` = padrão), `KnowledgePage` (`GET`/`POST .../knowledge/documents`, texto colado ou `.txt`/`.md`) com `SampleControls` (`POST`/`DELETE .../knowledge/sample`), `EstoquePage` com `ImportCsv` (`GET`/`POST .../inventory/products`, `.../products/import`), `AgendaConfigPage` (`GET .../schedule/services`, serviços, janelas, "Carregar exemplo" em `POST .../schedule/sample`) e `TestPage` (`POST .../messages` com `contactRef` `teste-no-site`).
- **Permissões** (`domain/permissions.ts`, mapa fixo): `persona:manage`, `knowledge:manage`, `inventory:manage` e `schedule:configure` são **só de `OWNER` e `ADMIN`**; `AGENT` e `VIEWER` não têm nenhuma.
- **Exemplos têm regras próprias:** `POST .../knowledge/sample` cria **2 documentos e 8 produtos** e só funciona em empresa **sem documento e sem produto** (409 `SAMPLE_REQUIRES_EMPTY`); exige `knowledge:manage` e `inventory:manage`. `POST .../schedule/sample` só funciona sem serviço próprio (409 `SAMPLE_REQUIRES_EMPTY`), cria "Corte de cabelo" (30 min) e, se a agenda não tem horários, a semana útil das 9h às 18h.
- **Navegação** (`company-nav.ts`): `AreaPage`, `AREA_PATHS`, `AREA_LABELS`, `REQUIRED` (permissão por aba), `allowedPages`; o menu lateral (`AppShell`, Dashboard Shell da 029) lista as abas permitidas.
- **Navegador:** `localStorage` guarda **só** `soprei-theme`; a última empresa e a visão da agenda já foram para o servidor (029). `Company` é model **global** (raiz do tenant), com `persona` anulável; não há hoje nenhum campo sobre onboarding.

## Comportamento esperado

### Visão geral

- Nova tela **"Primeiros passos"** em `/painel/primeiros-passos[/<passo>]`, **dentro do shell da 029** (menu lateral, seletor de empresa, tema), com um conteúdo centralizado e estreito (decisão D6). Abre sozinha **uma vez, logo depois de criar a empresa**; depois disso se abre pelo menu e pela lista "Configuração".
- Seis passos, em ordem: **1 Empresa**, **2 Persona**, **3 Documentos**, **4 Serviços** (opcional), **5 Estoque** (opcional), **6 Testar o atendente**. O passo 1 é o formulário que já existe em `/painel/empresas` (não é duplicado): ao terminar, a pessoa chega ao passo 2 com o 1 já marcado como feito. No fim, uma **sugestão** (não um passo): "Conectar o WhatsApp", que só leva à tela Canal (sem fluxo novo de conexão).
- **Todo passo é pulável e retomável.** Cada passo tem **Voltar**, **Pular** e **Continuar** (o rótulo de **Continuar** muda para **Salvar e continuar** quando há algo a gravar). Pular nunca grava nada e nunca apaga nada.

### Estado derivado do servidor (sem armazenamento novo no navegador)

- O progresso **não é guardado**: é calculado a partir do que já existe (decisão D3). Um passo está **feito** quando: persona definida (`persona` diferente de nulo; "Voltar ao padrão" a desfaz), existe ao menos 1 documento, existe ao menos 1 serviço **ativo**, existe ao menos 1 produto **ativo**. O passo "Testar" e o "Pular" ficam **só na memória da tela**: recarregar a página mostra o próximo passo ainda pendente (ou o passo da URL).
- **Passo na URL:** `/painel/primeiros-passos/persona`, `/documentos`, `/servicos`, `/estoque`, `/testar` (conjunto fixo de cinco valores; qualquer outro vira a tela do primeiro pendente). Sem conteúdo, nome nem id na URL. Faz o botão Voltar do navegador, o F5 e o atalho a partir da lista "Configuração" funcionarem (decisão D9).
- **O que o servidor devolve** (uma rota nova, decisão D4; sem texto de persona, documento, produto ou serviço, só booleanos):

```
GET /admin/companies/:companyId/onboarding
-> 200 { dismissed: boolean,
         steps: { persona?: boolean, knowledge?: boolean, schedule?: boolean, inventory?: boolean } }
PUT /admin/companies/:companyId/onboarding   { dismissed: boolean }
-> 200 (mesmo corpo do GET)
```

- Cada campo de `steps` só **existe** se quem pede tem a permissão daquele passo (`persona:manage`, `knowledge:manage`, `schedule:configure`, `inventory:manage`); campo ausente = passo **oculto** (hoje `OWNER` e `ADMIN` têm todas, mas o código não presume isso). O site mostra só os passos presentes.

### Persistência de "dispensado" (decisão D5)

- **Recomendado:** coluna anulável **`companies.onboarding_dismissed_at`** (`timestamptz`, migration **aditiva**), uma por empresa (um administrador que dispensa vale para todos). `Company` é model global: `MODEL_SCOPES` não muda. `PUT { dismissed: true }` grava a data atual; `{ dismissed: false }` anula (reabrir). Idempotente.
- Por que não evitar a coluna: sem ela, "Dispensar" só poderia viver na memória da tela, e o lembrete voltaria a cada login; guardar no navegador é proibido pela 018. A coluna é o menor custo para o dono ter "dispensar de verdade". Se o dono preferir zero backend, ver a alternativa em D5.
- **Concluído** não é gravado: é derivado ("todos os passos presentes estão feitos").

### Permissão, hierarquia e quem vê (decisões D7 e D8)

- **Permissão nova `onboarding:manage`** (só `OWNER` e `ADMIN`, no mapa fixo de `domain/permissions.ts`), exigida pelas duas rotas com `requirePermission('onboarding:manage', { companyParam: 'companyId' })` e perfil `admin`: 401 -> 403 (administrador da plataforma) -> **404** (`:companyId` diferente do token, antes da permissão) -> 403. O service recebe **só** o `CompanyId` da identidade.
- `AGENT` e `VIEWER` **não veem nada**: sem item de menu, sem lista "Configuração", sem chamada à API; o endereço digitado mostra o aviso padrão de "sem permissão" (mesma regra das outras telas). Quem entra por convite como `AGENT`/`VIEWER` não vê o assistente. **Atenção:** quem entra por convite como `ADMIN` tem a permissão e **vê** o menu e a lista "Configuração" (o estado é da empresa, não da pessoa), mas o assistente **nunca abre sozinho para ele** (só abre sozinho para quem acabou de criar a empresa). Ver D7.

### Lista "Configuração" depois do wizard (decisão D10)

- Cartão no topo de **Conversas** (a página inicial); dentro de "Primeiros passos" a própria lista de passos do cabeçalho faz esse papel (desvio registrado na E3), **enquanto** a empresa não dispensou e ainda falta algum item dos que a pessoa vê: "Configuração: 2 de 4 itens" com a lista (persona, documentos, serviços, estoque), cada item com **texto e ícone de feito/pendente (nunca só cor)** e um link para o passo certo; os opcionais levam o selo "opcional". Botão **"Dispensar"** (confirmação curta) chama o `PUT { dismissed: true }`; no menu, **"Primeiros passos"** continua disponível e reabre (`dismissed: false`). Some sozinha quando tudo está feito. Erro ao ler o estado **não** bloqueia Conversas (o cartão simplesmente não aparece).

### Os passos (reaproveitando telas e APIs existentes, decisão D11)

- **Regra geral:** nenhuma tela é reescrita. O corpo de cada passo é a tela/pedaço existente, com **um callback novo e opcional** (`onProgress`/`onSaved`) para o assistente reler o estado; sem ele, a tela se comporta como hoje. Se uma tela for grande demais para embutir sem mexer (em especial `AgendaConfigPage`), o implementer extrai o **menor formulário** necessário (por exemplo, o de criar serviço) para um componente compartilhado usado pelas duas telas, e registra a escolha. Nenhum `fetch` novo: tudo passa por `companyApi`, `knowledgeApi`, `inventoryApi`, `agendaApi`.
- **2 Persona** (`PersonaPage`): salvar grava pelo `PUT .../persona`. Opcional (cortável, D12): botão "Usar modelo" que preenche a caixa com um **texto fixo do site**, com lacunas entre colchetes para a pessoa editar; nunca é salvo sem a pessoa clicar em salvar.
- **3 Documentos** (`KnowledgePage`): colar texto ou enviar `.txt`/`.md`, como hoje. "Usar exemplo" (`SampleControls`) só aparece com a empresa **sem documento e sem produto**, e avisa em linguagem simples que **o exemplo também cria produtos** (então o passo Estoque passa a "feito"). Com documento ou produto já cadastrado, o botão não aparece.
- **4 Serviços** (opcional): criar um serviço da agenda (nome e duração) e/ou "Usar exemplo" (agenda), que cria "Corte de cabelo" e os horários da semana útil. Aviso fixo: sem horários semanais o atendente não tem o que oferecer; o link "Configurar agenda" leva à tela completa. Só aparece o exemplo se a empresa não tem serviço próprio.
- **5 Estoque** (opcional): cadastrar um produto, **Importar CSV** (`ImportCsv`) e, se ainda não carregou o exemplo no passo 3, "Usar exemplo" (a mesma carga). Só com `inventory:manage`.
- **6 Testar o atendente** (`TestPage` embutida): a pessoa manda uma mensagem pelo simulador e vê a resposta e "Fontes usadas". Avisa que, com o provedor de teste do ambiente (`mock`), a resposta é de mentira. Fecha com a **sugestão** "Conectar o WhatsApp" (botão para a tela Canal, só com `channel:read`) e o botão **"Ir para as conversas"**. Nada deste passo é derivado nem gravado (a conversa de teste aparece em Conversas como "Teste no site", como hoje).

### Interface, teclado e foco

- Cabeçalho do assistente com a **barra de progresso** (`role="progressbar"` com `aria-valuenow/min/max` e o texto "Passo 3 de 6", visível) e a lista dos passos (`ol`, o atual com `aria-current="step"`, cada um com texto e ícone de feito/pendente/pulado, nunca só cor); os passos são botões (navegação livre entre eles; nada é bloqueado).
- A cada troca de passo, o foco vai para o título do passo (`h2` com `tabIndex={-1}`) e um texto `aria-live="polite"` anuncia "Passo N de M: nome". Ordem de tab: lista de passos, conteúdo, **Voltar / Pular / Continuar**. Sem armadilha de foco; Esc não faz nada de destrutivo.
- **Rascunho só em memória:** o texto da persona, o documento colado ou o CSV ficam no estado da tela enquanto o passo existe. Sair de um passo com texto **não salvo** abre o `ConfirmDialog` ("Você tem texto não salvo. Sair e descartar?"); nada é copiado para `localStorage`, `sessionStorage`, URL, título da aba ou `console`.
- **Celular** (360 e 390 px): coluna única; a lista de passos vira a linha "Passo N de M" mais um botão que abre a lista (ou rola na horizontal sem estourar a tela); botões de ação com área de toque adequada e sem rolagem horizontal da página.
- **Cores só por tokens** (nada de cor fixa); todo par texto/fundo **novo** entra em `src/theme/contrast.test.ts` (mínimo 4,5:1 nos dois temas). Animações respeitam `prefers-reduced-motion`.

### Privacidade e observabilidade (decisão D13)

- Persona, texto de documento, nomes e SKUs de produto, nomes de serviço e o texto do teste **nunca** vão a log, métrica, URL, título nem armazenamento do navegador. O log do servidor só tem ids, a ação e o resultado (`onboarding atualizado`, `dismissed` verdadeiro/falso). A resposta de `GET onboarding` tem só booleanos.
- Métrica opcional, conjunto fixo: `company_onboarding_actions_total{action}` com `dismissed` e `reopened` (nenhum id, nenhum passo). Sem analytics de funil (fora de escopo).
- Sem auditoria (como a persona na 023); o dismiss não é evento de segurança.

## Critérios de aceite

Backend (E1)

- [x] A migration **aditiva** cria `companies.onboarding_dismissed_at timestamptz NULL`; o teste de drift do schema (`schema-catalog.integration.test.ts`) continua verde; nenhuma migration existente é alterada.
- [x] `ROLE_PERMISSIONS`: `onboarding:manage` está em `OWNER` e `ADMIN` e **não** em `AGENT` e `VIEWER`; o teste de matriz de permissões cobre a nova linha.
- [x] `GET /admin/companies/:companyId/onboarding` devolve `{ dismissed, steps }` com `persona`, `knowledge`, `schedule` e `inventory` booleanos corretos: empresa vazia = tudo `false`; persona definida = `persona: true` (e voltar ao padrão = `false`); 1 documento = `knowledge: true`; 1 serviço ativo = `schedule: true` e serviço **só inativo** = `false`; 1 produto ativo = `inventory: true` e produto **só inativo** = `false`.
- [x] Campo de `steps` cuja permissão quem pede não tem **não** aparece (teste de unidade do service com a checagem de permissão injetada); a resposta **nunca** contém texto de persona, título, nome, SKU nem id de documento, serviço ou produto (teste com sentinelas, como na 024).
- [x] `PUT` com `{ dismissed: true }` grava a data; repetir é idempotente (a data não muda); `{ dismissed: false }` anula; corpo inválido, campo extra ou ausente é 400 (schema estrito) sem eco do valor; um `GET` seguinte reflete o estado.
- [x] Ordem 401 -> 403 (`PlatformAdmin`) -> 404 (`:companyId` diferente do token) -> 403 (`AGENT`, `VIEWER`) nas duas rotas; `:companyId` que não é UUID é 404 uniforme.
- [x] **Isolamento:** com duas empresas, A com persona, documento, serviço e produto e B vazia, o `GET` de cada uma reflete só a própria; `PUT dismissed` em A **não** altera B (lido no banco); o service usa só o `CompanyId` da identidade e os repositórios de tenant com `companyId` primeiro (nenhum SQL cru novo, nenhuma consulta sem `companyId`); a rota entra no inventário de `rate-limit.test.ts` (perfil `admin`, `requirePermission`) e é percorrida pelo `site-bridge.integration.test.ts` (cookie da conta, ponte da 023).
- [x] O log de `PUT` tem só `companyId`, `membershipId`, a ação e o resultado; teste com `log-capture` prova que nenhum texto de persona, documento, produto ou serviço aparece (nem no `GET`); se a métrica for adotada, o rótulo é só `dismissed`/`reopened`.
- [x] O gate de vocabulário (`domain-vocabulary.test.ts`) continua verde (nenhum nome antigo da empresa volta).

Frontend, unitários (E1 a E3)

- [x] `onboarding-steps.ts` (puro): dado o estado e as permissões, devolve os passos visíveis na ordem certa, o primeiro pendente, o contador "N de M" e a decisão de mostrar ou não a lista (`dismissed`, tudo feito, sem permissão); passo ausente na resposta é oculto; o passo da URL com valor fora do conjunto fixo vira o primeiro pendente.
- [x] `company-nav`: `primeirosPassos` exige `onboarding:manage`; `/painel/primeiros-passos` e cada um dos cinco passos mapeiam para a tela e de volta; qualquer outro sufixo cai no primeiro pendente e **não** chama a API de outra empresa nem de passo inexistente; sem permissão a tela mostra o aviso e **não chama** a API.
- [x] Rascunho: sair de passo com texto sem salvar pede confirmação; confirmar descarta, cancelar mantém; o teste prova que `localStorage`/`sessionStorage` ficam só com `soprei-theme` e que o texto não aparece em `location`, `document.title` nem `console`.
- [x] Mensagens de erro vêm de `status` e `error.code` (nunca do texto do servidor); 401 volta ao login, 404 relê a sessão ("A empresa selecionada mudou"), como nas demais telas.
- [x] Pares de cor novos em `contrast.test.ts`, nos dois temas.

E2E Playwright (API falsa, desktop e celular, claro e escuro; os fluxos de dados podem rodar na matriz completa só em um tema e o contraste/foco nos dois, mas todos têm de passar nos dois)

- [x] **Conta nova sem empresa:** entrar leva a `/painel/empresas`; criar a empresa abre `/painel/primeiros-passos/persona` com "Passo 2 de 6" e o passo 1 marcado como feito.
- [x] **Pular tudo:** Pular em cada passo chega ao fim sem gravar nada (nenhuma chamada de escrita na API falsa), e "Ir para as conversas" abre Conversas com o cartão "Configuração: 0 de 4".
- [x] **Usar exemplos:** o exemplo do passo Documentos chama `POST .../knowledge/sample` (com o aviso de que cria produtos) e marca Documentos **e** Estoque como feitos; o exemplo da agenda chama `POST .../schedule/sample`; o botão não aparece quando já há documento ou produto (ou serviço).
- [x] **Salvar persona e documento:** os dois chamam as rotas existentes e atualizam o progresso; importar CSV no passo Estoque usa o fluxo existente.
- [x] **Retomar depois:** com persona feita e o resto pendente, recarregar a página e abrir "Primeiros passos" pelo menu cai no primeiro passo pendente; o link do cartão "Configuração" abre o passo certo; o Voltar do navegador volta ao passo anterior.
- [x] **Dispensar e reabrir:** "Dispensar" faz `PUT { dismissed: true }`, o cartão some (também depois de recarregar); o menu "Primeiros passos" continua e reabre com `PUT { dismissed: false }`.
- [x] **Convidado não vê:** com papel `AGENT` ou `VIEWER` não há item de menu, cartão nem chamada a `/onboarding`; abrir o endereço mostra "sem permissão". Com papel `ADMIN` (entrou por convite) o menu e o cartão aparecem, mas o assistente **não** abre sozinho.
- [x] **Trocar de empresa:** com duas empresas, o estado, o passo e o rascunho de uma não aparecem na outra (a área remonta); resposta tardia da empresa anterior é descartada.
- [x] **Teclado e foco:** percorrer o assistente só com teclado; o foco vai ao título do passo a cada troca; a barra de progresso expõe `aria-valuenow`; nenhum passo depende só de cor.
- [x] **Celular (390 px e 360 px):** sem rolagem horizontal da página; botões acessíveis; lista de passos utilizável.
- [x] Passo 6: enviar uma mensagem de teste mostra a resposta e "Fontes usadas"; o botão "Conectar o WhatsApp" só aparece com `channel:read` e leva a `/painel/canal`.

## Casos de borda e erros

- **Falha ao ler o estado** (rede, 5xx, 429): o assistente mostra o aviso com "Tentar de novo"; o cartão "Configuração" simplesmente não aparece; nunca bloqueia Conversas nem as telas de sempre. 401 volta ao login; 404 relê a sessão.
- **Falha ao dispensar:** mensagem de tela por `status`; o cartão continua; nada fica pela metade (o `PUT` é uma única escrita).
- **Dois administradores ao mesmo tempo:** o estado é derivado e relido; um dispensa, o outro vê o cartão sumir na próxima leitura. Reabrir por um reabre para todos (último vence; sem conflito).
- **Exemplo recusado (409 `SAMPLE_REQUIRES_EMPTY`):** a mensagem fixa existente aparece e o passo relê o estado (outra aba pode ter cadastrado algo).
- **Persona "Voltar ao padrão":** o passo volta a pendente. **Documento ou produto apagado depois:** o passo volta a pendente na próxima leitura.
- **Serviço sem horários semanais:** conta como "feito" no progresso (existe serviço ativo), mas o passo mostra o aviso fixo e o link para Configurar agenda. Não se deriva "tem horário" (mantém o estado simples).
- **Empresa suspensa ou vínculo desativado no meio:** como o resto do painel (401/404 tratados pelo `settle`).
- **Sem `ACCOUNTS_ENABLED`:** o site de contas e o painel não existem; a spec não toca o modo legado.
- **Riscos:** (1) o exemplo de conhecimento também cria produtos (surpresa) -> o aviso fixo e o teste de aceite; (2) "Pular" não é lembrado depois de recarregar (por desenho, D3), então a pessoa que quer silêncio precisa **Dispensar** -> o texto do botão deixa isso claro; (3) acoplar o wizard às telas pode inchar `KnowledgePage`/`AgendaConfigPage` -> o implementer extrai só o necessário e registra, e a E2 pode ser cortada; (4) a decisão D7 (ADMIN convidado vê o cartão) pode contrariar a expectativa do dono; (5) uma rota e uma permissão novas são superfície de autorização -> `reviewer` obrigatório e testes de isolamento acima; (6) o texto do modelo de persona (D12) é conteúdo de produto, não regra; revisar a redação com o dono.

## Isolamento entre empresas

Toca em dados da empresa (persona, documentos, serviços, produtos, a coluna nova). O `CompanyId` vem **só** do token assinado (`membershipAuth(request)`); o `:companyId` do caminho é conferido e descartado (404 antes de 403). O service usa os repositórios existentes (todos com `CompanyId` como primeiro parâmetro e `companyId` no `where`, protegidos pela extensão `tenant-scope`) para contar documentos, serviços ativos e produtos ativos e ler a persona; a escrita de `onboarding_dismissed_at` é uma atualização da linha de `companies` pelo id da identidade (a raiz do tenant é model global, com repositório próprio). **Nenhum SQL cru novo.** Teste: duas empresas com estados opostos, `GET` e `PUT` de uma não leem nem alteram a outra (critérios de isolamento acima), mais o inventário de rotas e a varredura do `site-bridge`.

## Fora de escopo

- Vídeo tutorial, tour guiado por balões, textos de ajuda longos, tradução.
- E-mails de boas-vindas ou de lembrete ("termine sua configuração"); notificações.
- Conexão **guiada** do WhatsApp dentro do wizard (Embedded Signup, número, token): só o botão que leva à tela Canal.
- Analytics, funil, tempo por passo, métrica por passo (só as duas contagens de dispensar/reabrir, se aprovadas).
- Gerar a persona ou os documentos por IA; importar de site, PDF ou planilha além do que já existe (`.txt`, `.md`, CSV).
- Convidar equipe, configurar equipe ou papéis dentro do wizard (a aba Equipe continua à parte).
- Configuração completa da agenda (recursos, janelas, intervalos, IA marcando horários da 028): o wizard só cria o serviço e carrega o exemplo.
- Wizard para `AGENT`/`VIEWER`, ou por pessoa (o estado "dispensado" é da empresa).
- Guardar qualquer coisa no navegador além do tema; derivar "tem horário semanal" ou "testou o atendente" no servidor.
- Mudar permissões existentes, rotas existentes ou o comportamento das telas reaproveitadas.

## Plano em etapas (pequenas e cortáveis)

- **E1 — Base, persona e documentos:** migration, permissão, rota `GET`/`PUT onboarding` com testes de isolamento, `company-nav` (`primeirosPassos`), `onboarding-steps.ts`, tela do assistente com barra de progresso, navegação e foco, passos 1 a 3 (persona e documentos, com exemplo), abertura automática depois de criar a empresa, **"Dispensar"** e o item de menu. Unitários, e2e de "conta nova", "pular tudo", "exemplo de documentos", "convidado não vê". Já é útil sozinha.
- **E2 — Serviços e estoque:** passos 4 e 5 (serviço, exemplo da agenda, estoque, Importar CSV), com a extração mínima de formulário se necessária. e2e de exemplos e CSV.
- **E3 — Teste final e lista "Configuração":** passo 6 (Testar embutido, sugestão do WhatsApp), cartão "Configuração" em Conversas, reabrir, e2e de "retomar", "trocar de empresa", "dispensar e reabrir", celular, claro e escuro e contraste.
- O "Usar modelo" da persona (D12) e a métrica (D13) são os itens mais fáceis de cortar.

## Decisões e dependências novas

**Dependências novas: nenhuma** (beUI, `lucide-react`, `motion` e os componentes existentes bastam). **Fonte externa:** nenhuma API de terceiros é tocada.

O dono decide; cada uma tem a recomendação (R) e a alternativa (A), em linguagem simples.

- **D1 — Quais passos e em que ordem.** R: empresa, persona, documentos, serviços (opcional), estoque (opcional) e "testar o atendente" no fim, com "conectar o WhatsApp" só como sugestão final. A: tirar serviços e estoque do wizard e deixá-los só na lista "Configuração"; ou pôr "conectar o WhatsApp" como passo.
- **D2 — Pular e voltar.** R: todo passo pode ser pulado e retomado; cada passo oferece "Usar exemplo" quando existe (documentos+produtos juntos, e agenda) e "Importar CSV" no estoque. Pular não grava nem apaga nada. A: obrigar persona e documentos antes de avançar.
- **D3 — De onde vem o progresso.** R: calculado do que já existe no servidor (persona definida, existe documento, existe serviço ativo, existe produto ativo); nada novo no navegador. Consequência: "Pular" e "testei" só valem enquanto a tela está aberta. A: guardar um registro de passo concluído/pulado no servidor (mais coluna e mais código; só se o dono quiser lembrar o "pulei").
- **D4 — Uma rota nova de estado.** R: `GET`/`PUT /admin/companies/:companyId/onboarding` (só booleanos), porque o "dispensado" precisa de leitura e escrita e uma rota só devolve tudo de uma vez. A: sem rota de leitura (o site chama as quatro rotas existentes de lista) e só o `PUT`; mais chamadas e mais regras de permissão espalhadas no site.
- **D5 — Onde guardar "dispensado".** R: coluna anulável `companies.onboarding_dismissed_at` (migration aditiva, uma por empresa; vale para todos os administradores). A: sem coluna e sem `PUT` (zero backend): o assistente abre só depois de criar a empresa e a lista "Configuração" aparece enquanto faltar algo, **sem** poder dispensar (incomoda para sempre quem não quer estoque). Outra A: a coluna no vínculo (cada pessoa dispensa o seu), com migration em `memberships`.
- **D6 — Onde roda.** R: dentro do shell da 029 (menu lateral e seletor de empresa continuam; é uma página `/painel/primeiros-passos` com conteúdo centralizado e estreito), porque reaproveita o layout, a troca de empresa e a saída. A: tela cheia sem menu (mais foco, mas duplica a saída, o tema e o seletor).
- **D7 — Quem vê e quando abre sozinho.** R: só `OWNER` e `ADMIN` (permissão nova `onboarding:manage`); só abre sozinho para quem **acabou de criar a empresa**; `AGENT` e `VIEWER` nunca veem. **Ponto de atenção:** um `ADMIN` que entrou por convite vê o menu e a lista "Configuração" (o estado é da empresa), mas o assistente não abre sozinho para ele. A: só o `OWNER` vê o cartão e o item de menu (quem entra por convite nunca vê, como o dono descreveu), com a permissão `onboarding:manage` só do `OWNER`.
- **D8 — Permissão própria ou reaproveitada.** R: permissão nova `onboarding:manage` (`OWNER` e `ADMIN`), para a rota não pegar carona em `persona:manage` e para o mapa de permissões continuar claro. A: reaproveitar `persona:manage` (sem permissão nova; some o item no mapa, mas mistura os assuntos).
- **D9 — Passo na URL.** R: `/painel/primeiros-passos/<passo>` com cinco valores fixos (sem dado nenhum), para o Voltar do navegador, o F5 e o atalho da lista funcionarem. A: passo só em memória (a URL é uma só), mais simples, mas F5 sempre cai no primeiro pendente.
- **D10 — Lista "Configuração".** R: cartão em Conversas e em "Primeiros passos" enquanto faltar algo e não estiver dispensado, com "Dispensar" e reabrir pelo menu; some sozinho quando tudo está feito; os opcionais contam como itens (por isso "Dispensar" existe). A: só o item de menu com a contagem "2 de 4", sem cartão.
- **D11 — Reaproveitar telas.** R: embutir as telas e os componentes existentes (`PersonaPage`, `KnowledgePage`, `SampleControls`, `ImportCsv`, `TestPage`) com um callback opcional, e extrair só o menor formulário da agenda; nenhuma API nova de dados. A: escrever formulários próprios do wizard, mais simples de ajustar e mais fácil de ficarem diferentes das telas "de verdade".
- **D12 — Modelo de persona (cortável).** R: botão "Usar modelo" com um texto fixo e lacunas entre colchetes que a pessoa edita (caixa vazia trava muita gente); a redação final é do dono. A: sem modelo (menos conteúdo para revisar; mais desistência no passo 2).
- **D13 — Métrica.** R: só `company_onboarding_actions_total{action}` (`dismissed`, `reopened`), sem id nem passo. A: nenhuma métrica (a spec fica ainda menor).

## Registro da implementação

### E1 — Base, persona e documentos (2026-11-06, Claude Code, Sonnet 5.5)

- **Backend:** migration aditiva `20261106200000_company_onboarding_dismissed` (`companies.onboarding_dismissed_at timestamptz NULL`; aplicada **só** em `soprei_test`), permissão `onboarding:manage` (OWNER e ADMIN) no mapa fixo, porta `OnboardingStore` (`application/ports/`), `OnboardingService` (`application/onboarding/`, recebe só o `CompanyId` e uma função de permissão; só consulta os passos permitidos), `PrismaOnboardingStore` (só `findFirst`/`updateMany`, sem SQL cru; o texto da persona é lido apenas para saber se existe), `GET`/`PUT /admin/companies/:companyId/onboarding` (`onboarding.controller.ts`, perfil `admin`, `requirePermission('onboarding:manage')`, corpo `{ dismissed }` estrito) e a métrica `company_onboarding_actions_total{action}` (D13, só `dismissed`/`reopened`, só conta mudança real). Dispensar é **uma** escrita condicional (`WHERE onboarding_dismissed_at IS NULL`): repetir não muda a data. `Company` (entidade) **não** ganhou o campo: o estado vive no store próprio, para não tocar em todos os fixtures.
- **Testes backend:** `onboarding.service.test.ts`, `onboarding.controller.test.ts` (matriz de papéis, 401/403/404, 400 sem eco, privacidade com sentinela, métrica), `onboarding.integration.test.ts` (Postgres real: serviço/produto só inativo = `false`, "voltar ao padrão", isolamento A x B, idempotência da data), `onboarding-migration.integration.test.ts` (schema temporário com rollback), snapshot de permissões, inventário de rotas (`rate-limit.test.ts`) e varredura do `site-bridge.integration.test.ts`.
- **Frontend:** `onboarding-steps.ts` (puro: passos visíveis, primeiro pendente, endereços, lista "Configuração", `PERSONA_TEMPLATE`), `onboarding-api.ts` (Zod estrito), `OnboardingPage.tsx` (barra `role="progressbar"`, lista `ol` com texto e ícone, foco no `h2` e `aria-live`, "Voltar/Pular/Continuar" e "Salvar e continuar", `ConfirmDialog` para rascunho, lista recolhível no celular), `PersonaPage` e `KnowledgePage` com pontes opcionais (`onProgress`, `onDraft`; `PersonaPage` ganhou "Usar modelo" só no assistente), `AccountApp` (abre o assistente depois de criar a empresa por `load('afterCreate')`, só se `canOpen('primeirosPassos')`; o passo vem do endereço e o Voltar do navegador funciona). Item **"Primeiros passos" é o último do menu** (`AREA_PAGES`), para nunca ser a primeira tela permitida (a página inicial continua Conversas).
- **Desvios e decisões:** (1) o passo 1 (Empresa) é um item **não clicável** (já está feito; o formulário continua em `/painel/empresas`); (2) abrir "Primeiros passos" pelo menu com a empresa dispensada reabre sozinho (`PUT { dismissed: false }`, melhor esforço); (3) os passos 4 a 6 ficam, nesta etapa, com um botão "Abrir a tela completa" (E2 e E3 trocam pelo corpo real); (4) **D12 (modelo de persona) implementado** com texto neutro e curto; **o dono deve revisar a redação** (`PERSONA_TEMPLATE`); (5) pares de contraste novos em `contrast.test.ts` (`color-success` em `card` e em `muted`; barra de progresso `primary` em `muted`).
- **Nota do dono:** o dono tem empresa com dados no banco de desenvolvimento: **nenhum seed foi usado nem criado**; os exemplos só vêm das rotas de exemplo já existentes, acionadas por quem clica.

### E2 — Serviços e estoque

- **Passo 4 (Serviços):** `OnboardingServices.tsx` usa **só** `agendaApi.services`, `createService` e `loadSample`. A escolha da D11: o **menor formulário** (`ServiceForm`: nome, duração e intervalo) foi **movido** de `AgendaConfigPage.tsx` para `AgendaDialogs.tsx` (exportado) e é o mesmo nas duas telas; o restante da configuração (janelas, recursos, opções da IA) continua só em Configurar agenda (botão "Configurar agenda" no passo). "Usar exemplo" só aparece sem serviço próprio; aviso fixo sobre horários semanais.
- **Passo 5 (Estoque):** embute o `EstoquePage` inteiro (novo produto, importar CSV, exemplo) com o callback opcional `onProgress` (chamado depois de qualquer escrita bem-sucedida, do exemplo e da importação). O exemplo de documentos e o de estoque são a mesma carga (`POST .../knowledge/sample`).
- **Decisão no passo de documentos/estoque:** se o exemplo é oferecido é decidido **uma vez, ao entrar no passo** (`DocumentsStep`/`StockStep`), para a mensagem "Exemplo carregado." e o "Remover exemplo" não sumirem quando o progresso muda; a regra de verdade (empresa sem documento e sem produto) continua do servidor (409).
- **Mudança de comportamento mínima em tela existente:** `SampleControls` agora chama `onChanged()` também no 409 (relê a lista, porque outra aba pode ter cadastrado algo).
- Testes: e2e de serviço, exemplo da agenda, produto novo, importar CSV, exemplo oferecido/escondido, 409 do exemplo e "pular" sem escrita (desktop e celular; claro e escuro nos de dados).

### E3 — Teste final e lista "Configuração"

- **Passo 6:** `TestStep` embute o `TestPage` de sempre (resposta e "Fontes usadas"), com o aviso de que o provedor `mock` responde de mentira, e a sugestão "Conectar o WhatsApp" (só com `channel:read`; só leva a `/painel/canal`). Nada é derivado nem gravado. O último passo troca "Continuar" por "Ir para as conversas".
- **Cartão "Configuração":** `ConfigurationCard.tsx` no topo de Conversas (só com `onboarding:manage`; sem a permissão não há chamada). "Configuração: N de M itens" com texto e ícone por item (e "(opcional)"), links para o passo certo (`<a href>` com clique simples interceptado), "Dispensar" com `ConfirmDialog` (`PUT { dismissed: true }`); some sozinho quando tudo está feito; erro ao ler o estado não aparece nem bloqueia Conversas (401 e 404 seguem o `settle`). Reabrir é entrar em "Primeiros passos" pelo menu (`PUT { dismissed: false }` automático).
- **Desvio:** o cartão **não** foi repetido dentro de "Primeiros passos" (a lista de passos do cabeçalho mostra o mesmo estado, com texto e ícone); o critério de aceite não o exige.
- **Troca de empresa:** o site abre Conversas da empresa nova (comportamento da 029); o assistente reabre pelo menu sem o rascunho da outra (a tela remonta por `key`).
- Testes: e2e de pular tudo (cartão "0 de 4", nenhuma escrita), teste final, cartão (itens, link, some ao completar; claro e escuro), dispensar e reabrir, falhas, `AGENT`/`VIEWER`, troca de empresa, teclado (Tab até "Continuar", foco no título), 360 px. Desktop e celular.

### Validação (2026-11-06)

- Typecheck, lint, `format:check` (raiz) e build verdes. Backend `pnpm test`: **1360 verdes em Node 24 e em Node 22**; suítes novas (serviço, controller, integração do store, migração e drift do schema) repetidas 3 vezes em Node 22; `site-bridge`, inventário de rotas e gate de vocabulário verdes. Frontend: 137 unitários; e2e Playwright **completo** (desktop e celular, em blocos) verde, incluindo 80 do assistente.
- **Não verificados / ressalvas:** `pnpm test:integration` completo não foi rodado (só as suítes da área); smoke do `dist` não feito; o CI (Node 22 e LTS) é a palavra final; falta o `reviewer`.

### Revisão (2026-11-06)

- **Colchetes do modelo:** `hasTemplatePlaceholders` (extrai as lacunas do próprio `PERSONA_TEMPLATE`) mostra um aviso fixo na tela da persona e, em "Salvar e continuar", pede confirmação ("Salvar com colchetes?"); salvar com o botão "Salvar" da própria tela não pergunta. Testes: unitário da detecção e e2e (claro e escuro).
- **Critérios fechados:** o e2e captura `console` e `pageerror` e prova que os textos sentinela de persona e documento não aparecem; unitário prova que `failureOf`, `knowledgeMessageOf` e `agendaMessageOf` ignoram o texto do servidor (só `status` e `error.code`).
- **Limitações aceitas:** (1) o aviso "Sair do passo?" não cobre a troca de aba pelo menu nem o Voltar do navegador (o rascunho só existe em memória e se perde); (2) o formulário de serviço não alimenta `onDraft` (sem aviso de texto não salvo); (3) entrar no assistente com a empresa dispensada reabre sozinho (o cartão volta em Conversas): intencional.
