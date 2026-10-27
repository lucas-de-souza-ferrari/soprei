# 012 — Reorganização de pastas (sem mudança de comportamento)

- **Status:** concluída (aprovada pelo dono em 2026-10-27 com todas as recomendações da seção "Decisões"; diff verificado por renames e testes; CI verde e merge confirmados pelo dono)
- **Branch:** `spec/012-reorganizacao-pastas`
- **Depende de:** 005 (concluída). É a próxima na ordem do roadmap, **antes da 011**, para que o canal WhatsApp já nasça na estrutura nova e para não haver ramo aberto mexendo nos mesmos arquivos.

## Objetivo

Reorganizar `src/` em subpastas por área, onde uma pasta já virou uma pilha de arquivos de responsabilidades diferentes. É uma spec **só de movimentação**: nenhum símbolo muda de nome, nenhuma linha de lógica muda, nenhum teste é acrescentado, removido ou reescrito. O ganho é achar as coisas e manter as camadas legíveis antes de entrarem a fila, o canal e a autenticação.

## Estado de partida (medido em 2026-10-27, `main` com a 005)

Pastas de produção e teste que passaram do ponto, contando arquivos diretamente na pasta:

| Pasta | Arquivos | O que se mistura |
| --- | --- | --- |
| `infrastructure/database` | 28 | conexão e transação, extensões do Prisma, repositórios, helpers de repositório, 13 testes |
| `infrastructure/http` | 14 | servidor, error handler, observabilidade, rate limit, IP do cliente, 3 testes de integração de rotas |
| `application` | 6 | atendimento, clientes e a interface do LLM, todos na raiz |
| `presentation` | 7 (+7 em `admin/`) | controllers de sistema (`health`, `metrics`), hooks e helpers comuns, helpers de rate limit |

Estão em boa forma e **não mudam**: `domain` (e suas 3 subpastas), `shared` (e subpastas), `infrastructure/config`, `logger`, `metrics`, `cache`, `external-apis`, `lifecycle.ts`, `presentation/admin`, `test-support`, e os 4 arquivos de `src/` (`index.ts` e os testes de boot e de lint).

Fatos verificados que condicionam a mudança:

- O `eslint.config.js` e o teste `src/eslint-rules.test.ts` referenciam **pastas de camada** (`src/infrastructure/database/**`, `src/application/**`, `src/presentation/**`, `src/domain/**`) e o arquivo `src/infrastructure/database/database.ts` (exceção do health check). Subpastas dentro dessas camadas continuam cobertas pelos mesmos globs; `database.ts` **fica na raiz** de `database/`.
- `tsconfig.build.json` exclui `src/**/test-server.ts` e `src/test-support`; `test-server.ts` **fica na raiz** de `http/`.
- Nenhum código lê arquivo por caminho relativo à sua própria pasta, exceto testes que apontam para `src/index.ts`, `src/test-support/shutdown-probe.ts` e `eslint.config.js`, que não se movem.
- Barrels: `infrastructure/database/index.ts` e `domain/index.ts`. Hoje parte dos imports de fora de `database/` (testes de `http`, `metrics`, `test-support/shutdown-probe.ts`) entra por caminho de arquivo, não pelo barrel.

## Convenções que a spec fixa (e vão para o `CLAUDE.md`)

1. **Pasta por área quando passar de uns 10 arquivos ou juntar duas responsabilidades.** Não criar pasta para o futuro: as pastas da 011 (fila, canal, webhook) nascem na 011.
2. **Teste ao lado do arquivo que testa**, na mesma subpasta; teste que atravessa várias partes (fluxo de atendimento, rotas de ponta a ponta) fica na pasta pai.
3. **Barrels só onde já existem** (`database/index.ts`, `domain/index.ts`). Nenhum barrel novo. Imports de fora de uma camada usam o barrel da camada quando ele exporta o símbolo; subpastas internas de uma pasta de infraestrutura não aparecem para fora dela.
4. **Sem aliases de caminho** (`@/...`): imports seguem relativos, como hoje.
5. **Nomes de arquivo não mudam** (sufixos `.service.ts`, `.repository.ts`, `.controller.ts` seguem valendo).

## Mapa de movimentação

Tudo com `git mv` (o histórico segue o arquivo). Cada linha vale para o arquivo e para o seu `.test.ts`/`.integration.test.ts`.

**`src/infrastructure/database/`**

| Fica na raiz | Vai para `extensions/` | Vai para `repositories/` |
| --- | --- | --- |
| `index.ts` | `tenant-scope.ts` (+ `.test`, `.integration.test`) | `tenant.repository.base.ts` (+ `.test`) |
| `database.ts` (+ `.test`, `.integration.test`) | `query-timing.ts` (+ `.test`) | `client.repository.ts` (+ `.integration.test`) |
| `transaction.ts` (+ `.test`) | `schema-info.ts` | `conversation.repository.ts` (+ `.integration.test`) |
| `database-errors.ts` (+ `.test`) | | `message.repository.ts` (+ `.integration.test`) |
| `attendance.integration.test.ts` (atravessa repositórios) | | `repository-errors.ts`, `mappers.ts` |
| | | `cursor.ts` (+ `.test`) |
| | | `attendance-unit-of-work.ts` |

Se ao mover o implementer achar que um arquivo é usado por dois grupos (por exemplo `schema-info.ts`, hoje só usado por `tenant-scope`), ele o mantém onde o uso real indicar e registra a escolha.

**`src/infrastructure/http/`**

| Fica na raiz | Vai para `observability/` | Vai para `rate-limit/` |
| --- | --- | --- |
| `server.ts`, `test-server.ts` | `observability.ts` (+ `.test`) | `rate-limit.ts` (+ `.test`, `.integration.test`) |
| `error-handler.ts` (+ `.test`) | | `client-ip.ts` (+ `.test`) |
| `admin-clients.integration.test.ts`, `attendance.integration.test.ts`, `health.integration.test.ts` | | |

**`src/application/`**

| Destino | Arquivos |
| --- | --- |
| `attendance/` | `attendance.service.ts` (+ `.test`), `attendance.schemas.ts` |
| `clients/` | `client.service.ts` (+ `.test`) |
| `ports/` | `llm-provider.ts` (a 011 acrescenta aqui `message-sender` e a porta da fila) |

**`src/presentation/`** (`admin/` não muda)

| Destino | Arquivos |
| --- | --- |
| `system/` | `health.controller.ts` (+ `.test`), `metrics.controller.ts` |
| `common/` | `bearer-auth.hook.ts` (+ `.test`), `route-pattern.ts`, `rate-limit.ts` |

Depois de mover, ajustam-se **apenas** as linhas de `import`/`export ... from` e os comentários e textos que citam o caminho antigo (inclusive o comentário do `eslint.config.js`, se citar arquivo que se moveu). O `import '.../presentation/rate-limit.js'` (efeito colateral que carrega a ampliação de tipos do Fastify) continua existindo, com o caminho novo.

## Documentação e configuração

- `CLAUDE.md` e `docs/context.md` (seção "Estrutura de pastas"): atualizar a árvore e acrescentar as cinco convenções acima. O `CLAUDE.md` cita arquivos pelo caminho em vários pontos (por exemplo `tenant-scope.ts`, `observability.ts`, `attendance.service.ts`, `src/application/llm-provider.ts`): corrigir todos.
- Specs já concluídas (001 a 011) **não são reescritas**: citam os caminhos da época, como registro histórico. A 011, que ainda não foi implementada, é a única a ser ajustada: onde ela cita `application`, `presentation` ou `infrastructure/http`, passa a apontar para `application/ports/`, `presentation/webhooks/` (a criar na 011) e `infrastructure/http/`.
- Nenhuma mudança em `package.json`, `tsconfig*.json`, CI, `prisma/` ou `.env*`, salvo se o implementer provar que algum glob quebra (e então registra aqui).

## Critérios de aceite

Cada item é verificável por comando ou por teste existente:

- [x] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` e `pnpm test:integration` verdes em Node 22 e 24, com **a mesma contagem de testes** de antes da mudança (hoje 466 unitários e 148 de integração) e os mesmos nomes de teste (comparação da lista de nomes antes e depois, ignorando a ordem).
- [x] `pnpm build` gera `dist/` e o processo compilado sobe e responde `GET /health` (o teste de boot existente cobre isso); `dist/` limpo antes do build, para não sobrar arquivo da estrutura antiga.
- [x] `git diff -M --summary main..HEAD` mostra os arquivos como **renames** (similaridade alta), e as demais mudanças de conteúdo são só linhas de `import`/`export ... from`, comentários e os documentos listados acima. A revisão confere isso por amostragem do diff com `git diff -M -U0` filtrando as linhas de import.
- [x] O teste `src/eslint-rules.test.ts` passa sem alteração de conteúdo (as exceções de Prisma e SQL cru continuam valendo em toda a pasta `database/**`, inclusive nas subpastas novas).
- [x] Nenhum arquivo `.ts` de produção ou teste ficou em pasta onde a convenção 2 mandaria outra (inspeção da lista final de `ls` por pasta, registrada no "Registro da implementação").
- [x] Nenhum import de fora de `src/infrastructure/database/` entra por subpasta (`extensions/` ou `repositories/`) quando o símbolo é exportado pelo barrel; os que hoje entram por arquivo (testes de `http`, `metrics` e `test-support/shutdown-probe.ts`) passam a usar o barrel se ele exporta o símbolo, ou o caminho novo do arquivo se não exporta (sem inflar o barrel só para isso).
- [x] `CLAUDE.md` e `docs/context.md` atualizados e sem citação de caminho antigo (`grep` por cada caminho movido, fora das specs históricas).

## Casos de borda e erros

- **Ordem dos commits:** um commit por área (`database`, `http`, `application`, `presentation`, docs), cada um com typecheck, lint e testes verdes. Assim o histórico mostra renames limpos e uma falha aponta a área.
- **Windows e maiúsculas/minúsculas:** nenhum nome muda só de caixa; `git mv` direto, sem passos intermediários.
- **Trabalho paralelo:** não há branch de spec aberta tocando esses arquivos (a 011 ainda não foi implementada). Se aparecer, a spec 012 espera ou o outro ramo reaplica a movimentação.
- **`dist/` e Prisma Client:** `dist/` é ignorado pelo git; limpar antes do build de verificação. `src/generated/` não se move.
- **Tool de refatoração:** se o implementer usar um script para reescrever imports, ele confere o resultado com `tsc` e com o diff; nada de reformatar arquivos inteiros.

## Isolamento entre clientes

Não se aplica: nenhuma lógica de acesso a dados muda. Os testes de isolamento existentes (repositórios, `tenant-scope`, atendimento) rodam intactos e são o critério de que nada se perdeu.

## Fora de escopo

- Renomear arquivos, funções, tipos ou variáveis; dividir ou juntar arquivos; qualquer mudança de lógica, de teste ou de configuração de runtime.
- Reorganizar `domain`, `shared`, `infrastructure/config`, `logger`, `metrics`, `cache`, `external-apis`, `presentation/admin` e `test-support`.
- Criar as pastas da 011 (`application/ports/` ganha só o `llm-provider.ts` agora; `presentation/webhooks/`, a fila e o canal ficam para a 011).
- Aliases de caminho, barrels novos, regras de ESLint novas, enxugar o `CLAUDE.md` ou o `context.md` além da correção dos caminhos.
- Mover ou renomear specs e documentos.

## Decisões (propostas; o dono decide)

1. **Subpastas `extensions/` e `repositories/` em `database` [recomendado]**, em vez de deixar 28 arquivos soltos.
2. **Subpastas `observability/` e `rate-limit/` em `http` [recomendado]**; as rotas de integração e o `server.ts` ficam na raiz.
3. **`application` por área (`attendance/`, `clients/`) mais `ports/` [recomendado]**, onde a 011 acrescenta as portas do canal e da fila.
4. **`presentation/system/` e `presentation/common/` [recomendado]**; `admin/` segue como está e a 011 cria `webhooks/`.
5. **Não mexer em `domain`, `shared`, `cache`, `test-support`, `config`, `logger`, `metrics` [recomendado]**: já estão coesas.
6. **Sem aliases de caminho [recomendado]**: imports relativos continuam, sem mudar o tooling.
7. **Um PR com commits por área [recomendado]** e **sem passar pelo `reviewer`**: o diff é mecânico e eu o verifico por renames. Se aparecer qualquer mudança que não seja de caminho, a revisão passa a ser necessária.

## Decisões e dependências novas

- Dependências novas: nenhuma. Sem migration.
- A spec não muda a stack nem as regras invariantes; só a localização dos arquivos e as convenções da seção "Convenções".

## Registro da implementação

Feita em 2026-10-27, branch `spec/012-reorganizacao-pastas`, um commit por área (`database`, `http`, `application`, `presentation`, docs). Status da spec mantido em `aprovada` (a conclusão fica para o dono).

**Pastas finais (arquivos diretamente em cada pasta):**

| Pasta | Arquivos |
| --- | --- |
| `infrastructure/database` | 9: `index.ts`, `database.ts` (+ `.test`, `.integration.test`), `transaction.ts` (+ `.test`), `database-errors.ts` (+ `.test`), `attendance.integration.test.ts` |
| `infrastructure/database/extensions` | 6: `tenant-scope` (+ `.test`, `.integration.test`), `query-timing` (+ `.test`), `schema-info` |
| `infrastructure/database/repositories` | 13: `tenant.repository.base` (+ `.test`), `client`, `conversation` e `message.repository` (cada um + `.integration.test`), `repository-errors`, `mappers`, `cursor` (+ `.test`), `attendance-unit-of-work` |
| `infrastructure/http` | 7: `server`, `test-server`, `error-handler` (+ `.test`), 3 testes de integração de rotas |
| `infrastructure/http/observability` | 2: `observability` (+ `.test`) |
| `infrastructure/http/rate-limit` | 5: `rate-limit` (+ `.test`, `.integration.test`), `client-ip` (+ `.test`) |
| `application/attendance`, `clients`, `ports` | 3, 2, 1 (raiz de `application/` ficou sem arquivos) |
| `presentation/system`, `common`, `admin` | 3, 4, 7 (raiz de `presentation/` ficou sem arquivos) |

**Verificação:**

- 39 renames (`git diff -M --summary main..HEAD`, similaridade de 79% a 100%; nenhum arquivo movido deixou de aparecer como rename). O restante do diff de `src/` são só linhas de `import`/`export ... from` (checado com `git diff -M -U0` filtrando essas linhas: nada sobra).
- Lista de nomes de teste capturada antes (reporter `tap`, 466 unitários e 148 de integração) e depois, nos Node 22.23.2 e 24.18.0: idêntica, mesmas contagens, nenhum teste falhado ou pulado.
- `pnpm typecheck`, `lint`, `format:check`, `test` e `test:integration` verdes nos dois Node. `rm -rf dist && pnpm build`: `dist/` só com a estrutura nova; `node dist/index.js` subiu e respondeu `GET /health` (200) e `/health/ready` (200).
- `src/eslint-rules.test.ts`, `eslint.config.js`, `package.json`, `tsconfig*.json`, CI e `pnpm-lock.yaml` não foram alterados.

**Decisões e desvios:**

- Nenhum arquivo foi usado por dois grupos: `schema-info.ts` segue em `extensions/` (só o `tenant-scope` o usa), `repository-errors.ts` e `cursor.ts` em `repositories/` (usados só pelos repositórios e pela base; `repository-errors` importa `database-errors` da raiz de `database/`, sentido que continua válido).
- Imports de fora de `database/` (testes de `http` e `metrics`, `lifecycle.integration.test.ts`, `test-support/shutdown-probe.ts`) passaram a usar o barrel `database/index.ts`, que já exportava todos os símbolos (`createDatabase`, `Database`, os quatro repositórios Prisma e a unit of work); o barrel não cresceu. Em dois arquivos de teste isso juntou duas linhas de import em uma (`admin-clients` e `db-metrics`).
- O `prettier` reformatou duas linhas de import que passaram de 100 colunas com o caminho novo (`mock-llm.provider.ts`, `server.ts`); o diff desses arquivos continua só de import.
- Comentário em `prisma/schema.prisma` citava `src/infrastructure/database/tenant-scope.ts`; ajustado para o caminho novo (só comentário; `prisma/` não tinha outra mudança, sem migration nem efeito no schema).
- As linhas 97 e 98 de `src/eslint-rules.test.ts` citam `../application/client.service.js` e `../presentation/health.controller.js` dentro de strings de código fictício que o teste manda o ESLint avaliar; não são imports reais e o arquivo não deveria mudar, então foram mantidas.
- O `import '.../presentation/common/rate-limit.js'` de efeito colateral continua em `infrastructure/http/rate-limit/rate-limit.ts`.
- Spec 011 ajustada (portas em `application/ports/`, `presentation/webhooks/` a criar na 011, caminho completo do teste de isolamento de `message.repository`); specs 001 a 010 intactas.
- Script de reescrita de imports usado fora do repositório (resolve cada `import`/`export ... from` relativo contra o caminho antigo e regrava só quando o arquivo ou o alvo mudou); resultado conferido com `tsc` e com o diff.
