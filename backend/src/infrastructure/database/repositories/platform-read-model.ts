import type {
  PlatformAccountDetailFacts,
  PlatformAccountListFilter,
  PlatformAccountRow,
  PlatformBillingOverviewFacts,
  PlatformChannelMode,
  PlatformChannelState,
  PlatformChannelView,
  PlatformCompanyAttendance,
  PlatformCompanyDetailFacts,
  PlatformCompanyListFilter,
  PlatformCompanyRow,
  PlatformNoticeRow,
  PlatformOrderFilter,
  PlatformOrderRow,
  PlatformOverviewFacts,
  PlatformPage,
  PlatformPageRequest,
  PlatformAttentionFilter,
  PlatformReadModel,
  PlatformSubscriptionFacts,
} from '../../../application/ports/platform-read-model.js';
import { SITE_TEST_CONTACT_REF } from '../../../application/attendance/contact-label.js';
import {
  PLATFORM_ATTENTION_MIN_AGE_MS,
  PLATFORM_ATTENTION_WINDOW_MS,
  PLATFORM_MAX_WINDOW_MS,
  PLATFORM_READ_TIMEOUT_MS,
  PLATFORM_TOKEN_EXPIRY_SOON_MS,
} from '../../../application/ports/platform-read-model.js';
import {
  type AccessStatus,
  type BillingNoticeKind,
  CompanyId,
  type CompanyStatus,
  HANDOFF_REASONS,
  type HandoffReason,
  type MembershipRole,
  type PaymentOrderKindValue,
  type PaymentOrderStatusValue,
  type PlanCode,
  type SubscriptionStatus,
} from '../../../domain/index.js';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  DatabaseError,
  ServiceUnavailableError,
  ValidationError,
} from '../../../shared/errors/index.js';
import { isUuid } from '../../../shared/utils/index.js';
import type { TenantScopedDb, TenantScopedPrisma } from '../extensions/tenant-scope.js';
import {
  currentWindowStart,
  findSubscriptionByAccount,
  findSubscriptionById,
} from './billing.repository.js';
import { withStatementTimeout } from './knowledge-retriever.js';
import { withRepositoryErrors } from './repository-errors.js';

/*
 * Leitura agregada do admin da plataforma (spec 044, E2, D6). É o ÚNICO módulo que lê dados de várias
 * empresas numa consulta, e o único SQL cru novo da spec. Regras deste arquivo (o teste
 * `platform-read-model.columns.test.ts` confere parte delas):
 *
 * - toda consulta é parametrizada (`$queryRaw` com template: nenhum valor concatenado) e lê uma lista
 *   fixa de colunas: ids, estados, datas, contagens, nome e slug de EMPRESA e, só em `accountDetail`, o
 *   e-mail da conta (D7). Nenhuma coluna de conteúdo é citada (texto de mensagem, contato, persona,
 *   documento, produto, serviço, token, PIN, referência de pagamento);
 * - o detalhe de uma empresa filtra `company_id = $id` em TODA consulta (inclusive nas junções);
 * - janelas de tempo limitadas a 30 dias e apoiadas nos índices existentes, SEMPRE por empresa: as
 *   consultas que somam várias empresas partem de `companies co` e descem por empresa (`CROSS JOIN
 *   LATERAL` ou subconsulta com `company_id = co.id`), às conversas com `updated_at` na janela
 *   (`(company_id, updated_at, id)`; o `updated_at` acompanha a última mensagem, spec 024) e delas às
 *   mensagens pelo índice `(company_id, conversation_id, created_at, id)`. Nada filtra só por data numa
 *   tabela inteira (`messages.created_at` não tem índice próprio; revisão da E2, I1);
 * - "precisa de atenção" (pendentes paradas e respostas não enviadas) tem UMA definição, em
 *   `stalledPendingFrom` e `unsentRepliesFrom`, usada pelo overview, pelo filtro da lista e pelo
 *   detalhe: só empresa ATIVA e nunca a conversa do "Testar" do site, a única citação de `contact_ref`
 *   (comparada com o parâmetro `SITE_TEST_CONTACT_REF`; nunca lida nem devolvida; revisão da E2, I2);
 * - cada chamada roda numa transação curta com `statement_timeout` de 3 s; estourou (ou o banco caiu),
 *   `ServiceUnavailableError` (503) sem detalhe.
 *
 * Datas: as colunas `timestamp` sem fuso guardam o instante em UTC (padrão do Prisma); as comparações usam
 * `utc(date)` e as leituras `AT TIME ZONE 'UTC'`, para o resultado não depender do fuso da sessão.
 */

const DAY_MS = 86_400_000;

/** Parâmetro de data para coluna `timestamp` (sem fuso, em UTC). */
function utc(date: Date): Prisma.Sql {
  return Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** Parâmetro de data para coluna `timestamptz`. */
function tz(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz`;
}

function since(now: Date, ms: number): Date {
  return new Date(now.getTime() - Math.min(ms, PLATFORM_MAX_WINDOW_MS));
}

/** Cursor opaco das listas: o id da última linha (ordem `id DESC`; os ids são UUID v7, crescentes no tempo). */
export function encodePlatformCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodePlatformCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!isUuid(id)) throw new ValidationError('Cursor inválido');
  return id.toLowerCase();
}

function afterCursor(column: Prisma.Sql, page: PlatformPageRequest): Prisma.Sql {
  return page.cursor === undefined
    ? Prisma.empty
    : Prisma.sql`AND ${column} < ${decodePlatformCursor(page.cursor)}::uuid`;
}

function toPage<TRow extends { readonly id: string }, T>(
  rows: readonly TRow[],
  limit: number,
  map: (row: TRow) => T,
): PlatformPage<T> {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(map),
    nextCursor: rows.length > limit && last !== undefined ? encodePlatformCursor(last.id) : null,
  };
}

function channelState(connectionStatus: string | null, hasNumber: boolean): PlatformChannelState {
  if (connectionStatus === 'CONNECTED' || connectionStatus === 'TOKEN_INVALID') {
    return connectionStatus;
  }
  return hasNumber ? 'LEGACY' : 'NOT_CONNECTED';
}

/** `COUNT(...)::int` chega como `number`; somas grandes como `bigint`. */
function num(value: number | bigint | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function emptyHandoffs(): Record<HandoffReason, number> {
  return Object.fromEntries(HANDOFF_REASONS.map((reason) => [reason, 0])) as Record<
    HandoffReason,
    number
  >;
}

/**
 * `FROM ... WHERE ...` das mensagens do contato paradas sem resposta numa empresa (`company` é a expressão
 * do id: `co.id` ou o parâmetro do detalhe). Mesma regra da retomada (spec 035): IA não pausada, fora o
 * que a equipe tratou pelo celular (`ai_ignore_before`) e fora o "Testar" do site. Quem chama exige a
 * empresa ATIVA (suspensa não é atendida nem retomada: o que fica parado nela não é alarme).
 */
function stalledPendingFrom(company: Prisma.Sql, now: Date): Prisma.Sql {
  const attentionSince = since(now, PLATFORM_ATTENTION_WINDOW_MS);
  const stalledBefore = new Date(now.getTime() - PLATFORM_ATTENTION_MIN_AGE_MS);
  return Prisma.sql`
      FROM conversations c
      JOIN messages m ON m.company_id = c.company_id AND m.conversation_id = c.id
     WHERE c.company_id = ${company}
       AND m.company_id = ${company}
       AND c.updated_at >= ${utc(attentionSince)}
       AND c.contact_ref <> ${SITE_TEST_CONTACT_REF}
       AND m.role = 'USER'
       AND m.answered_by_id IS NULL
       AND m.created_at >= ${utc(attentionSince)}
       AND m.created_at < ${utc(stalledBefore)}
       AND (c.ai_paused_until IS NULL OR c.ai_paused_until <= ${utc(now)})
       AND (c.ai_ignore_before IS NULL OR m.created_at > c.ai_ignore_before)`;
}

/**
 * `FROM ... WHERE ...` das respostas da IA que não saíram numa empresa. O "Testar" do site nunca envia
 * pelo canal (a resposta volta na tela, sem `sent_at`), então a conversa dele não conta (revisão da E2,
 * I2). Quem chama exige a empresa ATIVA e com número.
 */
function unsentRepliesFrom(company: Prisma.Sql, now: Date): Prisma.Sql {
  const attentionSince = since(now, PLATFORM_ATTENTION_WINDOW_MS);
  const stalledBefore = new Date(now.getTime() - PLATFORM_ATTENTION_MIN_AGE_MS);
  return Prisma.sql`
      FROM conversations c
      JOIN messages m ON m.company_id = c.company_id AND m.conversation_id = c.id
     WHERE c.company_id = ${company}
       AND m.company_id = ${company}
       AND c.updated_at >= ${utc(attentionSince)}
       AND c.contact_ref <> ${SITE_TEST_CONTACT_REF}
       AND m.role = 'ASSISTANT'
       AND m.sent_at IS NULL
       AND m.delivery_uncertain_at IS NULL
       AND m.created_at >= ${utc(attentionSince)}
       AND m.created_at < ${utc(stalledBefore)}`;
}

/**
 * Filtro "precisa de atenção" da lista de empresas: os MESMOS critérios do overview, por empresa
 * (`company_id = co.id` em toda subconsulta; `co` e `cc` são os aliases da consulta da lista).
 */
function attentionFilter(attention: PlatformAttentionFilter | undefined, now: Date): Prisma.Sql {
  if (attention === undefined) return Prisma.empty;
  switch (attention) {
    case 'pending_messages':
      return Prisma.sql`AND co.status = 'ACTIVE'
        AND EXISTS (SELECT 1 ${stalledPendingFrom(Prisma.sql`co.id`, now)})`;
    case 'unsent_replies':
      return Prisma.sql`AND co.status = 'ACTIVE' AND co.whatsapp_phone_number_id IS NOT NULL
        AND EXISTS (SELECT 1 ${unsentRepliesFrom(Prisma.sql`co.id`, now)})`;
    case 'token_invalid':
      return Prisma.sql`AND cc.status = 'TOKEN_INVALID'`;
    case 'token_expiring':
      return Prisma.sql`AND cc.status = 'CONNECTED'
        AND cc.token_expires_at >= ${utc(now)}
        AND cc.token_expires_at < ${utc(new Date(now.getTime() + PLATFORM_TOKEN_EXPIRY_SOON_MS))}`;
    case 'open_handoffs':
      return Prisma.sql`AND EXISTS (
        SELECT 1 FROM notifications n
         WHERE n.company_id = co.id AND n.status = 'OPEN' AND n.kind = 'HUMAN_HANDOFF')`;
  }
}

interface CompanyListSqlRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: CompanyStatus;
  readonly created_at: Date;
  readonly last_activity_at: Date | null;
  readonly connection_status: string | null;
  readonly has_number: boolean;
  readonly active_members: number;
  readonly messages_7d: number;
  readonly plan_code: PlanCode | null;
  readonly sub_status: SubscriptionStatus | null;
  readonly current_period_end: Date | null;
  readonly trial_ends_at: Date | null;
  readonly cancel_at_period_end: boolean | null;
}

interface AttendanceSqlRow {
  readonly conv_24h: number;
  readonly conv_7d: number;
  readonly conv_30d: number;
  readonly contact_24h: number;
  readonly contact_7d: number;
  readonly contact_30d: number;
  readonly replies_24h: number;
  readonly replies_7d: number;
  readonly replies_30d: number;
  readonly fallback_24h: number;
  readonly fallback_7d: number;
  readonly fallback_30d: number;
  readonly uncertain_24h: number;
  readonly uncertain_7d: number;
  readonly uncertain_30d: number;
}

/**
 * `PlatformReadModel` sobre o Postgres. Ver o comentário do topo do arquivo: SQL parametrizado e agregado,
 * colunas fixas, janelas limitadas e `statement_timeout` de 3 s.
 */
export class PrismaPlatformReadModel implements PlatformReadModel {
  constructor(
    private readonly prisma: TenantScopedPrisma,
    private readonly timeoutMs: number = PLATFORM_READ_TIMEOUT_MS,
  ) {}

  /** Uma transação curta sob `statement_timeout`; qualquer falha do banco vira 503 sem detalhe. */
  private async read<T>(operation: string, fn: (db: TenantScopedDb) => Promise<T>): Promise<T> {
    try {
      return await withRepositoryErrors(operation, () =>
        withStatementTimeout(this.prisma, this.timeoutMs, fn),
      );
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw new ServiceUnavailableError('Leitura do admin indisponível', {
          cause: error,
          context: { operation },
        });
      }
      throw error;
    }
  }

  overview(now: Date): Promise<PlatformOverviewFacts> {
    return this.read('PlatformRead.overview', async (db) => {
      const s24 = since(now, DAY_MS);
      const s7 = since(now, 7 * DAY_MS);
      const expiringUntil = new Date(now.getTime() + PLATFORM_TOKEN_EXPIRY_SOON_MS);

      const companies = await db.$queryRaw<{ status: CompanyStatus; n: number }[]>`
        SELECT co.status::text AS status, COUNT(*)::int AS n
          FROM companies co
         WHERE co.deleted_at IS NULL
         GROUP BY co.status`;

      const [accounts] = await db.$queryRaw<
        { total: number; verified: number; unverified: number; disabled: number }[]
      >`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE a.email_verified_at IS NOT NULL)::int AS verified,
               COUNT(*) FILTER (WHERE a.email_verified_at IS NULL)::int AS unverified,
               COUNT(*) FILTER (WHERE a.status = 'DISABLED')::int AS disabled
          FROM accounts a`;

      const [channel] = await db.$queryRaw<
        {
          not_connected: number;
          legacy: number;
          connected: number;
          token_invalid: number;
          api_only: number;
          coexistence: number;
          expiring: number;
        }[]
      >`
        SELECT COUNT(*) FILTER (WHERE cc.id IS NULL AND co.whatsapp_phone_number_id IS NULL)::int AS not_connected,
               COUNT(*) FILTER (WHERE cc.id IS NULL AND co.whatsapp_phone_number_id IS NOT NULL)::int AS legacy,
               COUNT(*) FILTER (WHERE cc.status = 'CONNECTED')::int AS connected,
               COUNT(*) FILTER (WHERE cc.status = 'TOKEN_INVALID')::int AS token_invalid,
               COUNT(*) FILTER (WHERE cc.mode = 'API_ONLY')::int AS api_only,
               COUNT(*) FILTER (WHERE cc.mode = 'COEXISTENCE')::int AS coexistence,
               COUNT(*) FILTER (WHERE cc.status = 'CONNECTED'
                                  AND cc.token_expires_at >= ${utc(now)}
                                  AND cc.token_expires_at < ${utc(expiringUntil)})::int AS expiring
          FROM companies co
          LEFT JOIN channel_connections cc ON cc.company_id = co.id
         WHERE co.deleted_at IS NULL`;

      // Por empresa (revisão da E2, I1): `companies` -> conversas na janela -> mensagens, sempre pelos
      // índices que começam por `company_id`; os totais são a soma das empresas não removidas.
      const [volume] = await db.$queryRaw<
        {
          contact_24h: number;
          replies_24h: number;
          fallback_24h: number;
          contact_7d: number;
          replies_7d: number;
          fallback_7d: number;
        }[]
      >`
        SELECT COALESCE(SUM(v.contact_24h), 0)::int AS contact_24h,
               COALESCE(SUM(v.replies_24h), 0)::int AS replies_24h,
               COALESCE(SUM(v.fallback_24h), 0)::int AS fallback_24h,
               COALESCE(SUM(v.contact_7d), 0)::int AS contact_7d,
               COALESCE(SUM(v.replies_7d), 0)::int AS replies_7d,
               COALESCE(SUM(v.fallback_7d), 0)::int AS fallback_7d
          FROM companies co
          CROSS JOIN LATERAL (
            SELECT COUNT(*) FILTER (WHERE m.role = 'USER' AND m.created_at >= ${utc(s24)}) AS contact_24h,
                   COUNT(*) FILTER (WHERE m.role = 'ASSISTANT' AND m.created_at >= ${utc(s24)}) AS replies_24h,
                   COUNT(*) FILTER (WHERE m.role = 'ASSISTANT' AND m.is_fallback
                                      AND m.created_at >= ${utc(s24)}) AS fallback_24h,
                   COUNT(*) FILTER (WHERE m.role = 'USER') AS contact_7d,
                   COUNT(*) FILTER (WHERE m.role = 'ASSISTANT') AS replies_7d,
                   COUNT(*) FILTER (WHERE m.role = 'ASSISTANT' AND m.is_fallback) AS fallback_7d
              FROM conversations c
              JOIN messages m ON m.company_id = c.company_id AND m.conversation_id = c.id
             WHERE c.company_id = co.id
               AND m.company_id = co.id
               AND c.updated_at >= ${utc(s7)}
               AND m.created_at >= ${utc(s7)}) v
         WHERE co.deleted_at IS NULL`;

      const [attention] = await db.$queryRaw<{ stalled: number; unsent: number }[]>`
        SELECT COALESCE(SUM(a.stalled), 0)::int AS stalled,
               COALESCE(SUM(a.unsent), 0)::int AS unsent
          FROM companies co
          CROSS JOIN LATERAL (
            SELECT (SELECT COUNT(*) ${stalledPendingFrom(Prisma.sql`co.id`, now)}) AS stalled,
                   CASE WHEN co.whatsapp_phone_number_id IS NULL THEN 0
                        ELSE (SELECT COUNT(*) ${unsentRepliesFrom(Prisma.sql`co.id`, now)}) END AS unsent) a
         WHERE co.deleted_at IS NULL
           AND co.status = 'ACTIVE'`;

      const [handoffs] = await db.$queryRaw<{ open_handoffs: number }[]>`
        SELECT COALESCE(SUM(h.n), 0)::int AS open_handoffs
          FROM companies co
          CROSS JOIN LATERAL (
            SELECT COUNT(*) AS n
              FROM notifications n
             WHERE n.company_id = co.id AND n.status = 'OPEN' AND n.kind = 'HUMAN_HANDOFF') h
         WHERE co.deleted_at IS NULL`;

      const byStatus = new Map(companies.map((row) => [row.status, num(row.n)]));
      return {
        companies: {
          active: byStatus.get('ACTIVE') ?? 0,
          suspended: byStatus.get('SUSPENDED') ?? 0,
        },
        accounts: {
          total: num(accounts?.total),
          verified: num(accounts?.verified),
          unverified: num(accounts?.unverified),
          disabled: num(accounts?.disabled),
        },
        channel: {
          byState: {
            NOT_CONNECTED: num(channel?.not_connected),
            LEGACY: num(channel?.legacy),
            CONNECTED: num(channel?.connected),
            TOKEN_INVALID: num(channel?.token_invalid),
          },
          byMode: { API_ONLY: num(channel?.api_only), COEXISTENCE: num(channel?.coexistence) },
        },
        attendance: {
          last24h: {
            contactMessages: num(volume?.contact_24h),
            replies: num(volume?.replies_24h),
            fallbackReplies: num(volume?.fallback_24h),
          },
          last7d: {
            contactMessages: num(volume?.contact_7d),
            replies: num(volume?.replies_7d),
            fallbackReplies: num(volume?.fallback_7d),
          },
        },
        attention: {
          stalledPending: num(attention?.stalled),
          unsentReplies: num(attention?.unsent),
          tokenInvalid: num(channel?.token_invalid),
          tokensExpiringSoon: num(channel?.expiring),
          openHandoffs: num(handoffs?.open_handoffs),
        },
      };
    });
  }

  billingOverview(
    now: Date,
    graceDays: number,
    monthStart: Date,
  ): Promise<PlatformBillingOverviewFacts> {
    return this.read('PlatformRead.billingOverview', async (db) => {
      const groups = await db.$queryRaw<
        {
          status: SubscriptionStatus;
          cancel_at_period_end: boolean;
          plan_code: PlanCode;
          trial_open: boolean;
          period_open: boolean;
          grace_open: boolean;
          n: number;
        }[]
      >`
        SELECT s.status::text AS status,
               s.cancel_at_period_end,
               p.code::text AS plan_code,
               (${tz(now)} < COALESCE(s.trial_ends_at, s.current_period_end)) AS trial_open,
               (${tz(now)} < s.current_period_end) AS period_open,
               (${tz(now)} < s.current_period_end
                              + make_interval(days => ${Math.max(0, Math.trunc(graceDays))}::int)) AS grace_open,
               COUNT(*)::int AS n
          FROM subscriptions s
          JOIN plans p ON p.id = s.plan_id
         GROUP BY 1, 2, 3, 4, 5, 6`;
      const [paid] = await db.$queryRaw<{ n: number; total: bigint | number | null }[]>`
        SELECT COUNT(*)::int AS n, COALESCE(SUM(o.amount_cents), 0)::int8 AS total
          FROM payment_orders o
         WHERE o.status = 'PAID'
           AND o.paid_at >= ${tz(monthStart)}`;
      return {
        subscriptions: groups.map((row) => ({
          status: row.status,
          cancelAtPeriodEnd: row.cancel_at_period_end,
          planCode: row.plan_code,
          trialOpen: row.trial_open,
          periodOpen: row.period_open,
          graceOpen: row.grace_open,
          count: num(row.n),
        })),
        paidOrders: { count: num(paid?.n), amountCents: num(paid?.total) },
      };
    });
  }

  listCompanies(
    filter: PlatformCompanyListFilter,
    page: PlatformPageRequest,
    now: Date,
  ): Promise<PlatformPage<PlatformCompanyRow>> {
    return this.read('PlatformRead.listCompanies', async (db) => {
      const s7 = since(now, 7 * DAY_MS);
      const q = filter.q?.trim().toLowerCase() ?? '';
      const rows = await db.$queryRaw<CompanyListSqlRow[]>`
        SELECT co.id::text AS id,
               co.name AS name,
               co.slug AS slug,
               co.status::text AS status,
               (co.created_at AT TIME ZONE 'UTC') AS created_at,
               (SELECT MAX(c.updated_at) AT TIME ZONE 'UTC'
                  FROM conversations c
                 WHERE c.company_id = co.id) AS last_activity_at,
               cc.status::text AS connection_status,
               (co.whatsapp_phone_number_id IS NOT NULL) AS has_number,
               (SELECT COUNT(*)::int
                  FROM memberships mb
                 WHERE mb.company_id = co.id AND mb.status = 'ACTIVE') AS active_members,
               (SELECT COUNT(*)::int
                  FROM messages m
                  JOIN conversations c ON c.id = m.conversation_id AND c.company_id = m.company_id
                 WHERE c.company_id = co.id
                   AND m.company_id = co.id
                   AND c.updated_at >= ${utc(s7)}
                   AND m.role = 'USER'
                   AND m.created_at >= ${utc(s7)}) AS messages_7d,
               p.code::text AS plan_code,
               s.status::text AS sub_status,
               s.current_period_end,
               s.trial_ends_at,
               s.cancel_at_period_end
          FROM companies co
          LEFT JOIN channel_connections cc ON cc.company_id = co.id
          LEFT JOIN subscriptions s ON s.id = co.subscription_id
          LEFT JOIN plans p ON p.id = s.plan_id
         WHERE co.deleted_at IS NULL
           ${filter.status === undefined ? Prisma.empty : Prisma.sql`AND co.status = ${filter.status}::company_status`}
           ${
             q === ''
               ? Prisma.empty
               : Prisma.sql`AND (strpos(lower(co.name), ${q}) > 0 OR strpos(co.slug, ${q}) > 0)`
           }
           ${attentionFilter(filter.attention, now)}
           ${afterCursor(Prisma.sql`co.id`, page)}
         ORDER BY co.id DESC
         LIMIT ${page.limit + 1}`;
      return toPage(rows, page.limit, (row) => ({
        id: CompanyId.parse(row.id),
        name: row.name,
        slug: row.slug,
        status: row.status,
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
        channelState: channelState(row.connection_status, row.has_number),
        activeMembers: num(row.active_members),
        messages7d: num(row.messages_7d),
        subscription:
          row.plan_code === null || row.sub_status === null || row.current_period_end === null
            ? null
            : {
                planCode: row.plan_code,
                status: row.sub_status,
                currentPeriodEnd: row.current_period_end,
                trialEndsAt: row.trial_ends_at,
                cancelAtPeriodEnd: row.cancel_at_period_end === true,
              },
      }));
    });
  }

  companyDetail(companyId: CompanyId, now: Date): Promise<PlatformCompanyDetailFacts | null> {
    return this.read('PlatformRead.companyDetail', async (db) => {
      const [company] = await db.$queryRaw<
        {
          id: string;
          name: string;
          slug: string;
          status: CompanyStatus;
          created_at: Date;
          updated_at: Date;
          subscription_id: string | null;
          phone_number_id: string | null;
        }[]
      >`
        SELECT co.id::text AS id, co.name AS name, co.slug AS slug, co.status::text AS status,
               (co.created_at AT TIME ZONE 'UTC') AS created_at,
               (co.updated_at AT TIME ZONE 'UTC') AS updated_at,
               co.subscription_id::text AS subscription_id,
               co.whatsapp_phone_number_id AS phone_number_id
          FROM companies co
         WHERE co.id = ${companyId}::uuid AND co.deleted_at IS NULL`;
      if (company === undefined) return null;

      const s24 = since(now, DAY_MS);
      const s7 = since(now, 7 * DAY_MS);
      const s30 = since(now, 30 * DAY_MS);
      const weekAhead = new Date(now.getTime() + 7 * DAY_MS);

      const memberships = await db.$queryRaw<
        { role: MembershipRole; status: AccessStatus; n: number }[]
      >`
        SELECT mb.role::text AS role, mb.status::text AS status, COUNT(*)::int AS n
          FROM memberships mb
         WHERE mb.company_id = ${companyId}::uuid
         GROUP BY mb.role, mb.status
         ORDER BY mb.role, mb.status`;

      const [holder] =
        company.subscription_id === null
          ? []
          : await db.$queryRaw<
              { id: string; verified: boolean; status: AccessStatus; created_at: Date }[]
            >`
              SELECT a.id::text AS id, (a.email_verified_at IS NOT NULL) AS verified,
                     a.status::text AS status, a.created_at
                FROM subscriptions s
                JOIN accounts a ON a.id = s.account_id
               WHERE s.id = ${company.subscription_id}::uuid`;

      const [connection] = await db.$queryRaw<
        {
          status: string;
          mode: PlatformChannelMode;
          waba_id: string;
          created_at: Date;
          token_expires_at: Date | null;
          token_invalid_at: Date | null;
        }[]
      >`
        SELECT cc.status::text AS status, cc.mode::text AS mode, cc.waba_id,
               (cc.created_at AT TIME ZONE 'UTC') AS created_at,
               (cc.token_expires_at AT TIME ZONE 'UTC') AS token_expires_at,
               (cc.token_invalid_at AT TIME ZONE 'UTC') AS token_invalid_at
          FROM channel_connections cc
         WHERE cc.company_id = ${companyId}::uuid`;

      const [conversations] = await db.$queryRaw<
        { conv_24h: number; conv_7d: number; conv_30d: number }[]
      >`
        SELECT COUNT(*) FILTER (WHERE c.updated_at >= ${utc(s24)})::int AS conv_24h,
               COUNT(*) FILTER (WHERE c.updated_at >= ${utc(s7)})::int AS conv_7d,
               COUNT(*)::int AS conv_30d
          FROM conversations c
         WHERE c.company_id = ${companyId}::uuid
           AND c.updated_at >= ${utc(s30)}`;

      const [messages] = await db.$queryRaw<
        Omit<AttendanceSqlRow, 'conv_24h' | 'conv_7d' | 'conv_30d'>[]
      >`
        SELECT COUNT(*) FILTER (WHERE m.role = 'USER' AND m.created_at >= ${utc(s24)})::int AS contact_24h,
               COUNT(*) FILTER (WHERE m.role = 'USER' AND m.created_at >= ${utc(s7)})::int AS contact_7d,
               COUNT(*) FILTER (WHERE m.role = 'USER')::int AS contact_30d,
               COUNT(*) FILTER (WHERE m.role = 'ASSISTANT' AND m.created_at >= ${utc(s24)})::int AS replies_24h,
               COUNT(*) FILTER (WHERE m.role = 'ASSISTANT' AND m.created_at >= ${utc(s7)})::int AS replies_7d,
               COUNT(*) FILTER (WHERE m.role = 'ASSISTANT')::int AS replies_30d,
               COUNT(*) FILTER (WHERE m.role = 'ASSISTANT' AND m.is_fallback
                                  AND m.created_at >= ${utc(s24)})::int AS fallback_24h,
               COUNT(*) FILTER (WHERE m.role = 'ASSISTANT' AND m.is_fallback
                                  AND m.created_at >= ${utc(s7)})::int AS fallback_7d,
               COUNT(*) FILTER (WHERE m.role = 'ASSISTANT' AND m.is_fallback)::int AS fallback_30d,
               COUNT(*) FILTER (WHERE m.delivery_uncertain_at IS NOT NULL
                                  AND m.created_at >= ${utc(s24)})::int AS uncertain_24h,
               COUNT(*) FILTER (WHERE m.delivery_uncertain_at IS NOT NULL
                                  AND m.created_at >= ${utc(s7)})::int AS uncertain_7d,
               COUNT(*) FILTER (WHERE m.delivery_uncertain_at IS NOT NULL)::int AS uncertain_30d
          FROM messages m
          JOIN conversations c ON c.id = m.conversation_id AND c.company_id = m.company_id
         WHERE c.company_id = ${companyId}::uuid
           AND m.company_id = ${companyId}::uuid
           AND c.updated_at >= ${utc(s30)}
           AND m.created_at >= ${utc(s30)}`;

      const handoffRows = await db.$queryRaw<
        { reason: HandoffReason | null; h_24h: number; h_7d: number; h_30d: number }[]
      >`
        SELECT n.reason::text AS reason,
               COUNT(*) FILTER (WHERE n.created_at >= ${tz(s24)})::int AS h_24h,
               COUNT(*) FILTER (WHERE n.created_at >= ${tz(s7)})::int AS h_7d,
               COUNT(*)::int AS h_30d
          FROM notifications n
         WHERE n.company_id = ${companyId}::uuid
           AND n.kind = 'HUMAN_HANDOFF'
           AND n.created_at >= ${tz(s30)}
         GROUP BY n.reason`;

      const [attention] = await db.$queryRaw<
        { stalled: number; unsent: number; open_handoffs: number }[]
      >`
        SELECT
          (SELECT COUNT(*)::int ${stalledPendingFrom(Prisma.sql`${companyId}::uuid`, now)}
              AND ${company.status === 'ACTIVE'}::boolean) AS stalled,
          (SELECT COUNT(*)::int ${unsentRepliesFrom(Prisma.sql`${companyId}::uuid`, now)}
              AND ${company.status === 'ACTIVE' && company.phone_number_id !== null}::boolean) AS unsent,
          (SELECT COUNT(*)::int
             FROM notifications n
            WHERE n.company_id = ${companyId}::uuid
              AND n.status = 'OPEN'
              AND n.kind = 'HUMAN_HANDOFF') AS open_handoffs`;

      const [content] = await db.$queryRaw<
        { documents: number; active_products: number; upcoming: number }[]
      >`
        SELECT
          (SELECT COUNT(*)::int FROM knowledge_documents d
            WHERE d.company_id = ${companyId}::uuid) AS documents,
          (SELECT COUNT(*)::int FROM products p
            WHERE p.company_id = ${companyId}::uuid AND p.active) AS active_products,
          (SELECT COUNT(*)::int FROM appointments ap
            WHERE ap.company_id = ${companyId}::uuid
              AND ap.kind = 'BOOKING'
              AND ap.status IN ('PENDING', 'CONFIRMED')
              AND ap.starts_at >= ${tz(now)}
              AND ap.starts_at < ${tz(weekAhead)}) AS upcoming`;

      const handoffs = {
        last24h: emptyHandoffs(),
        last7d: emptyHandoffs(),
        last30d: emptyHandoffs(),
      };
      for (const row of handoffRows) {
        // Notificação antiga sem motivo conta como "outro".
        const reason: HandoffReason = row.reason ?? 'OTHER';
        handoffs.last24h[reason] += num(row.h_24h);
        handoffs.last7d[reason] += num(row.h_7d);
        handoffs.last30d[reason] += num(row.h_30d);
      }
      const window = (
        suffix: '24h' | '7d' | '30d',
        handoffCounts: Record<HandoffReason, number>,
      ): PlatformCompanyAttendance => ({
        activeConversations: num(conversations?.[`conv_${suffix}`]),
        contactMessages: num(messages?.[`contact_${suffix}`]),
        replies: num(messages?.[`replies_${suffix}`]),
        fallbacks: num(messages?.[`fallback_${suffix}`]),
        uncertainDeliveries: num(messages?.[`uncertain_${suffix}`]),
        handoffs: handoffCounts,
      });

      const channel: PlatformChannelView =
        connection === undefined
          ? {
              state: company.phone_number_id === null ? 'NOT_CONNECTED' : 'LEGACY',
              mode: null,
              phoneNumberId: company.phone_number_id,
              wabaId: null,
              connectedAt: null,
              tokenExpiresAt: null,
              tokenInvalidAt: null,
            }
          : {
              state: channelState(connection.status, company.phone_number_id !== null),
              mode: connection.mode,
              phoneNumberId: company.phone_number_id,
              wabaId: connection.waba_id,
              connectedAt: connection.created_at,
              tokenExpiresAt: connection.token_expires_at,
              tokenInvalidAt: connection.token_invalid_at,
            };

      return {
        company: {
          id: CompanyId.parse(company.id),
          name: company.name,
          slug: company.slug,
          status: company.status,
          createdAt: company.created_at,
          updatedAt: company.updated_at,
        },
        subscriptionId: company.subscription_id,
        memberships: memberships.map((row) => ({
          role: row.role,
          status: row.status,
          count: num(row.n),
        })),
        holder:
          holder === undefined
            ? null
            : {
                accountId: holder.id,
                emailVerified: holder.verified,
                status: holder.status,
                createdAt: holder.created_at,
              },
        channel,
        attendance: {
          last24h: window('24h', handoffs.last24h),
          last7d: window('7d', handoffs.last7d),
          last30d: window('30d', handoffs.last30d),
        },
        attention: {
          stalledPending: num(attention?.stalled),
          unsentReplies: num(attention?.unsent),
          openHandoffs: num(attention?.open_handoffs),
        },
        content: {
          documents: num(content?.documents),
          activeProducts: num(content?.active_products),
          upcomingAppointments: num(content?.upcoming),
        },
      };
    });
  }

  subscription(
    by: { readonly subscriptionId: string } | { readonly accountId: string },
    now: Date,
  ): Promise<PlatformSubscriptionFacts | null> {
    return this.read('PlatformRead.subscription', async (db) => {
      const id = 'subscriptionId' in by ? by.subscriptionId : by.accountId;
      if (!isUuid(id)) return null;
      const record =
        'subscriptionId' in by
          ? await findSubscriptionById(db, by.subscriptionId)
          : await findSubscriptionByAccount(db, by.accountId);
      if (record === null) return null;
      const windowStart = currentWindowStart(record, now);
      const counter = await db.usageCounter.findFirst({
        where: { subscriptionId: record.id, windowStart },
        select: { tokens: true, sentMessages: true, extraReplies: true },
      });
      return {
        record,
        windowStart,
        usage: {
          tokens: Number(counter?.tokens ?? 0n),
          sentMessages: Number(counter?.sentMessages ?? 0n),
          extraReplies: counter?.extraReplies ?? 0,
        },
      };
    });
  }

  listAccounts(
    filter: PlatformAccountListFilter,
    page: PlatformPageRequest,
  ): Promise<PlatformPage<PlatformAccountRow>> {
    return this.read('PlatformRead.listAccounts', async (db) => {
      const rows = await db.$queryRaw<
        {
          id: string;
          email_masked: string;
          status: AccessStatus;
          verified: boolean;
          created_at: Date;
          companies: number;
          has_subscription: boolean;
        }[]
      >`
        SELECT a.id::text AS id,
               substr(a.email, 1, 1) || '***@' || split_part(a.email, '@', 2) AS email_masked,
               a.status::text AS status,
               (a.email_verified_at IS NOT NULL) AS verified,
               a.created_at,
               (SELECT COUNT(*)::int
                  FROM memberships mb
                  JOIN companies co ON co.id = mb.company_id AND co.deleted_at IS NULL
                 WHERE mb.account_id = a.id) AS companies,
               EXISTS (SELECT 1 FROM subscriptions s WHERE s.account_id = a.id) AS has_subscription
          FROM accounts a
         WHERE TRUE
           ${filter.status === undefined ? Prisma.empty : Prisma.sql`AND a.status = ${filter.status}::access_status`}
           ${
             filter.verified === undefined
               ? Prisma.empty
               : filter.verified
                 ? Prisma.sql`AND a.email_verified_at IS NOT NULL`
                 : Prisma.sql`AND a.email_verified_at IS NULL`
           }
           ${afterCursor(Prisma.sql`a.id`, page)}
         ORDER BY a.id DESC
         LIMIT ${page.limit + 1}`;
      return toPage(rows, page.limit, (row) => ({
        id: row.id,
        emailMasked: row.email_masked,
        status: row.status,
        verified: row.verified,
        createdAt: row.created_at,
        companies: num(row.companies),
        hasSubscription: row.has_subscription,
      }));
    });
  }

  accountDetail(accountId: string): Promise<PlatformAccountDetailFacts | null> {
    return this.read('PlatformRead.accountDetail', async (db) => {
      if (!isUuid(accountId)) return null;
      const [account] = await db.$queryRaw<
        { id: string; email: string; status: AccessStatus; verified: boolean; created_at: Date }[]
      >`
        SELECT a.id::text AS id, a.email, a.status::text AS status,
               (a.email_verified_at IS NOT NULL) AS verified, a.created_at
          FROM accounts a
         WHERE a.id = ${accountId}::uuid`;
      if (account === undefined) return null;
      const companies = await db.$queryRaw<
        {
          id: string;
          name: string;
          slug: string;
          status: CompanyStatus;
          role: MembershipRole;
          membership_status: AccessStatus;
        }[]
      >`
        SELECT co.id::text AS id, co.name AS name, co.slug AS slug, co.status::text AS status,
               mb.role::text AS role, mb.status::text AS membership_status
          FROM memberships mb
          JOIN companies co ON co.id = mb.company_id AND co.deleted_at IS NULL
         WHERE mb.account_id = ${accountId}::uuid
         ORDER BY co.id`;
      return {
        id: account.id,
        email: account.email,
        status: account.status,
        verified: account.verified,
        createdAt: account.created_at,
        companies: companies.map((row) => ({
          id: CompanyId.parse(row.id),
          name: row.name,
          slug: row.slug,
          status: row.status,
          role: row.role,
          membershipStatus: row.membership_status,
        })),
      };
    });
  }

  listOrders(
    filter: PlatformOrderFilter,
    page: PlatformPageRequest,
  ): Promise<PlatformPage<PlatformOrderRow>> {
    return this.read('PlatformRead.listOrders', async (db) => {
      const rows = await db.$queryRaw<
        {
          id: string;
          kind: PaymentOrderKindValue;
          status: PaymentOrderStatusValue;
          amount_cents: number;
          capture_method: string | null;
          created_at: Date;
          paid_at: Date | null;
          expires_at: Date;
          period_start: Date | null;
          period_end: Date | null;
          account_id: string;
        }[]
      >`
        SELECT o.id::text AS id, o.kind::text AS kind, o.status::text AS status, o.amount_cents,
               o.capture_method, o.created_at, o.paid_at, o.expires_at, o.period_start, o.period_end,
               s.account_id::text AS account_id
          FROM payment_orders o
          JOIN subscriptions s ON s.id = o.subscription_id
         WHERE TRUE
           ${filter.status === undefined ? Prisma.empty : Prisma.sql`AND o.status = ${filter.status}::payment_order_status`}
           ${filter.kind === undefined ? Prisma.empty : Prisma.sql`AND o.kind = ${filter.kind}::payment_order_kind`}
           ${afterCursor(Prisma.sql`o.id`, page)}
         ORDER BY o.id DESC
         LIMIT ${page.limit + 1}`;
      return toPage(rows, page.limit, (row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        amountCents: num(row.amount_cents),
        captureMethod: row.capture_method,
        createdAt: row.created_at,
        paidAt: row.paid_at,
        expiresAt: row.expires_at,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        accountId: row.account_id,
      }));
    });
  }

  listNotices(
    filter: { readonly kind?: BillingNoticeKind | undefined },
    page: PlatformPageRequest,
  ): Promise<PlatformPage<PlatformNoticeRow>> {
    return this.read('PlatformRead.listNotices', async (db) => {
      const rows = await db.$queryRaw<
        {
          id: string;
          kind: BillingNoticeKind;
          window_start: Date;
          created_at: Date;
          account_id: string;
        }[]
      >`
        SELECT pn.id::text AS id, pn.kind::text AS kind, pn.window_start, pn.created_at,
               s.account_id::text AS account_id
          FROM payment_notices pn
          JOIN subscriptions s ON s.id = pn.subscription_id
         WHERE TRUE
           ${filter.kind === undefined ? Prisma.empty : Prisma.sql`AND pn.kind = ${filter.kind}::payment_notice_kind`}
           ${afterCursor(Prisma.sql`pn.id`, page)}
         ORDER BY pn.id DESC
         LIMIT ${page.limit + 1}`;
      return toPage(rows, page.limit, (row) => ({
        kind: row.kind,
        windowStart: row.window_start,
        createdAt: row.created_at,
        accountId: row.account_id,
      }));
    });
  }
}
