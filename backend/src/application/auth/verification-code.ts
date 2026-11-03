import { createHmac, randomInt } from 'node:crypto';

/** Quantidade de dígitos do código de confirmação de e-mail (spec 020). */
export const VERIFICATION_CODE_DIGITS = 6;
const VERIFICATION_CODE_SPACE = 10 ** VERIFICATION_CODE_DIGITS;

/** Formato aceito na entrada: exatamente seis dígitos ASCII. */
export const VERIFICATION_CODE_PATTERN = /^\d{6}$/;

/** Fonte de inteiros em `[min, max)`; os testes injetam valores controlados. */
export type RandomInt = (min: number, max: number) => number;

/**
 * Código de 6 dígitos com zeros à esquerda. `crypto.randomInt` sorteia sem viés; nunca `Math.random`
 * nem módulo sobre bytes.
 */
export function generateVerificationCode(source: RandomInt = randomInt): string {
  return String(source(0, VERIFICATION_CODE_SPACE)).padStart(VERIFICATION_CODE_DIGITS, '0');
}

/** Chave do HMAC do código: HMAC do segredo com um rótulo fixo (separação de domínio). */
export function deriveVerificationKey(secret: string | Buffer): Buffer {
  return createHmac('sha256', secret).update('soprei:account-verification:v1').digest();
}

/**
 * HMAC-SHA256 em hex do código, com o e-mail normalizado na mensagem (o mesmo código em contas
 * diferentes gera hashes diferentes e o INSERT do cadastro continua único). Com 6 dígitos um hash
 * simples seria revertido em microssegundos; com o HMAC é preciso também o segredo.
 */
export function verificationDigest(key: Buffer, email: string, code: string): string {
  return createHmac('sha256', key).update(`account-verification:${email}:${code}`).digest('hex');
}
