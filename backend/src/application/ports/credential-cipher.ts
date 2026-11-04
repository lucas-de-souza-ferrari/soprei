import type { CompanyId } from '../../domain/index.js';
import type { SecretString } from '../../shared/types/index.js';

/**
 * Cifra de credenciais guardadas (spec 015). O texto cifrado é amarrado ao `companyId` (AAD): copiado
 * para a linha de outra empresa, não decifra. `decrypt` lança `CredentialDecryptionError` (mensagem
 * fixa, sem o texto cifrado nem a chave). O `plain` e a chave nunca vão a log, erro nem métrica.
 */
export interface CredentialCipher {
  encrypt(companyId: CompanyId, plain: SecretString): string;
  decrypt(companyId: CompanyId, stored: string): SecretString;
}
