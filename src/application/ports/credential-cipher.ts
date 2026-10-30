import type { ClientId } from '../../domain/index.js';
import type { SecretString } from '../../shared/types/index.js';

/**
 * Cifra de credenciais guardadas (spec 015). O texto cifrado é amarrado ao `clientId` (AAD): copiado
 * para a linha de outro cliente, não decifra. `decrypt` lança `CredentialDecryptionError` (mensagem
 * fixa, sem o texto cifrado nem a chave). O `plain` e a chave nunca vão a log, erro nem métrica.
 */
export interface CredentialCipher {
  encrypt(clientId: ClientId, plain: SecretString): string;
  decrypt(clientId: ClientId, stored: string): SecretString;
}
