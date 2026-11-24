import type { PlatformAdminId } from '../../domain/index.js';
import type { SecretString } from '../../shared/types/index.js';

/**
 * Cifra do segredo TOTP do administrador da plataforma (spec 044, E1). O texto cifrado é amarrado ao
 * `adminId` (AAD) e usa chaves próprias, distintas das credenciais do canal. `decrypt` lança
 * `CredentialDecryptionError` (mensagem fixa); o segredo e a chave nunca vão a log, erro nem métrica.
 */
export interface PlatformSecretCipher {
  encrypt(adminId: PlatformAdminId, plain: SecretString): string;
  decrypt(adminId: PlatformAdminId, stored: string): SecretString;
}
