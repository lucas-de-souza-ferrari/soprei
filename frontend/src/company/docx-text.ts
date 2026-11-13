import type { DocxWorkerReply, DocxWorkerRequest } from './docx-text.worker';
import type { ExtractResult } from './knowledge-file-reader';
import { KNOWLEDGE_DOCX_MAX_UNCOMPRESSED_BYTES, readZipDirectory } from './knowledge-file-rules';

/**
 * Leitor de DOCX (spec 040): só é alcançado por `import()` quando um `.docx` é escolhido. Cada leitura
 * cria um Web Worker de módulo próprio (`docx-text.worker.ts`, o único que toca o `mammoth`) e o
 * encerra no fim; no `abort` (outro arquivo, "Cancelar leitura", prazo, desmonte da tela) o worker é
 * encerrado na hora (`terminate`), o que libera a memória de verdade.
 *
 * Erro do worker antes do aviso `ready` é falha ao carregar o arquivo do worker (por exemplo, aba
 * aberta antes de um deploy: o arquivo com o hash antigo não existe mais) e vira `loader-failed`.
 */
export function extractDocxText(bytes: ArrayBuffer, signal: AbortSignal): Promise<ExtractResult> {
  return new Promise<ExtractResult>((resolve, reject) => {
    const directory = readZipDirectory(new Uint8Array(bytes));
    if (!directory.ok) {
      resolve({ problem: 'unreadable' });
      return;
    }
    const worker = new Worker(new URL('./docx-text.worker.ts', import.meta.url), {
      type: 'module',
    });
    let ready = false;
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
      const reply = event.data;
      if ('ready' in reply) {
        ready = true;
        const request: DocxWorkerRequest = {
          bytes,
          entries: directory.entries,
          maxUncompressed: KNOWLEDGE_DOCX_MAX_UNCOMPRESSED_BYTES,
        };
        worker.postMessage(request, [bytes]);
        return;
      }
      finish();
      if (reply.ok) resolve({ text: reply.text });
      else resolve({ problem: 'unreadable' });
    };
    worker.onerror = (event) => {
      // Sem a mensagem do erro: só a categoria fixa.
      event.preventDefault();
      finish();
      if (ready) reject(new Error('worker'));
      else resolve({ problem: 'loader-failed' });
    };
  });
}
