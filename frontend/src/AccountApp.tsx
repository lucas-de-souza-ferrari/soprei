import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

const companySchema = z.object({
  clientId: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  role: z.enum(['OWNER', 'ADMIN', 'AGENT', 'VIEWER']),
});
const companiesSchema = z.object({ items: z.array(companySchema) });
const sessionSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  selectedClientId: z.uuid().nullable(),
});
type Company = z.infer<typeof companySchema>;
type Session = z.infer<typeof sessionSchema>;
const roles = {
  OWNER: 'Proprietário',
  ADMIN: 'Administrador',
  AGENT: 'Atendente',
  VIEWER: 'Somente leitura',
} as const;
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Soprei-Client': 'web' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new ApiError(
      response.status,
      response.status === 401
        ? 'Entre novamente ou confira suas credenciais.'
        : response.status === 403
          ? 'Confirme seu e-mail ou confira seu acesso.'
          : response.status === 429
            ? 'Muitas tentativas. Aguarde antes de tentar novamente.'
            : 'Não foi possível concluir. Tente novamente mais tarde.',
    );
  return response.status === 204 ? undefined : response.json();
}

export function AccountApp() {
  const [page, setPage] = useState<'login' | 'register' | 'verify' | 'companies'>(
    location.pathname === '/criar-conta'
      ? 'register'
      : location.pathname === '/confirmar-email'
        ? 'verify'
        : 'login',
  );
  const [session, setSession] = useState<Session | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const navigate = (next: typeof page) => {
    setPage(next);
    setMessage('');
    history.replaceState(
      null,
      '',
      next === 'companies'
        ? '/painel/empresas'
        : next === 'register'
          ? '/criar-conta'
          : next === 'verify'
            ? '/confirmar-email'
            : '/entrar',
    );
  };

  const load = async (stamp: number) => {
    const current = sessionSchema.parse(await api('/auth/session'));
    const list = companiesSchema.parse(await api('/account/companies'));
    if (generation.current !== stamp) return;
    setSession(current);
    setCompanies(list.items);
    setPage('companies');
    history.replaceState(null, '', '/painel/empresas');
  };
  useEffect(() => {
    const stamp = ++generation.current;
    void load(stamp)
      .catch(() => {
        if (generation.current === stamp) {
          setSession(null);
          setCompanies([]);
        }
      })
      .finally(() => {
        if (generation.current === stamp) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, []);

  const perform = async (action: (stamp: number) => Promise<void>) => {
    if (busy) return;
    const stamp = generation.current;
    setBusy(true);
    setMessage('');
    try {
      await action(stamp);
    } catch (error) {
      if (stamp === generation.current) {
        if (error instanceof ApiError && error.status === 401 && session !== null) {
          generation.current++;
          setSession(null);
          setCompanies([]);
          setName('');
          setEmail('');
          setPassword('');
          setToken('');
          setBusy(false);
          navigate('login');
        }
        setMessage(
          error instanceof z.ZodError
            ? 'Resposta inválida do servidor.'
            : error instanceof Error
              ? error.message
              : 'Serviço indisponível.',
        );
      }
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };
  const submit = async () => {
    const stamp = generation.current;
    if (page === 'register') {
      await api('/auth/register', { email, password });
      if (stamp === generation.current) {
        navigate('verify');
        setMessage('Confira seu e-mail e cole o código abaixo.');
      }
    } else if (page === 'verify') {
      await api('/auth/verify-email', { email, password, token });
      if (stamp === generation.current) {
        setToken('');
        setPassword('');
        navigate('login');
        setMessage('E-mail confirmado. Você já pode entrar.');
      }
    } else {
      await api('/auth/login', { email, password });
      if (stamp === generation.current) {
        setPassword('');
        await load(stamp);
      }
    }
  };
  const logout = () => {
    const stamp = ++generation.current;
    setSession(null);
    setCompanies([]);
    setName('');
    setEmail('');
    setPassword('');
    setToken('');
    navigate('login');
    setBusy(true);
    void api('/auth/logout', {})
      .catch(() => {
        if (stamp === generation.current)
          setMessage('Saída local realizada; não foi possível confirmar a revogação no servidor.');
      })
      .finally(() => {
        if (stamp === generation.current) setBusy(false);
      });
  };

  return (
    <div className="account-shell">
      <a href="/" className="account-brand">
        <img src="/soprei-logo.svg" alt="Soprei — início" />
      </a>
      <main className="account-card">
        <p className="eyebrow">SEU ESPAÇO NO SOPREI</p>
        <h1>
          {page === 'companies'
            ? 'Suas empresas'
            : page === 'register'
              ? 'Vamos começar.'
              : page === 'verify'
                ? 'Confirme seu e-mail.'
                : 'Que bom ter você aqui.'}
        </h1>
        {message && (
          <p role="status" className="account-message">
            {message}
          </p>
        )}
        {page === 'companies' && session ? (
          <>
            <div className="account-person">
              <span>{session.email}</span>
              <button type="button" onClick={logout}>
                Sair
              </button>
            </div>
            <p>Escolha uma empresa para trabalhar ou crie um novo espaço.</p>
            {companies.length === 0 && (
              <p className="account-empty">Você ainda não tem empresas. Crie a primeira abaixo.</p>
            )}
            <ul className="company-list">
              {companies.map((company) => (
                <li key={company.clientId}>
                  <div>
                    <strong>{company.name}</strong>
                    <small>{roles[company.role]}</small>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async (stamp) => {
                        await api(`/account/companies/${company.clientId}/select`, {});
                        await load(stamp);
                      })
                    }
                  >
                    {session.selectedClientId === company.clientId ? 'Selecionada ✓' : 'Selecionar'}
                  </button>
                </li>
              ))}
            </ul>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async (stamp) => {
                  companySchema.parse(await api('/account/companies', { name }));
                  if (generation.current === stamp) setName('');
                  await load(stamp);
                });
              }}
            >
              <label htmlFor="company-name">Nome da empresa</label>
              <input
                id="company-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={200}
              />
              <button className="button primary" disabled={busy}>
                Criar empresa
              </button>
            </form>
          </>
        ) : (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform(submit);
              }}
            >
              <label htmlFor="email">E-mail</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                maxLength={254}
              />
              <label htmlFor="password">Senha</label>
              <input
                id="password"
                type="password"
                autoComplete={page === 'register' ? 'new-password' : 'current-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={page === 'register' ? 12 : 1}
                maxLength={128}
              />
              {page === 'register' && <small>Use uma senha com pelo menos 12 caracteres.</small>}
              {page === 'verify' && (
                <>
                  <label htmlFor="verification">Código recebido por e-mail</label>
                  <input
                    id="verification"
                    autoComplete="one-time-code"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    required
                  />
                </>
              )}
              <button className="button primary" disabled={busy}>
                {busy
                  ? 'Aguarde…'
                  : page === 'register'
                    ? 'Criar conta'
                    : page === 'verify'
                      ? 'Confirmar e-mail'
                      : 'Entrar'}
              </button>
            </form>
            <div className="account-links">
              <button
                disabled={busy}
                onClick={() => navigate(page === 'login' ? 'register' : 'login')}
              >
                {page === 'login' ? 'Criar minha conta' : 'Já tenho uma conta'}
              </button>
              {page !== 'verify' && (
                <button disabled={busy} onClick={() => navigate('verify')}>
                  Confirmar e-mail
                </button>
              )}
              {page === 'verify' && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await api('/auth/resend-verification', { email, password });
                      setMessage('Confira seu e-mail. O código anterior foi substituído.');
                    })
                  }
                >
                  Reenviar código
                </button>
              )}
            </div>
          </>
        )}
      </main>
      <p className="account-footnote">Inteligência para conversas que importam.</p>
    </div>
  );
}
