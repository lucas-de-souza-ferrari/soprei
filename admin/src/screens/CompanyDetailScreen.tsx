import { useState } from 'react';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
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
  List,
  PageHeader,
  Row,
  Select,
  Stat,
  StatGrid,
} from '../ui';
import { ChannelDisconnect, CompanyActions, MembershipActions } from './CompanyActions';
import { Invitations } from './InvitationActions';
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
 * O dono em destaque no topo, ou o aviso de empresa sem dono ativo. Quem é dono ativo (vínculo `OWNER`
 * ativo com a conta ativa ou sem conta) é decidido só no servidor (`owner` e `owners`); o app só exibe.
 */
function OwnerLine({ detail }: { readonly detail: CompanyDetail }) {
  const owner = detail.owner;
  if (owner === null || detail.owners === 0)
    return (
      <p className="flex items-start gap-2 rounded-md border border-destructive p-3 text-sm text-destructive">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          Empresa sem dono ativo. Ninguém administra a equipe nem a assinatura desta empresa.
        </span>
      </p>
    );
  const others = detail.owners - 1;
  return (
    <p className="min-w-0 text-base">
      <span className="text-muted-foreground">Dono: </span>
      <strong className="break-all">{owner.emailMasked}</strong>
      {others > 0 ? (
        <span className="text-muted-foreground">
          {' '}
          (e mais {formatCount(others)} {others === 1 ? 'dono' : 'donos'})
        </span>
      ) : null}
    </p>
  );
}

/**
 * Pessoas da empresa (spec 045, E1): papel, estado, e-mail mascarado e a situação da conta. "Abrir conta"
 * leva ao detalhe da conta (mascarado, sem auditoria); vínculo antigo sem conta não tem esse botão.
 */
function People({
  detail,
  self,
  onDone,
}: {
  readonly detail: CompanyDetail;
  readonly self: View;
  readonly onDone: () => void;
}) {
  const { navigate } = useAdmin();
  const holder = detail.holder;
  return (
    <div className="flex flex-col gap-3">
      <Facts
        items={[
          ['Pessoas', formatCount(detail.peopleTotal)],
          ['Convites pendentes', formatCount(detail.pendingInvitations)],
          [
            'Titular da assinatura',
            holder === null
              ? '—'
              : `${label(holder.status)} · e-mail ${holder.emailVerified ? 'confirmado' : 'não confirmado'} · desde ${formatDate(holder.createdAt)}`,
          ],
        ]}
      />
      {detail.people.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma pessoa.</p>
      ) : (
        <List label="Pessoas da empresa">
          {detail.people.map((person) => (
            <Row key={person.membershipId}>
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 break-all font-semibold">{person.emailMasked}</span>
                <Badge tone={person.role === 'OWNER' ? 'good' : 'neutral'}>
                  {label(person.role)}
                </Badge>
                {person.status === 'DISABLED' ? <Badge tone="bad">Vínculo desativado</Badge> : null}
                {person.account === null ? (
                  <Badge>Sem conta (vínculo antigo)</Badge>
                ) : (
                  <>
                    {person.account.status === 'DISABLED' ? (
                      <Badge tone="bad">Conta desativada</Badge>
                    ) : null}
                    {person.account.verified ? null : <Badge>E-mail não confirmado</Badge>}
                  </>
                )}
              </span>
              <span className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                <span>Desde {formatDate(person.createdAt)}</span>
                <span className="flex flex-wrap gap-2">
                  {/* Empresa removida: as pessoas só são vistas (restaure antes de mexer). */}
                  {detail.removedAt === null ? (
                    <MembershipActions detail={detail} person={person} onDone={onDone} />
                  ) : null}
                  {person.accountId === null ? null : (
                    <Button
                      ariaLabel={`Abrir conta ${person.emailMasked}`}
                      onClick={() => {
                        if (person.accountId !== null)
                          navigate({ name: 'account', accountId: person.accountId, from: self });
                      }}
                    >
                      Abrir conta
                    </Button>
                  )}
                </span>
              </span>
            </Row>
          ))}
        </List>
      )}
      {detail.peopleTotal > detail.people.length ? (
        <p className="text-xs text-muted-foreground">
          Mostrando {formatCount(detail.people.length)} de {formatCount(detail.peopleTotal)} pessoas
          (dono primeiro).
        </p>
      ) : null}
    </div>
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
      {/* Se o navegador fechar o diálogo à força no meio da ação, o erro aparece aqui fora. */}
      {open || error === undefined ? null : (
        <div className="basis-full">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      )}
      <Dialog
        open={open}
        title={suspend ? `Suspender ${detail.name}?` : `Reativar ${detail.name}?`}
        busy={busy}
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
  const self: View = { name: 'company', companyId, from };

  return (
    <>
      <div className="mb-2">
        <Button variant="ghost" onClick={() => navigate(from)}>
          <ArrowLeft aria-hidden className="size-4" />
          Voltar
        </Button>
      </div>
      <PageHeader title={data?.name ?? 'Empresa'} onRefresh={reload} busy={loading}>
        {data === undefined ? null : (
          <>
            {data.removedAt === null ? <StatusAction detail={data} onDone={reload} /> : null}
            <CompanyActions detail={data} onDone={reload} />
          </>
        )}
      </PageHeader>
      {error === undefined ? null : <Alert>{errorMessage(error)}</Alert>}
      {data === undefined ? (
        loading ? (
          <Loading />
        ) : null
      ) : (
        <div className="flex flex-col gap-4">
          {data.removedAt === null ? null : (
            <Alert>
              Empresa removida em {formatDateTime(data.removedAt)}. A equipe não a vê; restaure para
              voltar a mexer nela.
            </Alert>
          )}
          <OwnerLine detail={data} />
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
          <Card title="Pessoas">
            <People detail={data} self={self} onDone={reload} />
            {/* A removida não tem convites (a remoção revoga os pendentes; a lista dela é 404). */}
            {data.removedAt === null ? (
              <div className="mt-4">
                <Invitations detail={data} onDone={reload} />
              </div>
            ) : null}
          </Card>
          <Card title="Assinatura e uso">
            <Subscription detail={data} />
            {/* As ações da assinatura ficam na conta titular (spec 045, E4): a assinatura é da conta. */}
            {data.holder === null ? null : (
              <div className="mt-3">
                <Button
                  onClick={() => {
                    if (data.holder !== null)
                      navigate({ name: 'account', accountId: data.holder.accountId, from: self });
                  }}
                >
                  Abrir conta titular
                </Button>
              </div>
            )}
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
            <ChannelDisconnect detail={data} onDone={reload} />
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
