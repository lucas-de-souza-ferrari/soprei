/**
 * Versão do formato de sessão e de token (spec 022, renome do domínio: empresa e vínculo).
 * Trocar a versão torna INALCANÇÁVEL tudo o que foi gravado no formato antigo: o token antigo falha
 * na audiência (401) e a sessão antiga (com os campos de antes do renome) fica sob um prefixo
 * que o código novo nunca lê, então expira sozinha pelos TTL em vez de falhar na validação e virar 503.
 * O formato antigo teve duas formas (sem segmento, e `v2:` com as contas globais): `v3` é novo nas duas.
 *
 * A separação por modo da spec 017 continua: com `ACCOUNTS_ENABLED` ligado vale `v3`; desligado,
 * `v3-legacy`. Uma sessão ou token de um modo nunca vale no outro (a troca de modo invalida tudo).
 */
export const AUTH_VERSION = 'v3';
const LEGACY_MODE_VERSION = 'v3-legacy';

const versionOf = (accountsEnabled: boolean): string =>
  accountsEnabled ? AUTH_VERSION : LEGACY_MODE_VERSION;

/** Segmento entre o prefixo configurado e o resto da chave (`<prefixo>v3:<escopo>:...`). */
export function versionedAuthPrefix(configuredPrefix: string, accountsEnabled: boolean): string {
  return `${configuredPrefix}${versionOf(accountsEnabled)}:`;
}

/** Audiência do access token: `JWT_AUDIENCE:v3`. Um token de outra versão ou modo é recusado pela `jose`. */
export function versionedAudience(configuredAudience: string, accountsEnabled: boolean): string {
  return `${configuredAudience}:${versionOf(accountsEnabled)}`;
}
