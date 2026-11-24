import { useAdmin, useLoad } from '../admin-context';
import { overviewSchema, type AttentionFilter, type Group } from '../contracts';
import { errorMessage, formatCents, formatCount, label } from '../format';
import { Alert, Card, Loading, PageHeader, Stat, StatGrid } from '../ui';

function GroupStats({ group }: { readonly group: Group }) {
  if (group.length === 0) return <p className="text-sm text-muted-foreground">Nenhum.</p>;
  return (
    <StatGrid>
      {group.map((item) => (
        <Stat key={item.key} label={label(item.key)} value={formatCount(item.count)} />
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
                value={formatCount(data.attention.pendingMessages)}
                alert={data.attention.pendingMessages > 0}
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
                value={formatCount(data.attention.tokenExpiring)}
                alert={data.attention.tokenExpiring > 0}
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
            <GroupStats group={data.companies} />
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
                value={formatCount(data.traffic.last24h.contactMessages)}
              />
              <Stat label="Respostas (24 h)" value={formatCount(data.traffic.last24h.replies)} />
              <Stat
                label="Respostas de fallback (24 h)"
                value={formatCount(data.traffic.last24h.fallbacks)}
              />
              <Stat
                label="Mensagens (7 dias)"
                value={formatCount(data.traffic.last7d.contactMessages)}
              />
              <Stat label="Respostas (7 dias)" value={formatCount(data.traffic.last7d.replies)} />
              <Stat
                label="Respostas de fallback (7 dias)"
                value={formatCount(data.traffic.last7d.fallbacks)}
              />
            </StatGrid>
          </Card>
          <Card title="Canal por estado">
            <GroupStats group={data.channel.byState} />
          </Card>
          <Card title="Canal por modo">
            <GroupStats group={data.channel.byMode} />
          </Card>
          {data.billingEnabled && data.subscriptions !== null ? (
            <>
              <Card title="Assinaturas por estado">
                <GroupStats group={data.subscriptions.byState} />
              </Card>
              <Card title="Assinaturas por plano">
                <GroupStats group={data.subscriptions.byPlan} />
              </Card>
              {data.paidThisMonth === null ? null : (
                <Card title="Pagos no mês">
                  <StatGrid>
                    <Stat label="Pedidos pagos" value={formatCount(data.paidThisMonth.count)} />
                    <Stat
                      label="Total recebido"
                      value={formatCents(data.paidThisMonth.amountCents)}
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
