import mammoth from 'mammoth';
import type { ZipEntry } from './knowledge-file-rules';
import { canInflateRaw, inflatedSizeWithin } from './zip-inflate-guard';

/**
 * Worker do leitor de DOCX (spec 041, D6): único módulo que importa o `mammoth` (o ESLint impõe). Roda
 * fora da thread principal, então um DOCX grande não trava a tela e cancelar é `worker.terminate()`.
 * Só `extractRawText` (texto puro): sem imagens, sem HTML. Os avisos do mammoth (`messages`) são
 * descartados, e a mensagem de erro nunca volta à tela (só `{ ok: false }`).
 *
 * Antes do mammoth, a soma REAL do que o ZIP descompacta é conferida em fluxo (`zip-inflate-guard.ts`,
 * revisão I-1): o tamanho declarado no diretório pode mentir. Navegador sem `deflate-raw` no
 * `DecompressionStream` fica só com a soma declarada (conferida antes, na thread principal).
 *
 * Ao carregar, o worker avisa `{ ready: true }`: um erro antes desse aviso é falha ao carregar o
 * próprio worker (aba antiga depois de um deploy), que a tela mostra como "recarregue a página".
 */

export interface DocxWorkerRequest {
  readonly bytes: ArrayBuffer;
  readonly entries: readonly ZipEntry[];
  readonly maxUncompressed: number;
}

export type DocxWorkerReply =
  { readonly ready: true } | { readonly ok: true; readonly text: string } | { readonly ok: false };

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: DocxWorkerReply): void;
}

const scope = self as unknown as WorkerScope;

function isRequest(data: unknown): data is DocxWorkerRequest {
  if (typeof data !== 'object' || data === null) return false;
  const value = data as Partial<DocxWorkerRequest>;
  return (
    value.bytes instanceof ArrayBuffer &&
    Array.isArray(value.entries) &&
    typeof value.maxUncompressed === 'number'
  );
}

async function extract(request: DocxWorkerRequest): Promise<DocxWorkerReply> {
  if (canInflateRaw()) {
    const within = await inflatedSizeWithin(
      new Uint8Array(request.bytes),
      request.entries,
      request.maxUncompressed,
    );
    if (!within) return { ok: false };
  }
  const result = await mammoth.extractRawText({ arrayBuffer: request.bytes });
  return { ok: true, text: result.value };
}

scope.onmessage = (event) => {
  const data = event.data;
  if (!isRequest(data)) {
    scope.postMessage({ ok: false });
    return;
  }
  extract(data)
    .then((reply) => scope.postMessage(reply))
    .catch(() => scope.postMessage({ ok: false }));
};

scope.postMessage({ ready: true });
