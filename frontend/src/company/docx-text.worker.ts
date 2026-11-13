import mammoth from 'mammoth';

/**
 * Worker do leitor de DOCX (spec 040, D6): único módulo que importa o `mammoth` (o ESLint impõe). Roda
 * fora da thread principal, então um DOCX grande não trava a tela e cancelar é `worker.terminate()`.
 * Só `extractRawText` (texto puro): sem imagens, sem HTML. Os avisos do mammoth (`messages`) são
 * descartados, e a mensagem de erro nunca volta à tela (só `{ ok: false }`).
 */

export type DocxWorkerReply = { readonly ok: true; readonly text: string } | { readonly ok: false };

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: DocxWorkerReply): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const data = event.data;
  if (!(data instanceof ArrayBuffer)) {
    scope.postMessage({ ok: false });
    return;
  }
  mammoth
    .extractRawText({ arrayBuffer: data })
    .then((result) => scope.postMessage({ ok: true, text: result.value }))
    .catch(() => scope.postMessage({ ok: false }));
};
