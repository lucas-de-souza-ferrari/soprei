/**
 * Formulário de contato comercial (spec 040, E4). Limites fixos, sem variável de ambiente: o número de
 * pedidos por IP fica no perfil de rate limit `contact` (config); estes são os tetos globais e os prazos do
 * token do formulário.
 */

/** Teto global de e-mails de contato comercial por dia (UTC); estourado, o pedido é descartado em silêncio. */
export const SALES_CONTACT_DAILY_CAP = 30;
/** Validade do contador diário no Redis (maior que um dia, para cobrir o dia inteiro em qualquer fuso). */
export const SALES_CONTACT_CAP_TTL_SECONDS = 48 * 3_600;
/** No máximo estes envios em andamento; passou disso, o pedido é descartado em silêncio. */
export const SALES_CONTACT_MAX_IN_FLIGHT = 10;
/** Tempo mínimo entre emitir o token e enviar o formulário (robôs enviam na hora). */
export const SALES_CONTACT_FORM_MIN_AGE_MS = 3_000;
/** Validade do token do formulário. */
export const SALES_CONTACT_FORM_MAX_AGE_MS = 2 * 3_600_000;

/** Faixas de empresas ou unidades (enum fechado; o texto do e-mail vem de uma tabela fixa). */
export const SALES_CONTACT_UNITS = ['1-10', '11-30', '31-100', '100+'] as const;
export type SalesContactUnits = (typeof SALES_CONTACT_UNITS)[number];

/** Faixas de volume mensal de mensagens. */
export const SALES_CONTACT_VOLUMES = [
  'ate-30-mil',
  '30-a-100-mil',
  '100-a-500-mil',
  'mais-de-500-mil',
  'nao-sei',
] as const;
export type SalesContactVolume = (typeof SALES_CONTACT_VOLUMES)[number];

/** Pedido já validado (os campos de texto já estão normalizados). */
export interface SalesContactRequest {
  readonly name: string;
  readonly email: string;
  readonly phone?: string | undefined;
  readonly companyName: string;
  readonly units: SalesContactUnits;
  readonly monthlyVolume: SalesContactVolume;
  readonly message: string;
}
