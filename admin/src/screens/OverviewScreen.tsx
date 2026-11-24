import { useAdmin, useLoad } from '../admin-context';
import {
  ACCESS_LEVELS,
  CHANNEL_MODES,
  CHANNEL_STATES,
  PLAN_CODES,
  SUBSCRIPTION_STATES,
  countEntries,
  overviewSchema,
  type AttentionFilter,
} from '../contracts';
import { errorMessage, formatCents, formatCount, formatDate, label } from '../format';
import { Alert, Card, Loading, PageHeader, Stat, StatGrid } from '../ui';

/** Um agrupamento de chaves fixas, na ordem da lista, com o rótulo em português de cada chave. */
function GroupStats<K extends string>({
  keys,
  counts,
}: {
  readonly keys: readonly K[];
  readonly counts: Readonly<Record<K, number>>;
}) {
  return (
    <StatGrid>
      {countEntries(keys, counts).map(([key, value]) => (
        <Stat key={key} label={label(key)} value={formatCount(value)} />
      ))}
    </StatGrid>
  );
}

/** Visão geral (`GET /platform/overview`): cada "precisa de atenção" leva à lista filtrada. */
export function OverviewScreen() {
  const { navigate } = useAdmin();
  const { data, error, loading, reload } = useLoad(
    (api) => api.get('/platform/overview', overviewSchema),
    'overview',
  );
  const open = (attention: AttentionFilter) => () => navigate({ name: 'companies', attention });

  return (
    <>
      <PageHeader title="Visão geral" onRefresh={reload} busy={loading} />
      {error === undefined ? null : <Alert>{errorMessage(error)}</Alert>}
      {data === undefined ? (
        loading ? (
          <Loading />
        ) : null
      ) : (
        <div className="flex flex-col gap-4">
          <Card title="Precisa de atenção">
            <StatGrid>
              <Stat
                label="Mensagens pendentes há mais de 5 min"
                value={formatCount(data.attention.stalledPending)}
                alert={data.attention.stalledPending > 0}
                onOpen={open('pending_messages')}
              />
              <Stat
                label="Respostas não enviadas há mais de 5 min"
                value={formatCount(data.attention.unsentReplies)}
                alert={data.attention.unsentReplies > 0}
                onOpen={open('unsent_replies')}
              />
              <Stat
                label="Canais com token inválido"
                value={formatCount(data.attention.tokenInvalid)}
                alert={data.attention.tokenInvalid > 0}
                onOpen={open('token_invalid')}
              />
              <Stat
                label="Tokens que vencem em até 7 dias"
                value={formatCount(data.attention.tokensExpiringSoon)}
                alert={data.attention.tokensExpiringSoon > 0}
                onOpen={open('token_expiring')}
              />
              <Stat
                label="Pedidos de atendimento humano abertos"
                value={formatCount(data.attention.openHandoffs)}
                alert={data.attention.openHandoffs > 0}
                onOpen={open('open_handoffs')}
              />
            </StatGrid>
          </Card>
          <Card title="Empresas">
            <StatGrid>
              <Stat
                label="Ativas"
                value={formatCount(data.companies.active)}
                onOpen={() => navigate({ name: 'companies', status: 'active' })}
              />
              <Stat
                label="Suspensas"
                value={formatCount(data.companies.suspended)}
                onOpen={() => navigate({ name: 'companies', status: 'suspended' })}
              />
            </StatGrid>
          </Card>
          <Card title="Contas">
            <StatGrid>
              <Stat label="Total" value={formatCount(data.accounts.total)} />
              <Stat label="Confirmadas" value={formatCount(data.accounts.verified)} />
              <Stat label="Não confirmadas" value={formatCount(data.accounts.unverified)} />
              <Stat label="Desativadas" value={formatCount(data.accounts.disabled)} />
            </StatGrid>
          </Card>
          <Card title="Atendimento">
            <StatGrid>
              <Stat
                label="Mensagens (24 h)"
                value={formatCount(data.attendance.last24h.contactMessages)}
              />
              <Stat label="Respostas (24 h)" value={formatCount(data.attendance.last24h.replies)} />
              <Stat
                label="Respostas de fallback (24 h)"
                value={formatCount(data.attendance.last24h.fallbackReplies)}
              />
              <Stat
                label="Mensagens (7 dias)"
                value={formatCount(data.attendance.last7d.contactMessages)}
              />
              <Stat
                label="Respostas (7 dias)"
                value={formatCount(data.attendance.last7d.replies)}
              />
              <Stat
                label="Respostas de fallback (7 dias)"
                value={formatCount(data.attendance.last7d.fallbackReplies)}
              />
            </StatGrid>
          </Card>
          <Card title="Canal por estado">
            <GroupStats keys={CHANNEL_STATES} counts={data.channel.byState} />
          </Card>
          <Card title="Canal por modo">
            <GroupStats keys={CHANNEL_MODES} counts={data.channel.byMode} />
          </Card>
          {data.billingEnabled && data.subscriptions !== null ? (
            <>
              <Card title="Assinaturas por estado">
                <GroupStats keys={SUBSCRIPTION_STATES} counts={data.subscriptions.byState} />
              </Card>
              <Card title="Assinaturas por plano">
                <GroupStats keys={PLAN_CODES} counts={data.subscriptions.byPlan} />
              </Card>
              <Card title="Assinaturas por acesso">
                <GroupStats keys={ACCESS_LEVELS} counts={data.subscriptions.byAccess} />
              </Card>
              {data.paidOrdersThisMonth === null ? null : (
                <Card title="Pagos no mês">
                  <p className="mb-2 text-xs text-muted-foreground">
                    Desde {formatDate(data.paidOrdersThisMonth.monthStart)} (horário de Brasília).
                  </p>
                  <StatGrid>
                    <Stat
                      label="Pedidos pagos"
                      value={formatCount(data.paidOrdersThisMonth.count)}
                    />
                    <Stat
                      label="Total recebido"
                      value={formatCents(data.paidOrdersThisMonth.amountCents)}
                    />
                  </StatGrid>
                </Card>
              )}
            </>
          ) : (
            <Card title="Cobrança">
              <p className="text-sm text-muted-foreground">Cobrança desligada.</p>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
