/** O código de confirmação de e-mail tem exatamente seis dígitos (spec 020). */
export const VERIFICATION_CODE_LENGTH = 6;

/**
 * Normaliza o que a pessoa digita ou cola: mantém só dígitos ASCII (descarta espaços, hífen,
 * ponto e letras) e corta em seis. Assim `123 456` e `123-456` viram `123456`.
 */
export function normalizeVerificationCode(value: string): string {
  return value.replace(/[^0-9]/g, '').slice(0, VERIFICATION_CODE_LENGTH);
}

export function isCompleteVerificationCode(value: string): boolean {
  return /^[0-9]{6}$/.test(value);
}
