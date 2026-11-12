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
