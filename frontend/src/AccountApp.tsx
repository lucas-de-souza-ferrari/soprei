import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { z } from 'zod';
import { api, ApiError } from './api';
import { Logo } from './components/logo';
import { Alert, AlertContent, AlertDescription, AlertIcon } from './components/motion/alert';
import { Button } from './components/motion/button';
import { Card, CardContent, CardHeader, CardTitle } from './components/motion/card';
import { Input } from './components/motion/input';
import { Loader } from './components/motion/loader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/motion/tabs';
import { ThemeToggle } from './components/motion/theme-toggle';
import { CompanyArea } from './company/CompanyArea';
import { allowedPages, isAreaPage } from './company/company-nav';
import {
  isNeutralResetRequestError,
  pageForPath,
  pathForPage,
  passwordProblem,
  PASSWORD_HINT,
  RESET_INVALID_CODE_MESSAGE,
  RESET_NEUTRAL_MESSAGE,
  RESET_SUCCESS_MESSAGE,
  type AccountPage,
} from './account-flow';
import { isCompleteVerificationCode } from './verification-code';
import { VerificationField } from './verification-field';

const companySchema = z.object({
  companyId: z.uuid(),
  membershipId: z.uuid(),
  name: z.string(),
  role: z.enum(['OWNER', 'ADMIN', 'AGENT', 'VIEWER']),
  // Permissões do papel, derivadas no servidor (spec 023); só decidem quais abas aparecem.
  permissions: z.array(z.string().max(64)).max(32).default([]),
});
const companiesSchema = z.object({ items: z.array(companySchema) });
const sessionSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  selectedCompanyId: z.uuid().nullable(),
});
type Company = z.infer<typeof companySchema>;
type Session = z.infer<typeof sessionSchema>;
type Page = AccountPage;
type Notice = { tone: 'error' | 'info' | 'success'; text: string } | null;
const roles = {
  OWNER: 'Proprietário',
  ADMIN: 'Administrador',
  AGENT: 'Atendente',
  VIEWER: 'Somente leitura',
} as const;
function PasswordToggle({
  shown,
  onToggle,
  showLabel,
  hideLabel,
}: {
  shown: boolean;
  onToggle: () => void;
  showLabel: string;
  hideLabel: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onToggle}
      aria-label={shown ? hideLabel : showLabel}
      className="rounded-full"
    >
      {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
    </Button>
  );
}

export function AccountApp() {
  const [page, setPage] = useState<Page>(pageForPath(location.pathname));
  const [session, setSession] = useState<Session | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(true);
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);
  const [invalid, setInvalid] = useState<{
    field: 'password' | 'confirmation' | 'verification';
    text: string;
  } | null>(null);
  const generation = useRef(0);
  // Página em que o site abriu: um endereço da área da empresa só vale com sessão e empresa selecionada.
  const initialPage = useRef<Page>(pageForPath(location.pathname));
  const navigate = (next: Page) => {
    setPage(next);
    setNotice(null);
    setInvalid(null);
    setConfirmation('');
    setShowPassword(false);
    setShowConfirmation(false);
    history.replaceState(null, '', pathForPage(next));
  };

  const load = async (stamp: number, landing: Page = 'companies') => {
    const current = sessionSchema.parse(await api('/auth/session'));
    const list = companiesSchema.parse(await api('/account/companies'));
    if (generation.current !== stamp) return;
    setSession(current);
    setCompanies(list.items);
    const target =
      isAreaPage(landing) && list.items.some((item) => item.companyId === current.selectedCompanyId)
        ? landing
        : 'companies';
    setPage(target);
    if (target === 'companies') history.replaceState(null, '', '/painel/empresas');
  };
  useEffect(() => {
    const stamp = ++generation.current;
    void load(stamp, initialPage.current)
      .catch(() => {
        if (generation.current === stamp) {
          setSession(null);
          setCompanies([]);
          if (isAreaPage(initialPage.current)) {
            setPage('login');
            history.replaceState(null, '', pathForPage('login'));
          }
        }
      })
      .finally(() => {
        if (generation.current === stamp) {
          setBusy(false);
          setBooting(false);
        }
      });
    return () => {
      generation.current++;
    };
  }, []);

  const perform = async (action: (stamp: number) => Promise<void>) => {
    if (busy) return;
    const stamp = generation.current;
    setBusy(true);
    setNotice(null);
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
          setCode('');
          setBusy(false);
          navigate('login');
        }
        setNotice({
          tone: 'error',
          text:
            error instanceof z.ZodError
              ? 'Resposta inválida do servidor.'
              : error instanceof Error
                ? error.message
                : 'Serviço indisponível.',
        });
      }
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };
  const submit = async () => {
    const stamp = generation.current;
    if (page === 'register') {
      setInvalid(null);
      const problem = passwordProblem(password);
      if (problem !== null) {
        setInvalid({ field: 'password', text: problem });
        return;
      }
      if (password !== confirmation) {
        setInvalid({
          field: 'confirmation',
          text: 'As senhas não coincidem. Confira e tente novamente.',
        });
        return;
      }
      await api('/auth/register', { email, password });
      if (stamp === generation.current) {
        navigate('verify');
      }
    } else if (page === 'forgot') {
      // Resposta sempre neutra: o site nunca revela se existe conta para o e-mail. Só o limite de
      // tentativas (429) e a falha do servidor ou da rede são informados.
      try {
        await api('/auth/password-reset/request', { email });
      } catch (error) {
        if (!(error instanceof ApiError && isNeutralResetRequestError(error.status))) throw error;
      }
      if (stamp === generation.current) setNotice({ tone: 'info', text: RESET_NEUTRAL_MESSAGE });
    } else if (page === 'reset') {
      setInvalid(null);
      if (!isCompleteVerificationCode(code)) {
        setInvalid({ field: 'verification', text: 'Digite os 6 dígitos do código' });
        return;
      }
      const problem = passwordProblem(password);
      if (problem !== null) {
        setInvalid({ field: 'password', text: problem });
        return;
      }
      if (password !== confirmation) {
        setInvalid({
          field: 'confirmation',
          text: 'As senhas não coincidem. Confira e tente novamente.',
        });
        return;
      }
      await api(
        '/auth/password-reset/confirm',
        { email, code, newPassword: password },
        RESET_INVALID_CODE_MESSAGE,
      );
      if (stamp === generation.current) {
        setCode('');
        setPassword('');
        navigate('login');
        setNotice({ tone: 'success', text: RESET_SUCCESS_MESSAGE });
      }
    } else if (page === 'verify') {
      setInvalid(null);
      if (!isCompleteVerificationCode(code)) {
        setInvalid({ field: 'verification', text: 'Digite os 6 dígitos do código' });
        return;
      }
      await api(
        '/auth/verify-email',
        { email, password, code },
        'Confirmação inválida ou expirada. Se errou várias vezes, peça um novo código.',
      );
      if (stamp === generation.current) {
        setCode('');
        setPassword('');
        navigate('login');
        setNotice({ tone: 'success', text: 'E-mail confirmado. Você já pode entrar.' });
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
    // Invalida respostas atrasadas; a tela só sai da conta depois que o servidor confirma.
    const stamp = ++generation.current;
    setBusy(true);
    setNotice(null);
    void api('/auth/logout', {})
      .then(() => {
        if (stamp !== generation.current) return;
        setSession(null);
        setCompanies([]);
        setName('');
        setEmail('');
        setPassword('');
        setCode('');
        navigate('login');
      })
      .catch(() => {
        if (stamp === generation.current)
          setNotice({
            tone: 'error',
            text: 'Saída não confirmada: você continua conectado. Tente sair novamente.',
          });
      })
      .finally(() => {
        if (stamp === generation.current) setBusy(false);
      });
  };

  const openArea = (next: Page) => {
    setPage(next);
    setNotice(null);
    history.replaceState(null, '', pathForPage(next));
  };
  const sessionLost = () => {
    generation.current++;
    setSession(null);
    setCompanies([]);
    setName('');
    setEmail('');
    setPassword('');
    setCode('');
    setBusy(false);
    navigate('login');
    setNotice({ tone: 'error', text: 'Sua sessão terminou. Entre novamente.' });
  };
  const companyChanged = () => {
    const stamp = ++generation.current;
    setBusy(true);
    void load(stamp)
      .then(() => {
        if (generation.current === stamp)
          setNotice({ tone: 'info', text: 'A empresa selecionada mudou. Escolha de novo.' });
      })
      .catch(() => {
        if (generation.current === stamp) sessionLost();
      })
      .finally(() => {
        if (generation.current === stamp) setBusy(false);
      });
  };
  const selectedCompany = companies.find((item) => item.companyId === session?.selectedCompanyId);

  const submitLabel =
    page === 'register'
      ? 'Criar conta'
      : page === 'verify'
        ? 'Confirmar e-mail'
        : page === 'forgot'
          ? 'Enviar código'
          : page === 'reset'
            ? 'Redefinir senha'
            : 'Entrar';
  const choosingPassword = page === 'register' || page === 'reset';
  const codeField = (
    <VerificationField
      value={code}
      onChange={(value) => {
        setCode(value);
        if (invalid?.field === 'verification') setInvalid(null);
      }}
      error={invalid?.field === 'verification' ? invalid.text : undefined}
    />
  );
  const form = (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void perform(submit);
      }}
    >
      <Input
        id="email"
        label="E-mail"
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        required
        maxLength={254}
      />
      {page === 'reset' && codeField}
      {page !== 'forgot' && (
        <Input
          id="password"
          label={page === 'reset' ? 'Nova senha' : 'Senha'}
          type={showPassword ? 'text' : 'password'}
          autoComplete={choosingPassword ? 'new-password' : 'current-password'}
          value={password}
          onChange={(value) => {
            setPassword(value);
            if (invalid?.field === 'password') setInvalid(null);
          }}
          required
          minLength={1}
          maxLength={128}
          error={invalid?.field === 'password' ? invalid.text : undefined}
          rightIcon={
            <PasswordToggle
              shown={showPassword}
              onToggle={() => setShowPassword(!showPassword)}
              showLabel="Mostrar senha"
              hideLabel="Ocultar senha"
            />
          }
        />
      )}
      {choosingPassword && (
        <>
          <p className="-mt-2 px-1 text-xs text-muted-foreground">{PASSWORD_HINT}</p>
          <Input
            id="confirmation"
            label={page === 'reset' ? 'Confirmar nova senha' : 'Confirmar senha'}
            type={showConfirmation ? 'text' : 'password'}
            autoComplete="new-password"
            value={confirmation}
            onChange={(value) => {
              setConfirmation(value);
              if (invalid?.field === 'confirmation') setInvalid(null);
            }}
            required
            maxLength={128}
            error={invalid?.field === 'confirmation' ? invalid.text : undefined}
            rightIcon={
              <PasswordToggle
                shown={showConfirmation}
                onToggle={() => setShowConfirmation(!showConfirmation)}
                showLabel="Mostrar confirmação de senha"
                hideLabel="Ocultar confirmação de senha"
              />
            }
          />
        </>
      )}
      {page === 'verify' && (
        <>
          <p className="-mb-1 px-1 text-sm text-muted-foreground">
            Confira seu e-mail e digite o código de 6 dígitos.
          </p>
          {codeField}
        </>
      )}
      <Button type="submit" size="lg" disabled={busy} className="mt-2 w-full">
        {busy ? (
          <>
            <span aria-hidden="true">
              <Loader variant="spinner" size={16} label="Aguarde" className="text-current" />
            </span>
            Aguarde…
          </>
        ) : (
          submitLabel
        )}
      </Button>
    </form>
  );

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top_right,var(--tint),transparent_55%)] px-5 py-10">
      <header
        className={`mx-auto mb-10 flex w-full items-center justify-between ${isAreaPage(page) ? 'max-w-[860px]' : 'max-w-[620px]'}`}
      >
        <a href="/" className="block w-[140px]">
          <Logo alt="Soprei — início" className="w-full" />
        </a>
        <ThemeToggle />
      </header>
      <main>
        <Card
          className={`mx-auto w-full bg-card ${isAreaPage(page) ? 'max-w-[860px]' : 'max-w-[620px]'} gap-5 p-0 py-8 shadow-[0_20px_70px_var(--shadow)] max-sm:py-6`}
        >
          <CardHeader className="gap-3 px-8 max-sm:px-5">
            <p className="eyebrow">SEU ESPAÇO NO SOPREI</p>
            <CardTitle
              as="h1"
              className="font-[Manrope] text-4xl leading-tight tracking-[-0.05em] max-sm:text-3xl"
            >
              {isAreaPage(page)
                ? (selectedCompany?.name ?? 'Painel da empresa')
                : page === 'companies'
                  ? 'Suas empresas'
                  : page === 'register'
                    ? 'Vamos começar.'
                    : page === 'verify'
                      ? 'Confirme seu e-mail.'
                      : page === 'forgot'
                        ? 'Recupere seu acesso.'
                        : page === 'reset'
                          ? 'Crie uma nova senha.'
                          : 'Que bom ter você aqui.'}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5 px-8 max-sm:px-5">
            {notice && (
              <Alert variant={notice.tone === 'error' ? 'destructive' : notice.tone}>
                <AlertIcon />
                <AlertContent>
                  <AlertDescription className="text-inherit">{notice.text}</AlertDescription>
                </AlertContent>
              </Alert>
            )}
            {booting ? (
              <div className="grid place-items-center gap-3 py-10 text-sm text-muted-foreground">
                <Loader variant="spinner" size={28} label="Verificando sua sessão" />
                <span aria-hidden="true">Verificando sua sessão…</span>
              </div>
            ) : isAreaPage(page) && session && selectedCompany ? (
              <CompanyArea
                key={selectedCompany.companyId}
                company={selectedCompany}
                page={page}
                onNavigate={openArea}
                onSwitch={() => openArea('companies')}
                onSession={sessionLost}
                onChanged={companyChanged}
              />
            ) : page === 'companies' && session ? (
              <>
                <div className="flex items-center justify-between gap-4 break-words">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{session.email}</span>
                  <Button variant="outline" size="sm" onClick={logout}>
                    Sair
                  </Button>
                </div>
                <p>Escolha uma empresa para trabalhar ou crie um novo espaço.</p>
                {companies.length === 0 && (
                  <p className="py-2 text-muted-foreground">
                    Você ainda não tem empresas. Crie a primeira abaixo.
                  </p>
                )}
                <ul className="m-0 list-none p-0">
                  {companies.map((company) => (
                    <li
                      key={company.companyId}
                      className="flex items-center justify-between gap-4 border-b border-border py-4"
                    >
                      <div className="min-w-0">
                        <strong className="block [overflow-wrap:anywhere]">{company.name}</strong>
                        <small className="block pt-1 text-xs text-muted-foreground">
                          {roles[company.role]}
                        </small>
                      </div>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          size="sm"
                          variant={
                            session.selectedCompanyId === company.companyId
                              ? 'primary'
                              : 'secondary'
                          }
                          disabled={busy}
                          onClick={() =>
                            void perform(async (stamp) => {
                              await api(`/account/companies/${company.companyId}/select`, {});
                              await load(stamp);
                            })
                          }
                        >
                          {session.selectedCompanyId === company.companyId
                            ? 'Selecionada ✓'
                            : 'Selecionar'}
                        </Button>
                        {session.selectedCompanyId === company.companyId &&
                          allowedPages(company.permissions).length > 0 && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                openArea(allowedPages(company.permissions)[0] ?? 'companies')
                              }
                            >
                              Abrir painel
                            </Button>
                          )}
                      </div>
                    </li>
                  ))}
                </ul>
                <form
                  className="grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform(async (stamp) => {
                      companySchema.parse(await api('/account/companies', { name }));
                      if (generation.current === stamp) setName('');
                      await load(stamp);
                    });
                  }}
                >
                  <Input
                    id="company-name"
                    label="Nome da empresa"
                    value={name}
                    onChange={setName}
                    required
                    maxLength={200}
                  />
                  <Button type="submit" size="lg" disabled={busy} className="w-full">
                    {busy ? (
                      <>
                        <span aria-hidden="true">
                          <Loader
                            variant="spinner"
                            size={16}
                            label="Aguarde"
                            className="text-current"
                          />
                        </span>
                        Aguarde…
                      </>
                    ) : (
                      'Criar empresa'
                    )}
                  </Button>
                </form>
              </>
            ) : (
              <>
                {page === 'verify' || page === 'forgot' || page === 'reset' ? (
                  form
                ) : (
                  <Tabs
                    value={page}
                    onValueChange={(value) => navigate(value === 'register' ? 'register' : 'login')}
                  >
                    <TabsList>
                      <TabsTrigger
                        value="login"
                        disabled={busy}
                        className="focus-visible:outline-3 focus-visible:outline-ring"
                      >
                        Entrar
                      </TabsTrigger>
                      <TabsTrigger
                        value="register"
                        disabled={busy}
                        className="focus-visible:outline-3 focus-visible:outline-ring"
                      >
                        Criar conta
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value={page}>{form}</TabsContent>
                  </Tabs>
                )}
                <div className="flex flex-wrap gap-2">
                  {(page === 'login' || page === 'register') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => navigate('verify')}
                    >
                      Confirmar e-mail
                    </Button>
                  )}
                  {page === 'login' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => navigate('forgot')}
                    >
                      Esqueci minha senha
                    </Button>
                  )}
                  {page === 'forgot' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => navigate('reset')}
                    >
                      Já tenho um código
                    </Button>
                  )}
                  {page === 'reset' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => navigate('forgot')}
                    >
                      Pedir novo código
                    </Button>
                  )}
                  {(page === 'forgot' || page === 'reset') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => navigate('login')}
                    >
                      Voltar para entrar
                    </Button>
                  )}
                  {page === 'verify' && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => navigate('login')}
                      >
                        Já tenho uma conta
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await api('/auth/resend-verification', { email, password });
                            setNotice({
                              tone: 'info',
                              text: 'Confira seu e-mail. O código anterior foi substituído.',
                            });
                          })
                        }
                      >
                        Reenviar código
                      </Button>
                    </>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </main>
      <p className="mt-8 text-center text-xs text-muted-foreground">
        Inteligência para conversas que importam.
      </p>
    </div>
  );
}
