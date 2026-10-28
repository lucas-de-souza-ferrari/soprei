import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** `X-Hub-Signature-256`: `sha256=` seguido de 64 dígitos hexadecimais (HMAC-SHA256 de 32 bytes). */
const SIGNATURE_HEADER = /^sha256=([0-9a-fA-F]{64})$/;

/**
 * Confere a assinatura de um evento da Meta: HMAC-SHA256 dos **bytes crus** do corpo com o segredo
 * do app (`WHATSAPP_APP_SECRET`), comparado em tempo constante. Cabeçalho ausente, repetido,
 * malformado ou de tamanho errado é inválido (o tamanho é conferido antes de comparar, porque
 * `timingSafeEqual` lança com buffers de tamanhos diferentes).
 */
export function verifyWhatsappSignature(
  rawBody: Buffer,
  header: string | readonly string[] | undefined,
  appSecret: string,
): boolean {
  if (typeof header !== 'string') return false;
  const match = SIGNATURE_HEADER.exec(header);
  if (match === null) return false;
  const provided = Buffer.from(match[1] ?? '', 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Compara dois segredos de texto em tempo constante (SHA-256 dos dois, de tamanho fixo, sem
 * vazar o tamanho nem o conteúdo pelo tempo). Usado no `hub.verify_token` do handshake.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
