import type { ZipEntry } from './knowledge-file-rules';

/**
 * Defesa contra bomba de compressão no DOCX (spec 040, revisão I-1). O tamanho descompactado que o
 * diretório do ZIP declara pode mentir, e o JSZip (dentro do mammoth) descompacta cada entrada
 * inteira na memória. Aqui cada entrada é descompactada em fluxo (`DecompressionStream`), contando os
 * bytes que saem de verdade, e a leitura para assim que a soma passa do teto: o mammoth só recebe
 * o arquivo se a soma real couber. Roda no worker do DOCX; só importa tipos (nada do resto do site
 * entra no pacote do worker).
 *
 * Devolve `false` quando passa do teto, quando uma entrada está fora do arquivo, usa um método que
 * não é "armazenado" (0) nem "deflate" (8) ou não descompacta. Nunca lança.
 */
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_SIZE = 30;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** `true` se o navegador descompacta `deflate-raw` (sem isso só vale a soma declarada). */
export function canInflateRaw(): boolean {
  try {
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

export async function inflatedSizeWithin(
  bytes: Uint8Array,
  entries: readonly ZipEntry[],
  max: number,
): Promise<boolean> {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let total = 0;
    for (const entry of entries) {
      const local = entry.localHeaderOffset;
      if (local + LOCAL_SIZE > bytes.length) return false;
      if (view.getUint32(local, true) !== LOCAL_SIGNATURE) return false;
      const nameLength = view.getUint16(local + 26, true);
      const extraLength = view.getUint16(local + 28, true);
      const start = local + LOCAL_SIZE + nameLength + extraLength;
      const end = start + entry.compressedSize;
      if (end > bytes.length) return false;
      if (entry.method === METHOD_STORED) {
        total += entry.compressedSize;
        if (total > max) return false;
        continue;
      }
      if (entry.method !== METHOD_DEFLATE) return false;
      const stream = new Blob([bytes.slice(start, end)])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'));
      const reader = stream.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => undefined);
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}
