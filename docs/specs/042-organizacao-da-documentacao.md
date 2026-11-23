# 042 — Organização da documentação

- **Status:** em implementação (aprovada pelo dono em 2026-11-23, "Aprovo todas": D1 a D8 como recomendadas; E1 e E2 implementadas, cada uma na sua branch, aguardando CI, revisão e merge)
- **Branch:** `spec/042-organizacao-da-documentacao`
- **Depende de:** nenhuma (só documentação; convém não haver outra branch aberta que mexa em `AGENTS.md`)

## Objetivo

A documentação que os agentes leem em toda sessão cresceu além do útil e parte dela ficou desatualizada: o `AGENTS.md` tem 180 KB e é carregado inteiro em qualquer tarefa, o `docs/handoff.md` (76 KB) virou um histórico empilhado com o "Próximo passo sugerido" vencido, dez specs com código na `main` ainda dizem "aprovada" ou "em implementação", e há sobras versionadas. Esta spec reorganiza isso sem mudar nenhuma regra nem nenhum código de produção.

## Medidas de partida (conferidas na `main` `adf0b4a`, 2026-11-23)

- `AGENTS.md`: 180.623 bytes, 498 linhas. Só a seção "Planos e assinaturas" tem 30 KB; o preâmbulo (antes de "Stack") tem 17 KB.
- `docs/handoff.md`: 76.143 bytes, 173 linhas; 24 parágrafos "Atualização anterior" antes de "Onde estamos". A seção "Próximo passo sugerido" manda aplicar a spec 022 e revisar a 025, ambas mergeadas.
- `docs/context.md`: 56.010 bytes. A seção 3 ("Decisões em aberto") ainda lista o provedor de LLM como aberto, a fila com "concorrência 1" e a hospedagem como "VPS (protótipo: Hetzner)"; a seção 6 ("Estado atual") para na spec 025 e diz que 007, 008, 011 e 013 aguardam merge.
- Linha de status: 015, 016, 017, 030, 031, 032, 034, 036, 037, 038, 039, 040 e 041 não refletem o que o handoff registra.
- Sobras versionadas: `.tmp-onb.txt` (saída de uma execução do Playwright, commit `f8f0824`) e `lab/e0/` (o próprio `README.md` da pasta diz que ela "nunca vai para a `main`").
- `README.md`: 14 linhas; diz que "a publicação e a hospedagem serão definidas separadamente".
- Quem depende dos caminhos: `CLAUDE.md` (importa `@AGENTS.md`), `.claude/agents/*.md`, `docs/agents/*.md`, `README.md`, `docs/context.md` e `backend/src/domain-vocabulary.test.ts` (a lista `SCANNED` varre `AGENTS.md`, `docs/context.md`, `docs/handoff.md` e `docs/agents`). `docs/` e `CLAUDE.md` estão no `.prettierignore`; `AGENTS.md` e `README.md` não estão (o `format:check` os confere).

## Comportamento esperado

### E1 — `AGENTS.md` enxuto e arquivos de área

1. O `AGENTS.md` fica só com o que vale para **qualquer** tarefa: vocabulário do domínio, organização do workspace, stack, como trabalhamos, trabalho em turnos, comandos e ambiente local, regras invariantes, arquitetura e padrões, acesso a dados e isolamento (spec 003), o resumo do deploy (por causa da regra de migration aditiva) e "Nunca faça sem perguntar".
2. O restante vai para `docs/areas/`, um arquivo por área, **com o texto movido sem reescrita** (D2). Divisão proposta (D1):

   | Arquivo | Seções de hoje |
   | --- | --- |
   | `docs/areas/contas.md` | Contas globais (017), código de confirmação (020), recuperação de senha e expurgo (021) |
   | `docs/areas/autenticacao-e-papeis.md` | Autenticação (007), Autorização por papéis (008) |
   | `docs/areas/http-base.md` | Rate limiting (005), Observabilidade (004) |
   | `docs/areas/canal-whatsapp.md` | Canal (011), Capacidade (034), Agrupamento (013), Credenciais e Embedded Signup (015), Conectar pelo site (023), Coexistência (039) |
   | `docs/areas/llm.md` | Provedor de LLM real (014) |
   | `docs/areas/painel.md` | Conversas (024), Convites e equipe (025), Primeiros passos (030), Notificações (038) |
   | `docs/areas/conhecimento-e-estoque.md` | Base de conhecimento e estoque (026, 041) |
   | `docs/areas/agenda.md` | Agenda (027), IA e agenda por ferramentas (028) |
   | `docs/areas/cobranca.md` | Planos e assinaturas (031, 040), contato comercial |
   | `docs/areas/frontend.md` | Interface (018), páginas legais (032), redesign do painel (029) |

3. O `AGENTS.md` ganha a seção "Áreas": uma tabela com o arquivo, o que ele cobre e **quando é obrigatório lê-lo** (pastas e specs que disparam a leitura), e a regra: quem vai tocar uma área lê o arquivo dela antes; documentação de área nova entra em `docs/areas/`, não no `AGENTS.md`.
4. Os roteiros `docs/agents/spec-writer.md`, `implementer.md` e `reviewer.md` passam a dizer "leia `AGENTS.md` e os arquivos de `docs/areas/` das áreas tocadas". O `CLAUDE.md` continua importando só `@AGENTS.md`.
5. `backend/src/domain-vocabulary.test.ts` passa a varrer também `docs/areas` (o texto sai do `AGENTS.md`, que hoje é varrido; a cobertura não pode diminuir). Entradas de `domain-vocabulary.allowlist.json` que apontam para `AGENTS.md` acompanham o texto para o arquivo novo.

### E2 — handoff, contexto, README, specs e sobras

1. **`docs/handoff.md`** passa a ter só o estado atual, em seções fixas: "Última sessão", "Onde estamos", "Passos do dono pendentes", "Próximo passo", "Decisões do dono que não são óbvias no código", "Armadilhas", "O que não vem pelo git" e "Pendências abertas". Os parágrafos "Atualização anterior" saem (D3). Cada item das seções duráveis é conferido contra a `main`: o que já foi feito ou não vale mais sai; o que ainda vale fica. O cabeçalho do arquivo passa a dizer que a sessão nova **substitui** "Última sessão" em vez de empilhar.
2. **`docs/context.md`**: a seção 3 fica só com o que está de fato em aberto (as linhas já decididas vão para "Stack decidida" com a spec que decidiu); a seção 6 é trocada por um parágrafo curto do estado atual que aponta para o índice de specs. O "Histórico de decisões" não muda. A hospedagem só é escrita como decidida se o dono confirmar (D6).
3. **`README.md`** reescrito: o que é o Soprei, estrutura do repositório, como rodar localmente (apontando para o `AGENTS.md`), onde está cada documento (`docs/context.md`, `docs/specs/README.md`, `docs/areas/`, `docs/ops/`) e que o deploy é automático a partir da `main`.
4. **Status das specs**: a linha `- **Status:**` de toda spec começa por uma das cinco palavras do template (`esboço`, `rascunho`, `aprovada`, `em implementação`, `concluída`); o detalhe continua entre parênteses. Só essa linha muda nas specs existentes. Valores propostos (D4), a confirmar pelo dono porque CI e merge são informação dele:

   | Spec | Hoje | Proposto |
   | --- | --- | --- |
   | 015, 016, 017, 030, 036, 038, 039, 040, 041 | aprovada / em implementação | concluída |
   | 028 | "código concluído e mergeado" | concluída (E0 e E5 pendentes do dono) |
   | 037 | E1 a E3 aprovadas e implementadas | concluída (staging ainda não montado pelo dono) |
   | 031 | aprovada | em implementação (E1 a E5 concluídas; E6 não feita) |
   | 032 | aprovada | em implementação (E1 concluída) |
   | 034 | em implementação | em implementação (E1 a E3 concluídas; E4 e E5 não feitas) |
   | 018 a 027, 029 | "concluída e mergeada" | concluída (texto atual entre parênteses) |

5. **Índice** `docs/specs/README.md`: uma linha por spec (número, título, status, etapas pendentes), mais os números reservados ou sem arquivo (035 reservada para "eficiência do turno").
6. **Sobras**: `git rm` de `.tmp-onb.txt` e de `lab/e0/` (D5). As branches remotas já mergeadas (`spec/040-e2-tela`, `spec/041-conhecimento-pdf-docx`, `fix/backup-runuser`, `docs/registro-desligamento`) e a `dev` são apagadas **pelo dono**, se quiser; o agente não apaga branch remota.

### Teste de estrutura

Novo `backend/src/docs-structure.test.ts` (unitário, roda no `pnpm test`, só lê arquivos versionados, no molde de `ci-workflow.test.ts`). Ele mantém a organização de pé depois desta spec.

## Critérios de aceite

E1:

- [x] `AGENTS.md` tem no máximo 50.000 bytes (`docs-structure.test.ts`).
- [x] Todo arquivo de `docs/areas/*.md` aparece na tabela "Áreas" do `AGENTS.md` e todo caminho da tabela existe (`docs-structure.test.ts`).
- [x] Nenhum arquivo de `docs/areas/` passa de 60.000 bytes (`docs-structure.test.ts`).
- [x] Os três roteiros de `docs/agents/` citam `docs/areas/` (`docs-structure.test.ts`).
- [x] O gate de vocabulário varre `docs/areas` e continua verde, sem exceção sem uso (`domain-vocabulary.test.ts`).
- [x] **Verificação única, registrada na spec:** toda linha não vazia do `AGENTS.md` da `main` de partida existe, idêntica, no `AGENTS.md` novo ou em algum `docs/areas/*.md` (script de uma linha rodado pelo implementer; a saída vai ao "Registro da implementação"). As únicas diferenças aceitas são títulos de seção e a tabela "Áreas".
- [x] `pnpm typecheck`, `pnpm lint` e `pnpm format:check` verdes.

E2:

- [x] `docs/handoff.md` tem no máximo 20.000 bytes e contém as oito seções fixas (`docs-structure.test.ts`).
- [x] A linha de status de toda spec `docs/specs/NNN-*.md` começa por uma das cinco palavras do template (`docs-structure.test.ts`).
- [x] `docs/specs/README.md` tem uma linha para cada arquivo de spec e nenhuma para arquivo inexistente (`docs-structure.test.ts`).
- [x] `.tmp-onb.txt` e `lab/` não estão mais versionados (`docs-structure.test.ts`: `git ls-files` não os lista).
- [x] Todo link relativo do `README.md` aponta para arquivo existente (`docs-structure.test.ts`).
- [ ] O diff das specs existentes só toca a linha de status (conferido pelo `reviewer` no PR).
- [x] `ci-workflow.test.ts`, `deploy-workflow.test.ts` e `domain-vocabulary.test.ts` continuam verdes.

## Casos de borda e erros

- **Texto com vocabulário antigo no `context.md`:** a seção 6 tem um trecho entre os marcadores `vocabulario-antigo:inicio/fim`. Se o trecho sair, os marcadores saem juntos e qualquer exceção da allowlist que deixe de casar é removida (o gate falha com exceção sem uso).
- **Referências cruzadas:** specs e código citam seções do `AGENTS.md` pelo nome (por exemplo `"Ambiente local" em AGENTS.md`, `seção "Planos e assinaturas" do AGENTS.md`). As que apontam para seções movidas e estão em arquivos vivos (`docs/handoff.md`, `docs/context.md`, `docs/ops/*.md`, roteiros, comentários de código, `.env.example`) são corrigidas; as que estão dentro de specs ficam como estão (são histórico) e a tabela "Áreas" permite achar o destino.
- **Regra de segurança perdida na mudança:** é o risco principal. Por isso o texto é movido sem reescrita e há a verificação linha a linha.
- **Agente que não lê a área:** a tabela "Áreas" diz o gatilho por pasta; o `reviewer` passa a conferir no PR se a área tocada foi lida (o roteiro dele ganha esse item).
- **Item do handoff de validade incerta:** na dúvida, fica. O PR lista o que foi removido das seções duráveis para o dono conferir.
- **BOM:** o `Write` de um agente já gravou BOM literal (armadilha registrada). O teste de estrutura falha se algum `.md` tocado começar com BOM.

## Isolamento entre empresas

Não se aplica (nenhum acesso a dados, nenhum código de produção). As regras de isolamento permanecem no `AGENTS.md`, sem mudança de texto.

## Fora de escopo

- Reescrever, resumir ou corrigir o conteúdo das áreas (fica para depois, área por área, se o dono quiser).
- Mudar qualquer regra, fluxo de trabalho ou decisão.
- Tocar no corpo de specs existentes (só a linha de status).
- Fatiar `attendance.service.ts` e `AccountApp.tsx`, e os demais achados da auditoria de 2026-11-11 (spec 035 e seguintes).
- Apagar branches remotas e proteger a `main` no GitHub (passos do dono).
- `CLAUDE.md` por pasta ou qualquer mecanismo próprio de uma ferramenta: a regra tem de valer para qualquer agente.

## Decisões e dependências novas

Nenhuma dependência nova. Decisões para o dono:

- **D1 — Divisão em dez arquivos de área (tabela acima).** Recomendado. Alternativa: um arquivo por spec (mais arquivos, e o agente teria de abrir vários para uma tarefa só do canal).
- **D2 — Mover sem reescrever.** Recomendado: a mudança fica verificável linha a linha e o PR é revisável. Alternativa: aproveitar para condensar (ganho maior de tamanho, risco de perder regra e revisão muito mais cara).
- **D3 — Histórico do handoff sai do arquivo.** Recomendado: o git guarda as versões e o detalhe de cada entrega já está no "Registro da implementação" da spec. Alternativa: mover os parágrafos antigos para `docs/handoff-arquivo.md`.
- **D4 — Status proposto por spec (tabela da E2).** O dono confirma ou corrige linha a linha.
- **D5 — Apagar `lab/e0/`.** Recomendado (o E0 da 039 terminou e o próprio README da pasta diz que ela não vai para a `main`). Alternativa: manter até o fim do teste manual da coexistência.
- **D6 — Hospedagem no `context.md`.** O handoff registra o servidor próprio (Hetzner, PM2 + nginx) em produção. Recomendado: registrar como decidida, com a data de hoje no histórico de decisões. Alternativa: manter em aberto.
- **D7 — Dois PRs (E1, depois E2), na mesma numeração.** Recomendado: a E1 é a parte de risco e fica isolada. Alternativa: um PR só.
- **D8 — Limites do teste:** 50 KB para o `AGENTS.md`, 60 KB por área, 20 KB para o handoff. A estimativa do `AGENTS.md` depois da E1 é de cerca de 40 KB.
- **Revisão:** não é spec de segurança, mas o `AGENTS.md` carrega as regras de segurança; recomenda-se o `reviewer` na E1, com foco em "nada se perdeu".

## Registro da implementação

### E1 (2026-11-23, Claude Code, Fable 5.2, branch `spec/042-organizacao-da-documentacao`)

- **Divisão:** feita por script descartável (fora do repositório), por título de seção e pelos parágrafos em negrito do preâmbulo. `AGENTS.md`: de 180.623 para 45.022 bytes (41 KB de texto mais o alinhamento da tabela "Áreas" feito pelo Prettier). Áreas: `canal-whatsapp` 36 KB, `cobranca` 30 KB, `painel` 18 KB, `autenticacao-e-papeis` 16 KB, `agenda` 14 KB, `conhecimento-e-estoque` 8 KB, `http-base` 8 KB, `contas` 7 KB, `llm` 5 KB, `frontend` 4 KB.
- **Verificação única (linha a linha contra a `main` `adf0b4a`):** 379 linhas não vazias no `AGENTS.md` antigo; ausentes no conjunto novo: 19, **todas títulos de seção** (`### X` virou `## X` no arquivo de área). Nenhuma linha de conteúdo se perdeu ou mudou.
- **Ficou no `AGENTS.md`:** vocabulário, organização do workspace, stack, como trabalhamos, turnos, comandos e ambiente local, regras invariantes, arquitetura e padrões, deploy (037), acesso a dados e isolamento (003) e "Nunca faça sem perguntar". A seção nova "Áreas" fica antes de "Stack".
- **Desvio aceito (D2):** como o texto não foi reescrito, o núcleo ainda cita seções movidas por expressões como "abaixo", "acima" e `ver "Autenticação"`; a seção "Áreas" avisa que essas seções estão nos arquivos da tabela. Dentro de um arquivo de área, "acima"/"abaixo" podem apontar para seção de outro arquivo (por exemplo, o painel cita a ponte do cookie da 023, que está em `canal-whatsapp.md`).
- **Outros arquivos:** `backend/src/docs-structure.test.ts` (novo, 4 testes), `domain-vocabulary.test.ts` (varre `docs/areas`; nenhuma exceção da allowlist apontava para o `AGENTS.md`), os três roteiros de `docs/agents/`, `CLAUDE.md` (aviso de que as áreas não são carregadas sozinhas) e duas referências do `backend/.env.example` (uma dizia `CLAUDE.md` para "Ambiente local"; a outra aponta agora para a área de autenticação).
- **Ambiente desta sessão:** máquina sem `node_modules`, sem `backend/.env` e com Node 26.13.1 no `PATH` (não o 24 do `.nvmrc`). Foram feitos `pnpm install --frozen-lockfile` e `pnpm db:generate` com uma `DATABASE_URL` fictícia só no ambiente do comando (nenhum `.env` criado, nenhuma conexão).

### Revisão da E1 (2026-11-23, `reviewer`, sem bloqueante; correções aplicadas na mesma data)

O `reviewer` refez a conferência linha a linha por conta própria e chegou ao mesmo resultado (379 linhas, 19 ausentes, todas títulos; 53 linhas novas, só cabeçalhos, a seção "Áreas" e títulos; nenhuma duplicada, ordem preservada). Achados e o que foi feito:

- **I1 (aplicado):** a seção "Áreas" passou a citar o número das specs de cada seção, e o parágrafo dela cobre as citações por número, por "abaixo"/"acima" e as feitas a partir de um arquivo de área; o caso "(seção abaixo)" dos limites por perfil e IP é dito explicitamente.
- **I2 (aplicado):** gatilhos de leitura completados (`application/auth/` e `presentation/auth/` na autenticação; persona, `api.ts`, cifra, guarda do processo e config no canal; `presentation/billing/`, `entitlements`, `application/companies/` e `privacidade.md` na cobrança; `application/inventory/` e `application/notifications/` nas áreas certas) e o aviso de que `attendance.service.ts` cruza seis áreas.
- **I3 (aplicado, sem promover regra ao núcleo):** dois itens novos na seção "Áreas" mandam ler `http-base.md` e os itens "Privacidade" de autenticação e canal para qualquer log, métrica ou uso de Redis novo, e "Painel de conversas" para qualquer resposta com dado de contato. Mover essas regras para "Regras invariantes" seria reescrita e fica para decisão do dono.
- **I4 (aplicado):** `docs/handoff.md` desta branch atualizado para a E1.
- **S1 a S3 (aplicados):** o teste confere BOM em toda a documentação versionada (constante montada por código; a ferramenta de escrita tinha gravado o caractere literal), exige item completo (arquivo, seções com número de spec e gatilho) em vez de qualquer link, não fixa mais a contagem de áreas e normaliza fim de linha.
- **S4 (aplicado):** a tabela virou lista (o alinhamento do Prettier custava cerca de 3,5 KB); o `AGENTS.md` ficou com 44 KB mesmo com os gatilhos novos. A spec e os critérios falam em "tabela"; vale a lista.
- **S6 (aplicado):** cabeçalho de `docs/areas/frontend.md` sem a frase sobre `backend/`; roteiros e `CLAUDE.md` citam a seção "Áreas".
- **S5 (parte na E2, parte em aberto):** a frase da hospedagem no `AGENTS.md` e a referência do handoff a "Provedor de LLM real" são tratadas na E2. **Em aberto, para o dono:** o bullet "Atendimento" do núcleo diz que o `PATCH /admin/companies/:id` aceita `whatsappPhoneNumberId`, e a área do canal (spec 015) diz que não aceita mais (400). A contradição já existia na `main`; corrigir é alterar texto de regra, fora da D2. **Corrigido em seguida, por decisão do dono (2026-11-23):** o núcleo passou a dizer que o `PATCH` não aceita o campo (400), como o schema estrito `updateCompanyBodySchema` e o teste de `companies.controller.test.ts` já garantiam.

### E2 (2026-11-23, Claude Code, Fable 5.2, branch `spec/042-e2-handoff-e-specs`, empilhada sobre a E1)

- **`docs/handoff.md`:** de 76 KB para 19 KB. "Última sessão", "Onde estamos", "Passos do dono pendentes" e "Próximo passo" são novas; "Decisões do dono que não são óbvias no código", "Armadilhas", "O que não vem pelo git" e "Pendências abertas" foram mantidas **com o texto de antes** (só o título encurtado e a "decisão de hospedagem" retirada das pendências).
- **Removido do handoff, para o dono conferir (D3):** os 25 parágrafos "Atualização anterior"; a seção antiga "Onde estamos" (resumos das specs 027, 028 e 029, ajustes da revisão da 023 e pendências aceitas da 029, que continuam no Registro de cada spec); e a lista antiga "Passos do dono" (aplicar migrations e reiniciar depois de cada merge das specs 020 a 031, variáveis do `.env` de desenvolvimento, troca da spec 022 na máquina do dono, testes manuais das specs 014 e 015 com a API real, stash do GitHub Desktop). Critério: o sistema está em produção com essas specs, e o deploy aplica as migrations. O que não deu para confirmar foi mantido em "Passos do dono pendentes" com a marca "conferir". O texto completo está no git (`git show adf0b4a:docs/handoff.md`).
- **`docs/context.md`:** seção 3 só com o que está em aberto, mais a lista "Decididas depois" (fila, LLM, canal, hospedagem, cobrança, e-mail); seção 3.1 corrigida (dois provedores, ferramentas); seção 6 trocada por um resumo que aponta para o índice. O marcador de vocabulário antigo que abria dentro da seção 6 passou a abrir no início da seção 7. **Não tocado:** a seção 5 (roadmap), que ainda tem linhas de estado antigas (por exemplo a da spec 036); fica como histórico do roadmap, e o índice de specs é a fonte do estado.
- **`AGENTS.md`:** uma frase da seção "Stack" trocada (dizia que a hospedagem não estava decidida; D6).
- **Specs:** 14 linhas de status mudaram (015, 016, 017, 028, 030, 031, 032, 034, 036, 037, 038, 039, 040, 041), sempre no formato "palavra (resumo; status normalizado em 2026-11-23, spec 042). Antes: texto anterior inteiro". As specs 018 a 027 e 029 já começavam por "concluída" e não foram tocadas. Nenhuma outra linha de spec mudou.
- **Índice:** `docs/specs/README.md`, 41 linhas, com a coluna "Pendente"; o teste confere que o status do índice é o da spec.
- **Sobras:** `git rm` de `.tmp-onb.txt` e de `lab/e0/` (4 arquivos). As branches remotas ficam com o dono.
- **Teste:** `docs-structure.test.ts` passou a ter 10 testes (5 da E1, 5 da E2).
- **Verificado localmente (Node 26.13.1):** `typecheck`, `lint`, `format:check`, `docs-structure` (10), `domain-vocabulary` (5), `ci-workflow` (9) e `deploy-workflow` (11). **Não rodado:** `pnpm test` completo, integração, Playwright e build (nenhum código de produção mudou); o CI decide.
- **Critério ainda aberto:** "o diff das specs existentes só toca a linha de status" é do `reviewer`.
- **Correção (2026-11-23, mesmo dia):** o dono informou que **não há servidor de produção hoje**. A D6 e os resumos "em produção" tinham sido escritos a partir do handoff anterior. Corrigidos: as linhas de status normalizadas (agora dizem "na `main`"), as seções 3 e 6 e a entrada da 042 no `docs/context.md`, o `docs/handoff.md`, o README e o índice de specs.
