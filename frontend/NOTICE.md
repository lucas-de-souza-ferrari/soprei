# Avisos de terceiros do site

Os componentes copiados têm o aviso na própria pasta: `src/components/motion/NOTICE.md` (beUI, MIT) e
`src/company/NOTICE.md` (Dashboard Shell da Obsidian UI, MIT).

## Fontes DM Sans e Manrope (SIL Open Font License 1.1)

Spec 032, decisão D5: as fontes são servidas pelo próprio site (`public/fonts/`), sem o Google Fonts, para
nenhum visitante enviar o IP a terceiros. O `@font-face` está no começo de `src/style.css`.

- **Origem dos arquivos `woff2`:** Google Fonts, a fonte oficial de distribuição das duas famílias. Endereços
  obtidos da folha de estilo `https://fonts.googleapis.com/css2?family=DM+Sans:wght@400..700&family=Manrope:wght@400..800`
  em 2026-11-12 e baixados de `fonts.gstatic.com` sem alteração (fontes variáveis, eixo de peso, subconjuntos
  latin e latin-ext):

| Arquivo em `public/fonts/` | Família, versão no Google Fonts e subconjunto  | SHA-256                                                            |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| `dm-sans-latin.woff2`      | DM Sans (`dmsans/v17`), latin, peso 400 a 700  | `9fea608a947e67020c33cad9a6fe3d60c54119dfb8cff87768a8117a15ed7543` |
| `dm-sans-latin-ext.woff2`  | DM Sans (`dmsans/v17`), latin-ext              | `a5d38fe99f930275684999b462c7123faa063d9e44e73b4b241723d884aa0f49` |
| `manrope-latin.woff2`      | Manrope (`manrope/v23`), latin, peso 400 a 800 | `8c2def024c1bf31aacf3624ae3c4d701269b4ec3dc765c04830839f0d36b2d9e` |
| `manrope-latin-ext.woff2`  | Manrope (`manrope/v23`), latin-ext             | `2f7335119075b2079f1d882530bbc18728461612bf90743203d73a74a48f4d9b` |

- **Licença:** SIL Open Font License, Versão 1.1. O texto completo acompanha os arquivos em
  `public/fonts/OFL-DM-Sans.txt` e `public/fonts/OFL-Manrope.txt`, copiados do repositório oficial do Google
  Fonts (`https://github.com/google/fonts`, pastas `ofl/dmsans` e `ofl/manrope`; o da DM Sans é idêntico ao do
  repositório da família, `https://github.com/googlefonts/dm-fonts`).
- **Copyright:** "Copyright 2014 The DM Sans Project Authors (https://github.com/googlefonts/dm-fonts)" e
  "Copyright 2018 The Manrope Project Authors (https://github.com/googlefonts/manrope)".
- **Uso:** os arquivos são redistribuídos sem modificação, junto com a licença; o nome das fontes não foi
  alterado. A OFL permite usar e redistribuir as fontes com software, desde que não sejam vendidas sozinhas.
- **Para atualizar:** repita o pedido acima, baixe os novos `woff2`, troque os arquivos e os hashes desta tabela
  e confira o `unicode-range` do `src/style.css` contra a folha de estilo.

## Leitores de PDF e DOCX da base de conhecimento (spec 040)

O texto de PDFs e DOCX escolhidos na aba Conhecimento é extraído no navegador. As bibliotecas só são
carregadas quando um arquivo desses é escolhido (`import()` e Web Worker; arquivos `pdf-text-*.js`,
`pdf.worker.min-*.mjs`, `docx-text-*.js` e `docx-text.worker-*.js` do build, servidos pelo próprio site).

| Pacote       | Versão exata | Licença      | Origem                                                                                 |
| ------------ | ------------ | ------------ | -------------------------------------------------------------------------------------- |
| `pdfjs-dist` | 6.5.438      | Apache-2.0   | Mozilla (PDF.js), `https://github.com/mozilla/pdf.js`, build `legacy`                  |
| `mammoth`    | 1.13.0       | BSD-2-Clause | Michael Williamson, `https://github.com/mwilliamson/mammoth.js` (build para navegador) |

- O `pdfjs-dist` não tem dependências de execução; a dependência opcional `@napi-rs/canvas` (MIT) é só do
  Node e não entra no build do site.
- O texto da licença Apache-2.0 acompanha o pacote (`node_modules/pdfjs-dist/LICENSE`). O worker servido
  (`pdf.worker.min-*.mjs`) é copiado sem alteração e mantém o aviso de licença da Mozilla no começo; o
  pedaço minificado com o resto da biblioteca (`pdf-text-*.js`) perde o comentário, por isso a licença fica
  registrada aqui.

Dependências de execução do `mammoth` (o worker do DOCX empacota as que o caminho do navegador usa; o
`readable-stream` do `jszip`, por exemplo, é trocado pela versão de navegador e não entra). Licenças conferidas
no `package.json` de cada pacote instalado, em 2026-11-12:

| Pacote                                        | Versão               | Licença                                   |
| --------------------------------------------- | -------------------- | ----------------------------------------- |
| `jszip`                                       | 3.10.2               | MIT ou GPL-3.0-or-later (usado sob a MIT) |
| `pako` (do `jszip`)                           | 1.0.11               | MIT e Zlib                                |
| `lie`, `immediate` (do `jszip`)               | 3.3.0, 3.0.6         | MIT                                       |
| `setimmediate` (do `jszip`)                   | 1.0.5                | MIT                                       |
| `readable-stream` e dependências (do `jszip`) | 2.3.8                | MIT (`inherits`: ISC)                     |
| `@xmldom/xmldom`                              | 0.8.15               | MIT                                       |
| `underscore`                                  | 1.13.8               | MIT                                       |
| `base64-js`                                   | 1.5.1                | MIT                                       |
| `xmlbuilder`                                  | 10.1.1               | MIT                                       |
| `lop`, `option`, `duck`                       | 0.4.2, 0.2.4, 0.1.12 | BSD-2-Clause                              |
| `dingbat-to-unicode`                          | 1.0.2                | BSD-2-Clause                              |

- `argparse` (MIT) e `sprintf-js` (BSD-3-Clause) são só do comando de linha do `mammoth` e não entram no build.
- As licenças BSD-2-Clause do `mammoth`, `lop`, `option`, `duck` e `dingbat-to-unicode` pedem que o aviso de
  copyright acompanhe a redistribuição: os textos estão no arquivo `LICENSE` de cada pacote
  (`node_modules/<pacote>/LICENSE`; "Copyright (c) 2013, Michael Williamson" no `mammoth`, `lop` e `duck`).
