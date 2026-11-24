import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238 sobre o HOTP da RFC 4226) do segundo fator do administrador da plataforma (spec 044,
 * E1): SHA-1, 6 dígitos, passo de 30 s, tolerância de um passo para cada lado. Só `node:crypto`, sem
 * dependência. O segredo e o código nunca vão a log, erro nem métrica.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Passos aceitos antes e depois do atual (relógio do celular adiantado ou atrasado). */
export const TOTP_WINDOW = 1;
/** 160 bits, o tamanho recomendado pela RFC 4226 para o HMAC-SHA-1. */
export const TOTP_SECRET_BYTES = 20;
export const TOTP_CODE_PATTERN = /^[0-9]{6}$/;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** Base32 da RFC 4648, sem `=` (o formato que os aplicativos autenticadores leem). */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

/** Inverso de `base32Encode`; `undefined` para texto fora do alfabeto (sem ecoar o texto). */
export function base32Decode(text: string): Buffer | undefined {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) return undefined;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Passo TOTP de um instante (milissegundos desde a época). */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** Código de 6 dígitos de um passo (HOTP com o passo como contador de 8 bytes). */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * O passo em que `code` confere (o atual ou um vizinho), ou `undefined`. Compara os três candidatos
 * sempre, em tempo constante, sem sair cedo.
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number): number | undefined {
  if (!TOTP_CODE_PATTERN.test(code)) return undefined;
  const current = totpStep(nowMs);
  const given = Buffer.from(code, 'utf8');
  let matched: number | undefined;
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta += 1) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = Buffer.from(totpCode(secret, step), 'utf8');
    if (timingSafeEqual(expected, given) && matched === undefined) matched = step;
  }
  return matched;
}

/**
 * URI `otpauth://` para o aplicativo autenticador. O rótulo é fixo (`Soprei:plataforma`): o e-mail do
 * administrador não entra (não precisa, e a URI é impressa no terminal).
 */
export function otpauthUri(secretBase32: string): string {
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: 'Soprei',
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/Soprei:plataforma?${params.toString()}`;
}
