import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  SALES_CONTACT_FORM_MAX_AGE_MS,
  SALES_CONTACT_FORM_MIN_AGE_MS,
} from '../../domain/index.js';

/**
 * Token do formulário de contato comercial (spec 040, D14), sem estado: `<emitidoEmMs>.<HMAC>` com o HMAC-SHA256
 * (chave derivada do `JWT_SECRET` com rótulo próprio) de `"sales-contact:" + emitidoEmMs`, em base64url. Prova
 * que o formulário foi aberto pelo menos 3 s antes do envio (robôs enviam na hora; o tempo vindo do navegador
 * seria forjável) e no máximo 2 h antes. O token nunca vai a log.
 */
export function deriveSalesContactKey(jwtSecret: string | Buffer): Buffer {
  return createHmac('sha256', jwtSecret).update('soprei:sales-contact:v1').digest();
}

function mac(key: Buffer, issuedAtMs: number): string {
  return createHmac('sha256', key)
    .update(`sales-contact:${String(issuedAtMs)}`)
    .digest('base64url');
}

export function issueFormToken(key: Buffer, nowMs: number): string {
  const issuedAtMs = Math.trunc(nowMs);
  return `${String(issuedAtMs)}.${mac(key, issuedAtMs)}`;
}

/** Folga para relógios de processos diferentes: token "do futuro" além disto é inválido. */
const CLOCK_SKEW_MS = 60_000;

export type FormTokenCheck = 'ok' | 'too_fast' | 'expired';

/**
 * `expired` cobre o token alterado, malformado, de outra chave ou com mais de 2 h (a pessoa recarrega a
 * página); `too_fast` é o token legítimo com menos de 3 s. O HMAC é sempre comparado em tempo constante.
 */
export function checkFormToken(key: Buffer, token: string, nowMs: number): FormTokenCheck {
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (match === null) return 'expired';
  const issuedAtMs = Number(match[1]);
  const expected = Buffer.from(mac(key, issuedAtMs));
  const given = Buffer.from(match[2] ?? '');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'expired';
  const age = nowMs - issuedAtMs;
  if (age < -CLOCK_SKEW_MS || age > SALES_CONTACT_FORM_MAX_AGE_MS) return 'expired';
  if (age < SALES_CONTACT_FORM_MIN_AGE_MS) return 'too_fast';
  return 'ok';
}
