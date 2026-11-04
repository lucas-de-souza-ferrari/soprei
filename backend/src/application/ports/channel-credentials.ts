import type { CompanyId } from '../../domain/index.js';
import type { SecretString } from '../../shared/types/index.js';

/**
 * O que o envio precisa da empresa do job (spec 015): número, token e a versão do token. Lido do
 * banco **a cada envio**, pelo `companyId` do job; nada vem do payload do webhook.
 */
export type ChannelCredentialsResult =
  | {
      readonly kind: 'ready';
      readonly phoneNumberId: string;
      readonly token: SecretString;
      /** `legacy` = token global de transição (empresa sem conexão própria). */
      readonly tokenVersion: number | 'legacy';
    }
  /** A conexão da empresa está `TOKEN_INVALID`: nada é enviado até um novo `PUT`. */
  | { readonly kind: 'token_invalid' }
  /** Sem número ou sem token utilizável (empresa não conectado e sem token global). */
  | { readonly kind: 'none' };

export interface ChannelCredentials {
  /** Lança `NotFoundError` se a empresa não existe; `CredentialDecryptionError` se o texto não decifra. */
  forCompany(companyId: CompanyId): Promise<ChannelCredentialsResult>;
}
