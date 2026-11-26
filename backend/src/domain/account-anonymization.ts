/** Domínio do e-mail de uma conta anonimizada (`.invalid`, RFC 2606: nunca recebe e-mail). Spec 045, E6. */
export const ANONYMIZED_EMAIL_DOMAIN = 'excluido.invalid';

/** O e-mail que uma conta (e os vínculos dela) recebe ao ser removida por anonimização. */
export function anonymizedEmailFor(uuid: string): string {
  return `removida-${uuid}@${ANONYMIZED_EMAIL_DOMAIN}`;
}

/**
 * `true` se o e-mail é de uma conta já anonimizada. O cadastro público recusa o domínio `.invalid`
 * (`isAnonymizedEmailDomain`), então só a anonimização produz esse formato.
 */
export function isAnonymizedEmail(email: string): boolean {
  return email.startsWith('removida-') && isAnonymizedEmailDomain(email);
}

/** `true` se o e-mail é do domínio reservado às contas anonimizadas (qualquer parte local). */
export function isAnonymizedEmailDomain(email: string): boolean {
  return email.toLowerCase().endsWith(`@${ANONYMIZED_EMAIL_DOMAIN}`);
}
