import { getDocument, GlobalWorkerOptions, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ExtractResult } from './knowledge-file-reader';
import {
  KNOWLEDGE_PDF_MAX_PAGES,
  PdfTextCollector,
  type PdfTextItem,
} from './knowledge-file-rules';

/**
 * Único módulo que importa o `pdfjs-dist` (spec 041; o ESLint impõe). Só é alcançado por `import()`
 * quando um PDF é escolhido: o pacote inicial do site não muda.
 *
 * O worker do pdf.js é servido pelo próprio site (o Vite emite o arquivo em `dist/assets/` com
 * hash; build `legacy`, D11). Nada é buscado fora do site: sem `cMapUrl`, `standardFontDataUrl`,
 * `wasmUrl` nem `iccUrl` (D5). Só `getTextContent`, página por página: nada é desenhado e nenhum
 * JavaScript do PDF é executado (não se importa o visualizador nem o sandbox de scripting).
 */
GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

/**
 * Opções seguras. `isEvalSupported` não existe mais no `pdfjs-dist` 6.x (o compilador de funções com
 * `eval`/`new Function` foi removido do worker; conferido no pacote instalado); a opção fica
 * declarada para que uma troca de versão não volte a ligar o `eval`.
 */
type DocumentInitParameters = Exclude<Parameters<typeof getDocument>[0], string | URL | undefined>;

function documentParameters(data: Uint8Array): DocumentInitParameters & {
  readonly isEvalSupported: false;
} {
  return {
    data,
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    verbosity: VerbosityLevel.ERRORS,
  };
}

/** Só os itens com texto (os de conteúdo marcado não têm `str`). */
function textItems(items: readonly object[]): PdfTextItem[] {
  return items.flatMap((item) =>
    'str' in item && typeof item.str === 'string' ? [item as PdfTextItem] : [],
  );
}

/** Extrai o texto do PDF. No `abort`, destrói a tarefa (encerra o worker do pdf.js). */
export async function extractPdfText(
  bytes: ArrayBuffer,
  signal: AbortSignal,
): Promise<ExtractResult> {
  const task = getDocument(documentParameters(new Uint8Array(bytes)));
  let passwordRequired = false;
  const destroy = (): void => {
    // `destroy()` pode rejeitar; o erro não importa (a leitura já acabou) e não pode ficar solto.
    task.destroy().catch(() => undefined);
  };
  // Não pede senha: cancela a leitura e a tela mostra "protegido por senha".
  task.onPassword = () => {
    passwordRequired = true;
    destroy();
  };
  signal.addEventListener('abort', destroy, { once: true });
  try {
    const document = await task.promise;
    if (document.numPages > KNOWLEDGE_PDF_MAX_PAGES) return { problem: 'too-many-pages' };
    const collector = new PdfTextCollector();
    for (let number = 1; number <= document.numPages; number++) {
      if (signal.aborted) return { problem: 'unreadable' };
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      page.cleanup();
      if (!collector.add(textItems(content.items))) return { problem: 'content-too-large' };
    }
    return { text: collector.text() };
  } catch (error) {
    if (passwordRequired || (error instanceof Error && error.name === 'PasswordException')) {
      return { problem: 'pdf-password' };
    }
    // O worker do pdf.js não carregou (aba aberta antes de um deploy: o arquivo com o hash antigo não
    // existe mais) e o pdf.js tentou o "fake worker", que também falha. Só a categoria é usada.
    if (error instanceof Error && error.message.startsWith('Setting up fake worker failed')) {
      return { problem: 'loader-failed' };
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', destroy);
    destroy();
  }
}
