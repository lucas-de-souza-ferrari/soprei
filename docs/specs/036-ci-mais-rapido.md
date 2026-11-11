# 036 — CI mais rápido

- **Status:** em implementação (aprovada pelo dono em 2026-11-11 com D1 a D6 como recomendadas; implementada na branch, falta a medição no CI)
- **Branch:** `spec/036-ci-mais-rapido`
- **Depende de:** 001 (CI), 018 (testes de navegador). Não depende da 034 nem a toca.
- **Observação de numeração:** conferido em `docs/specs/` e `docs/context.md` em 2026-11-11: existem 001 a 034 em arquivo. A **035** foi reservada em conversa com o dono para "eficiência do turno" (ainda sem arquivo); por isso esta é a **036**.
- **Não é spec de segurança** (não toca autenticação, autorização, isolamento, endpoint público nem segredos): o `reviewer` é opcional.
- **Fontes consultadas em 2026-11-11:** [Playwright, Continuous Integration](https://playwright.dev/docs/ci), [Playwright, Sharding](https://playwright.dev/docs/test-sharding) e [GitHub, GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). O que não foi lido na fonte está marcado **(S#)** e deve ser conferido na implementação.

## Objetivo

O CI leva cerca de 20 minutos por versão do Node e roda tudo duas vezes; cada correção depois de uma falha custa mais 20 minutos de espera. Esta spec reduz o tempo de relógio de um push para **menos de 10 minutos**, sem remover nem pular nenhum teste.

## Situação atual (lida no código)

- `.github/workflows/ci.yml`: **um job** (`verify`) em matriz `node: ['22', 'lts/*']`, com Postgres 18 e Redis 8 como services, que roda em sequência: `pnpm install`, `db:generate`, `typecheck`, `lint`, `format:check`, `build`, `db:migrate:deploy`, `pnpm test`, `pnpm test:integration`, `playwright install --with-deps chromium` e `test:browser`. Gatilhos: `pull_request` e `push` na `main`. Não há `concurrency` nem cache dos navegadores.
- `lts/*` é um alvo móvel: desde outubro de 2026 resolve para o Node 26 **(S1)**; o `CLAUDE.md` e o `docs/handoff.md` ainda falam em "Node 22 e 24" na máquina do dono.
- `frontend/playwright.config.ts`: `fullyParallel: false`, sem `workers` (o padrão do Playwright é metade dos núcleos: num runner de 2 núcleos dá **1 worker**), `retries: 1` no CI, dois projetos (`desktop` e `mobile`), `webServer` com `pnpm dev` (Vite em modo desenvolvimento) na porta 5186. São 444 testes (222 por projeto), cerca de 12 minutos, executados **duas vezes** (uma por versão do Node), embora rodem dentro do Chromium contra uma API falsa.
- Runner: `ubuntu-latest` tem **2 núcleos e 8 GB em repositório privado** e 4 núcleos e 16 GB em público (documentação do GitHub). O repositório é tratado aqui como privado **(S2)**.
- `backend/package.json`: `test:integration` roda com `--test-concurrency=1` (73 arquivos); `test` (114 arquivos no backend, mais 21 no frontend) usa a concorrência padrão do Node.
- Playwright resolvido no lockfile: `1.64.1`.

## Comportamento esperado

Nada muda para quem usa o Soprei. Muda o pipeline:

1. **Uma versão do Node nos PRs e na `main`**, lida de um arquivo `.nvmrc` na raiz (D1).
2. **Jobs paralelos** em vez de um job em sequência (D2):

   | Job | Conteúdo | Services |
   | --- | --- | --- |
   | `static` | install, `db:generate`, `typecheck`, `lint`, `format:check`, `build` | nenhum |
   | `tests` | install, `db:generate`, `db:migrate:deploy`, `pnpm test`, `pnpm test:integration` | Postgres 18 e Redis 8 |
   | `browser` (N fatias) | install, navegador do Playwright, `test:browser --shard=i/N` | nenhum |

3. **Playwright uma única vez por push**, dividido em fatias que rodam em jobs paralelos (D3), com o navegador em cache (D4).
4. **Execuções antigas do mesmo PR são canceladas** quando chega um push novo (D5).
5. **Compatibilidade com as outras versões do Node** verificada por uma execução **semanal agendada** (e sob demanda, por `workflow_dispatch`), fora do caminho dos PRs (D1).
6. A integração do backend **continua com `--test-concurrency=1`** (D6).

**Orçamento de tempo (estimativa, a medir na implementação; os jobs rodam ao mesmo tempo, vale o mais lento):**

| Job | Estimativa |
| --- | --- |
| `static` | 3 a 4 min |
| `tests` | 5 a 7 min (não há medição separada hoje; ver E1) |
| `browser`, cada fatia (3 fatias) | 1,5 a 2 min de preparo + cerca de 4 min de testes |

Minutos cobrados (repositório privado): hoje cerca de 40 por push (2 x 20); estimados 25 a 30 com esta spec, mesmo com mais jobs, porque a segunda versão do Node sai dos PRs.

## Etapas

Um PR só. Como o workflow só é exercitado no próprio GitHub Actions, a ordem abaixo permite medir cada passo; o dono dá o push e informa os tempos.

- **E1 — medir e separar:** `.nvmrc`, uma versão do Node, jobs `static`, `tests` e `browser`, `concurrency`. Cada job imprime `nproc`. Anotar no Registro da implementação a duração de cada job e as contagens de testes (unitários, integração e navegador) da última execução **antes** da mudança e da primeira **depois**.
- **E2 — Playwright em fatias:** `fullyParallel: true`, `workers` fixo em 1 no CI, matriz de fatias, cache do navegador, artefato de rastreamento por fatia.
- **E3 — execução semanal:** workflow agendado que chama a mesma suíte nas outras versões do Node.
- **E4 — documentação:** os trechos listados em D1.
- **E5 — só se a medição pedir:** se o job `tests` ficar acima de 8 min, dividir a integração em fatias por job (D6, alternativa B). Se não for necessário, não fazer.

## Critérios de aceite

Os itens marcados **[teste]** viram um teste unitário que lê os arquivos como texto (mesmo modelo de `backend/src/domain-vocabulary.test.ts`, sem dependência nova); os marcados **[CI]** são conferidos na execução real e registrados, com o link da execução, no Registro da implementação.

- [x] **[teste]** Existe `.nvmrc` na raiz com uma major do Node que satisfaz `engines.node` dos três `package.json`; `ci.yml` usa `node-version-file: .nvmrc` e não contém mais `matrix.node` nem `lts/*`.
- [x] **[teste]** `ci.yml` tem os jobs `static`, `tests` e `browser`; só `tests` declara `services`; nenhum comando do job único de hoje ficou de fora (lista fixa no teste: `db:generate`, `typecheck`, `lint`, `format:check`, `build`, `db:migrate:deploy`, `pnpm test`, `pnpm test:integration`, `test:browser`).
- [x] **[teste]** `ci.yml` declara `concurrency` com grupo por PR (ou por ref) e `cancel-in-progress` verdadeiro **só** para `pull_request`.
- [x] **[teste]** `frontend/playwright.config.ts` tem `fullyParallel: true`, `workers` igual a 1 quando `CI` está definido e `retries` 1 no CI (inalterado); o job `browser` passa `--shard` com o índice e o total vindos da matriz.
- [x] **[teste]** O cache do navegador usa o caminho `~/.cache/ms-playwright` e uma chave que contém a versão do Playwright lida do lockfile ou do pacote instalado (nunca um valor escrito à mão).
- [x] **[teste]** `backend/package.json` mantém `--test-concurrency=1` em `test:integration`.
- [x] **[teste]** Existe um workflow agendado (cron semanal e `workflow_dispatch`) que roda a suíte nas versões definidas em D1 e não é disparado por `pull_request` nem por `push`.
- [ ] **[CI]** A soma dos testes de navegador de todas as fatias é **444** (o mesmo número de antes), com zero ignorados a mais; cada teste roda em exatamente uma fatia.
- [ ] **[CI]** As contagens de testes unitários e de integração são iguais às da última execução antes da mudança.
- [ ] **[CI]** Em **três execuções seguidas** de PR com o cache do navegador já aquecido, o tempo de relógio do workflow (da criação ao fim do último job) fica **abaixo de 10 minutos**; a primeira execução (cache vazio) fica abaixo de 12.
- [ ] **[CI]** Dois pushes seguidos no mesmo PR: a execução do primeiro aparece como cancelada.
- [ ] **[CI]** A execução semanal, disparada à mão uma vez por `workflow_dispatch`, termina verde nas versões de D1.
- [x] `AGENTS.md`, `CLAUDE.md`, `docs/agents/implementer.md` e `docs/handoff.md` não dizem mais que o CI dos PRs roda em duas versões (trechos em D1); `docs/context.md` ganha a decisão no histórico.
- [x] `pnpm typecheck`, `pnpm lint` e `pnpm format:check` verdes.

## Casos de borda e erros

- **Falha de rede ao baixar o navegador:** com o cache aquecido não há download do navegador. Com o cache vazio (primeira execução ou troca de versão do Playwright), o download continua podendo falhar; reexecutar o job resolve. A instalação das bibliotecas do sistema (`apt`) continua dependendo de rede (D4).
- **Troca de versão do Playwright:** a chave do cache muda e o navegador é baixado de novo, uma vez. Nunca se usa um navegador de outra versão (sem `restore-keys` parcial).
- **Teste que dependia da ordem dentro do arquivo:** com `fullyParallel: true` ele pode falhar localmente (onde há mais de um worker). É defeito do teste e é consertado no teste; não se volta a `fullyParallel: false` nem se marca o arquivo como serial sem registrar o motivo na spec.
- **Fatia que falha:** as outras fatias continuam (`fail-fast: false`); o rastreamento sai num artefato com o número da fatia no nome (`playwright-traces-<fatia>`).
- **Execução cancelada pelo `concurrency`:** aparece como cancelada, não como falha. Pushes na `main` nunca são cancelados (cada commit da `main` termina a sua execução).
- **Proteção da branch `main`:** se houver verificações obrigatórias com os nomes antigos (`Node 22`, `Node lts/*`), o merge fica bloqueado até o dono trocá-las pelos nomes novos **[DONO]**.
- **Execução semanal vermelha:** não bloqueia PR. O GitHub avisa por e-mail quem alterou o agendamento por último **(S3)**; a correção vira um PR normal. Quem assume uma sessão confere a última execução semanal (regra nova em `docs/handoff.md`).
- **`.nvmrc` e `engines` divergentes:** o teste do primeiro critério falha.

## Isolamento entre empresas

Não se aplica: nenhum dado, rota ou repositório é tocado. Os testes de isolamento existentes continuam rodando todos (critério das contagens).

## Fora de escopo

- Dependabot ou Renovate, `pnpm audit` e qualquer auditoria de dependências.
- Relatório ou meta de cobertura de código.
- Deploy e qualquer etapa de entrega (spec 033).
- Trocar o runner (máquinas maiores ou próprias) e mudar a visibilidade do repositório.
- Rodar o Playwright contra o site compilado (`vite preview`) em vez do `pnpm dev`: provavelmente mais rápido por teste, mas muda o que é testado; fica como alavanca seguinte se a meta não for atingida.
- Relatório HTML único do Playwright juntando as fatias (`merge-reports`): os rastreamentos por fatia bastam.
- Reescrever testes para ficarem mais rápidos, trocar os `waitForTimeout` existentes ou reduzir retentativas.
- Elevar `engines.node` (hoje `>=22`).
- Rodar só os testes afetados pelo diff (filtros por caminho).
- O arquivo `.tmp-onb.txt` versionado na raiz (saída antiga de um teste de navegador): parece sobra; remover é outro commit, com o aval do dono.

## Decisões e dependências novas

Nenhuma dependência de pacote nova. Ações do GitHub usadas: as que já existem (`actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, `actions/upload-artifact`) mais `actions/cache` (D4).

**Decisões para o dono (cada uma com recomendação e alternativa):**

### D1 — Uma só versão do Node nos PRs

- **Recomendação:** `.nvmrc` na raiz com **`24`** (só a major: as correções de segurança da linha 24 entram sozinhas), lido pelo CI com `node-version-file`. Essa passa a ser **a versão de produção** (a spec 033 diz "o mesmo que o CI"). Motivos: (a) o Node 22 sai de suporte em abril de 2027 **(S1)**, cedo demais para ser a base de produção; (b) o 26 virou LTS há poucas semanas **(S1)**; (c) o 24 tem suporte até abril de 2028 **(S1)** e já está instalado na máquina do dono. Mais um workflow **semanal** (segunda-feira de madrugada, e `workflow_dispatch`) que roda a suíte inteira em **`22`** (o piso de `engines.node`) e em **`lts/*`** (a próxima versão para onde a produção vai migrar). O workflow semanal reaproveita o mesmo arquivo de jobs (workflow reutilizável com a versão do Node como entrada), para não haver duas listas de passos.
- **Alternativa A:** manter as duas versões nos unitários e na integração e rodar só o Playwright em uma. O ganho vem quase todo do Playwright, então a meta de 10 min ainda é possível, mas os minutos cobrados caem menos e a regra das duas versões fica.
- **Alternativa B:** `.nvmrc` com `22` (o piso: o que passa no 22 quase sempre passa nas seguintes) e semanal só em `lts/*`. Mais conservador com `engines`, mas fixa a produção numa versão a cinco meses do fim do suporte.
- **Risco da recomendação:** código que use API só existente no 24 passa no PR e só é pego na semanal do 22. Mitigação: a semanal e `@types/node`; se incomodar, subir `engines.node` para `>=24` em spec própria.
- **Trechos que mudam se aprovada (regra registrada do dono; só mudam com a aprovação desta spec):**
  - `AGENTS.md`, "Trabalho em turnos", item 7: "quem os executa é o GitHub Actions, em Node 22 e na LTS mais recente" e "spec só está pronta com o CI verde nas duas versões do Node" passam a "na versão do `.nvmrc`" e "com o CI verde"; acrescentar a execução semanal.
  - `AGENTS.md`, "Comandos", parágrafo depois da tabela: "O CI roda esses quatro (mais `db:generate` e `db:migrate:deploy`) em Node 22 e na LTS mais recente".
  - `AGENTS.md`, "Stack": "Node.js 22 ou superior (`engines.node >= 22`...)" fica, com o acréscimo de que o CI e a produção usam a versão do `.nvmrc`.
  - `docs/agents/implementer.md`, nível 4 da validação ("em **Node 22 e na LTS mais recente**, repetição das suítes novas e alteradas nas duas versões") e a linha "Entrega" ("resultado de cada comando em cada Node").
  - `CLAUDE.md`: "os Node 22 e 24 ficam instalados lado a lado (nvm); para validar nas duas versões..." passa a apontar a versão do `.nvmrc` como padrão e a outra só para investigar uma falha da semanal.
  - `docs/handoff.md`: "Validação: o CI (GitHub Actions, Node 22 e LTS) é a palavra final", a armadilha "Log do CI" (artefatos `playwright-traces-0` (Node 22) e `-1` (LTS), que passam a ser por fatia) e "Node 22 e 24" na lista da máquina.
  - `docs/context.md`: entrada nova no "Histórico de decisões" (a de 2026-11-03 fica como está, é histórico) e a linha do roadmap.
  - `docs/specs/033-producao-deploy-e-operacao.md` (rascunho): "Node 22 e LTS" na descrição do CI e "Node 22 ou superior (o mesmo que o CI)" passam a citar o `.nvmrc`. `README.md` não muda.

### D2 — Jobs paralelos

- **Recomendação:** três jobs, como na tabela de "Comportamento esperado": `static`, `tests` (unitários do backend e do frontend e integração, com Postgres e Redis) e `browser`. Cada job repete `checkout`, `pnpm install` (com o cache do pnpm, que já existe) e, onde precisa, `db:generate`. Um PR com erro de lint e teste quebrado mostra os dois de uma vez.
- **Alternativa:** dois jobs (tudo do backend num, navegador no outro). Menos repetição de `install`, mas o job do backend fica mais longo e mistura falha de lint com falha de teste.
- **Custo:** cada job a mais repete cerca de 1 min de preparo e o GitHub arredonda cada job para o minuto inteiro.

### D3 — Paralelizar o Playwright

- **O que foi verificado em `frontend/e2e/`** (14 arquivos de teste, 5 de fixture): nenhum `beforeAll`/`afterAll`, nenhum `describe.serial` nem `describe.configure`, nenhuma variável mutável de módulo, nenhum arquivo escrito em disco, nenhum `storageState` compartilhado. O estado da API falsa é criado dentro de cada teste e preso à `page` por `page.route`; o `localStorage` é por contexto de navegador (um por teste); os testes de tempo usam `page.clock`. O único recurso comum é o servidor do Vite, que só serve arquivos. **Não há estado compartilhado que impeça rodar em paralelo.** Riscos que sobram: 4 `waitForTimeout` curtos e testes de tempo real, mais sensíveis a CPU disputada.
- **Recomendação:** seguir a documentação do Playwright, que recomenda **1 worker por máquina no CI** e **fatias (`--shard`) para paralelizar**: `fullyParallel: true` (a divisão em fatias passa a ser por teste e fica equilibrada; sem isso é por arquivo, e os arquivos vão de 4 a 36 testes), `workers: process.env.CI ? 1 : undefined` e uma matriz de **3 fatias** (`--shard=1/3` a `3/3`), cada uma num job. Estimativa: 12 min viram cerca de 4 min por fatia.
- **Alternativa A:** 2 fatias (cerca de 6 min de testes mais o preparo; perto demais do limite de 10 min).
- **Alternativa B:** um job só com `workers: 2`. Num runner de 2 núcleos, dois Chromium mais o Vite disputam CPU: ganho incerto e mais risco de teste intermitente; contraria a recomendação do Playwright.
- **Efeito local:** com `fullyParallel: true` a máquina do dono passa a rodar testes do mesmo arquivo em paralelo (mais rápido; pode revelar dependência de ordem, ver "Casos de borda").

### D4 — Cache dos navegadores e `--with-deps`

- **Fato da documentação:** o Playwright **não recomenda** o cache por tempo ("restaurar leva o mesmo que baixar") e, para quem quiser, manda usar a versão do Playwright na chave. Aqui o motivo é **confiabilidade**: o download já falhou por DNS e já levou 8 min.
- **Recomendação:** `actions/cache` em `~/.cache/ms-playwright`, chave `<sistema>-playwright-<versão resolvida>` (hoje `1.64.1`), sem chave parcial. Com acerto, pula `playwright install chromium`. **As bibliotecas do sistema continuam sendo instaladas em toda execução** (`playwright install-deps chromium`, que é a parte `--with-deps` separada do download **(S4)**): elas ficam fora do diretório do cache e a imagem do runner muda sem aviso; o custo é de dezenas de segundos. Ou seja: `--with-deps` deixa de ser usado como está, mas a instalação das dependências continua.
- **Alternativa A:** rodar o job `browser` no contêiner oficial `mcr.microsoft.com/playwright:v1.64.1-noble` (navegador e bibliotecas já dentro; sem download do navegador e sem `apt`). Exige manter a tag igual à versão do lockfile (um teste de texto garante) e baixar a imagem a cada job.
- **Alternativa B:** tirar também o `install-deps` e confiar nas bibliotecas que a imagem `ubuntu-latest` já traz. Mais rápido, mas pode quebrar numa atualização da imagem (a falha seria ruidosa: o navegador não abre).
- **Alternativa C:** não fazer cache (seguir a documentação ao pé da letra) e aceitar o download a cada fatia.

### D5 — `concurrency`

- **Recomendação:** `group` por workflow e PR (`github.event.pull_request.number`, ou `github.ref` fora de PR) e `cancel-in-progress` **só em `pull_request`**. Push novo no PR cancela a execução anterior; a `main` nunca é cancelada.
- **Alternativa:** cancelar também na `main` (economiza minutos em merges seguidos, mas um commit da `main` pode ficar sem resultado).

### D6 — `--test-concurrency=1` da integração

- **O que foi verificado em `backend/src/test-support/` e nos testes:** `TestKeyspace` (prefixo `soprei:test:<uuid>` por instância, limpeza só do que criou) e `TestTenants` (slug aleatório por empresa, limpeza só das empresas criadas) isolam bem o que é **por empresa**. Mas há testes de integração que agem sobre o **banco inteiro**: `unverified-account-purge` (apaga contas não confirmadas antigas de qualquer origem), `invitation-expiry` (expurgo que cruza empresas), `billing-notice` (`runOnce` percorre todas as assinaturas e grava estado), `checkout` (a reconciliação pega pedidos pendentes de qualquer conta), `billing` (altera linhas do catálogo global `plans` e as restaura), `auth-cli` (administradores da plataforma, tabela global) e os testes de migration (DDL em schema temporário dentro de transação). Com arquivos em paralelo no mesmo banco, um desses pode apagar, avisar ou reconciliar dado de outro arquivo: falha intermitente, do tipo mais caro de investigar. Além disso cada hash `scrypt` usa cerca de 128 MiB.
- **Recomendação:** **manter `--test-concurrency=1`.** O ganho desta spec vem da versão única, dos jobs paralelos e das fatias do Playwright.
- **Alternativa A:** subir para 2 depois de marcar os arquivos "globais" para rodarem isolados. Exige mexer em testes e aceitar risco de intermitência; não recomendado.
- **Alternativa B (a E5, só se o job `tests` passar de 8 min):** dividir a integração em 2 jobs com `--test-shard=i/2` do runner do Node **(S5)**, **cada job com o próprio Postgres e Redis**. Dentro de cada job a concorrência continua 1 e os bancos são separados, então não há interferência; nenhum teste muda.

### Suposições a conferir na implementação

- **(S1)** Calendário do Node: 22 em manutenção até abril de 2027; 24 até abril de 2028; 26 é a LTS ativa desde outubro de 2026 (`lts/*`). Conferir em `nodejs.org` antes de gravar o `.nvmrc`.
- **(S2)** O repositório é privado (2 núcleos por runner). Se for público, há 4 núcleos e a alternativa B da D3 fica mais atraente; a E1 imprime `nproc` para tirar a dúvida.
- **(S3)** Quem recebe o aviso de falha de workflow agendado.
- **(S4)** `playwright install-deps chromium` existe na 1.64.1 e instala só as bibliotecas do sistema.
- **(S5)** `--test-shard` está disponível no runner de testes do Node 24 e divide por arquivo.

**Decisões tomadas durante a implementação:** ver o Registro abaixo.

## Registro da implementação (2026-11-11)

- **Aprovação:** o dono aprovou D1 a D6 como recomendadas ("Aprovo tudo", 2026-11-11).
- **Arquivos:** `.nvmrc` (`24`); `.github/workflows/ci.yml` (jobs `static`, `tests`, `browser` com 3 fatias, `concurrency`, gatilho `workflow_call` com as entradas `node-version` e `artifact-suffix`); `.github/workflows/node-compat.yml` (segunda-feira 06:00 UTC e `workflow_dispatch`; chama o `ci.yml` em `22` e `lts/*`); `frontend/playwright.config.ts` (`fullyParallel: true`, `workers` 1 no CI); `backend/src/ci-workflow.test.ts` (8 testes de texto, cobrem os critérios **[teste]**); `AGENTS.md`, `CLAUDE.md`, `docs/agents/implementer.md`, `docs/handoff.md`, `docs/context.md` e duas linhas da spec 033.
- **Um arquivo de jobs só:** em vez de um terceiro arquivo reutilizável, o próprio `ci.yml` aceita `workflow_call`. Nos PRs a entrada `node-version` vem vazia e o `setup-node` usa o `.nvmrc`; na semanal a entrada tem precedência. O grupo de `concurrency` inclui a versão, para as duas pernas da semanal não se bloquearem; o sufixo do artefato evita nomes repetidos na mesma execução.
- **Job `static` sem banco:** o `prisma generate` só lê `DATABASE_URL` (não conecta); o passo recebe a URL descartável do CI.
- **Suposições conferidas:** S1 confirmada no calendário oficial (`nodejs/Release`, `schedule.json`): 22 até 2027-04-30, 24 até 2028-04-30, 26 LTS desde 2026-10-28. S4 confirmada (`playwright install-deps` e o caminho `~/.cache/ms-playwright` em playwright.dev/docs/browsers). **S2, S3 e S5 não conferidas** (S2 sai do `nproc` da primeira execução; S5 só importa se a E5 for necessária).
- **Fatias:** `playwright test --list --shard=i/3` dá 148 + 148 + 148 = **444**, o total de antes.
- **Validação local (Node 24.18, Windows, Edge):** `pnpm typecheck`, `pnpm lint` e `pnpm format:check` verdes; `ci-workflow.test.ts` e `domain-vocabulary.test.ts` verdes (13 testes). Suíte de navegador completa com `fullyParallel` e os workers padrão da máquina: 428 passaram, 12 pulados, **4 falharam**. Repetidos com 1 worker (como no CI): `accounts.spec.ts:6` (temas claro e escuro, desktop) e `company.spec.ts:419` (mobile) passam, ou seja, são sensíveis a CPU disputada; `team.spec.ts:350` (mobile, "trocar de empresa durante o carregamento") **falha também sozinho com 1 worker**, portanto não depende desta mudança (a conferir no CI, onde a `main` estava verde). Nenhum teste foi alterado.
- **Primeira execução no CI (2026-11-11) e mudança da D4:** as três fatias do job `browser` falharam no passo `playwright install-deps chromium`: o `apt` do runner (imagem Ubuntu 26.04) não resolveu DNS e desistiu depois de 3 min 20 s. O log mostrou que **todas as bibliotecas do Chromium já estão na imagem**; o `apt` só ia instalar 9 pacotes de fontes extras, que os testes não usam (as capturas de tela são só salvas, nunca comparadas). **O passo foi removido** (é a alternativa B da D4, no lugar da recomendação aprovada), porque ele era justamente a dependência de rede que derrubava o job. Com o cache aquecido o job `browser` não baixa mais nada além do `pnpm install`. Se uma imagem futura perder uma biblioteca, o navegador não abre e o erro é explícito. O teste `ci-workflow.test.ts` passou a exigir que o job não use `install-deps`, `--with-deps` nem `apt`. **O dono pode reverter essa escolha** (voltar o passo, ou usar o contêiner da alternativa A).
- **Não feito:** a E5 (fatiar a integração) fica condicionada à medição. Os critérios **[CI]** dependem do push do dono: tempos por job, contagens de unitários e integração antes e depois, cancelamento e a execução semanal disparada à mão.
- **Passos do dono:** dar o push e abrir o PR; se a `main` tiver verificações obrigatórias com os nomes antigos (`Node 22`, `Node lts/*`), trocá-las pelos novos (`Checagens estáticas e build`, `Testes unitários e de integração`, `Navegador (fatia 1)` a `(fatia 3)`); depois do merge, disparar "Compatibilidade do Node" uma vez pelo botão "Run workflow" (workflow agendado só existe a partir da `main`).
