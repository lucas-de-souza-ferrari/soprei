import { useCallback, useEffect, useMemo, useState } from 'react';
import { LogOut } from 'lucide-react';
import { ApiError, type ApiClient } from './api';
import { AdminContext, type View } from './admin-context';
import { sessionSchema } from './contracts';
import { SESSION_NOT_KEPT, errorMessage, signOutErrorMessage } from './format';
import { LoginScreen } from './screens/LoginScreen';
import { OverviewScreen } from './screens/OverviewScreen';
import { CompaniesScreen } from './screens/CompaniesScreen';
import { CompanyDetailScreen } from './screens/CompanyDetailScreen';
import { AccountsScreen } from './screens/AccountsScreen';
import { BillingScreen } from './screens/BillingScreen';
import { ChannelScreen } from './screens/ChannelScreen';
import { HealthScreen } from './screens/HealthScreen';
import { Alert, Button, Loading } from './ui';

type SessionState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'signed-out'; readonly notice?: string }
  | { readonly kind: 'signed-in'; readonly email: string };

const NAV: readonly (readonly [View['name'], string])[] = [
  ['overview', 'Visão geral'],
  ['companies', 'Empresas'],
  ['accounts', 'Contas'],
  ['billing', 'Cobrança'],
  ['channel', 'Canal'],
  ['health', 'Saúde'],
];

/** Tela da seção ativa no menu (o detalhe de uma empresa fica sob "Empresas"). */
function section(view: View): View['name'] {
  return view.name === 'company' ? 'companies' : view.name;
}

/**
 * App do admin da plataforma (spec 044, E3). A sessão é só o cookie `HttpOnly` do servidor: ao abrir, o
 * app pergunta `GET /platform/auth/session`; qualquer 401 volta à tela Entrar ("Sair" só sai quando o
 * servidor confirma; um 401 logo depois de um login aceito vira aviso de cookie não guardado). Nada vai ao
 * armazenamento do navegador, à barra de endereço nem ao título (src/page-rules.test.ts confere).
 */
export function App({ api }: { readonly api: ApiClient }) {
  const [session, setSession] = useState<SessionState>({ kind: 'checking' });
  const [view, setView] = useState<View>({ name: 'overview' });

  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | undefined>(undefined);

  /**
   * `afterLogin`: o login acabou de responder 204. Um 401 aqui não é "sem sessão" comum, e sim o
   * navegador que não guardou o cookie (`Secure` sem HTTPS, outro hostname): a tela Entrar avisa.
   */
  const checkSession = useCallback(
    (afterLogin = false) => {
      setSession({ kind: 'checking' });
      api.get('/platform/auth/session', sessionSchema).then(
        ({ email }) => setSession({ kind: 'signed-in', email }),
        (error: unknown) =>
          setSession(
            error instanceof ApiError && error.status === 401
              ? afterLogin
                ? { kind: 'signed-out', notice: SESSION_NOT_KEPT }
                : { kind: 'signed-out' }
              : { kind: 'signed-out', notice: errorMessage(error) },
          ),
      );
    },
    [api],
  );

  useEffect(() => checkSession(), [checkSession]);
  const afterLogin = useCallback(() => checkSession(true), [checkSession]);

  const expire = useCallback(() => {
    setSession({ kind: 'signed-out', notice: 'Sessão encerrada. Entre novamente.' });
    setSignOutError(undefined);
    setView({ name: 'overview' });
  }, []);

  const navigate = useCallback((next: View) => {
    setView(next);
    window.scrollTo(0, 0);
  }, []);

  const context = useMemo(() => ({ api, navigate, expire }), [api, navigate, expire]);

  /**
   * Só sai quando o servidor confirma: o cookie é `HttpOnly` e quem o apaga (e revoga a sessão) é ele.
   * Se o `POST` falha (503, 403, rede), a sessão continua viva e a tela diz isso; 401 já é sessão
   * encerrada, logo conta como saída.
   */
  const signOut = useCallback(async () => {
    setSigningOut(true);
    setSignOutError(undefined);
    try {
      await api.post('/platform/auth/logout');
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setSignOutError(signOutErrorMessage(error));
        setSigningOut(false);
        return;
      }
    }
    setSigningOut(false);
    setSignOutError(undefined);
    setSession({ kind: 'signed-out' });
    setView({ name: 'overview' });
  }, [api]);

  if (session.kind === 'checking')
    return (
      <main className="mx-auto max-w-md p-4">
        <Loading />
      </main>
    );

  if (session.kind === 'signed-out')
    return <LoginScreen api={api} notice={session.notice} onSignedIn={afterLogin} />;

  return (
    <AdminContext.Provider value={context}>
      <header className="border-b border-border bg-card text-card-foreground">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <span className="font-semibold">Soprei Admin</span>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm text-muted-foreground">{session.email}</span>
            <Button variant="ghost" onClick={() => void signOut()} disabled={signingOut}>
              <LogOut aria-hidden className="size-4" />
              {signingOut ? 'Saindo…' : 'Sair'}
            </Button>
          </div>
        </div>
        <nav aria-label="Seções" className="mx-auto max-w-5xl px-4 pb-2">
          <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
            {NAV.map(([name, text]) => {
              const current = section(view) === name;
              return (
                <li key={name}>
                  <button
                    type="button"
                    aria-current={current ? 'page' : undefined}
                    onClick={() => navigate({ name } as View)}
                    className={`min-h-10 rounded-md px-3 text-sm ${
                      current
                        ? 'bg-muted font-semibold text-foreground'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {text}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-4">
        {signOutError === undefined ? null : <Alert>{signOutError}</Alert>}
        <Screen view={view} />
      </main>
    </AdminContext.Provider>
  );
}

function Screen({ view }: { readonly view: View }) {
  switch (view.name) {
    case 'overview':
      return <OverviewScreen />;
    case 'companies':
      return (
        <CompaniesScreen
          key={`${view.status ?? ''}|${view.attention ?? ''}`}
          initialStatus={view.status}
          initialAttention={view.attention}
        />
      );
    case 'company':
      return (
        <CompanyDetailScreen key={view.companyId} companyId={view.companyId} from={view.from} />
      );
    case 'accounts':
      return <AccountsScreen />;
    case 'billing':
      return <BillingScreen />;
    case 'channel':
      return <ChannelScreen />;
    case 'health':
      return <HealthScreen />;
  }
}
