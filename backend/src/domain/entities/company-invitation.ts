import type { WithoutCompanyId } from '../repositories/tenant.repository.js';
import type { CompanyId } from '../value-objects/company-id.js';
import type { MembershipRole } from './membership.js';

export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** Papéis que um convite pode atribuir (spec 025, decisão 3): `OWNER` nunca é convidável. */
export const INVITABLE_ROLES = ['ADMIN', 'AGENT', 'VIEWER'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// Prazos e cotas (spec 025, decisões 5, 6, 7 e 16): constantes, não variáveis de ambiente.
/** Validade do link a partir da criação ou do último reenvio. */
export const INVITATION_VALIDITY_DAYS = 7;
export const INVITATION_VALIDITY_MS = INVITATION_VALIDITY_DAYS * DAY_MS;
/** O e-mail do convidado pendente é apagado por expurgo este tempo depois do vencimento. */
export const INVITATION_EXPIRY_GRACE_MS = 7 * DAY_MS;
/** Intervalo mínimo entre dois envios do mesmo convite. */
export const INVITATION_RESEND_INTERVAL_MS = MINUTE_MS;
/** Máximo de envios (o primeiro mais os reenvios) por convite. */
export const INVITATION_MAX_SENDS = 6;
/** Convites pendentes (não vencidos) por empresa. */
export const INVITATION_MAX_PENDING = 20;
/** Janela das cotas de envio. */
export const INVITATION_QUOTA_WINDOW_MS = DAY_MS;
/** Envios (criar e reenviar) por empresa e por convidador (vínculo) na janela. */
export const INVITATION_COMPANY_SENDS_PER_DAY = 30;
export const INVITATION_INVITER_SENDS_PER_DAY = 20;
/** Envios por conta convidadora, somando todas as empresas (Redis), na janela. */
export const INVITATION_ACCOUNT_SENDS_PER_DAY = 50;
/** E-mails ao mesmo destinatário, somando todas as empresas (Redis), na janela. */
export const INVITATION_RECIPIENT_EMAILS_PER_DAY = 3;

/**
 * Convite por e-mail (model de tenant, spec 025). `email` e `tokenHash` existem só enquanto
 * `PENDING` (o banco os anula ao fechar). O e-mail é dado pessoal: nunca em log, métrica, auditoria
 * nem mensagem de erro.
 */
export interface CompanyInvitation {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly email: string | null;
  readonly role: MembershipRole;
  readonly status: InvitationStatus;
  readonly tokenHash: string | null;
  /**
   * Quem convidou (spec 045, E3b): exatamente um dos dois (CHECK no banco). O vínculo da empresa (025) ou o
   * administrador da plataforma (que também pode convidar `OWNER`).
   */
  readonly invitedByMembershipId: string | null;
  readonly invitedByAdminId: string | null;
  readonly acceptedMembershipId: string | null;
  readonly expiresAt: Date;
  readonly lastSentAt: Date;
  readonly sendCount: number;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
}

/** Quem convida: um vínculo da empresa (025) ou o administrador da plataforma (spec 045, E3b). */
export type InvitationInviter =
  | { readonly invitedByMembershipId: string; readonly invitedByAdminId?: never }
  | { readonly invitedByAdminId: string; readonly invitedByMembershipId?: never };

/** Dados de criação; sem `companyId` (vem do parâmetro do repositório). */
export type NewCompanyInvitation = WithoutCompanyId &
  InvitationInviter & {
    readonly email: string;
    readonly role: MembershipRole;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    /** Instante da criação (e do primeiro envio). */
    readonly now: Date;
  };

export interface InvitationRenewal {
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly lastSentAt: Date;
}

export interface InvitationClosing {
  readonly status: Exclude<InvitationStatus, 'PENDING'>;
  readonly closedAt: Date;
  /** Obrigatório (e só aceito) em `ACCEPTED`. */
  readonly acceptedMembershipId?: string;
}
