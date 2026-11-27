import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { z } from 'zod';
import { api, ApiError } from './api';
import { Logo } from './components/logo';
import { Alert, AlertContent, AlertDescription, AlertIcon } from './components/motion/alert';
import { Button } from './components/motion/button';
import { Card, CardContent, CardHeader, CardTitle } from './components/motion/card';
import { DeleteAccountDialog } from './DeleteAccountDialog';
import { Input } from './components/motion/input';
import { Loader } from './components/motion/loader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/motion/tabs';
import { ThemeToggle } from './components/motion/theme-toggle';
import { AppShell } from './company/AppShell';
import { loadEntitlements, type Entitlements } from './company/billing-api';
import { hasModule, moduleOfPage, type CheckoutReturn } from './company/billing-rules';
import { pickCompanyToOpen } from './company/company-pick';
import { CompanyArea } from './company/CompanyArea';
import { NotificationBell } from './company/NotificationBell';
import { InvitePage } from './invite/InvitePage';
import { LegalLinks } from './legal/LegalLinks';
import { wizardPath, wizardStepForPath, type WizardStepId } from './company/onboarding-steps';
import { INVITE_ACCOUNT_CREATED_MESSAGE } from './invite/invite-flow';
import {
  allowedPages,
  AREA_LABELS,
  BILLING_PERMISSION,
  canOpen,
  type ConversasRoute,
  conversasPath,
  conversasRouteForPath,
  isAreaPage,
} from './company/company-nav';
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

/**
 * Tela do primeiro carregamento: um endereço da área ou de empresas/convite vale como está; qualquer outro
 * (entrar, cadastro...) com sessão abre a empresa (spec 029).
 */
function bootLanding(initial: Page): Page | 'auto' {
  return initial === 'companies' || initial === 'invite' || isAreaPage(initial) ? initial : 'auto';
}

export interface AccountAppProps {
  /** Token do convite lido do fragmento pelo `main.tsx` (spec 025); só vive em memória. */
  readonly initialInviteToken?: string | null;
  /** Volta do checkout lida da query pelo `main.tsx` (spec 031, E4); só vive em memória. */
  readonly initialCheckoutReturn?: CheckoutReturn | null;
}

export function AccountApp({
  initialInviteToken = null,
  initialCheckoutReturn = null,
}: AccountAppProps = {}) {
  const [page, setPage] = useState<Page>(pageForPath(location.pathname));
  // O convite aberto fica só em memória: atravessa o login (`/entrar`) e volta, nunca vai a armazenamento.
  const [inviteToken, setInviteToken] = useState<string | null>(initialInviteToken);
  const [session, setSession] = useState<Session | null>(null);
  // Assinatura (spec 031, E4): o acesso da empresa selecionada (faixa e módulos) e se a conta é a titular.
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [checkoutReturn, setCheckoutReturn] = useState<CheckoutReturn | null>(
    initialCheckoutReturn,
  );
  const checkoutReturnRef = useRef<CheckoutReturn | null>(initialCheckoutReturn);
  checkoutReturnRef.current = checkoutReturn;
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
  /** Spec 038: muda quando uma notificação é resolvida, para o sino reler a contagem. */
  const [bellRefresh, setBellRefresh] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  /** Diálogo "Excluir minha conta" (spec 032, E7) aberto. */
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [invalid, setInvalid] = useState<{
    field: 'password' | 'confirmation' | 'verification';
    text: string;
  } | null>(null);
  const [route, setRoute] = useState<ConversasRoute>(
    conversasRouteForPath(location.pathname) ?? { kind: 'list' },
  );
  const [wizardStep, setWizardStep] = useState<WizardStepId | null>(
    wizardStepForPath(location.pathname),
  );
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

  /**
   * Lê a sessão e as empresas e decide a tela. `landing`: `companies` fica na tela de empresas (gerenciar);
   * `invite` volta ao convite; uma tela da área abre se a empresa selecionada existe; `auto` (e uma tela da
   * área sem empresa selecionada) abre a empresa **sempre** que dá (spec 029, E2): a selecionada pelo
   * servidor no login (a última usada), ou a única que a conta tem. Só mostra a tela de empresas se há
   * várias e nenhuma selecionada, ou nenhuma (criar a primeira).
   */
  const load = async (
    stamp: number,
    requested: Page | 'auto' | 'afterCreate' = 'companies',
    requestedReplace = false,
  ) => {
    let landing = requested;
    let replaceUrl = requestedReplace;
    // Leituras auxiliares da Assinatura (spec 031): feitas uma vez por empresa, antes de decidir a tela e
    // reaproveitadas depois. Qualquer falha vira "sem cobrança" (nada é escondido).
    let probed: { companyId: string | null; access: Entitlements | null } | null = null;
    const probe = async (companyId: string | null) => {
      if (probed !== null && probed.companyId === companyId) return probed;
      const access = companyId === null ? null : await loadEntitlements(companyId);
      probed = { companyId, access };
      return probed;
    };
    let current = sessionSchema.parse(await api('/auth/session'));
    const list = companiesSchema.parse(await api('/account/companies'));
    if (generation.current !== stamp) return;
    const hasSelected = list.items.some((item) => item.companyId === current.selectedCompanyId);
    if (landing === 'afterCreate') {
      // Empresa recém-criada (spec 030): abre o assistente de primeiros passos se a pessoa pode usá-lo.
      const created = list.items.find((item) => item.companyId === current.selectedCompanyId);
      landing =
        created !== undefined && canOpen('primeirosPassos', created.permissions)
          ? 'primeirosPassos'
          : 'auto';
      replaceUrl = true;
    }
    if (landing === 'auto' || (isAreaPage(landing) && !hasSelected)) {
      const choice = pickCompanyToOpen(list.items, current.selectedCompanyId);
      if (choice.kind === 'select') {
        // Sessão sem empresa (anterior ao deploy ou pré-seleção que falhou): seleciona a única.
        try {
          await api(`/account/companies/${choice.companyId}/select`, {});
          current = { ...current, selectedCompanyId: choice.companyId };
        } catch {
          // Sem seleção: cai na tela de empresas, com a sessão intacta.
        }
        if (generation.current !== stamp) return;
      }
      const opened = list.items.find((item) => item.companyId === current.selectedCompanyId);
      landing =
        opened === undefined ? 'companies' : (allowedPages(opened.permissions)[0] ?? 'conversas');
      // Voltando do checkout depois de um login: abre a Assinatura para confirmar o pagamento.
      if (opened !== undefined && checkoutReturnRef.current !== null) landing = 'assinatura';
      // Titular com a assinatura encerrada: o login abre a Assinatura (como voltar a usar), não as Conversas.
      else if (opened !== undefined) {
        const info = await probe(opened.companyId);
        if (generation.current !== stamp) return;
        if (info.access?.holder === true && info.access.access === 'blocked')
          landing = 'assinatura';
      }
      replaceUrl = true;
      setRoute({ kind: 'list' });
      setWizardStep(null);
    }
    // Assinatura (spec 031): leituras auxiliares; qualquer falha vira "sem cobrança" (nada é escondido).
    const selectedId = current.selectedCompanyId;
    const info = await probe(
      selectedId !== null && list.items.some((item) => item.companyId === selectedId)
        ? selectedId
        : null,
    );
    if (generation.current !== stamp) return;
    setEntitlements(info.access);
    setSession(current);
    setCompanies(list.items);
    const target =
      landing === 'invite'
        ? 'invite'
        : isAreaPage(landing) &&
            list.items.some((item) => item.companyId === current.selectedCompanyId)
          ? landing
          : 'companies';
    setPage(target);
    if (target === 'companies') history.replaceState(null, '', '/painel/empresas');
    else if (target === 'invite') history.replaceState(null, '', pathForPage('invite'));
    else if (replaceUrl) history.replaceState(null, '', pathForPage(target));
  };
  useEffect(() => {
    const stamp = ++generation.current;
    void load(stamp, bootLanding(initialPage.current))
      .catch(() => {
        if (generation.current === stamp) {
          setSession(null);
          setCompanies([]);
          if (isAreaPage(initialPage.current) || initialPage.current === 'companies') {
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
        // Com um convite aberto em memória, o login volta a ele (`/convite`) em vez de ir às empresas.
        await load(stamp, inviteToken === null ? 'auto' : 'invite');
      }
    }
  };
  /** Sai da conta na tela (o servidor já encerrou a sessão): limpa o que era dela e volta ao login. */
  const leaveAccount = () => {
    setSession(null);
    setCompanies([]);
    setName('');
    setEmail('');
    setPassword('');
    setCode('');
    navigate('login');
  };
  const accountDeleted = () => {
    // Invalida respostas atrasadas da conta que deixou de existir.
    ++generation.current;
    setDeletingAccount(false);
    leaveAccount();
    setNotice({ tone: 'success', text: 'Sua conta foi excluída.' });
  };
  const logout = () => {
    // Invalida respostas atrasadas; a tela só sai da conta depois que o servidor confirma.
    const stamp = ++generation.current;
    setBusy(true);
    setNotice(null);
    void api('/auth/logout', {})
      .then(() => {
        if (stamp !== generation.current) return;
        leaveAccount();
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
    setRoute({ kind: 'list' });
    setWizardStep(null);
    setNotice(null);
    history.replaceState(null, '', pathForPage(next));
  };
  // Conversas (spec 024): abrir e voltar à lista entram no histórico do navegador (o "voltar" funciona);
  // a empresa selecionada vive na sessão do servidor, então ela é a mesma ao voltar e ao atualizar.
  const goConversations = (next: ConversasRoute) => {
    setPage('conversas');
    setRoute(next);
    setNotice(null);
    history.pushState(null, '', conversasPath(next));
  };
  // Assistente de primeiros passos (spec 030): cada passo é um endereço; trocar entra no histórico (o voltar
  // do navegador funciona) e normalizar o endereço só o substitui.
  const goWizard = useCallback((step: WizardStepId, replace: boolean) => {
    setPage('primeirosPassos');
    setWizardStep(step);
    setNotice(null);
    if (replace) history.replaceState(null, '', wizardPath(step));
    else history.pushState(null, '', wizardPath(step));
  }, []);
  // Convite (spec 025). Aceito: o painel da empresa nova abre em Conversas. Conta criada: login com aviso.
  const inviteAccepted = () => {
    setInviteToken(null);
    const stamp = ++generation.current;
    setBusy(true);
    void load(stamp, 'conversas', true)
      .catch(() => {
        if (generation.current === stamp) sessionLost();
      })
      .finally(() => {
        if (generation.current === stamp) setBusy(false);
      });
  };
  const inviteCreated = (inviteEmail: string) => {
    setInviteToken(null);
    setPassword('');
    setCode('');
    navigate('login');
    setEmail(inviteEmail);
    setNotice({ tone: 'success', text: INVITE_ACCOUNT_CREATED_MESSAGE });
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
  // Voltar e avançar do navegador dentro da área da empresa (só com sessão e empresa selecionada).
  useEffect(() => {
    if (session === null) return;
    const onPop = () => {
      const next = pageForPath(location.pathname);
      if (!isAreaPage(next)) return;
      setPage(next);
      setRoute(conversasRouteForPath(location.pathname) ?? { kind: 'list' });
      setWizardStep(wizardStepForPath(location.pathname));
      setNotice(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [session]);
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

  const noticeNode = notice && (
    <Alert variant={notice.tone === 'error' ? 'destructive' : notice.tone}>
      <AlertIcon />
      <AlertContent>
        <AlertDescription className="text-inherit">{notice.text}</AlertDescription>
      </AlertContent>
    </Alert>
  );
  const baseAreaCompany = isAreaPage(page) && !booting && session ? selectedCompany : undefined;
  // A conta titular ganha a permissão de CONTA que abre a Assinatura (conveniência de tela; o servidor barra).
  const areaCompany =
    baseAreaCompany === undefined
      ? undefined
      : entitlements?.holder === true
        ? { ...baseAreaCompany, permissions: [...baseAreaCompany.permissions, BILLING_PERMISSION] }
        : baseAreaCompany;
  // Abas de módulo (Agenda, Estoque) somem sem o módulo contratado; sem leitura do acesso nada some.
  const menuPages = (permissions: readonly string[]) =>
    allowedPages(permissions).filter((item) => {
      const needed = moduleOfPage(item);
      return needed === null || hasModule(entitlements, needed);
    });
  // Relê o acesso e o titular depois de uma mudança na assinatura (o menu e a faixa acompanham).
  const refreshAccess = () => {
    const stamp = generation.current;
    const selectedId = session?.selectedCompanyId ?? null;
    if (selectedId === null) return;
    void loadEntitlements(selectedId).then((access) => {
      if (generation.current !== stamp) return;
      setEntitlements(access);
    });
  };
  const switcherItem = (item: Company) => ({
    companyId: item.companyId,
    name: item.name,
    roleLabel: roles[item.role],
  });
  const switchCompany = (companyId: string) =>
    void perform(async (stamp) => {
      await api(`/account/companies/${companyId}/select`, {});
      await load(stamp, 'auto');
    });

  // Área da empresa (spec 029): tela inteira com menu lateral, sem o cartão centrado.
  if (areaCompany !== undefined && session) {
    return (
      <AppShell
        title={AREA_LABELS[isAreaPage(page) ? page : 'conversas']}
        banner={noticeNode}
        headerActions={
          areaCompany.permissions.includes('notification:read') ? (
            <NotificationBell
              key={areaCompany.companyId}
              companyId={areaCompany.companyId}
              refreshKey={bellRefresh}
              onOpen={() => openArea('notificacoes')}
            />
          ) : undefined
        }
        current={switcherItem(areaCompany)}
        companies={companies.map(switcherItem)}
        pages={menuPages(areaCompany.permissions)}
        page={isAreaPage(page) ? page : 'conversas'}
        email={session.email}
        busy={busy}
        onNavigate={openArea}
        onSelectCompany={switchCompany}
        onManage={() => openArea('companies')}
        onLogout={logout}
      >
        <CompanyArea
          key={areaCompany.companyId}
          company={areaCompany}
          page={isAreaPage(page) ? page : 'conversas'}
          route={route}
          wizardStep={wizardStep}
          onWizardStep={goWizard}
          onOpenConversation={(id) => goConversations({ kind: 'detail', id })}
          onBackToConversations={() => goConversations({ kind: 'list' })}
          onNavigate={openArea}
          entitlements={entitlements}
          checkoutReturn={checkoutReturn}
          onReturnConsumed={() => setCheckoutReturn(null)}
          onBillingChanged={refreshAccess}
          onOpenCompanies={() => openArea('companies')}
          onSession={sessionLost}
          onChanged={companyChanged}
          onNotificationsChanged={() => setBellRefresh((value) => value + 1)}
        />
      </AppShell>
    );
  }

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
                : page === 'invite'
                  ? 'Você recebeu um convite.'
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
            {noticeNode}
            {booting ? (
              <div className="grid place-items-center gap-3 py-10 text-sm text-muted-foreground">
                <Loader variant="spinner" size={28} label="Verificando sua sessão" />
                <span aria-hidden="true">Verificando sua sessão…</span>
              </div>
            ) : page === 'invite' ? (
              <InvitePage
                token={inviteToken}
                session={session === null ? null : { email: session.email }}
                onNeedLogin={() => navigate('login')}
                onSwitchAccount={logout}
                onAccepted={inviteAccepted}
                onCreated={inviteCreated}
                onClose={() => {
                  setInviteToken(null);
                  navigate('login');
                }}
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
                      const created = companySchema.parse(
                        await api('/account/companies', { name }),
                      );
                      if (generation.current === stamp) setName('');
                      // Criar seleciona e abre a empresa nova, sem o clique extra (spec 029).
                      await api(`/account/companies/${created.companyId}/select`, {});
                      await load(stamp, 'afterCreate');
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
                <section
                  aria-labelledby="account-danger-title"
                  className="mt-4 grid gap-2 border-t border-border pt-4"
                >
                  <h2 id="account-danger-title" className="m-0 text-base font-semibold">
                    Excluir conta
                  </h2>
                  <p className="m-0 text-sm text-muted-foreground">
                    Remove seu e-mail e sua senha e tira seu acesso a todas as empresas.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="justify-self-start border-destructive text-destructive"
                    disabled={busy}
                    onClick={() => setDeletingAccount(true)}
                  >
                    Excluir minha conta
                  </Button>
                </section>
                <DeleteAccountDialog
                  open={deletingAccount}
                  onDeleted={accountDeleted}
                  onClose={() => setDeletingAccount(false)}
                />
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
      <LegalLinks className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground [&_a]:underline [&_a]:underline-offset-2" />
    </div>
  );
}
