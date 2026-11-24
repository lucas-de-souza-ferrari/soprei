import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ApiError } from '../api';
import { useAdmin, useLoad, type View } from '../admin-context';
import {
  ACTION_REASONS,
  companyDetailSchema,
  type ActionReason,
  type CompanyDetail,
  type Group,
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

const ONBOARDING_LABELS: Record<string, string> = {
  persona: 'Persona',
  knowledge: 'Conhecimento',
  schedule: 'Agenda',
  inventory: 'Estoque',
};

function yesNo(value: boolean): string {
  return value ? 'Sim' : 'Não';
}

function groupText(group: Group): string {
  return group.length === 0
    ? 'nenhum'
    : group.map((item) => `${label(item.key)}: ${formatCount(item.count)}`).join(' · ');
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
              ['Atendimento humano', groupText(w.handoffs)],
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
  return (
    <Facts
      items={[
        ['Plano', `${label(sub.plan)} (${label(sub.cycle)})`],
        ['Estado', `${label(sub.state)} · ${label(sub.access)}`],
        ['Período', `${formatDate(sub.periodStart)} a ${formatDate(sub.periodEnd)}`],
        ['Cancela no fim do período', yesNo(sub.cancelAtPeriodEnd)],
        [
          'Troca agendada',
          sub.scheduledChange === null
            ? '—'
            : `${label(sub.scheduledChange.plan)} (${label(sub.scheduledChange.cycle)}) em ${formatDate(sub.scheduledChange.effectiveAt)}`,
        ],
        ['Módulos', sub.modules.length === 0 ? '—' : sub.modules.map(label).join(', ')],
        ['Respostas na janela', formatUsage(sub.usage.replies, sub.usage.repliesQuota)],
        ['Tokens na janela', formatUsage(sub.usage.tokens, sub.usage.tokensQuota)],
        [
          'Janela de uso',
          `${formatDate(sub.usage.windowStart)} a ${formatDate(sub.usage.windowEnd)}`,
        ],
      ]}
    />
  );
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
                ['Última atividade', formatDateTime(data.lastActivityAt)],
                ['Persona preenchida', yesNo(data.hasPersona)],
                ['Módulos', data.modules.length === 0 ? '—' : data.modules.map(label).join(', ')],
              ]}
            />
          </Card>
          <Card title="Precisa de atenção">
            <StatGrid>
              <Stat
                label="Mensagens pendentes"
                value={formatCount(data.attention.pendingMessages)}
                alert={data.attention.pendingMessages > 0}
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
                value={yesNo(data.attention.tokenExpiring)}
                alert={data.attention.tokenExpiring}
              />
              <Stat
                label="Atendimento humano aberto"
                value={formatCount(data.attention.openHandoffs)}
                alert={data.attention.openHandoffs > 0}
              />
            </StatGrid>
          </Card>
          <Card title="Primeiros passos">
            {data.onboarding.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sem dados.</p>
            ) : (
              <Facts
                items={data.onboarding.map(
                  (step) =>
                    [
                      ONBOARDING_LABELS[step.key] ?? step.key,
                      step.done ? 'Feito' : 'Pendente',
                    ] as const,
                )}
              />
            )}
          </Card>
          <Card title="Equipe">
            <Facts
              items={[
                ...data.members.map(
                  (m) =>
                    [
                      `${label(m.role)} (${label(m.status).toLowerCase()})`,
                      formatCount(m.count),
                    ] as const,
                ),
                [
                  'Titular',
                  data.owner === null
                    ? '—'
                    : `${label(data.owner.status)} · e-mail ${data.owner.emailVerified ? 'confirmado' : 'não confirmado'} · desde ${formatDate(data.owner.createdAt)}`,
                ],
              ]}
            />
          </Card>
          <Card title="Assinatura e uso">
            <Subscription detail={data} />
          </Card>
          <Card title="Canal">
            {data.channel === null ? (
              <p className="text-sm text-muted-foreground">Não conectado.</p>
            ) : (
              <Facts
                items={[
                  ['Estado', label(data.channel.state)],
                  ['Modo', label(data.channel.mode)],
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
                ['Reservas nos próximos 7 dias', formatCount(data.content.upcomingBookings7d)],
              ]}
            />
          </Card>
        </div>
      )}
    </>
  );
}
