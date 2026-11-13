import type { DocxWorkerReply } from './docx-text.worker';
import type { ExtractResult } from './knowledge-file-reader';

/**
 * Leitor de DOCX (spec 040): só é alcançado por `import()` quando um `.docx` é escolhido. Cada leitura
 * cria um Web Worker de módulo próprio (`docx-text.worker.ts`, o único que toca o `mammoth`) e o
 * encerra no fim; no `abort` (outro arquivo, "Cancelar leitura", prazo, desmonte da tela) o worker é
 * encerrado na hora (`terminate`), o que libera a memória de verdade.
 */
export function extractDocxText(bytes: ArrayBuffer, signal: AbortSignal): Promise<ExtractResult> {
  return new Promise<ExtractResult>((resolve, reject) => {
    const worker = new Worker(new URL('./docx-text.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = (): void => {
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const onAbort = (): void => {
      finish();
      reject(new Error('cancelado'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<DocxWorkerReply>) => {
      finish();
      if (event.data.ok) resolve({ text: event.data.text });
      else resolve({ problem: 'unreadable' });
    };
    worker.onerror = (event) => {
      // Sem a mensagem do erro: só a categoria fixa.
      event.preventDefault();
      finish();
      reject(new Error('worker'));
    };
    worker.postMessage(bytes, [bytes]);
  });
}
