import { Eye, EyeOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { passwordProblem, PASSWORD_HINT } from '../account-flow';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { Input } from '../components/motion/input';
import { Loader } from '../components/motion/loader';
import {
  INVITE_FAILURE_MESSAGE,
  INVITE_RATE_MESSAGE,
  INVITE_ROLE_LABELS,
  INVITE_UNAVAILABLE_MESSAGE,
  inviteFailureKind,
  invitePreviewSchema,
  type InvitePreview,
  sameEmail,
} from './invite-flow';

export interface InvitePageProps {
  /** Token em memória (lido do fragmento pelo `main.tsx`); `null` = abre a falha sem chamar a API. */
  readonly token: string | null;
  /** Quem está logado agora (e-mail da conta), ou `null`. */
  readonly session: { readonly email: string } | null;
  /** Vai ao login com o convite guardado em memória; depois do login volta aqui. */
  readonly onNeedLogin: () => void;
  /** Sai da conta atual e vai ao login (o convite continua em memória). */
  readonly onSwitchAccount: () => void;
  /** Convite aceito pela conta logada: o site abre o painel da empresa nova. */
  readonly onAccepted: () => void;
  /** Conta criada pelo convite: o site leva ao login com a mensagem de sucesso. */
  readonly onCreated: (email: string) => void;
  /** Abandona o convite (falha ou desistência): volta à entrada. */
  readonly onClose: () => void;
}

type View =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; preview: InvitePreview };

/**
 * Página pública `/convite` (spec 025). Escolhe a jornada pelo `preview` (que não consome o convite):
 * conta existente com a sessão do mesmo e-mail aceita direto; sem sessão vai ao login e volta; conta nova
 * define a senha. Toda falha de convite é a mesma mensagem, que nunca diz qual foi o problema nem para
 * qual e-mail o convite foi enviado. O texto de erro do servidor nunca é lido.
 */
export function InvitePage({
  token,
  session,
  onNeedLogin,
  onSwitchAccount,
  onAccepted,
  onCreated,
  onClose,
}: InvitePageProps) {
  const [view, setView] = useState<View>(token === null ? { kind: 'failed' } : { kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [problem, setProblem] = useState<{
    field: 'password' | 'confirmation';
    text: string;
  } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (token === null) {
      setView({ kind: 'failed' });
      return;
    }
    const stamp = ++generation.current;
    setView({ kind: 'loading' });
    api('/auth/invitations/preview', { token })
      .then((body) => {
        if (stamp !== generation.current) return;
        setView({ kind: 'ready', preview: invitePreviewSchema.parse(body) });
      })
      .catch((error: unknown) => {
        if (stamp !== generation.current) return;
        const kind =
          error instanceof ApiError ? inviteFailureKind(error.status, error.code) : 'unavailable';
        setView({ kind: kind === 'invalid' ? 'failed' : 'unavailable' });
      });
    return () => {
      generation.current++;
    };
  }, [token, attempt]);

  /** Falha de uma ação (aceitar): a mesma mensagem única para qualquer problema do convite. */
  const handleFailure = useCallback(
    (error: unknown): void => {
      const kind =
        error instanceof ApiError ? inviteFailureKind(error.status, error.code) : 'unavailable';
      if (kind === 'session') onNeedLogin();
      else if (kind === 'invalid') setView({ kind: 'failed' });
      else if (kind === 'rate') setNotice(INVITE_RATE_MESSAGE);
      else if (kind === 'policy') {
        setProblem({ field: 'password', text: passwordProblem(password) ?? PASSWORD_HINT });
      } else setNotice(INVITE_UNAVAILABLE_MESSAGE);
    },
    [onNeedLogin, password],
  );

  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return;
    const stamp = generation.current;
    setBusy(true);
    setNotice(null);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      if (stamp === generation.current) handleFailure(error);
    } finally {
      setBusy(false);
    }
  };

  if (view.kind === 'loading') {
    return (
      <div className="grid place-items-center gap-3 py-10 text-sm text-muted-foreground">
        <Loader variant="spinner" size={28} label="Verificando o convite" />
        <span aria-hidden="true">Verificando o convite…</span>
      </div>
    );
  }

  if (view.kind === 'failed' || view.kind === 'unavailable') {
    const failed = view.kind === 'failed';
    return (
      <div className="grid gap-4">
        <div aria-live="polite">
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">
                {failed ? INVITE_FAILURE_MESSAGE : INVITE_UNAVAILABLE_MESSAGE}
              </AlertDescription>
            </AlertContent>
          </Alert>
        </div>
        <div className="flex flex-wrap gap-2">
          {!failed && (
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              Tentar de novo
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Ir para a entrada
          </Button>
        </div>
      </div>
    );
  }

  const { preview } = view;
  const intro = (
    <p className="m-0">
      Você foi convidado para a empresa <strong>{preview.companyName}</strong>, com o papel de{' '}
      <strong>{INVITE_ROLE_LABELS[preview.role]}</strong>.
    </p>
  );
  const status = (
    <div aria-live="polite">
      {notice !== null && (
        <Alert variant="destructive">
          <AlertIcon />
          <AlertContent>
            <AlertDescription className="text-inherit">{notice}</AlertDescription>
          </AlertContent>
        </Alert>
      )}
    </div>
  );

  if (preview.accountState === 'EXISTS') {
    if (session === null) {
      return (
        <div className="grid gap-4">
          {intro}
          <p className="m-0 text-sm text-muted-foreground">
            Entre com a sua conta para aceitar. Depois do login, você volta para este convite.
          </p>
          <div>
            <Button onClick={onNeedLogin}>Entrar para aceitar</Button>
          </div>
        </div>
      );
    }
    const matches = sameEmail(session.email, preview.email);
    return (
      <div className="grid gap-4">
        {intro}
        {status}
        <p className="m-0 text-sm text-muted-foreground">
          Você está entrando como <strong className="text-foreground">{session.email}</strong>.
          {matches ? '' : ' Este convite foi enviado para outro e-mail.'}
        </p>
        <div className="flex flex-wrap gap-2">
          {matches && (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api('/auth/invitations/accept', { token });
                  onAccepted();
                })
              }
            >
              Entrar na empresa {preview.companyName}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={onSwitchAccount}>
            Sair e entrar com outra conta
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const text = passwordProblem(password);
        if (text !== null) {
          setProblem({ field: 'password', text });
          return;
        }
        if (password !== confirmation) {
          setProblem({
            field: 'confirmation',
            text: 'As senhas não coincidem. Confira e tente novamente.',
          });
          return;
        }
        void run(async () => {
          await api('/auth/invitations/accept-new', { token, password });
          setPassword('');
          setConfirmation('');
          onCreated(preview.email);
        });
      }}
    >
      {intro}
      {status}
      <p className="m-0 text-sm text-muted-foreground">
        Crie uma senha para a sua conta no Soprei. O e-mail do convite é o da conta:{' '}
        <strong className="text-foreground [overflow-wrap:anywhere]">{preview.email}</strong>.
      </p>
      <Input
        id="convite-senha"
        label="Senha"
        type={showPassword ? 'text' : 'password'}
        autoComplete="new-password"
        value={password}
        onChange={(value) => {
          setPassword(value);
          if (problem?.field === 'password') setProblem(null);
        }}
        required
        maxLength={128}
        aria-describedby="convite-senha-dica"
        error={problem?.field === 'password' ? problem.text : undefined}
        rightIcon={
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowPassword(!showPassword)}
            aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
            className="rounded-full"
          >
            {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
        }
      />
      <p id="convite-senha-dica" className="-mt-2 px-1 text-xs text-muted-foreground">
        {PASSWORD_HINT}
      </p>
      <Input
        id="convite-confirmacao"
        label="Confirmar senha"
        type={showPassword ? 'text' : 'password'}
        autoComplete="new-password"
        value={confirmation}
        onChange={(value) => {
          setConfirmation(value);
          if (problem?.field === 'confirmation') setProblem(null);
        }}
        required
        maxLength={128}
        error={problem?.field === 'confirmation' ? problem.text : undefined}
      />
      <Button type="submit" size="lg" disabled={busy} className="w-full">
        Criar conta
      </Button>
    </form>
  );
}
