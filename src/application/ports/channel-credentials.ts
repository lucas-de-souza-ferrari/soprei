import type { ClientId } from '../../domain/index.js';
import type { SecretString } from '../../shared/types/index.js';

/**
 * O que o envio precisa do cliente do job (spec 015): número, token e a versão do token. Lido do
 * banco **a cada envio**, pelo `clientId` do job; nada vem do payload do webhook.
 */
export type ChannelCredentialsResult =
  | {
      readonly kind: 'ready';
      readonly phoneNumberId: string;
      readonly token: SecretString;
      /** `legacy` = token global de transição (cliente sem conexão própria). */
      readonly tokenVersion: number | 'legacy';
    }
  /** A conexão do cliente está `TOKEN_INVALID`: nada é enviado até um novo `PUT`. */
  | { readonly kind: 'token_invalid' }
  /** Sem número ou sem token utilizável (cliente não conectado e sem token global). */
  | { readonly kind: 'none' };

export interface ChannelCredentials {
  /** Lança `NotFoundError` se o cliente não existe; `CredentialDecryptionError` se o texto não decifra. */
  forClient(clientId: ClientId): Promise<ChannelCredentialsResult>;
}
