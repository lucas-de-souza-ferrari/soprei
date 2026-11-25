import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Input } from '../components/motion/input';
import { Loader } from '../components/motion/loader';
import { isStillSelected } from './company-api';
import { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
import { RetryAlert } from './RetryAlert';
import {
  type InvitationItem,
  type Member,
  STALE_MESSAGE,
  TEAM_PAGE_SIZE,
  teamApi,
  teamFailureOf,
} from './team-api';
import {
  assignableRoles,
  formatDate,
  formatDateTime,
  type InvitableRole,
  INVITATION_STATE_LABELS,
  invitableRoles,
  MEMBER_STATUS_LABELS,
  memberActions,
  resendWaitSeconds,
  type Role,
  ROLE_LABELS,
  roleChangeNeedsConfirmation,
} from './team-rules';

export interface TeamPageProps {
  readonly companyId: string;
  /** Papel e vínculo de quem está na tela (de `GET /account/companies`): só decidem o que mostrar. */
  readonly actor: { readonly role: Role; readonly membershipId: string };
  readonly permissions: readonly string[];
  /** Falha com mensagem de tela (texto) ou tratada por quem chama (login: `null`). */
  readonly settle: (error: unknown) => string | null;
  /** A empresa selecionada mudou (404 com outra empresa na sessão). */
  readonly onChanged: () => void;
}

type Notice = { tone: 'error' | 'success'; text: string } | null;
type Pending =
  | { kind: 'revoke'; invitation: InvitationItem }
  | { kind: 'disable'; member: Member }
  | { kind: 'role'; member: Member; role: Role };

export const INVITE_SUCCESS_MESSAGE = 'Convite criado. Enviamos o link para o e-mail informado.';
const EMAIL_PROBLEM = 'Informe um e-mail válido.';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SELECT_CLASS =
  'h-12 w-full rounded-xl border border-input bg-background px-3 text-base text-foreground focus-visible:outline-3 focus-visible:outline-ring';

/** Selo de texto (nunca só cor): `tone` escolhe só o token de cor, já coberto no teste de contraste. */
function Chip({
  tone,
  children,
}: {
  tone: 'success' | 'muted' | 'primary' | 'danger';
  children: string;
}) {
  const color = {
    success: 'text-(--color-success)',
    muted: 'text-muted-foreground',
    primary: 'text-primary',
    danger: 'text-destructive',
  }[tone];
  return (
    <span
      className={`rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {children}
    </span>
  );
}

function confirmationOf(pending: Pending): NonNullable<ConfirmDialogProps['request']> {
  if (pending.kind === 'revoke') {
    return {
      title: 'Revogar o convite?',
      text: `O link enviado para ${pending.invitation.email} deixa de funcionar.`,
      confirmLabel: 'Revogar',
    };
  }
  if (pending.kind === 'disable') {
    return {
      title: 'Desativar a pessoa?',
      text: `${pending.member.email} perde o acesso na próxima ação. Você pode reativá-la depois.`,
      confirmLabel: 'Desativar',
    };
  }
  return {
    title: 'Mudar o papel?',
    text: `${pending.member.email} passa de ${ROLE_LABELS[pending.member.role]} para ${ROLE_LABELS[pending.role]}. A mudança vale na próxima ação da pessoa.`,
    confirmLabel: 'Mudar papel',
  };
}

/**
 * Equipe da empresa (spec 025): membros, convites pendentes e o formulário de convite. As ações
 * mostradas são as que a hierarquia permite (espelho de `canManageRole`); o servidor é a barreira.
 * Mensagens só por `status` e `error.code`, nunca pelo texto do servidor. O e-mail do convidado só vive
 * em memória, nesta tela: nada vai a URL, `localStorage`, `sessionStorage`, título nem `console`.
 */
export function TeamPage({ companyId, actor, permissions, settle, onChanged }: TeamPageProps) {
  const canManage = permissions.includes('membership:manage');
  const [members, setMembers] = useState<Member[]>([]);
  const [membersNext, setMembersNext] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<InvitationItem[]>([]);
  const [invitationsNext, setInvitationsNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableRole>('AGENT');
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<Pending | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);

  const inviteRoles = useMemo(() => invitableRoles(actor.role), [actor.role]);
  const memberRoles = useMemo(() => assignableRoles(actor.role), [actor.role]);

  // O papel escolhido no formulário precisa existir entre os atribuíveis.
  const chosenRole: InvitableRole = inviteRoles.includes(role) ? role : (inviteRoles[0] ?? 'AGENT');

  /** Falha da API: sessão = quem chama; 404 = relê a sessão; senão o texto escolhido pelo site. */
  const explain = useCallback(
    async (error: unknown, stamp: number): Promise<string | null> => {
      const failure = teamFailureOf(error);
      if (failure.kind === 'session') {
        settle(error);
        return null;
      }
      if (failure.kind === 'changed') {
        try {
          const same = await isStillSelected(companyId);
          if (stamp !== generation.current) return null;
          if (!same) {
            onChanged();
            return null;
          }
          return STALE_MESSAGE;
        } catch (inner) {
          return stamp === generation.current ? settle(inner) : null;
        }
      }
      return failure.text;
    },
    [companyId, onChanged, settle],
  );

  const load = useCallback(async (): Promise<void> => {
    const stamp = ++generation.current;
    setLoadError(null);
    try {
      const [memberPage, invitationPage] = await Promise.all([
        teamApi.members(companyId, { limit: TEAM_PAGE_SIZE }),
        teamApi.invitations(companyId, { limit: TEAM_PAGE_SIZE }),
      ]);
      if (stamp !== generation.current) return;
      setMembers([...memberPage.items]);
      setMembersNext(memberPage.nextCursor);
      setInvitations([...invitationPage.items]);
      setInvitationsNext(invitationPage.nextCursor);
      setLoaded(true);
    } catch (error) {
      const text = await explain(error, stamp);
      if (stamp === generation.current && text !== null) setLoadError(text);
    }
  }, [companyId, explain]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load, attempt]);

  // O relógio só anda enquanto algum reenvio ainda está dentro do intervalo (dica de tela).
  const cooling = invitations.some((item) => resendWaitSeconds(item.lastSentAt, now) > 0);
  useEffect(() => {
    if (!cooling) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cooling]);

  /** Executa uma ação de escrita e recarrega as listas; a resposta tardia de outra empresa é descartada. */
  const act = async (work: () => Promise<void>, success?: string): Promise<boolean> => {
    if (busy) return false;
    const stamp = ++generation.current;
    setBusy(true);
    setNotice(null);
    try {
      await work();
      if (stamp !== generation.current) return false;
      setNow(Date.now());
      await load();
      setNotice(success === undefined ? null : { tone: 'success', text: success });
      return true;
    } catch (error) {
      const text = await explain(error, stamp);
      if (stamp === generation.current && text !== null) {
        setNotice({ tone: 'error', text });
        // 404 (item sumiu) e conflitos de estado pedem lista atualizada.
        if (text === STALE_MESSAGE) await load();
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const loadMore = async (kind: 'members' | 'invitations'): Promise<void> => {
    const cursor = kind === 'members' ? membersNext : invitationsNext;
    if (cursor === null || busy) return;
    const stamp = generation.current;
    setBusy(true);
    try {
      if (kind === 'members') {
        const page = await teamApi.members(companyId, { limit: TEAM_PAGE_SIZE, cursor });
        if (stamp !== generation.current) return;
        setMembers((current) => [...current, ...page.items]);
        setMembersNext(page.nextCursor);
      } else {
        const page = await teamApi.invitations(companyId, { limit: TEAM_PAGE_SIZE, cursor });
        if (stamp !== generation.current) return;
        setInvitations((current) => [...current, ...page.items]);
        setInvitationsNext(page.nextCursor);
      }
    } catch (error) {
      const text = await explain(error, stamp);
      if (stamp === generation.current && text !== null) setNotice({ tone: 'error', text });
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = async (): Promise<void> => {
    const current = pending;
    if (current === null) return;
    await act(async () => {
      if (current.kind === 'revoke') await teamApi.revoke(companyId, current.invitation.id);
      else if (current.kind === 'disable') {
        await teamApi.updateMember(companyId, current.member.id, { status: 'DISABLED' });
      } else await teamApi.updateMember(companyId, current.member.id, { role: current.role });
    });
    // Com sucesso ou falha o diálogo fecha (a mensagem fica na região de aviso).
    setPending(null);
  };

  if (loadError !== null) {
    return (
      <div className="grid gap-4">
        <div aria-live="polite">
          <RetryAlert
            text={loadError}
            disabled={false}
            onRetry={() => {
              setLoadError(null);
              setAttempt((value) => value + 1);
            }}
          />
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="grid place-items-center gap-3 py-10 text-sm text-muted-foreground">
        <Loader variant="spinner" size={28} label="Carregando a equipe" />
        <span aria-hidden="true">Carregando a equipe…</span>
      </div>
    );
  }

  const onlyMe = members.length <= 1;

  return (
    <div className="grid gap-8">
      <div aria-live="polite">
        {notice && (
          <Alert variant={notice.tone === 'error' ? 'destructive' : 'success'}>
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">{notice.text}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
      </div>

      {canManage && inviteRoles.length > 0 && (
        <form
          aria-labelledby="equipe-convidar"
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const value = email.normalize('NFKC').trim().toLowerCase();
            if (!EMAIL_SHAPE.test(value) || value.length > 254) {
              setEmailError(EMAIL_PROBLEM);
              return;
            }
            setEmailError(undefined);
            void act(async () => {
              await teamApi.invite(companyId, { email: value, role: chosenRole });
              setEmail('');
            }, INVITE_SUCCESS_MESSAGE);
          }}
        >
          <h2 id="equipe-convidar" className="m-0 text-xl font-semibold">
            Convidar uma pessoa
          </h2>
          <Input
            id="convite-email"
            label="E-mail da pessoa"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(value) => {
              setEmail(value);
              setEmailError(undefined);
            }}
            maxLength={254}
            error={emailError}
            required
          />
          <div className="grid gap-1">
            <label htmlFor="convite-papel" className="px-1 text-sm font-medium">
              Papel
            </label>
            <select
              id="convite-papel"
              className={SELECT_CLASS}
              value={chosenRole}
              onChange={(event) => setRole(event.target.value as InvitableRole)}
            >
              {inviteRoles.map((item) => (
                <option key={item} value={item}>
                  {ROLE_LABELS[item]}
                </option>
              ))}
            </select>
          </div>
          {email.trim() !== '' && (
            <p className="m-0 px-1 text-sm text-muted-foreground">
              O link será enviado para <strong className="text-foreground">{email.trim()}</strong>.
            </p>
          )}
          <div>
            <Button type="submit" disabled={busy}>
              Enviar convite
            </Button>
          </div>
        </form>
      )}

      <section aria-labelledby="equipe-membros" className="grid gap-3">
        <h2 id="equipe-membros" className="m-0 text-xl font-semibold">
          Membros
        </h2>
        <ul className="m-0 grid list-none gap-3 p-0">
          {members.map((member) => {
            const actions = memberActions(actor.role, actor.membershipId, member);
            const self = member.id === actor.membershipId;
            return (
              <li
                key={member.id}
                className="grid gap-2 rounded-xl border border-border bg-card p-4"
                data-testid="membro"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <strong className="[overflow-wrap:anywhere]">{member.email}</strong>
                  {self && <span className="text-sm text-muted-foreground">(você)</span>}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span>{ROLE_LABELS[member.role]}</span>
                  <Chip tone={member.status === 'ACTIVE' ? 'success' : 'muted'}>
                    {MEMBER_STATUS_LABELS[member.status]}
                  </Chip>
                  <span>Desde {formatDate(member.createdAt)}</span>
                </div>
                {canManage && actions.manage && (
                  <div className="flex flex-wrap items-end gap-2 pt-1">
                    <div className="grid min-w-[10rem] gap-1">
                      <label htmlFor={`papel-${member.id}`} className="px-1 text-xs">
                        Papel de {member.email}
                      </label>
                      <select
                        id={`papel-${member.id}`}
                        className={SELECT_CLASS}
                        value={member.role}
                        disabled={busy}
                        onChange={(event) => {
                          const next = event.target.value as Role;
                          if (next === member.role) return;
                          if (roleChangeNeedsConfirmation(member.role)) {
                            setPending({ kind: 'role', member, role: next });
                          } else {
                            void act(async () => {
                              await teamApi.updateMember(companyId, member.id, { role: next });
                            });
                          }
                        }}
                      >
                        {memberRoles.map((item) => (
                          <option key={item} value={item}>
                            {ROLE_LABELS[item]}
                          </option>
                        ))}
                      </select>
                    </div>
                    {member.status === 'ACTIVE' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => setPending({ kind: 'disable', member })}
                      >
                        Desativar
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await teamApi.updateMember(companyId, member.id, { status: 'ACTIVE' });
                          })
                        }
                      >
                        Reativar
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {membersNext !== null && (
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void loadMore('members')}
            >
              Carregar mais membros
            </Button>
          </div>
        )}
      </section>

      <section aria-labelledby="equipe-convites" className="grid gap-3">
        <h2 id="equipe-convites" className="m-0 text-xl font-semibold">
          Convites pendentes
        </h2>
        {invitations.length === 0 ? (
          <p className="m-0 text-muted-foreground">
            {onlyMe
              ? 'Você ainda é a única pessoa da equipe. Convide alguém.'
              : 'Nenhum convite pendente.'}
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0">
            {invitations.map((item) => {
              const wait = resendWaitSeconds(item.lastSentAt, now);
              const expired = item.state === 'EXPIRED';
              return (
                <li
                  key={item.id}
                  className="grid gap-2 rounded-xl border border-border bg-card p-4"
                  data-testid="convite"
                >
                  <strong className="[overflow-wrap:anywhere]">{item.email}</strong>
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>{ROLE_LABELS[item.role]}</span>
                    {item.fromPlatform && <Chip tone="muted">Convite da equipe do Soprei</Chip>}
                    <Chip tone={expired ? 'danger' : 'primary'}>
                      {INVITATION_STATE_LABELS[item.state]}
                    </Chip>
                    <span>Enviado em {formatDateTime(item.lastSentAt)}</span>
                    <span>
                      {expired ? 'Venceu em' : 'Vence em'} {formatDate(item.expiresAt)}
                    </span>
                  </div>
                  {canManage &&
                    memberActions(actor.role, actor.membershipId, { id: '', role: item.role })
                      .manage && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {/* O convite da plataforma só é reenviado por ela (spec 045, E3b); a equipe revoga. */}
                        {!item.fromPlatform && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy || wait > 0}
                            onClick={() =>
                              void act(async () => {
                                await teamApi.resend(companyId, item.id);
                              }, 'Convite reenviado.')
                            }
                          >
                            {wait > 0 ? `Reenviar (${String(wait)} s)` : 'Reenviar'}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setPending({ kind: 'revoke', invitation: item })}
                        >
                          Revogar
                        </Button>
                      </div>
                    )}
                </li>
              );
            })}
          </ul>
        )}
        {invitationsNext !== null && (
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void loadMore('invitations')}
            >
              Carregar mais convites
            </Button>
          </div>
        )}
      </section>

      <ConfirmDialog
        request={pending === null ? null : confirmationOf(pending)}
        busy={busy}
        onConfirm={() => void confirmPending()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
