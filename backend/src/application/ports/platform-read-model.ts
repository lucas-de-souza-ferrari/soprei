import type {
  AccessStatus,
  CompanyId,
  CompanyStatus,
  HandoffReason,
  MembershipRole,
  PaymentOrderKindValue,
  PaymentOrderStatusValue,
  PlanCode,
  SubscriptionRecord,
  SubscriptionStatus,
} from '../../domain/index.js';
import type { BillingNoticeKind } from '../../domain/index.js';

/**
 * Leitura agregada do admin da plataforma (spec 044, E2, D6): a ÚNICA leitura que cruza empresas por
 * desenho. Só contagens, estados, datas, ids internos, nomes e slugs de empresa e, onde indicado, o e-mail
 * da conta. **Nunca** texto de mensagem, `contactRef`, `externalId`, persona, título ou texto de
 * documento, nome de produto ou de serviço, token, PIN nem referência de pagamento. A implementação fica
 * num módulo único de `infrastructure/database/` (SQL parametrizado e agregado, `statement_timeout`).
 */

/** Idade mínima para uma pendente (ou resposta não enviada) entrar em "precisa de atenção". */
export const PLATFORM_ATTENTION_MIN_AGE_MS = 5 * 60_000;
/** Até onde "precisa de atenção" olha para trás (janela limitada; spec: no máximo 30 dias). */
export const PLATFORM_ATTENTION_WINDOW_MS = 7 * 86_400_000;
/** Token do canal que vence em até isto entra em "precisa de atenção". */
export const PLATFORM_TOKEN_EXPIRY_SOON_MS = 7 * 86_400_000;
/** A maior janela de tempo de qualquer consulta do admin (spec 044, D6). */
export const PLATFORM_MAX_WINDOW_MS = 30 * 86_400_000;
/** `statement_timeout` de cada consulta agregada (spec 044): estourou, 503 sem detalhe. */
export const PLATFORM_READ_TIMEOUT_MS = 3_000;
/** Página das listas do admin: padrão e teto (spec 044). */
export const PLATFORM_LIST_DEFAULT_LIMIT = 30;
export const PLATFORM_LIST_MAX_LIMIT = 50;

/** Estado do canal de uma empresa (o mesmo conjunto do `GET .../channel` da spec 015). */
export type PlatformChannelState = 'NOT_CONNECTED' | 'CONNECTED' | 'TOKEN_INVALID' | 'LEGACY';
export type PlatformChannelMode = 'API_ONLY' | 'COEXISTENCE';

export interface PlatformPageRequest {
  readonly limit: number;
  /** Cursor opaco devolvido pela página anterior. */
  readonly cursor?: string | undefined;
}

export interface PlatformPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Volume do atendimento numa janela, somado entre empresas. */
export interface PlatformAttendanceVolume {
  readonly contactMessages: number;
  readonly replies: number;
  readonly fallbackReplies: number;
}

export interface PlatformAttentionCounts {
  /** Mensagens do contato sem resposta há mais de 5 min (IA não pausada, fora as ignoradas). */
  readonly stalledPending: number;
  /** Respostas sem `sentAt` há mais de 5 min, fora as de entrega incerta, em empresas com número. */
  readonly unsentReplies: number;
  /** Conexões do canal em `TOKEN_INVALID`. */
  readonly tokenInvalid: number;
  /** Conexões conectadas cujo token vence em até 7 dias. */
  readonly tokensExpiringSoon: number;
  /** Notificações de atendimento humano abertas. */
  readonly openHandoffs: number;
}

export interface PlatformOverviewFacts {
  readonly companies: { readonly active: number; readonly suspended: number };
  readonly accounts: {
    readonly total: number;
    readonly verified: number;
    readonly unverified: number;
    readonly disabled: number;
  };
  readonly channel: {
    readonly byState: Readonly<Record<PlatformChannelState, number>>;
    readonly byMode: Readonly<Record<PlatformChannelMode, number>>;
  };
  readonly attendance: {
    readonly last24h: PlatformAttendanceVolume;
    readonly last7d: PlatformAttendanceVolume;
  };
  readonly attention: PlatformAttentionCounts;
}

/**
 * Assinaturas agrupadas pelo que decide o estado efetivo (`resolveAccess`) e pelo plano: o serviço aplica
 * a regra do domínio a cada grupo, sem ler assinatura por assinatura.
 */
export interface PlatformSubscriptionGroup {
  readonly status: SubscriptionStatus;
  readonly cancelAtPeriodEnd: boolean;
  readonly planCode: PlanCode;
  /** `now < (trialEndsAt ?? currentPeriodEnd)`. */
  readonly trialOpen: boolean;
  /** `now < currentPeriodEnd`. */
  readonly periodOpen: boolean;
  /** `now < currentPeriodEnd + carência`. */
  readonly graceOpen: boolean;
  readonly count: number;
}

export interface PlatformBillingOverviewFacts {
  readonly subscriptions: readonly PlatformSubscriptionGroup[];
  readonly paidOrders: { readonly count: number; readonly amountCents: number };
}

/** O que decide o acesso de uma assinatura (sem id nem conta). */
export interface PlatformSubscriptionSnapshot {
  readonly planCode: PlanCode;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date;
  readonly trialEndsAt: Date | null;
  readonly cancelAtPeriodEnd: boolean;
}

export interface PlatformCompanyListFilter {
  readonly status?: CompanyStatus | undefined;
  /** Busca em nome e slug (até 64 caracteres, sem diferenciar maiúsculas). */
  readonly q?: string | undefined;
  /** Só empresas com este "precisa de atenção" (os mesmos critérios do overview). */
  readonly attention?: PlatformAttentionFilter | undefined;
}

/** Os itens de "precisa de atenção" que filtram a lista de empresas (cada um liga o overview à lista). */
export const PLATFORM_ATTENTION_FILTERS = [
  'pending_messages',
  'unsent_replies',
  'token_invalid',
  'token_expiring',
  'open_handoffs',
] as const;
export type PlatformAttentionFilter = (typeof PLATFORM_ATTENTION_FILTERS)[number];

export interface PlatformCompanyRow {
  readonly id: CompanyId;
  readonly name: string;
  readonly slug: string;
  readonly status: CompanyStatus;
  readonly createdAt: Date;
  /** Última atividade de conversa (o `updatedAt` mais recente); `null` sem conversa. */
  readonly lastActivityAt: Date | null;
  readonly channelState: PlatformChannelState;
  readonly activeMembers: number;
  /** Mensagens do contato nos últimos 7 dias. */
  readonly messages7d: number;
  /** Assinatura ligada à empresa; `null` sem assinatura (empresa anterior à cobrança). */
  readonly subscription: PlatformSubscriptionSnapshot | null;
}

/** Atendimento de UMA empresa numa janela. */
export interface PlatformCompanyAttendance {
  readonly activeConversations: number;
  readonly contactMessages: number;
  readonly replies: number;
  readonly fallbacks: number;
  readonly uncertainDeliveries: number;
  readonly handoffs: Readonly<Record<HandoffReason, number>>;
}

export interface PlatformChannelView {
  readonly state: PlatformChannelState;
  readonly mode: PlatformChannelMode | null;
  readonly phoneNumberId: string | null;
  readonly wabaId: string | null;
  readonly connectedAt: Date | null;
  readonly tokenExpiresAt: Date | null;
  readonly tokenInvalidAt: Date | null;
}

export interface PlatformCompanyDetailFacts {
  readonly company: {
    readonly id: CompanyId;
    readonly name: string;
    readonly slug: string;
    readonly status: CompanyStatus;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
  readonly subscriptionId: string | null;
  readonly memberships: readonly {
    readonly role: MembershipRole;
    readonly status: AccessStatus;
    readonly count: number;
  }[];
  /** A conta titular da assinatura da empresa, **sem e-mail**; `null` sem assinatura. */
  readonly holder: {
    readonly accountId: string;
    readonly emailVerified: boolean;
    readonly status: AccessStatus;
    readonly createdAt: Date;
  } | null;
  readonly channel: PlatformChannelView;
  readonly attendance: {
    readonly last24h: PlatformCompanyAttendance;
    readonly last7d: PlatformCompanyAttendance;
    readonly last30d: PlatformCompanyAttendance;
  };
  readonly attention: {
    readonly stalledPending: number;
    readonly unsentReplies: number;
    readonly openHandoffs: number;
  };
  readonly content: {
    readonly documents: number;
    readonly activeProducts: number;
    /** Reservas (não bloqueios) pendentes ou confirmadas nos próximos 7 dias. */
    readonly upcomingAppointments: number;
  };
}

/** Assinatura com o uso da janela atual (a mesma regra de quem mede: `currentWindowStart`). */
export interface PlatformSubscriptionFacts {
  readonly record: SubscriptionRecord;
  readonly windowStart: Date;
  readonly usage: {
    readonly tokens: number;
    readonly sentMessages: number;
    readonly extraReplies: number;
  };
}

export interface PlatformAccountListFilter {
  readonly status?: AccessStatus | undefined;
  readonly verified?: boolean | undefined;
}

export interface PlatformAccountRow {
  readonly id: string;
  /** Mascarado no próprio banco: primeira letra do nome e o domínio (`l***@exemplo.com`). */
  readonly emailMasked: string;
  readonly status: AccessStatus;
  readonly verified: boolean;
  readonly createdAt: Date;
  /** Empresas (não removidas) com vínculo desta conta. */
  readonly companies: number;
  readonly hasSubscription: boolean;
}

export interface PlatformAccountCompany {
  readonly id: CompanyId;
  readonly name: string;
  readonly slug: string;
  readonly status: CompanyStatus;
  readonly role: MembershipRole;
  readonly membershipStatus: AccessStatus;
}

export interface PlatformAccountDetailFacts {
  readonly id: string;
  /** E-mail completo (D7): só aqui, e cada leitura é auditada pelo serviço. */
  readonly email: string;
  readonly status: AccessStatus;
  readonly verified: boolean;
  readonly createdAt: Date;
  readonly companies: readonly PlatformAccountCompany[];
}

export interface PlatformOrderFilter {
  readonly status?: PaymentOrderStatusValue | undefined;
  readonly kind?: PaymentOrderKindValue | undefined;
}

export interface PlatformOrderRow {
  readonly id: string;
  readonly kind: PaymentOrderKindValue;
  readonly status: PaymentOrderStatusValue;
  readonly amountCents: number;
  readonly captureMethod: string | null;
  readonly createdAt: Date;
  readonly paidAt: Date | null;
  readonly expiresAt: Date;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly accountId: string;
}

export interface PlatformNoticeRow {
  readonly kind: BillingNoticeKind;
  readonly windowStart: Date;
  readonly createdAt: Date;
  readonly accountId: string;
}

/**
 * Porta da leitura agregada. Toda consulta: SQL parametrizado, colunas fixas, janelas de no máximo 30 dias
 * e `statement_timeout` de 3 s (estourou: `ServiceUnavailableError`). Id inexistente ou de empresa
 * removida: `null` (o serviço responde 404).
 */
export interface PlatformReadModel {
  overview(now: Date): Promise<PlatformOverviewFacts>;
  /** Só com a cobrança ligada. `monthStart`: início do mês corrente (o serviço decide o fuso). */
  billingOverview(
    now: Date,
    graceDays: number,
    monthStart: Date,
  ): Promise<PlatformBillingOverviewFacts>;
  listCompanies(
    filter: PlatformCompanyListFilter,
    page: PlatformPageRequest,
    now: Date,
  ): Promise<PlatformPage<PlatformCompanyRow>>;
  companyDetail(companyId: CompanyId, now: Date): Promise<PlatformCompanyDetailFacts | null>;
  /** Assinatura por id (da empresa) ou da conta, com o uso da janela atual; `null` se não existe. */
  subscription(
    by: { readonly subscriptionId: string } | { readonly accountId: string },
    now: Date,
  ): Promise<PlatformSubscriptionFacts | null>;
  listAccounts(
    filter: PlatformAccountListFilter,
    page: PlatformPageRequest,
  ): Promise<PlatformPage<PlatformAccountRow>>;
  accountDetail(accountId: string): Promise<PlatformAccountDetailFacts | null>;
  listOrders(
    filter: PlatformOrderFilter,
    page: PlatformPageRequest,
  ): Promise<PlatformPage<PlatformOrderRow>>;
  listNotices(
    filter: { readonly kind?: BillingNoticeKind | undefined },
    page: PlatformPageRequest,
  ): Promise<PlatformPage<PlatformNoticeRow>>;
}
