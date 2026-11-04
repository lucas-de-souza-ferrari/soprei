import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUuid } from '../../shared/utils/index.js';

/** Tamanho máximo aceito para o token na entrada (o formato válido tem 117 caracteres). */
export const INVITATION_TOKEN_MAX_LENGTH = 256;

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Chave do HMAC do convite: HMAC do segredo da aplicação com um rótulo fixo (separação de domínio
 * em relação às chaves dos códigos de confirmação de e-mail e de recuperação de senha, 020 e 021:
 * um código daqueles nunca confere aqui).
 */
export function deriveInvitationKey(secret: string | Buffer): Buffer {
  return createHmac('sha256', secret).update('soprei:company-invitation:v1').digest();
}

/** Segredo do link: 256 bits aleatórios em base64url (43 caracteres). */
export function generateInvitationSecret(source: (size: number) => Buffer = randomBytes): string {
  return source(32).toString('base64url');
}

/** HMAC-SHA256 em hex do segredo; é só o que o banco guarda (nunca o segredo). */
export function invitationDigest(key: Buffer, secret: string): string {
  return createHmac('sha256', key).update(`company-invitation:${secret}`).digest('hex');
}

/** Compara dois digests em hex em tempo constante (tamanhos diferentes nunca conferem). */
export function digestsMatch(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'utf8');
  const actual = Buffer.from(actualHex, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Chave de cota no Redis: HMAC do valor (e-mail do destinatário ou id da conta convidadora) com a
 * mesma chave derivada. Nunca o e-mail nem o id em claro no Redis.
 */
export function invitationQuotaDigest(
  key: Buffer,
  kind: 'recipient' | 'account',
  value: string,
): string {
  return createHmac('sha256', key).update(`invite-quota:${kind}:${value}`).digest('hex');
}

export interface ParsedInvitationToken {
  readonly companyId: string;
  readonly invitationId: string;
  readonly secret: string;
}

/**
 * `<companyId>.<invitationId>.<segredo>`. O token **não é autoridade**: só acha a linha (por
 * `companyId` e `invitationId`); o HMAC do segredo é que autoriza. `null` para qualquer formato
 * inválido (ids que não são UUID, segredo fora de 43 caracteres base64url, partes a mais ou a menos).
 */
export function parseInvitationToken(token: string): ParsedInvitationToken | null {
  if (token.length > INVITATION_TOKEN_MAX_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [companyId, invitationId, secret] = parts as [string, string, string];
  if (!isUuid(companyId) || !isUuid(invitationId) || !SECRET_PATTERN.test(secret)) return null;
  return { companyId: companyId.toLowerCase(), invitationId: invitationId.toLowerCase(), secret };
}

export function buildInvitationToken(
  companyId: string,
  invitationId: string,
  secret: string,
): string {
  return `${companyId}.${invitationId}.${secret}`;
}

/** Link do e-mail: o token vai no fragmento (o navegador não o envia ao servidor nem em `Referer`). */
export function buildInvitationLink(appOrigin: string, token: string): string {
  return `${appOrigin}/convite#t=${token}`;
}
