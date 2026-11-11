import type { ListOptions, Page } from './pagination.js';
import type { CompanyId } from './value-objects/company-id.js';

/**
 * Notificações do painel (spec 030). Hoje há um tipo só, `HUMAN_HANDOFF`: a IA reconheceu, no
 * atendimento, que a conversa precisa de uma pessoa da equipe. O estado é **da empresa** (não por
 * pessoa): aberta até alguém da equipe marcar como resolvida. Nunca guarda texto de mensagem.
 */
export const NOTIFICATION_KINDS = ['HUMAN_HANDOFF'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_STATUSES = ['OPEN', 'RESOLVED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * Motivos fixos do pedido de atendimento humano. Lista fechada de propósito: o modelo nunca escreve
 * texto livre aqui (seria dado pessoal e vetor de injeção).
 */
export const HANDOFF_REASONS = [
  'CONTACT_REQUESTED',
  'CANNOT_HELP',
  'COMPLAINT',
  'SENSITIVE',
  'OTHER',
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export function isHandoffReason(value: unknown): value is HandoffReason {
  return (HANDOFF_REASONS as readonly unknown[]).includes(value);
}

/** Teto de notificações abertas por empresa: acima disso, nenhuma nova é criada (métrica `capped`). */
export const NOTIFICATION_MAX_OPEN = 500;

export interface Notification {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly kind: NotificationKind;
  /** Só em `HUMAN_HANDOFF` (o banco exige). */
  readonly reason: HandoffReason | null;
  readonly conversationId: string;
  /** A resposta do assistente que gerou a notificação. */
  readonly messageId: string;
  readonly status: NotificationStatus;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  /** Nunca sai em resposta da API: a rota devolve só `resolvedByMe`. */
  readonly resolvedByMembershipId: string | null;
}

export interface NewHandoffNotification {
  readonly reason: HandoffReason;
  readonly conversationId: string;
  readonly messageId: string;
  readonly createdAt: Date;
}

/** `created`: gravada; `deduplicated`: a conversa já tinha uma aberta; `capped`: teto da empresa. */
export type NotificationCreateResult = 'created' | 'deduplicated' | 'capped';

export type NotificationStatusFilter = 'open' | 'resolved' | 'all';

/** Notificação aberta de uma conversa, para o painel de conversas. */
export interface OpenHandoff {
  readonly notificationId: string;
  readonly reason: HandoffReason | null;
  readonly createdAt: Date;
}

/** `resolved`: esta chamada resolveu; `already`: já estava resolvida (idempotente). */
export type NotificationResolveResult = 'resolved' | 'already';

/**
 * Repositório de notificações (model de tenant): `CompanyId` primeiro em todo método; id de outra
 * empresa se comporta como inexistente.
 */
export interface NotificationRepository {
  /**
   * Cria a notificação de atendimento humano, salvo se a conversa já tem uma aberta (unicidade parcial
   * no banco decide a corrida) ou se a empresa atingiu `maxOpen` abertas.
   */
  createHandoff(
    companyId: CompanyId,
    data: NewHandoffNotification,
    maxOpen: number,
  ): Promise<NotificationCreateResult>;
  list(
    companyId: CompanyId,
    status: NotificationStatusFilter,
    options?: ListOptions,
  ): Promise<Page<Notification>>;
  countOpen(companyId: CompanyId): Promise<number>;
  /** Lança `NotFoundError` se o id não existe na empresa (inclusive id malformado). */
  resolve(
    companyId: CompanyId,
    id: string,
    membershipId: string,
    now: Date,
  ): Promise<NotificationResolveResult>;
  /** Abertas por conversa, em lote (sem N+1); conversas sem aberta não aparecem no mapa. */
  openHandoffsByConversation(
    companyId: CompanyId,
    conversationIds: readonly string[],
  ): Promise<ReadonlyMap<string, OpenHandoff>>;
}
