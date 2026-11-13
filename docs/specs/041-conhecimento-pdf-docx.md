# 041 — Conhecimento: ler PDF e DOCX no navegador

- **Status:** aprovada pelo dono em 2026-11-12 ("Aprovo todas": D1 decidida antes; D2 a D13 como recomendadas); E1 e E2 implementadas em 2026-11-12 (aguardando CI, `reviewer` e merge)
- **Branch:** `spec/041-conhecimento-pdf-docx`
- **Depende de:** 026 (base de conhecimento, aba Conhecimento), 018 (interface e tokens de cor), 030 (o passo "Documentos" dos Primeiros passos reaproveita a mesma tela)

## Objetivo

Na aba Conhecimento (`/painel/conhecimento`, spec 026), o campo de arquivo passa a aceitar também **PDF** e **DOCX**, porque é nesses formatos que a maioria das empresas já tem a política de trocas, o cardápio ou as perguntas frequentes. Hoje a pessoa precisa abrir o arquivo e colar o texto. O texto é extraído **no navegador** e enviado pela rota que já existe; o servidor não muda.

## Estado atual (lido no código em 2026-11-12)

- `frontend/src/company/KnowledgePage.tsx`: `readFile` lê o arquivo inteiro com `FileReader.readAsArrayBuffer`; `onFile` confere o nome (`checkFileName`, só `.txt`, `.md`, `.markdown`), o tamanho antes de ler (`checkFileSize`, `KNOWLEDGE_FILE_MAX_BYTES` = 200 KB em `knowledge-api.ts`), decodifica (`decodeTextFile`: UTF-8, recusa U+FFFD, vazio e mais de `KNOWLEDGE_CONTENT_MAX` = 100.000 caracteres), põe o texto no `Textarea` e, se o título está vazio, sugere `titleFromFileName` (tira `.txt`/`.md`/`.markdown`, troca `_` e `-` por espaço, corta em 120). O input tem `accept=".txt,.md,.markdown,text/plain,text/markdown"`, rótulo "Ou escolha um arquivo de texto" e é desabilitado com `busy`. As mensagens são fixas (`FILE_PROBLEM_MESSAGES` em `knowledge-rules.ts`).
- A tela usa um contador `generation` para descartar resposta tardia; ele é incrementado também por adicionar, apagar e "Carregar mais". Trocar de empresa desmonta a área (`key`), então a tela é desmontada.
- O servidor (`POST /admin/companies/:companyId/knowledge/documents`, `knowledge.validators.ts` e `chunker.ts`) recebe JSON `{ title, content }`, normaliza (NFC, `\r\n`/`\r` para `\n`, espaços no fim da linha), recusa NUL e vazio e aplica os limites de `backend/src/domain/knowledge.ts` (100.000 caracteres, 150 trechos por documento, 50 documentos e 2.000 trechos por empresa). Nenhum `bodyLimit` próprio nas rotas de conhecimento: vale o padrão do Fastify (1 MiB), que cabe 100.000 caracteres em JSON (no máximo ~300 KB em UTF-8).
- `frontend/package.json` não tem leitor de PDF nem de DOCX. As dependências do site têm versão exata e são justificadas em spec (018, 029). O `vite.config.ts` exige exatamente um CSS no `index.html` do build (plugin das páginas legais); módulos carregados por `import()` não mudam isso.
- Não existe Playwright da aba Conhecimento (a E6 da 026 foi cortada); `e2e/onboarding-fixture.ts` já simula `knowledge/documents` na API falsa.

## Comportamento esperado

### Para quem usa

- Rótulo do campo: **"Ou escolha um arquivo (texto, PDF ou Word)"**.
- `hint` do texto: **"Cole o texto (política de trocas, horários, perguntas frequentes...) ou escolha um arquivo .txt, .md, .pdf ou .docx. Arquivos de texto até 200 KB; PDF e Word até 10 MB."** (o número segue a D2).
- `accept`: `.txt,.md,.markdown,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document`. O `accept` é só conveniência: a conferência real é por extensão **e** por conteúdo (abaixo).
- Ao escolher um PDF ou DOCX válido: aparece **"Lendo arquivo…"** (com o `Loader` já usado na tela e texto visível, região `aria-live="polite"`) e um botão **"Cancelar leitura"**; o `Textarea` e o botão "Adicionar" ficam desabilitados durante a leitura; o campo de arquivo continua habilitado (escolher outro arquivo cancela a leitura em andamento). Terminada a leitura, o texto vai para o `Textarea` (substitui o que havia, como já acontece com `.txt`), o título é sugerido se estiver vazio e aparece a nota **"Texto lido do arquivo: N caracteres. Confira antes de adicionar: tabelas, colunas e cabeçalhos podem sair fora de ordem."** A pessoa revisa, edita se quiser e clica em "Adicionar": o envio é exatamente o de hoje (JSON, mesma rota, mesmos erros do servidor).
- `.txt` e `.md` continuam exatamente como hoje (200 KB, `decodeTextFile`, mesmas mensagens), só com o texto de "tipo errado" atualizado.
- O aviso fixo de privacidade (`KNOWLEDGE_PRIVACY_NOTICE`) continua no topo da aba, sem mudança.
- Vale também no passo "Documentos" dos Primeiros passos (030), que monta a mesma `KnowledgePage`.

### Detecção do tipo (função pura)

1. **Pela extensão** (minúsculas): `.txt`/`.md`/`.markdown` = texto; `.pdf` = PDF; `.docx` = DOCX; `.doc` = recusa "formato antigo"; `.odt` = recusa "ODT"; qualquer outra = "tipo errado".
2. **Tamanho antes de ler**: 0 bytes = "vazio"; texto acima de 200 KB e PDF/DOCX acima de `KNOWLEDGE_BINARY_FILE_MAX_BYTES` (D2) = "grande demais", **sem ler o arquivo**.
3. **Pelo conteúdo** (só os primeiros 1.024 bytes, `file.slice(0, 1024)`, antes de ler o resto):
   - `.pdf` precisa conter `%PDF-` nos primeiros 1.024 bytes (a especificação do PDF tolera lixo antes do cabeçalho); senão "não é um PDF válido".
   - `.docx` precisa começar com `PK\x03\x04` (ZIP). Se começa com `D0 CF 11 E0 A1 B1 1A E1` (contêiner OLE: `.doc` antigo **ou** DOCX protegido por senha, que o Office grava nesse formato), a mensagem é "protegido por senha ou formato antigo". Outro conteúdo = "não é um documento do Word (.docx) válido".
   - Depois de ler o DOCX inteiro, o diretório central do ZIP (lido por uma função pura nossa, sem dependência) precisa ter `word/document.xml` e `[Content_Types].xml`; senão "não é um documento do Word válido" (cobre `.xlsx`, `.pptx`, `.odt` e ZIP qualquer renomeados). A mesma leitura soma o tamanho descompactado declarado das entradas: acima de `KNOWLEDGE_DOCX_MAX_UNCOMPRESSED_BYTES` (D7) ou ZIP64 = "não foi possível ler" (defesa contra bomba de compressão; o prazo da leitura e o worker são a segunda barreira, porque o tamanho declarado pode mentir).

### Extração

- **Carregamento sob demanda:** `pdfjs-dist` e `mammoth` só são importados por `import()` dinâmico, no momento em que um PDF ou DOCX é escolhido. O pacote inicial do site não muda. Falha ao carregar o módulo (sem rede, ou aba aberta antes de um deploy que trocou os nomes dos arquivos) = mensagem "Não foi possível carregar o leitor de arquivos. Recarregue a página e tente de novo."
- **PDF (`pdfjs-dist`):**
  - Worker do pdf.js servido **pelo próprio site**: `GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/<build>/pdf.worker.min.mjs', import.meta.url)` (o Vite emite o arquivo em `dist/assets/` com hash). **Nada de CDN** nem de host externo (a CSP pendente da 023 deve poder ficar em `worker-src 'self'`/`script-src 'self'` para o leitor). Não se configuram `cMapUrl`, `standardFontDataUrl`, `wasmUrl` nem `iccUrl` (D5): o leitor não busca nada fora do site.
  - `getDocument` só com `data` (os bytes já lidos; nunca `url`) e as opções seguras: `isEvalSupported: false`, `enableXfa: false`, `disableFontFace: true`, `useSystemFonts: false`, `useWorkerFetch: false`, `disableAutoFetch: true`, `disableStream: true`, `disableRange: true` e `verbosity` no nível só de erros. `onPassword` não pede senha: cancela e a leitura vira "protegido por senha".
  - Só `getPage(n).getTextContent()`, página por página. **Nada é desenhado** (sem canvas, sem camada de anotações, sem links, sem formulários) e **nenhum JavaScript do PDF é executado** (não se importa o visualizador nem o sandbox de scripting; não se chama `getJSActions` nem `getFieldObjects`).
  - Montagem do texto (função pura `joinPdfTextItems`): concatena `str` de cada item, `hasEOL` vira `\n`, páginas separadas por linha em branco. A leitura **para assim que o texto passa de 100.000 caracteres** (não precisa ler o resto para recusar, D3) ou ao passar de `KNOWLEDGE_PDF_MAX_PAGES` páginas (D7).
  - O parsing do pdf.js roda no worker dele, fora da thread principal.
  - Permissões de "cópia proibida" de um PDF sem senha de abertura são ignoradas (D9).
- **DOCX (`mammoth`):** só `extractRawText({ arrayBuffer })` (texto puro; parágrafos separados por linha em branco). Sem imagens, sem HTML, sem `convertToHtml`; as mensagens de aviso do mammoth (`result.messages`) são descartadas, nunca exibidas nem logadas. Roda num **Web Worker próprio** (`new Worker(new URL('./docx-text.worker.ts', import.meta.url), { type: 'module' })`, D6), o que tira o trabalho da thread principal e permite cancelar de verdade (`worker.terminate()`).
- **Normalização do texto extraído (função pura `normalizeExtractedText`, PDF e DOCX):** NFC; `\r\n` e `\r` viram `\n`; remove caracteres de controle (C0 e C1, exceto `\n`; tabulação vira espaço), U+FFFD, hífen suave (U+00AD) e caracteres de largura zero; junta espaços repetidos numa linha; tira espaços no começo e no fim de cada linha; três ou mais quebras seguidas viram duas; `trim` final. O resultado continua passando pela normalização do servidor (idempotente). Sem NUL, então o servidor não recusa por isso.
- **Depois de normalizar:** sem nenhuma letra ou dígito (`\p{L}` ou `\p{N}`) = "sem texto" (PDF escaneado ou DOCX vazio); mais de 100.000 caracteres = recusa com a mensagem que já existe (D3).
- **Título padrão:** `titleFromFileName` passa a tirar também `.pdf` e `.docx` (o resto da regra não muda).
- **Prazo:** toda leitura de PDF ou DOCX tem prazo de `KNOWLEDGE_FILE_READ_TIMEOUT_MS` (D7); estourou, a leitura é cancelada e aparece "A leitura demorou demais...".

### Cancelamento

- Um controle de leitura próprio (contador `fileRun` e um `AbortController` por leitura), **separado** do `generation` da tela, para que "Carregar mais" ou apagar um documento não cancelem a leitura.
- Escolher outro arquivo, clicar em "Cancelar leitura", estourar o prazo ou desmontar a tela (troca de empresa, sair da aba, fechar o passo do assistente) cancela a leitura: no PDF, `loadingTask.destroy()`; no DOCX, `worker.terminate()`. Resultado que chega depois do cancelamento é descartado (nunca preenche o `Textarea`).
- Cancelar não mostra erro; o campo de arquivo é limpo.
- A orquestração fica num módulo com dependências injetáveis (carregadores do leitor, relógio/prazo), testável em Node sem o pdf.js e sem o mammoth.

### Mensagens (fixas; nunca o texto de erro do pdf.js, do mammoth ou do navegador)

| Problema | Mensagem |
| --- | --- |
| tipo errado | "Use um arquivo .txt, .md, .pdf ou .docx." |
| `.doc` | "Arquivos .doc antigos não são aceitos. Salve como .docx ou PDF, ou cole o texto." |
| `.odt` | "Arquivos .odt não são aceitos. Salve como .docx ou PDF, ou cole o texto." |
| texto grande demais (`.txt`/`.md`) | a atual ("O arquivo passa de 200 KB. Divida o texto em arquivos menores.") |
| PDF/DOCX grande demais | "O arquivo passa de 10 MB. Envie um arquivo menor ou cole só o texto." |
| vazio (0 bytes) | a atual ("O arquivo está vazio.") |
| conteúdo não é PDF | "Este arquivo não é um PDF válido." |
| conteúdo não é DOCX | "Este arquivo não é um documento do Word (.docx) válido." |
| DOCX em contêiner OLE | "Este documento do Word está protegido por senha ou em formato antigo. Remova a senha ou salve como .docx de novo, ou cole o texto." |
| PDF com senha | "Este PDF está protegido por senha. Remova a senha e tente de novo, ou cole o texto." |
| sem texto | "Não encontramos texto neste arquivo. Se for um PDF escaneado (uma imagem), o Soprei ainda não consegue lê-lo: cole o texto no campo acima." |
| páginas demais | "O PDF tem mais de 500 páginas. Divida o arquivo ou cole só a parte que interessa." |
| texto extraído grande demais | a atual ("O texto do arquivo passa de 100.000 caracteres. Divida em arquivos menores.") |
| corrompido / erro interno do leitor | "Não foi possível ler este arquivo. Ele pode estar corrompido: tente salvá-lo de novo ou cole o texto." |
| prazo | "A leitura do arquivo demorou demais. Tente um arquivo menor ou cole o texto." |
| leitor não carregou | "Não foi possível carregar o leitor de arquivos. Recarregue a página e tente de novo." |

As mensagens de erro continuam no parágrafo `role="alert"` já existente (`arquivo-do-documento-erro`, `text-destructive`); a nota de sucesso e o "Lendo arquivo…" usam `text-muted-foreground` sobre o fundo da página, par já coberto pelo `contrast.test.ts`. **Nenhum par de cor novo**; se a implementação precisar de um, ele entra em `src/theme/contrast.test.ts`.

### Privacidade

- O conteúdo do arquivo (bytes e texto) existe só em memória da tela e dos workers. Nunca vai a `console`, `localStorage`, `sessionStorage`, URL, título da página nem mensagem de erro; nada é enviado a lugar nenhum além do `POST` que já existe, quando a pessoa clica em "Adicionar".
- O `verbosity` do pdf.js fica no mínimo; mesmo assim, o teste de navegador captura o `console` e prova que uma frase secreta do arquivo não aparece.
- O nome do arquivo só vira sugestão de título (como hoje).

### Backend

**Nada muda:** nenhuma rota nova, nenhum arquivo binário no servidor, sem migration, sem variável de ambiente, sem métrica nova.

### Arquivos previstos (sugestão; o implementer pode ajustar dentro de `frontend/src/company/`)

- `knowledge-rules.ts`: tipos e mensagens novos, `checkFileName`/`checkFileSize` por tipo, `titleFromFileName`.
- `knowledge-file-rules.ts` (puro): `detectFileKind`, `checkMagicBytes`, `readZipDirectory` (nomes, soma descompactada, ZIP64), `normalizeExtractedText`, `joinPdfTextItems`, `extractedTextProblem`.
- `knowledge-file-reader.ts`: orquestração (carregamento dinâmico, prazo, cancelamento), com dependências injetáveis.
- `pdf-text.ts` (único módulo que importa `pdfjs-dist`), `docx-text.ts` e `docx-text.worker.ts` (únicos que tocam o `mammoth`); os três só são alcançados por `import()`/`new Worker`.
- `frontend/eslint.config.js`: `no-restricted-imports` de `pdfjs-dist` e `mammoth` fora desses módulos.
- `frontend/NOTICE.md`: as duas bibliotecas, versão e licença.
- Testes: `knowledge-file.test.ts` (unitários), `e2e/knowledge-files.spec.ts`, `e2e/knowledge-fixture.ts` (API falsa da aba) e `e2e/file-builders.ts` (geradores de PDF e ZIP, D8).

## Etapas

Uma branch e um PR, dois commits-grupo (o dono pode cortar o DOCX se a E2 travar):

| Etapa | O quê | Pronto quando |
| --- | --- | --- |
| E1 | Regras puras, orquestração com cancelamento e prazo, leitor de PDF (pdf.js, worker do bundle), textos novos da tela, ESLint, `NOTICE.md`, unitários e Playwright de PDF | critérios marcados (E1) verdes no CI |
| E2 | Leitor de DOCX (mammoth em worker próprio), verificação do ZIP, unitários e Playwright de DOCX | critérios marcados (E2) verdes no CI |

## Critérios de aceite

Legenda: [U] unitário (`pnpm --filter soprei-frontend test`), [E] Playwright (desktop e celular, claro e escuro onde houver tela nova), [B] build ou checagem estática, [R] conferido na revisão do PR.

**E1**

- [x] [U] `detectFileKind`: `.txt`, `.md`, `.markdown`, `.pdf`, `.docx` (maiúsculas e minúsculas) reconhecidos; `.doc`, `.odt` e outra extensão devolvem o problema próprio.
- [x] [U] Tamanho antes de ler: texto no limite de 200 KB passa e 1 byte acima recusa; PDF/DOCX no limite da D2 passa e 1 byte acima recusa; 0 byte = vazio.
- [x] [U] Assinatura: `%PDF-` no byte 0 e no byte 1.000 passa; ausente nos primeiros 1.024 bytes recusa; `PK\x03\x04` passa para `.docx`; cabeçalho OLE em `.docx` dá o problema "protegido ou antigo"; texto qualquer com extensão `.pdf` ou `.docx` recusa.
- [x] [U] `normalizeExtractedText`: NFC, `\r\n`/`\r`, controles, U+FFFD, U+00AD, largura zero, espaços repetidos, quebras em excesso e `trim` (vetores fixos); aplicada duas vezes dá o mesmo resultado; o resultado nunca contém NUL.
- [x] [U] `extractedTextProblem`: texto só com espaços e pontuação = sem texto; 100.000 caracteres passa; 100.001 recusa.
- [x] [U] `joinPdfTextItems`: `hasEOL` vira quebra, páginas separadas por linha em branco; para ao passar de 100.000 caracteres.
- [x] [U] `titleFromFileName` tira `.pdf` e `.docx` e mantém a regra atual (os vetores antigos continuam passando).
- [x] [U] Orquestração (com leitores falsos): escolher um segundo arquivo cancela o primeiro e só o segundo preenche; resultado tardio do primeiro é descartado; "Cancelar leitura" não gera mensagem de erro; prazo estourado gera a mensagem de prazo e chama o cancelamento do leitor; falha no carregamento do módulo gera "leitor não carregou"; erro do leitor com texto qualquer vira a mensagem fixa (a mensagem original nunca aparece).
- [x] [U] Todas as mensagens de `FILE_PROBLEM_MESSAGES` são as da tabela e nenhuma interpola texto do arquivo.
- [x] [B] `pnpm typecheck`, `pnpm lint`, `pnpm format:check` e `pnpm build` verdes; o ESLint recusa importar `pdfjs-dist` fora de `pdf-text.ts`; o build gera o worker do pdf.js em `dist/assets/`.
- [x] [U] Teste de texto do código: `pdf-text.ts` só é referenciado por `import(` (nunca por import estático); o código não define `cMapUrl`, `standardFontDataUrl`, `wasmUrl` nem `iccUrl`, e passa `isEvalSupported: false` e `enableXfa: false`.
- [x] [E] Aba Conhecimento com API falsa: escolher um PDF gerado com duas páginas de texto preenche o `Textarea` com o texto das duas páginas, sugere o título pelo nome, mostra "Texto lido do arquivo: N caracteres" e "Adicionar" envia `{ title, content }` à rota de sempre.
- [x] [E] "Lendo arquivo…" aparece enquanto o worker do pdf.js está atrasado (atraso injetado por `page.route` no endereço do worker); escolher outro arquivo nesse intervalo faz valer só o segundo; "Cancelar leitura" volta a tela ao estado anterior sem erro.
- [x] [E] PDF sem nenhum texto (página só com desenho) mostra a mensagem "sem texto"; PDF protegido por senha mostra a mensagem de senha; PDF truncado mostra "não foi possível ler"; arquivo de texto renomeado para `.pdf` mostra "não é um PDF válido"; arquivo de 10 MB + 1 byte mostra "passa de 10 MB" sem carregar o leitor (nenhum pedido ao módulo do pdf.js).
- [x] [E] Módulo do leitor bloqueado por `page.route` mostra "Não foi possível carregar o leitor de arquivos".
- [x] [E] Privacidade: com um PDF que contém uma frase secreta, o `console` do navegador nunca a mostra, `localStorage` só tem a chave do tema, `sessionStorage` fica vazio, a URL e o título não mudam e nenhum pedido sai para host diferente do site (todo pedido fora de `127.0.0.1:5186` falha o teste).
- [x] [E] `.txt` continua como antes (um caso de regressão), e a tela a 360 px de largura não tem rolagem horizontal com a nota e o "Lendo arquivo…" visíveis.

**E2**

- [x] [U] `readZipDirectory`: lê nomes e tamanhos de um ZIP gerado no teste; acusa ausência de `word/document.xml` ou `[Content_Types].xml`; soma descompactada acima do teto e ZIP64 recusam; ZIP truncado ou sem fim de diretório recusa sem lançar exceção crua.
- [x] [U] Teste de texto do código: `docx-text.worker.ts` só é criado por `new Worker(new URL(...))` e usa só `extractRawText`; `mammoth` não é importado fora dele (ESLint).
- [x] [E] DOCX gerado com dois parágrafos preenche o `Textarea` com os dois, separados por linha em branco, e o título sugerido não tem `.docx`.
- [x] [E] ZIP sem `word/document.xml` renomeado para `.docx` mostra "não é um documento do Word válido"; arquivo com cabeçalho OLE renomeado para `.docx` mostra "protegido por senha ou em formato antigo"; DOCX sem texto mostra "sem texto"; `.doc` e `.odt` são recusados pela extensão.
- [x] [E] Trocar de arquivo durante a leitura de um DOCX (worker atrasado por `page.route`) faz valer só o segundo.
- [x] [E] Privacidade do DOCX: mesma prova do PDF (frase secreta fora do `console`, do armazenamento e da URL).

**Geral**

- [ ] [R] Nenhum arquivo em `backend/` mudou; nenhuma migration, variável de ambiente ou rota nova.
- [ ] [R] `frontend/NOTICE.md` lista `pdfjs-dist` e `mammoth` com versão exata e licença; as licenças das dependências transitivas que entram no bundle foram conferidas e registradas no Registro da implementação.
- [ ] [R] `AGENTS.md` (seção da 026) atualizado com uma linha sobre os formatos aceitos e as dependências.

## Casos de borda e erros

- **PDF escaneado:** sem camada de texto, o resultado normalizado não tem letra nem dígito: mensagem "sem texto". Sem OCR.
- **PDF com texto em fonte sem mapeamento Unicode:** o pdf.js devolve lixo ou U+FFFD; a normalização tira o U+FFFD e, se não sobra letra nem dígito, cai em "sem texto". Lixo legível (caracteres trocados) passa: a nota "confira antes de adicionar" e a revisão no `Textarea` são a defesa.
- **PDF com senha de abertura:** recusado, sem pedir senha. **Só com senha de permissões** (abre sem senha): lido normalmente (D9).
- **PDF enorme em páginas sem texto** (um catálogo de fotos): o teto de páginas e o prazo encerram a leitura.
- **PDF em colunas, tabelas, cabeçalho e rodapé repetidos:** o texto sai na ordem que o pdf.js entrega; a pessoa revisa. Remover cabeçalho/rodapé repetido fica fora de escopo.
- **DOCX com imagens, caixas de texto, controle de alterações:** só o texto que o `extractRawText` devolve entra; imagens são ignoradas.
- **Bomba de compressão no DOCX:** teto do tamanho descompactado declarado, prazo e o worker próprio (o `terminate` libera a memória); a aba do navegador é o único afetado, nunca o servidor.
- **Arquivo que muda depois de escolhido** (removido do disco): a leitura falha e cai em "não foi possível ler".
- **Texto extraído com mais de 150 trechos ou empresa no teto de documentos/trechos:** o servidor responde com os erros que já existem (`KNOWLEDGE_DOCUMENT_TOO_LARGE`, `KNOWLEDGE_LIMIT_REACHED`), já mapeados em `knowledgeMessageOf`.
- **Navegador sem `Worker` de módulo ou recurso que o pdf.js exige:** o carregamento ou a leitura falha e aparece "leitor não carregou" ou "não foi possível ler"; colar o texto continua funcionando.
- **Aba antiga depois de um deploy:** o `import()` do leitor pode dar 404 (nomes com hash mudaram): "leitor não carregou ... recarregue a página".

## Isolamento entre empresas

Não se aplica: nenhum acesso a dados novo. O envio continua pela rota da 026, com o `CompanyId` da sessão conferido pelo servidor; a extração acontece só no navegador. Troca de empresa desmonta a tela e cancela a leitura, então texto lido para uma empresa nunca preenche o formulário de outra (coberto pelo teste de orquestração e pelo desmonte).

## Fora de escopo

- OCR de PDF escaneado ou de imagem.
- `.doc` (Word 97-2003), `.odt`, `.rtf`, `.pages`, `.xlsx`, `.csv` na base de conhecimento, HTML.
- Pedir a senha de PDF ou DOCX protegido.
- Enviar o arquivo ao servidor, guardar o arquivo original, extração no backend.
- Vários arquivos de uma vez, arrastar e soltar.
- Remover cabeçalho e rodapé repetidos, reconstruir tabelas, preservar formatação (títulos, listas) como Markdown.
- Mudar os limites do servidor (100.000 caracteres, trechos, documentos).
- Playwright do restante da aba Conhecimento (o que a E6 da 026 cortou), além dos casos de arquivo e de um caso de regressão do `.txt`.
- CSP do site (continua com a hospedagem; esta spec só garante que o leitor não depende de host externo).

## Decisões e dependências novas

### Dependências (justificativa exigida pelo `AGENTS.md`)

- **`pdfjs-dist`** (Mozilla, licença Apache-2.0 esperada): o leitor de PDF de referência para navegador, mantido pela Mozilla (é o do Firefox), com worker próprio, sem dependências nativas e com opções para desligar `eval`, XFA e fontes. Escrever um leitor de PDF próprio não é viável (compressão, fontes, mapas de caracteres). Versão **exata**, a estável mais recente no momento da implementação e **nunca abaixo de 4.2.67** (S3).
- **`mammoth`** (licença BSD-2-Clause esperada): extrai o texto puro de DOCX no navegador (`extractRawText`), pequeno e estável. Ler o XML do DOCX à mão exigiria descompactar ZIP (deflate) e interpretar o WordprocessingML, maior e mais arriscado que a dependência. Versão **exata**, a estável mais recente sem alerta de segurança conhecido (S6).
- Ambas entram em `dependencies` do `soprei-frontend`, carregadas **só sob demanda** (o pacote inicial não cresce). Nenhuma dependência nova no backend.

### D1 — Onde extrair o texto: no navegador (**decidida pelo dono, 2026-11-12**)

O navegador extrai e o servidor continua recebendo só texto pela rota existente. Nenhuma rota nova, nenhum arquivo binário no backend, sem migration, sem variável de ambiente. Motivos: o servidor não passa a interpretar arquivo não confiável, o conteúdo bruto nunca sai da máquina da pessoa e a pessoa revisa o texto antes de enviar.

### D2 — Tamanho máximo do PDF/DOCX

**Recomendação: 10 MB** (`KNOWLEDGE_BINARY_FILE_MAX_BYTES`, constante do site; o de texto continua 200 KB). PDFs exportados do Word com logotipo e fotos passam fácil de 5 MB, e o custo é só memória do navegador (o servidor recebe no máximo 100.000 caracteres). **Alternativa:** 5 MB (menos memória em celular antigo; mais gente caindo em "cole o texto").

### D3 — Texto extraído com mais de 100.000 caracteres

**Recomendação: recusar** com a mensagem que já existe ("divida em arquivos menores"), parando a leitura assim que passar do limite. É o comportamento do `.txt` hoje e evita a IA ficar sem o fim do documento sem ninguém perceber. **Alternativa:** cortar em 100.000 e avisar "o texto foi cortado na página N" (mais cômodo, mas a pessoa pode adicionar sem ler o aviso).

### D4 — O que conta como "sem texto"

**Recomendação:** depois da normalização, **nenhuma letra ou dígito** Unicode. Simples e sem falso positivo em documento curto. **Alternativa:** um mínimo (ex.: 20 letras), que pegaria PDFs escaneados com lixo de OCR embutido, mas recusaria documentos legítimos muito curtos.

### D5 — Worker e recursos do pdf.js

**Recomendação:** worker emitido pelo próprio build (`new URL(..., import.meta.url)`), **sem** `cMapUrl`, `standardFontDataUrl`, `wasmUrl` e `iccUrl`. Para extrair texto de documentos em português, os mapas de caracteres embutidos no PDF (ToUnicode) bastam; os mapas predefinidos servem sobretudo a fontes CJK. **Alternativa:** copiar os `cmaps` do pacote para o build (cerca de 1 MB a mais em arquivos estáticos, servidos do próprio site) para ler também PDFs com fontes CJK sem mapa embutido.

### D6 — DOCX fora da thread principal

**Recomendação:** `mammoth` num **Web Worker de módulo próprio**: a tela não trava com arquivo grande e o cancelamento é real (`terminate`). **Alternativa:** na thread principal (mais simples; um DOCX grande pode travar a tela por alguns segundos e o cancelamento só descarta o resultado). Se a S5 falhar (o mammoth não roda em worker), o implementer usa a alternativa e registra o desvio.

### D7 — Tetos de leitura

**Recomendação:** `KNOWLEDGE_PDF_MAX_PAGES` = 500; `KNOWLEDGE_DOCX_MAX_UNCOMPRESSED_BYTES` = 50 MB (soma declarada no diretório do ZIP); `KNOWLEDGE_FILE_READ_TIMEOUT_MS` = 60 s. Todos constantes do site, sem variável de ambiente. Um PDF de texto atinge 100.000 caracteres bem antes de 500 páginas; o teto de páginas só pega catálogos de imagem. **Alternativa:** sem teto de páginas, contando só com o prazo.

### D8 — Arquivos de teste

**Recomendação: gerados no próprio teste**, por um ajudante sem dependência em `frontend/e2e/file-builders.ts`: PDF mínimo escrito à mão (objetos, fluxo de conteúdo com `BT ... Tj ... ET`, fonte Helvetica padrão, tabela `xref` calculada), PDF sem texto (só um retângulo), PDF truncado, ZIP "stored" (sem compressão, CRC-32 calculado) para o DOCX mínimo (`[Content_Types].xml`, `_rels/.rels`, `word/document.xml`) e para o ZIP sem `document.xml`, cabeçalho OLE e o arquivo de 10 MB + 1. O **PDF com senha** também gerado (manipulador padrão, revisão 2, RC4 de 40 bits escrito no ajudante e MD5 do `node:crypto`). Assim nenhum binário vai para o git e o conteúdo de cada fixture fica legível no teste. **Alternativa:** versionar arquivos pequenos em `frontend/e2e/fixtures/` (feitos no LibreOffice e com `qpdf`), com um README de origem; vale como saída se o PDF com senha gerado à mão não for aceito pelo pdf.js (o implementer registra).

### D9 — PDF com restrição de cópia (sem senha de abertura)

**Recomendação:** ler normalmente (o pdf.js já faz assim). O arquivo é da própria empresa e a restrição não é barreira de segurança. **Alternativa:** recusar com "este PDF não permite copiar o texto" (respeita o autor, mas trava documentos legítimos exportados com restrição por padrão).

### D10 — Interação durante a leitura

**Recomendação:** `Textarea` e "Adicionar" desabilitados, campo de arquivo habilitado (trocar de arquivo cancela) e botão "Cancelar leitura". **Alternativa:** desabilitar tudo, inclusive o campo de arquivo (mais simples, mas a pessoa fica presa a uma leitura longa até o prazo).

### D11 — Build do pdf.js

**Recomendação:** o build `legacy` do `pdfjs-dist` (e o worker correspondente): funciona em navegadores mais antigos (iPhones sem atualização são comuns entre pequenas empresas) e, por ser carregado sob demanda, o tamanho maior não pesa no site. **Alternativa:** o build moderno (menor; exige navegador recente, e quem não tem recebe "leitor não carregou").

### D12 — Revisão

**Recomendação:** passar pelo `reviewer` antes do merge (duas dependências que interpretam arquivo não confiável e uma superfície de privacidade), embora não seja spec de autenticação ou isolamento.

### D13 — Etapas

**Recomendação:** E1 (base e PDF) e E2 (DOCX) na mesma branch e no mesmo PR, em commits separados. **Alternativa:** uma etapa só.

## Suposições a conferir (pelo implementer, na documentação oficial e no pacote instalado; registrar o resultado e a fonte no Registro da implementação)

- **S1 — Licenças:** `pdfjs-dist` Apache-2.0 e `mammoth` BSD-2-Clause; dependências transitivas do mammoth que entram no bundle (esperadas: `jszip`, dual MIT/GPL-3.0, usada sob MIT; `pako`, MIT e Zlib; `@xmldom/xmldom`, MIT; `bluebird`, MIT; `lop`, BSD-2-Clause; `underscore`, MIT; `base64-js`, MIT; `dingbat-to-unicode`, BSD-2-Clause; `argparse`, só do CLI). Qualquer licença copyleft forte ou ausente para a implementação e volta ao dono.
- **S2 — API do pdf.js na versão instalada:** nomes e efeito de `isEvalSupported`, `enableXfa`, `disableFontFace`, `useSystemFonts`, `useWorkerFetch`, `disableAutoFetch`, `disableStream`, `disableRange`, `verbosity` e `onPassword`; nomes das exceções de senha (`PasswordException`) e de arquivo inválido (`InvalidPDFException`); campos `str` e `hasEOL` de `getTextContent`; o caminho do worker no build `legacy`.
- **S3 — Segurança do pdf.js:** a falha de execução de código pela matriz de fonte (CVE-2024-4367) está corrigida a partir da 4.2.67 e é mitigada por `isEvalSupported: false`; conferir os avisos de segurança da versão escolhida.
- **S4 — Nada é buscado fora do site:** sem `cMapUrl`, `standardFontDataUrl` e `wasmUrl`, a extração de texto de PDFs comuns funciona e o pdf.js não tenta buscar recurso externo (o Playwright com bloqueio de host externo confirma).
- **S5 — mammoth em Web Worker:** o build para navegador do `mammoth` roda num worker de módulo empacotado pelo Vite (sem DOM), em `pnpm dev` e no `pnpm build`.
- **S6 — Avisos de segurança do mammoth:** há registro de uma correção de leitura de arquivos por caminho relativo (imagens vinculadas) em versões antigas, relevante só no Node; conferir os avisos e usar uma versão sem alerta aberto.
- **S7 — Vite:** `new URL('pdfjs-dist/...', import.meta.url)` e o worker do DOCX funcionam no servidor de desenvolvimento usado pelo Playwright e no build sem plugin novo (talvez seja preciso `optimizeDeps.exclude`); o build continua com um único CSS no `index.html`.
- **S8 — Navegadores:** o Playwright do projeto roda só Chromium. Safari (iPhone) e Chrome no Android ficam para o teste manual do dono.
- **S9 — Corpo da requisição:** o limite padrão do Fastify (1 MiB) segue cabendo 100.000 caracteres em JSON (conferido no código em 2026-11-12: nenhuma rota de conhecimento define `bodyLimit`).

## Passos do dono

1. Aprovar ou ajustar D2 a D13.
2. Depois do merge e do deploy (só o site muda; não há migration nem variável), teste manual num computador e num celular (iPhone com Safari e Android com Chrome): um PDF de texto real, um PDF escaneado, um PDF com senha e um DOCX real; conferir o texto no campo antes de adicionar e perguntar algo do documento em "Testar".
3. Não ponha segredo nem dado pessoal nos documentos (o aviso da aba continua valendo).

## Registro da implementação

2026-11-12, Claude Code (Opus 5.5, implementer), branch `spec/040-conhecimento-pdf-docx`. Commits: E1 `6fe744c` (regras, orquestração, PDF, tela, ESLint, NOTICE, testes) e E2 `75a656b` (DOCX). **Nenhum arquivo do `backend/` mudou**: sem rota, migration, variável de ambiente nem métrica.

### Arquivos

- `frontend/src/company/knowledge-file-rules.ts` (puro): `detectFileKind`, `checkFileSizeFor`, `checkMagicBytes`, `readZipDirectory`, `docxZipProblem`, `normalizeExtractedText`, `extractedTextProblem`, `pdfPageText`, `PdfTextCollector`, `joinPdfTextItems` e as constantes `KNOWLEDGE_BINARY_FILE_MAX_BYTES` (10 MB), `KNOWLEDGE_PDF_MAX_PAGES` (500), `KNOWLEDGE_DOCX_MAX_UNCOMPRESSED_BYTES` (50 MB), `KNOWLEDGE_FILE_READ_TIMEOUT_MS` (60 s), `FILE_HEAD_BYTES` (1.024).
- `frontend/src/company/knowledge-file-reader.ts`: `FileReadController` (contador próprio + um `AbortController` por leitura, prazo, carregadores e relógio injetáveis) e `readBlob` (o `FileReader` da 026).
- `frontend/src/company/pdf-text.ts` (único que importa `pdfjs-dist`), `docx-text.ts` (cria o worker) e `docx-text.worker.ts` (único que importa o `mammoth`).
- `knowledge-rules.ts` (tipos e mensagens novos, `checkFileName` e `titleFromFileName` com `.pdf`/`.docx`), `KnowledgePage.tsx` (rótulo, `hint`, `accept`, "Lendo arquivo…", "Cancelar leitura", nota de caracteres, cancelamento no desmonte), `frontend/eslint.config.js` (`no-restricted-imports`), `frontend/vite.config.ts` (`optimizeDeps.include: ['mammoth']`), `frontend/NOTICE.md`, `shell.test.ts` (a lista fixa de dependências do site ganhou as duas).
- Testes: `src/company/knowledge-file.test.ts` (20 unitários), `e2e/knowledge-files.spec.ts` (12 casos x desktop e celular), `e2e/knowledge-fixture.ts`, `e2e/file-builders.ts`.

### Dependências e o que foi conferido (S1 a S6)

- **`pdfjs-dist` 6.5.438** (estável mais recente, publicada em 2026-11-01; acima de 4.2.67) e **`mammoth` 1.13.0** (mais recente, 2026-09-26), versão exata, instaladas com `corepack pnpm` 12.3.4 (o `pnpm` global desta máquina falha ao baixar a versão do `packageManager`); `pnpm install --frozen-lockfile` passa.
- **S1 (licenças, lidas no `package.json` e no `LICENSE` de cada pacote instalado):** `pdfjs-dist` Apache-2.0 (sem dependência de execução; a opcional `@napi-rs/canvas`, MIT, é só do Node e entra no lockfile, não no build). `mammoth` BSD-2-Clause; dependências: `jszip` 3.10.2 (MIT ou GPL-3.0-or-later, usado sob MIT), `pako` 1.0.11 (MIT e Zlib), `lie`, `immediate`, `setimmediate`, `readable-stream` e dependências (MIT; `inherits` ISC), `@xmldom/xmldom` 0.8.15 (MIT), `underscore` 1.13.8 (MIT), `base64-js` (MIT), `xmlbuilder` 10.1.1 (MIT), `lop`, `option`, `duck`, `dingbat-to-unicode` (BSD-2-Clause), `argparse` (MIT) e `sprintf-js` (BSD-3-Clause, só do CLI). **Diferente do esperado:** o `mammoth` 1.13.0 não usa mais o `bluebird` (trocado por promessas nativas, NEWS da 1.13.0). Nenhuma licença copyleft obrigatória. Tudo em `frontend/NOTICE.md`.
- **S2 (API do pdf.js 6.5.438, lida em `types/src/display/api.d.ts` e `legacy/build/pdf.mjs` do pacote):** existem `enableXfa`, `disableFontFace`, `useSystemFonts`, `useWorkerFetch`, `disableAutoFetch`, `disableStream`, `disableRange`, `verbosity` (`VerbosityLevel.ERRORS` = 0) e `onPassword` (na tarefa; sem ele a promessa rejeita com `PasswordException`); `getTextContent` devolve itens com `str` e `hasEOL`; o worker do build `legacy` é `legacy/build/pdf.worker.min.mjs`. **`isEvalSupported` não existe mais** no 6.x: o worker instalado não tem `eval(` nem `new Function(` (conferido por busca no `pdf.worker.mjs`). Passamos `isEvalSupported: false` mesmo assim (tipo por interseção), para o caso de uma troca de versão, e acrescentamos `useWasm: false` (sem isso o worker poderia tentar buscar `.wasm`).
- **S3:** CVE-2024-4367 (execução de código pela matriz de fonte) foi corrigida na 4.2.67; na 6.5.438 o caminho com `eval` nem existe. `pnpm audit --prod` (2026-11-12) não acusa nada no `pdfjs-dist` nem no `mammoth` (só dois avisos antigos do `lodash` do Prisma Studio, no backend).
- **S5:** o `mammoth` roda no Web Worker de módulo no `vite` de desenvolvimento e no build (`docx-text.worker-*.js`, ~311 kB); o campo `browser` do pacote troca `unzip.js` e `docx/files.js` pelas versões de navegador (sem `fs`).
- **S6:** NEWS do `mammoth`: 1.11.0 desligou o acesso a arquivos externos por padrão (o CVE de caminho relativo), 1.12.2 corrigiu poluição de protótipo pelos estilos do documento, 1.12.3 um retrocesso exponencial (DoS) e 1.13.0 o escape do Markdown. A 1.13.0 não tem alerta aberto; o próprio NEWS recomenda rodar documento não confiável em thread separada com prazo, que é o que a D6 faz.
- **S7:** `new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url)` funciona no Vite 6.4.5 (dev e build; o build emite `dist/assets/pdf.worker.min-<hash>.mjs`, copiado sem alteração). O worker do DOCX também, sem plugin. O build continua com um único CSS no `index.html`. **Precisou** de `optimizeDeps.include: ['mammoth']`: a varredura do Vite não entra no worker, e no primeiro DOCX o servidor de desenvolvimento reotimizava as dependências e recarregava a página (o Playwright pegou isso). O pacote inicial (`index-*.js`) não tem código do pdf.js nem do mammoth.
- **S4:** o Playwright aborta e registra todo pedido fora de `127.0.0.1:5186` (rota no contexto, que pega também os workers) e a lista fica vazia em todos os casos de PDF e DOCX.
- **S8:** só Chromium (canal `chrome` local); Safari e Chrome no Android ficam para o teste manual do dono.
- **S9:** não mudou nada no servidor.

### Desvios e decisões de implementação

- **`isEvalSupported`** (acima): sem efeito no 6.x, mantido por defesa; o critério do teste de texto continua valendo.
- **Limite de 100.000 caracteres no PDF:** o coletor normaliza **cada página** antes de somar (o limite vale sobre o texto normalizado, não sobre o bruto, que tem espaços repetidos); páginas vazias não deixam linha a mais. `joinPdfTextItems` recebe as páginas (iterável) e para de consumir ao passar.
- **Teto de páginas:** conferido por `numPages` logo ao abrir (não lê nenhuma página de um PDF com mais de 500).
- **ZIP truncado ou com diretório inválido** mostra "não foi possível ler" (`unreadable`); ZIP válido sem `word/document.xml` ou `[Content_Types].xml` mostra "não é um documento do Word (.docx) válido". Só a assinatura e o diretório são conferidos antes de carregar o leitor.
- **`.txt` passa pelo mesmo controlador** (mesmas mensagens e o mesmo `decodeTextFile`), sem "Lendo arquivo…" nem nota.
- **Normalização:** a NFC é aplicada depois de remover os invisíveis (senão "e" + largura zero + acento agudo não seria idempotente); a tabulação vira espaço antes da remoção de controles; os de largura zero removidos são U+200B a U+200D, U+2060 e U+FEFF.
- **Erro do worker do DOCX:** `event.preventDefault()` no `onerror`, para o navegador não escrever a mensagem no console.
- **E1 e E2 em commits separados:** o `mammoth` entrou só no commit da E2; no da E1, um `.docx` mostrava "leitor não carregou" (estado intermediário, nunca publicado).
- Os unitários do DOCX reaproveitam os geradores de `e2e/file-builders.ts` (import relativo do teste).

### Verificação local (Node 22.22.3, `corepack pnpm` 12.3.4)

- Verde: `tsc --noEmit` e `eslint .` do frontend; `prettier --check` do repositório; `vite build` (worker do pdf.js e do DOCX em `dist/assets/`); **todos os unitários do frontend** (241); `domain-vocabulary.test.ts` do backend; o ESLint recusa `pdfjs-dist` e `mammoth` fora dos módulos próprios (conferido com `--stdin`).
- Playwright (`e2e/knowledge-files.spec.ts`, desktop e celular, Chromium do sistema): 24 de 24, repetido (`--repeat-each=2`, 48 de 48) depois da E2; a E1 também repetida. `e2e/onboarding.spec.ts` (o passo Documentos usa a mesma tela): 88 de 88.
- **Não rodado:** o resto do Playwright, os unitários e a integração do backend (o backend não mudou), a versão do Node do `.nvmrc` (24). CI é a palavra final.

### Riscos e pendências

- **nginx e `.mjs`:** o worker do pdf.js é servido como `.mjs`. Worker de módulo exige tipo JavaScript; o `mime.types` do nginx do servidor precisa mapear `mjs` para `text/javascript` ou `application/javascript` (senão o PDF mostra "não foi possível ler"). **Conferir no servidor antes do teste manual** (`curl -I https://<site>/assets/pdf.worker.min-*.mjs`); se vier `application/octet-stream`, acrescentar `types { text/javascript mjs; }` no `location /` (não mudei os exemplos de `deploy/nginx/`).
- O CSP pendente (023) precisa de `worker-src 'self'` para os dois workers.
- Rodar o servidor de desenvolvimento dos testes reotimizou o cache de dependências do Vite (`frontend/node_modules/.vite`), compartilhado com o servidor do dono na 5173: ele pode ter recarregado a página uma vez.
- Passos do dono: os da seção "Passos do dono" (teste manual em computador, iPhone e Android) e a conferência do `.mjs`.

### Revisão (reviewer, 2026-11-12) e correções aplicadas (2026-11-13)

Veredito: **aprovada com ressalvas, sem bloqueantes**. Todas as ressalvas foram aplicadas (decisão do dono: "Aplicar todas"):

- **I-1 (bomba de compressão no DOCX):** o tamanho declarado no diretório do ZIP pode mentir. Agora o worker do DOCX descompacta cada entrada em fluxo (`DecompressionStream('deflate-raw')`, `zip-inflate-guard.ts`), conta os bytes reais e para ao passar de 50 MB, **antes** do `mammoth`; método diferente de 0/8, entrada fora do arquivo ou deflate corrompido recusam. Navegador sem `deflate-raw` fica só com a soma declarada (documentado no worker). Testes: unitário com uma bomba de 2 MiB que declara 1 KB e e2e com 80 MiB que declara 1 KB ("não foi possível ler").
- **S-1:** worker que não carrega (aba antiga depois de um deploy) agora mostra "Recarregue a página": o worker do DOCX avisa `ready` ao carregar (erro antes disso = `loader-failed`) e o pdf.js que falha no "fake worker" também vira `loader-failed`. Dois testes e2e (404 no worker do DOCX e no do PDF).
- **S-2:** os exemplos de nginx (`deploy/nginx/*.conf.example`) ganharam `location ~* \.mjs$ { types { text/javascript mjs; } ... }`, travado por `deploy-scripts.test.ts`; `docs/ops/deploy.md` ganhou o passo do checklist (ler um PDF e um DOCX no staging e conferir o `Content-Type` do `.mjs`). Conferido localmente: PDF, DOCX e a bomba passam também contra `vite build` + `vite preview` (não entrou no CI).
- **S-3 e S-4:** `frontend/NOTICE.md` registra o `core-js` (MIT) embutido no build `legacy` do pdf.js e o `new Function` do polyfill de `setImmediate` no worker do DOCX (nota para a CSP futura).
- **S-5:** `task.destroy()` do pdf.js com `.catch(() => undefined)`.

Verificação local: `typecheck`, `lint`, `format:check`, 242 testes unitários do site, `deploy-scripts.test.ts` (57) e `knowledge-files.spec.ts` 30/30 (desktop e celular).

## Renumeração (2026-11-13)

Esta spec foi escrita, aprovada e implementada como **040** (branch `spec/040-conhecimento-pdf-docx`, PR #8). Enquanto isso, outra spec 040 (`040-novos-planos-e-enterprise.md`) entrou na `main`, e o PR #8 foi fechado sem merge. A decisão do dono (2026-11-13) foi renumerar esta para **041**: o arquivo, a branch (`spec/041-conhecimento-pdf-docx`, sobre a `main` `2a2fbdc`) e as referências no código, nos testes, no `AGENTS.md`, no `frontend/NOTICE.md`, nos exemplos do nginx e em `docs/ops/deploy.md`. Os commits levados para a branch nova mantêm as mensagens originais ("spec 040"), e o Registro acima cita a branch e os commits antigos. O conteúdo não mudou.
