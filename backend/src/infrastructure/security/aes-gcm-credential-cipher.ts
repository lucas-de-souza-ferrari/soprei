import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { CredentialCipher } from '../../application/ports/credential-cipher.js';
import type { CompanyId } from '../../domain/index.js';
import {
  CredentialDecryptionError,
  type CredentialDecryptionReason,
} from '../../shared/errors/index.js';
import { SecretString } from '../../shared/types/index.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';
export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

export interface CredentialKey {
  readonly keyId: string;
  readonly key: Buffer;
}

export type ParsedKeys =
  | { readonly ok: true; readonly keys: readonly CredentialKey[] }
  | { readonly ok: false; readonly message: string };

/**
 * Lê `CHANNEL_CREDENTIALS_KEYS` (`keyId:<32 bytes em base64url>`, separadas por vírgula). A mensagem
 * de erro **nunca** inclui o valor da chave.
 */
export function parseCredentialKeys(raw: string): ParsedKeys {
  const keys: CredentialKey[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    if (separator < 1) return { ok: false, message: 'cada chave deve ser keyId:<base64url>' };
    const keyId = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    if (!KEY_ID_PATTERN.test(keyId)) {
      return { ok: false, message: 'keyId deve casar com ^[A-Za-z0-9_-]{1,16}$' };
    }
    if (seen.has(keyId)) return { ok: false, message: 'keyId repetido' };
    seen.add(keyId);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
      return { ok: false, message: `a chave "${keyId}" não é base64url` };
    }
    const key = Buffer.from(encoded, 'base64url');
    if (key.length !== KEY_BYTES) {
      return { ok: false, message: `a chave "${keyId}" deve ter exatamente 32 bytes` };
    }
    keys.push({ keyId, key });
  }
  return { ok: true, keys };
}

function aad(companyId: CompanyId, keyId: string): Buffer {
  return Buffer.from(`${companyId}|${keyId}`, 'utf8');
}

/**
 * AES-256-GCM (spec 015): IV aleatório de 12 bytes por cifra, tag de 16 bytes, formato
 * `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url). A AAD é `companyId|keyId`. Chaves com `keyId`:
 * a ativa cifra, todas decifram (rotação).
 */
export class AesGcmCredentialCipher implements CredentialCipher {
  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly active: CredentialKey;

  constructor(keys: readonly CredentialKey[], activeKeyId: string) {
    this.keys = new Map(keys.map((entry) => [entry.keyId, entry.key]));
    const active = keys.find((entry) => entry.keyId === activeKeyId);
    if (active === undefined) throw new Error('chave ativa de credenciais ausente da lista');
    this.active = active;
  }

  encrypt(companyId: CompanyId, plain: SecretString): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.active.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(companyId, this.active.keyId));
    const body = Buffer.concat([cipher.update(plain.reveal(), 'utf8'), cipher.final()]);
    return [
      VERSION,
      this.active.keyId,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      body.toString('base64url'),
    ].join('.');
  }

  decrypt(companyId: CompanyId, stored: string): SecretString {
    const parts = stored.split('.');
    const [version, keyId, ivText, tagText, bodyText] = parts;
    if (
      parts.length !== 5 ||
      version !== VERSION ||
      keyId === undefined ||
      ivText === undefined ||
      tagText === undefined ||
      bodyText === undefined
    ) {
      throw fail('malformed');
    }
    const key = this.keys.get(keyId);
    if (key === undefined) throw fail('unknown_key');
    const iv = Buffer.from(ivText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw fail('malformed');
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(companyId, keyId));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(Buffer.from(bodyText, 'base64url')),
        decipher.final(),
      ]);
      return new SecretString(plain.toString('utf8'));
    } catch {
      throw fail('tampered');
    }
  }
}

function fail(reason: CredentialDecryptionReason): CredentialDecryptionError {
  return new CredentialDecryptionError(reason);
}
