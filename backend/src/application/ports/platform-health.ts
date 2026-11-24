/**
 * Contadores do processo que respondeu, desde o boot (spec 044, E2, D11): uma lista FIXA, só números e
 * resultados de conjuntos fechados (nenhum id, texto ou rótulo livre). Valem para este processo: com mais
 * de um processo por ambiente (spec 034, E4), mostram só o do HTTP.
 */
export interface PlatformProcessCounters {
  readonly attendanceFallbacks: number;
  readonly attendanceUnsentReplies: number;
  readonly channelSend: { readonly ok: number; readonly error: number };
  readonly queueJobsFailed: number;
  readonly processFatalErrors: number;
  readonly entitlementErrors: number;
  readonly usageMeterErrors: number;
  readonly billingNoticesFailed: number;
  /** Pedidos de contato comercial por resultado (conjunto fixo da spec 040). */
  readonly salesContactRequests: Readonly<Record<SalesContactResultName, number>>;
}

/** Os resultados de `sales_contact_requests_total` (spec 040), na ordem em que a Saúde os mostra. */
export const SALES_CONTACT_RESULTS = [
  'sent',
  'failed',
  'spam',
  'too_fast',
  'capped',
  'daily_cap',
  'invalid',
  'expired',
] as const;
export type SalesContactResultName = (typeof SALES_CONTACT_RESULTS)[number];
