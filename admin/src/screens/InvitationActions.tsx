import { useState } from 'react';
import { useLoad } from '../admin-context';
import {
  MEMBERSHIP_ROLES,
  createCompanyResponseSchema,
  invitationPageSchema,
  type CompanyDetail,
  type Invitation,
  type MembershipRole,
} from '../contracts';
import { errorMessage, formatCount, formatDateTime, label } from '../format';
import { Alert, Badge, Button, List, Loading, Row, Select } from '../ui';
import { ActionDialog, TextInput, type ActionSpec } from './CompanyActions';

type InvitationAction = 'invite' | 'resend' | 'revoke';

/**
 * Convites pendentes da empresa e as ações da plataforma sobre eles (spec 045, E3b): "Convidar pessoa"
 * (e-mail e papel, inclusive dono; o e-mail fica só no estado do diálogo e some ao fechar), "Reenviar" e
 * "Revogar". A lista vem com o e-mail mascarado; nada é guardado no navegador.
 */
export function Invitations({
  detail,
  onDone,
}: {
  readonly detail: CompanyDetail;
  readonly onDone: () => void;
}) {
  const base = `/platform/companies/${encodeURIComponent(detail.id)}/invitations`;
  const { data, error, loading, reload } = useLoad(
    (api) => api.get(`${base}?limit=50`, invitationPageSchema),
    `${detail.id}|${detail.updatedAt}`,
  );
  const [current, setCurrent] = useState<{
    readonly action: InvitationAction;
    readonly invitation?: Invitation;
  } | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MembershipRole>('AGENT');
  const active = detail.status === 'ACTIVE' && detail.removedAt === null;

  function open(action: InvitationAction, invitation?: Invitation) {
    setEmail('');
    setRole('AGENT');
    setCurrent({ action, ...(invitation === undefined ? {} : { invitation }) });
  }
  function close() {
    // O e-mail digitado não fica em memória depois do diálogo.
    setEmail('');
    setCurrent(null);
  }
  function done() {
    reload();
    onDone();
  }

  const target = current?.invitation;
  const spec: ActionSpec | null =
    current === null
      ? null
      : current.action === 'invite'
        ? {
            title: `Convidar pessoa para ${detail.name}?`,
            effect:
              'A pessoa recebe por e-mail um link de uso único, válido por 7 dias. A conta nasce quando ela abre o link e define a própria senha; quem já tem conta entra e aceita. Convidar como dono dá a ela a propriedade da empresa ao aceitar.',
            confirm: 'Enviar convite',
            danger: role === 'OWNER',
            code: false,
            path: base,
            body: { email: email.trim(), role },
            kind: 'invite',
            ready: /^[^@\s]+@[^@\s]+$/.test(email.trim()),
            fields: (
              <>
                <TextInput
                  label="E-mail da pessoa"
                  name="invite-email"
                  value={email}
                  onChange={setEmail}
                  maxLength={254}
                />
                <Select<MembershipRole>
                  label="Papel"
                  value={role}
                  onChange={setRole}
                  options={MEMBERSHIP_ROLES.map((key) => [key, label(key)] as const)}
                />
              </>
            ),
          }
        : current.action === 'resend'
          ? {
              title: `Reenviar o convite para ${target?.emailMasked ?? ''}?`,
              effect:
                'Um link novo sai por e-mail e o anterior deixa de valer; a validade volta a 7 dias. Há intervalo de 60 s entre envios e no máximo 6 envios por convite.',
              confirm: 'Reenviar',
              danger: false,
              code: false,
              path: `${base}/${encodeURIComponent(target?.id ?? '')}/resend`,
              kind: 'resend',
            }
          : {
              title: `Revogar o convite para ${target?.emailMasked ?? ''}?`,
              effect: 'O link deixa de valer na hora. Dá para convidar de novo depois.',
              confirm: 'Revogar convite',
              danger: true,
              code: false,
              path: `${base}/${encodeURIComponent(target?.id ?? '')}/revoke`,
              kind: 'revoke',
            };

  const items = data?.items ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Convites</h3>
        {active ? <Button onClick={() => open('invite')}>Convidar pessoa</Button> : null}
      </div>
      {error === undefined ? null : <Alert>{errorMessage(error)}</Alert>}
      {data === undefined ? (
        loading ? (
          <Loading />
        ) : null
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum convite pendente.</p>
      ) : (
        <List label="Convites pendentes">
          {items.map((invitation) => (
            <Row key={invitation.id}>
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 break-all font-semibold">{invitation.emailMasked}</span>
                <Badge tone={invitation.role === 'OWNER' ? 'good' : 'neutral'}>
                  {label(invitation.role)}
                </Badge>
                {invitation.state === 'EXPIRED' ? <Badge tone="bad">Vencido</Badge> : null}
                <Badge>
                  {invitation.invitedBy === 'platform' ? 'Pela plataforma' : 'Pela equipe'}
                </Badge>
              </span>
              <span className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                <span>
                  Vale até {formatDateTime(invitation.expiresAt)} ·{' '}
                  {formatCount(invitation.sendCount)}{' '}
                  {invitation.sendCount === 1 ? 'envio' : 'envios'}
                </span>
                {active ? (
                  <span className="flex flex-wrap gap-2">
                    <Button
                      ariaLabel={`Reenviar convite ${invitation.emailMasked}`}
                      onClick={() => open('resend', invitation)}
                    >
                      Reenviar
                    </Button>
                    <Button
                      variant="danger"
                      ariaLabel={`Revogar convite ${invitation.emailMasked}`}
                      onClick={() => open('revoke', invitation)}
                    >
                      Revogar
                    </Button>
                  </span>
                ) : null}
              </span>
            </Row>
          ))}
        </List>
      )}
      <ActionDialog
        key={current === null ? 'fechado' : `${current.action}|${current.invitation?.id ?? ''}`}
        spec={spec}
        onClose={close}
        onDone={done}
      />
    </div>
  );
}

/**
 * "Nova empresa" (spec 045, E3b): nome, slug e o e-mail de quem será o dono. A empresa e o convite de dono
 * nascem juntos; depois a tela abre o detalhe da empresa nova. O e-mail fica só no estado do diálogo.
 */
export function NewCompany({ onCreated }: { readonly onCreated: (companyId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');

  function start() {
    setName('');
    setSlug('');
    setEmail('');
    setOpen(true);
  }
  function close() {
    setEmail('');
    setOpen(false);
  }

  const spec: ActionSpec | null = open
    ? {
        title: 'Criar empresa?',
        effect:
          'A empresa nasce ativa e sem assinatura, e a pessoa recebe por e-mail o convite para ser a dona. O slug não muda depois. Com a cobrança ligada, ao aceitar, a empresa passa a contar no plano da pessoa, mesmo que passe do limite de empresas dele.',
        confirm: 'Criar empresa',
        danger: false,
        code: false,
        path: '/platform/companies',
        body: { name: name.trim(), slug, ownerEmail: email.trim() },
        kind: 'create',
        ready:
          name.trim().length > 0 &&
          name.trim().length <= 120 &&
          /^[a-z0-9-]{3,63}$/.test(slug) &&
          /^[^@\s]+@[^@\s]+$/.test(email.trim()),
        submit: async (api, body) => {
          const created = await api.postFor(
            '/platform/companies',
            body,
            createCompanyResponseSchema,
          );
          onCreated(created.companyId);
        },
        fields: (
          <>
            <TextInput
              label="Nome"
              name="company-name"
              value={name}
              onChange={setName}
              maxLength={120}
            />
            <TextInput
              label="Slug"
              name="company-slug"
              value={slug}
              onChange={(value) => setSlug(value.toLowerCase())}
              maxLength={63}
              hint="De 3 a 63 letras minúsculas, dígitos e hífen. Não muda depois."
            />
            <TextInput
              label="E-mail de quem será o dono"
              name="owner-email"
              value={email}
              onChange={setEmail}
              maxLength={254}
            />
          </>
        ),
      }
    : null;

  return (
    <>
      <Button variant="primary" onClick={start}>
        Nova empresa
      </Button>
      <ActionDialog
        key={open ? 'aberto' : 'fechado'}
        spec={spec}
        onClose={close}
        onDone={() => undefined}
      />
    </>
  );
}
