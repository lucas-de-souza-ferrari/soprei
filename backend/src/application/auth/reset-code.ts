import { createHmac } from 'node:crypto';

/**
 * Chave do HMAC do código de recuperação de senha (spec 021): HMAC do segredo com um rótulo fixo,
 * diferente do da confirmação de e-mail (`soprei:account-verification:v1`). Finalidades distintas:
 * um código de uma nunca confere na outra (rótulo, prefixo da mensagem e colunas diferentes).
 */
export function deriveResetKey(secret: string | Buffer): Buffer {
  return createHmac('sha256', secret).update('soprei:password-reset:v1').digest();
}

/** HMAC-SHA256 em hex do código com o e-mail normalizado na mensagem (prefixo `password-reset:`). */
export function resetDigest(key: Buffer, email: string, code: string): string {
  return createHmac('sha256', key).update(`password-reset:${email}:${code}`).digest('hex');
}
