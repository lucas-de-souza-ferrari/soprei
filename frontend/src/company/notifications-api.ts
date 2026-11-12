import { z } from 'zod';
import { request } from '../api';

/**
 * Contratos das notificações (spec 038). Estritos: a resposta **não pode** trazer `contactRef`,
 * `externalId`, texto de mensagem nem o id de quem resolveu (se o servidor voltar a mandá-los, a tela
 * falha em vez de exibir). Mensagens da tela vêm de `status` e `error.code` (ver `failureOf`).
 */
export const HANDOFF_REASONS = [
  'CONTACT_REQUESTED',
  'CANNOT_HELP',
  'COMPLAINT',
  'SENSITIVE',
  'OTHER',
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** Texto fixo do site para cada motivo (o servidor só manda o código). */
export const REASON_LABELS: Readonly<Record<HandoffReason, string>> = {
  CONTACT_REQUESTED: 'O contato pediu para falar com uma pessoa',
  CANNOT_HELP: 'A IA não conseguiu resolver o pedido',
  COMPLAINT: 'Reclamação ou insatisfação',
  SENSITIVE: 'Assunto urgente ou sensível',
  OTHER: 'Outro motivo',
};

export function reasonLabel(reason: HandoffReason | null): string {
  return reason === null ? REASON_LABELS.OTHER : REASON_LABELS[reason];
}

export const NOTIFICATIONS_PAGE_SIZE = 30;

const isoDate = z.iso.datetime();

export const notificationSchema = z.strictObject({
  id: z.uuid(),
  kind: z.literal('HUMAN_HANDOFF'),
  reason: z.enum(HANDOFF_REASONS).nullable(),
  status: z.enum(['OPEN', 'RESOLVED']),
  conversation: z
    .strictObject({
      id: z.uuid(),
      contactLabel: z.string().min(1).max(128),
      channel: z.enum(['whatsapp', 'simulator']),
    })
    .nullable(),
  createdAt: isoDate,
  resolvedAt: isoDate.nullable(),
  resolvedByMe: z.boolean(),
});
export type NotificationItem = z.infer<typeof notificationSchema>;

export const notificationsPageSchema = z.strictObject({
  items: z.array(notificationSchema).max(50),
  nextCursor: z.string().min(1).max(512).nullable(),
});

export const summarySchema = z.strictObject({ open: z.number().int().min(0) });

/** Pedido aberto numa conversa (vem no histórico da conversa). */
export const openHandoffSchema = z.strictObject({
  notificationId: z.uuid(),
  reason: z.enum(HANDOFF_REASONS).nullable(),
  createdAt: isoDate,
});
export type OpenHandoff = z.infer<typeof openHandoffSchema>;

const base = (companyId: string): string => `/admin/companies/${companyId}/notifications`;

export const notificationsApi = {
  summary: async (companyId: string) =>
    summarySchema.parse(await request(`${base(companyId)}/summary`)),
  list: async (
    companyId: string,
    params: { readonly status: 'open' | 'resolved'; readonly cursor?: string | undefined },
  ) => {
    const query = new URLSearchParams({
      status: params.status,
      limit: String(NOTIFICATIONS_PAGE_SIZE),
    });
    if (params.cursor !== undefined) query.set('cursor', params.cursor);
    return notificationsPageSchema.parse(await request(`${base(companyId)}?${query.toString()}`));
  },
  resolve: async (companyId: string, notificationId: string): Promise<void> => {
    await request(`${base(companyId)}/${encodeURIComponent(notificationId)}/resolve`, {
      method: 'POST',
      body: {},
    });
  },
};
