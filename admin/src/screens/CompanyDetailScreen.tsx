import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ApiError } from '../api';
import { useAdmin, useLoad, type View } from '../admin-context';
import {
  ACTION_REASONS,
  HANDOFF_REASONS,
  companyDetailSchema,
  countEntries,
  type ActionReason,
  type CompanyDetail,
} from '../contracts';
import {
  errorMessage,
  formatCount,
  formatDate,
  formatDateTime,
  formatUsage,
  label,
} from '../format';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Facts,
  Loading,
  PageHeader,
  Select,
  Stat,
  StatGrid,
} from '../ui';
import { modulesText, subscriptionFacts } from './subscription-facts';

const ONBOARDING_STEPS = [
  ['persona', 'Persona'],
  ['knowledge', 'Conhecimento'],
  ['schedule', 'Agenda'],
  ['inventory', 'Estoque'],
] as const;

function yesNo(value: boolean): string {
  return value ? 'Sim' : 'Não';
}

/** Handoffs por motivo: só os motivos com contagem (todos zerados: "nenhum"). */
function handoffsText(handoffs: CompanyDetail['attendance']['last24h']['handoffs']): string {
  const used = countEntries(HANDOFF_REASONS, handoffs).filter(([, value]) => value > 0);
  return used.length === 0
    ? 'nenhum'
    : used.map(([key, value]) => `${label(key)}: ${formatCount(value)}`).join(' · ');
}

function Attendance({ detail }: { readonly detail: CompanyDetail }) {
  const windows = [
    ['24 h', detail.attendance.last24h],
    ['7 dias', detail.attendance.last7d],
    ['30 dias', detail.attendance.last30d],
  ] as const;
  return (
    <div className="flex flex-col gap-3">
      {windows.map(([name, w]) => (
        <div key={name}>
          <h3 className="mb-2 text-sm font-semibold">Últimas {name}</h3>
          <Facts
            items={[
              ['Conversas ativas', formatCount(w.activeConversations)],
              ['Mensagens do contato', formatCount(w.contactMessages)],
              ['Respostas', formatCount(w.replies)],
              ['Respostas de fallback', formatCount(w.fallbacks)],
              ['Entregas incertas', formatCount(w.uncertainDeliveries)],
              ['Atendimento humano', handoffsText(w.handoffs)],
            ]}
          />
        </div>
      ))}
    </div>
  );
}

function Subscription({ detail }: { readonly detail: CompanyDetail }) {
  if (!detail.billingEnabled)
    return <p className="text-sm text-muted-foreground">Cobrança desligada.</p>;
  const sub = detail.subscription;
  if (sub === null) return <p className="text-sm text-muted-foreground">Sem assinatura.</p>;
  const usage = detail.usage;
  return (
    <Facts items={[...subscriptionFacts(sub), ...(usage === null ? [] : usageFacts(usage))]} />
  );
}

function usageFacts(usage: NonNullable<CompanyDetail['usage']>) {
  return [
    ['Respostas na janela', formatUsage(usage.replies.used, usage.replies.limit)],
    ['Tokens na janela', formatUsage(usage.tokens.used, usage.tokens.limit)],
    ['Janela de uso', `${formatDate(usage.windowStart)} a ${formatDate(usage.windowEnd)}`],
  ] as const;
}

/**
 * Suspender ou reativar (D1): diálogo de confirmação com o motivo numa lista. O `POST` é idempotente
 * (204); depois dele a tela relê o detalhe.
 */
function StatusAction({
  detail,
  onDone,
}: {
  readonly detail: CompanyDetail;
  readonly onDone: () => void;
}) {
  const { api, expire } = useAdmin();
  const suspend = detail.status === 'ACTIVE';
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ActionReason>('PAYMENT');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      await api.post(`/platform/companies/${detail.id}/${suspend ? 'suspend' : 'reactivate'}`, {
        reason,
      });
      setOpen(false);
      onDone();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) return expire();
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant={suspend ? 'danger' : 'primary'}
        onClick={() => {
          setReason('PAYMENT');
          setError(undefined);
          setOpen(true);
        }}
      >
        {suspend ? 'Suspender' : 'Reativar'}
      </Button>
      <Dialog
        open={open}
        title={suspend ? `Suspender ${detail.name}?` : `Reativar ${detail.name}?`}
        onClose={() => setOpen(false)}
      >
        <p className="mb-3 text-sm">
          {suspend
            ? 'A empresa deixa de receber mensagens pelo canal e a equipe perde o acesso ao painel na próxima requisição.'
            : 'A empresa volta a receber mensagens pelo canal e a equipe volta a entrar no painel.'}
        </p>
        <Select<ActionReason>
          label="Motivo"
          value={reason}
          onChange={setReason}
          options={ACTION_REASONS.map((key) => [key, label(key)] as const)}
        />
        {error === undefined ? null : <Alert>{errorMessage(error)}</Alert>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button onClick={() => setOpen(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant={suspend ? 'danger' : 'primary'}
            onClick={() => void confirm()}
            disabled={busy}
          >
            {suspend ? 'Confirmar suspensão' : 'Confirmar reativação'}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

/** Detalhe de uma empresa (`GET /platform/companies/:companyId`): só números, estados e datas. */
export function CompanyDetailScreen({
  companyId,
  from,
}: {
  readonly companyId: string;
  readonly from: View;
}) {
  const { navigate } = useAdmin();
  const { data, error, loading, reload } = useLoad(
    (api) => api.get(`/platform/companies/${encodeURIComponent(companyId)}`, companyDetailSchema),
    companyId,
  );

  return (
    <>
      <div className="mb-2">
        <Button variant="ghost" onClick={() => navigate(from)}>
          <ArrowLeft aria-hidden className="size-4" />
          Voltar
        </Button>
      </div>
      <PageHeader title={data?.name ?? 'Empresa'} onRefresh={reload} busy={loading}>
        {data === undefined ? null : <StatusAction detail={data} onDone={reload} />}
      </PageHeader>
      {error === undefined ? null : <Alert>{errorMessage(error)}</Alert>}
      {data === undefined ? (
        loading ? (
          <Loading />
        ) : null
      ) : (
        <div className="flex flex-col gap-4">
          <Card title="Empresa">
            <Facts
              items={[
                [
                  'Estado',
                  <Badge key="s" tone={data.status === 'SUSPENDED' ? 'bad' : 'neutral'}>
                    {label(data.status)}
                  </Badge>,
                ],
                ['Slug', data.slug],
                ['Criada em', formatDateTime(data.createdAt)],
                ['Atualizada em', formatDateTime(data.updatedAt)],
                ['Persona preenchida', yesNo(data.hasPersona)],
                ['Módulos liberados', modulesText(data.modules)],
              ]}
            />
          </Card>
          <Card title="Precisa de atenção">
            <StatGrid>
              <Stat
                label="Mensagens pendentes"
                value={formatCount(data.attention.stalledPending)}
                alert={data.attention.stalledPending > 0}
              />
              <Stat
                label="Respostas não enviadas"
                value={formatCount(data.attention.unsentReplies)}
                alert={data.attention.unsentReplies > 0}
              />
              <Stat
                label="Token inválido"
                value={yesNo(data.attention.tokenInvalid)}
                alert={data.attention.tokenInvalid}
              />
              <Stat
                label="Token vencendo"
                value={yesNo(data.attention.tokenExpiringSoon)}
                alert={data.attention.tokenExpiringSoon}
              />
              <Stat
                label="Atendimento humano aberto"
                value={formatCount(data.attention.openHandoffs)}
                alert={data.attention.openHandoffs > 0}
              />
            </StatGrid>
          </Card>
          <Card title="Primeiros passos">
            <Facts
              items={[
                ...ONBOARDING_STEPS.map(
                  ([key, name]) =>
                    [name, data.onboarding.steps[key] ? 'Feito' : 'Pendente'] as const,
                ),
                ['Lista dispensada pela equipe', yesNo(data.onboarding.dismissed)],
              ]}
            />
          </Card>
          <Card title="Equipe">
            <Facts
              items={[
                ...data.memberships.map(
                  (m) =>
                    [
                      `${label(m.role)} (${label(m.status).toLowerCase()})`,
                      formatCount(m.count),
                    ] as const,
                ),
                [
                  'Titular',
                  data.holder === null
                    ? '—'
                    : `${label(data.holder.status)} · e-mail ${data.holder.emailVerified ? 'confirmado' : 'não confirmado'} · desde ${formatDate(data.holder.createdAt)}`,
                ],
              ]}
            />
          </Card>
          <Card title="Assinatura e uso">
            <Subscription detail={data} />
          </Card>
          <Card title="Canal">
            {data.channel.state === 'NOT_CONNECTED' ? (
              <p className="text-sm text-muted-foreground">Não conectado.</p>
            ) : (
              <Facts
                items={[
                  ['Estado', label(data.channel.state)],
                  ['Modo', data.channel.mode === null ? '—' : label(data.channel.mode)],
                  ['Phone number id', data.channel.phoneNumberId ?? '—'],
                  ['WABA id', data.channel.wabaId ?? '—'],
                  ['Conectado em', formatDateTime(data.channel.connectedAt)],
                  ['Token vence em', formatDateTime(data.channel.tokenExpiresAt)],
                  ['Token recusado em', formatDateTime(data.channel.tokenInvalidAt)],
                ]}
              />
            )}
          </Card>
          <Card title="Atendimento">
            <Attendance detail={data} />
          </Card>
          <Card title="Conteúdo">
            <Facts
              items={[
                ['Documentos', formatCount(data.content.documents)],
                ['Produtos ativos', formatCount(data.content.activeProducts)],
                ['Reservas nos próximos 7 dias', formatCount(data.content.upcomingAppointments)],
              ]}
            />
          </Card>
        </div>
      )}
    </>
  );
}
