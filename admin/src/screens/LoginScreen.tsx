import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../api';
import { loginErrorMessage, normalizeCode } from '../format';
import { Alert, Button } from '../ui';

const FIELD = 'min-h-10 w-full rounded-md border border-input bg-card px-3 text-card-foreground';

/**
 * Entrar (spec 044, E1 e E3): e-mail, senha e o código de 6 dígitos do aplicativo autenticador, numa só
 * chamada. A falha é sempre a mesma mensagem (o servidor não diz qual dos três errou). Os campos só vivem
 * no estado do React; depois da tentativa a senha e o código são apagados.
 */
export function LoginScreen({
  api,
  notice,
  onSignedIn,
}: {
  readonly api: ApiClient;
  readonly notice: string | undefined;
  readonly onSignedIn: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (code.length !== 6) {
      setError('O código tem 6 dígitos.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.post('/platform/auth/login', { email: email.trim(), password, code });
      onSignedIn();
    } catch (failure) {
      setError(loginErrorMessage(failure));
      setPassword('');
      setCode('');
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-8">
      <h1 className="mb-1 text-2xl font-semibold">Soprei Admin</h1>
      <p className="mb-4 text-sm text-muted-foreground">Acesso restrito ao dono da plataforma.</p>
      {notice !== undefined && error === undefined ? <Alert tone="info">{notice}</Alert> : null}
      {error === undefined ? null : <Alert>{error}</Alert>}
      <form
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
      >
        <label className="flex flex-col gap-1 text-sm">
          E-mail
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            maxLength={320}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Senha
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Código do autenticador
          <input
            type="text"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            required
            value={code}
            onChange={(event) => setCode(normalizeCode(event.target.value))}
            className={`${FIELD} tracking-widest`}
          />
        </label>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </Button>
      </form>
    </main>
  );
}
