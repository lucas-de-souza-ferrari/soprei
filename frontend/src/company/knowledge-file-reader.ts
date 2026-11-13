import {
  checkFileSizeFor,
  checkMagicBytes,
  detectFileKind,
  docxZipProblem,
  extractedTextProblem,
  FILE_HEAD_BYTES,
  type FileKind,
  KNOWLEDGE_FILE_READ_TIMEOUT_MS,
  normalizeExtractedText,
} from './knowledge-file-rules';
import { decodeTextFile, type FileProblem } from './knowledge-rules';

/**
 * Orquestração da leitura de um arquivo da base de conhecimento (spec 040): tipo, tamanho e
 * assinatura antes de ler, carregamento sob demanda do leitor de PDF/DOCX, prazo e cancelamento.
 * As dependências (leitura de bytes, carregadores dos leitores, relógio) são injetáveis: os testes
 * rodam em Node sem o pdf.js e sem o mammoth. O conteúdo do arquivo nunca sai daqui a não ser no
 * resultado: nada vai a `console`, armazenamento do navegador ou URL.
 */

/** Resultado de um leitor de PDF ou DOCX (o texto ainda sem a normalização final). */
export type ExtractResult =
  | { readonly text: string }
  | {
      readonly problem: Extract<
        FileProblem,
        'pdf-password' | 'too-many-pages' | 'content-too-large' | 'unreadable'
      >;
    };

/**
 * Leitor de PDF ou DOCX. Ao receber `abort` no `signal` ele libera o que segura (no PDF,
 * `loadingTask.destroy()`; no DOCX, `worker.terminate()`). Pode lançar: qualquer erro vira a
 * mensagem fixa "não foi possível ler".
 */
export type Extractor = (bytes: ArrayBuffer, signal: AbortSignal) => Promise<ExtractResult>;

export interface FileLike {
  readonly name: string;
  readonly size: number;
  slice(start: number, end: number): Blob;
}

export interface FileReadDeps {
  readonly readBytes: (blob: Blob | FileLike) => Promise<ArrayBuffer>;
  /** `import()` do módulo do leitor de PDF (só alcançado quando um PDF é escolhido). */
  readonly loadPdf: () => Promise<Extractor>;
  readonly loadDocx: () => Promise<Extractor>;
  readonly timeoutMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export type ReadOutcome =
  | { readonly status: 'text'; readonly kind: FileKind; readonly text: string }
  | { readonly status: 'problem'; readonly problem: FileProblem }
  /** Outra leitura começou, "Cancelar leitura", desmonte da tela: nada a mostrar. */
  | { readonly status: 'cancelled' };

/**
 * Chamado quando um PDF ou DOCX passou do tipo e do tamanho e a leitura assíncrona começa (a tela
 * mostra "Lendo arquivo…"). O fim é o próprio resultado de `read`.
 */
export type ReadingListener = () => void;

const CANCELLED: ReadOutcome = { status: 'cancelled' };
const problem = (value: FileProblem): ReadOutcome => ({ status: 'problem', problem: value });

class Timeout extends Error {}
class Cancelled extends Error {}
class LoaderFailed extends Error {}

/**
 * Controle de leitura com contador próprio (`fileRun`) e um `AbortController` por leitura, separado
 * do `generation` da tela: "Carregar mais" ou apagar um documento não cancelam a leitura.
 */
export class FileReadController {
  #run = 0;
  #current: AbortController | null = null;
  readonly #deps: FileReadDeps;

  constructor(deps: FileReadDeps) {
    this.#deps = deps;
  }

  /** Cancela a leitura em andamento (se houver); o resultado dela é descartado. */
  cancel(): void {
    this.#run++;
    this.#current?.abort();
    this.#current = null;
  }

  /**
   * Lê o arquivo. Começar outra leitura cancela a anterior, que resolve com `cancelled`.
   * `onReading` só é chamado para PDF e DOCX que passaram do tipo e do tamanho.
   */
  async read(file: FileLike, onReading: ReadingListener = () => undefined): Promise<ReadOutcome> {
    this.cancel();
    const run = this.#run;
    const controller = new AbortController();
    this.#current = controller;
    const stale = (): boolean => run !== this.#run || controller.signal.aborted;

    const detected = detectFileKind(file.name);
    if ('problem' in detected) return problem(detected.problem);
    const { kind } = detected;
    const sizeProblem = checkFileSizeFor(kind, file.size);
    if (sizeProblem !== null) return problem(sizeProblem);

    if (kind === 'text') {
      try {
        const decoded = decodeTextFile(await this.#deps.readBytes(file));
        if (stale()) return CANCELLED;
        if ('problem' in decoded) return problem(decoded.problem);
        return { status: 'text', kind, text: decoded.text };
      } catch {
        return stale() ? CANCELLED : problem('not-utf8');
      }
    }

    onReading();
    try {
      return await this.#readBinary(kind, file, controller, stale);
    } finally {
      if (this.#current === controller) this.#current = null;
    }
  }

  async #readBinary(
    kind: 'pdf' | 'docx',
    file: FileLike,
    controller: AbortController,
    stale: () => boolean,
  ): Promise<ReadOutcome> {
    const setTimer = this.#deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    const clearTimer =
      this.#deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let rejectGuard: (reason: Error) => void = () => undefined;
    // Prazo e cancelamento numa só promessa: a primeira que chegar encerra a leitura.
    const guard = new Promise<never>((_, reject) => {
      rejectGuard = reject;
    });
    guard.catch(() => undefined);
    const timer = setTimer(() => {
      rejectGuard(new Timeout());
      controller.abort();
    }, this.#deps.timeoutMs ?? KNOWLEDGE_FILE_READ_TIMEOUT_MS);
    const onAbort = (): void => rejectGuard(new Cancelled());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const step = <T>(promise: Promise<T>): Promise<T> => {
      promise.catch(() => undefined);
      return Promise.race([promise, guard]);
    };

    try {
      const head = new Uint8Array(await step(this.#deps.readBytes(file.slice(0, FILE_HEAD_BYTES))));
      if (stale()) return CANCELLED;
      const magic = checkMagicBytes(kind, head);
      if (magic !== null) return problem(magic);
      const bytes = await step(this.#deps.readBytes(file));
      if (stale()) return CANCELLED;
      if (kind === 'docx') {
        const zip = docxZipProblem(new Uint8Array(bytes));
        if (zip !== null) return problem(zip);
      }
      const load = kind === 'pdf' ? this.#deps.loadPdf : this.#deps.loadDocx;
      const extract = await step(
        load().catch(() => {
          throw new LoaderFailed();
        }),
      );
      if (stale()) return CANCELLED;
      const result = await step(extract(bytes, controller.signal));
      if (stale()) return CANCELLED;
      if ('problem' in result) return problem(result.problem);
      const text = normalizeExtractedText(result.text);
      const textProblem = extractedTextProblem(text);
      if (textProblem !== null) return problem(textProblem);
      return { status: 'text', kind, text };
    } catch (error) {
      if (error instanceof Timeout) return problem('timeout');
      if (stale()) return CANCELLED;
      if (error instanceof LoaderFailed) return problem('loader-failed');
      // A mensagem do leitor nunca é mostrada nem registrada.
      return problem('unreadable');
    } finally {
      clearTimer(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (!controller.signal.aborted) controller.abort();
    }
  }
}

/** Lê um `Blob` inteiro com o `FileReader` (o mesmo caminho do `.txt` desde a spec 026). */
export function readBlob(blob: Blob | FileLike): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('leitura'));
    };
    reader.onerror = () => reject(new Error('leitura'));
    reader.readAsArrayBuffer(blob as Blob);
  });
}
