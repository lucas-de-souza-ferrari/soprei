import { createHash } from 'node:crypto';
import type { CompanyId } from '../../domain/index.js';

/** `contactRef` fixo da caixa "Testar o atendimento" do site (spec 023). */
export const SITE_TEST_CONTACT_REF = 'teste-no-site';

export type ContactChannel = 'whatsapp' | 'simulator';

export interface ContactDescription {
  /** Rótulo seguro para exibir: nunca o telefone inteiro nem o texto livre do `contactRef`. */
  readonly contactLabel: string;
  readonly channel: ContactChannel;
}

/** Telefone: só dígitos, `+`, espaços, hífen e parênteses, com 8 a 15 dígitos (spec 024). */
const PHONE_SHAPE = /^[+\d\s()-]+$/;
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;
const VISIBLE_DIGITS = 4;

/** O `contactRef` tem forma de telefone, isto é, a conversa é do canal e não do simulador? */
export function isPhoneContactRef(contactRef: string): boolean {
  if (contactRef === SITE_TEST_CONTACT_REF || !PHONE_SHAPE.test(contactRef)) return false;
  const digits = contactRef.replace(/\D/gu, '');
  return digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS;
}

/**
 * Máscara do contato, feita no servidor (spec 024): o `contactRef` do canal real é o telefone do
 * contato e **nunca** deve chegar ao navegador. Telefone vira `Contato final 1234` (canal
 * `whatsapp`); o contato fixo do teste do site vira `Teste no site`; qualquer outro texto livre
 * vira `Simulador a1b2` (4 hexadecimais do SHA-256 de `companyId:contactRef`, só para distinguir
 * conversas; o texto nunca aparece). Heurística: falha para o lado seguro (numérico = `whatsapp`).
 */
export function describeContact(companyId: CompanyId, contactRef: string): ContactDescription {
  if (contactRef === SITE_TEST_CONTACT_REF) {
    return { contactLabel: 'Teste no site', channel: 'simulator' };
  }
  if (PHONE_SHAPE.test(contactRef)) {
    const digits = contactRef.replace(/\D/gu, '');
    if (digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS) {
      return {
        contactLabel: `Contato final ${digits.slice(-VISIBLE_DIGITS)}`,
        channel: 'whatsapp',
      };
    }
  }
  const hash = createHash('sha256').update(`${companyId}:${contactRef}`).digest('hex').slice(0, 4);
  return { contactLabel: `Simulador ${hash}`, channel: 'simulator' };
}
