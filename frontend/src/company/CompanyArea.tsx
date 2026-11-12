import { useCallback, useRef } from 'react';
import { AccessNotice, ModuleInvite } from './AccessNotice';
import { AgendaConfigPage } from './AgendaConfigPage';
import { AgendaPage } from './AgendaPage';
import { ChannelPage } from './ChannelPage';
import type { Entitlements } from './billing-api';
import { hasModule, moduleOfPage, type CheckoutReturn } from './billing-rules';
import {
  allowedPages,
  BILLING_PERMISSION,
  canOpen,
  type ConversasRoute,
  type AreaPage,
} from './company-nav';
import { ConversationPage } from './ConversationPage';
import { EstoquePage } from './EstoquePage';
import { KnowledgePage } from './KnowledgePage';
import { NotificationsPage } from './NotificationsPage';
import { ConversationsPage } from './ConversationsPage';
import { failureOf } from './company-api';
import { OnboardingPage } from './OnboardingPage';
import type { WizardStepId } from './onboarding-steps';
import { PersonaPage } from './PersonaPage';
import { SubscriptionPage } from './SubscriptionPage';
import { TeamPage } from './TeamPage';
import type { Role } from './team-rules';
import { TestPage } from './TestPage';

export interface AreaCompany {
  readonly companyId: string;
  readonly name: string;
  /** Vínculo e papel de quem está na tela (spec 025): só decidem o que a tela de equipe mostra. */
  readonly membershipId: string;
  readonly role: Role;
  readonly permissions: readonly string[];
}

export interface CompanyAreaProps {
  readonly company: AreaCompany;
  readonly page: AreaPage;
  /** Dentro da aba Conversas: a lista ou uma conversa (spec 024). */
  readonly route: ConversasRoute;
  /** Passo do assistente pedido pelo endereço (spec 030); `null` = o primeiro pendente. */
  readonly wizardStep: WizardStepId | null;
  readonly onWizardStep: (step: WizardStepId, replace: boolean) => void;
  readonly onOpenConversation: (conversationId: string) => void;
  readonly onBackToConversations: () => void;
  readonly onNavigate: (page: AreaPage) => void;
  /** Acesso da empresa (spec 031): faixa de estado e módulos contratados; `null` = sem cobrança ou sem leitura. */
  readonly entitlements: Entitlements | null;
  /** Volta do checkout (só em memória) e avisos de que a assinatura mudou (o site relê o acesso). */
  readonly checkoutReturn: CheckoutReturn | null;
  readonly onReturnConsumed: () => void;
  readonly onBillingChanged: () => void;
  /** Leva à tela de empresas (onde se cria a primeira e começa o teste gratuito). */
  readonly onOpenCompanies: () => void;
  /** 401: a sessão acabou; o site volta ao login. */
  readonly onSession: () => void;
  /** 404: a empresa selecionada mudou (outra aba, suspensão); o site recarrega e volta à lista. */
  readonly onChanged: () => void;
  /** Spec 038: uma notificação foi resolvida; o sino relê a contagem. */
  readonly onNotificationsChanged?: () => void;
}

/**
 * Área da empresa selecionada (spec 023): menu por permissão e as telas Conversas (spec 024), Canal, Persona e Testar. O
 * componente é remontado a cada empresa (`key`), então nada de uma empresa sobra na outra. O que o
 * menu esconde é só conveniência: o servidor aplica as permissões de verdade.
 */
export function CompanyArea({
  company,
  page,
  route,
  wizardStep,
  onWizardStep,
  onOpenConversation,
  onBackToConversations,
  onNavigate,
  entitlements,
  checkoutReturn,
  onReturnConsumed,
  onBillingChanged,
  onOpenCompanies,
  onSession,
  onChanged,
  onNotificationsChanged = () => undefined,
}: CompanyAreaProps) {
  // `settle` precisa ser estável (as telas o usam em efeitos): os callbacks entram por ref.
  const handlers = useRef({ onSession, onChanged });
  handlers.current = { onSession, onChanged };
  const settle = useCallback((error: unknown): string | null => {
    const failure = failureOf(error);
    if (failure.kind === 'session') {
      handlers.current.onSession();
      return null;
    }
    if (failure.kind === 'changed') {
      handlers.current.onChanged();
      return null;
    }
    return failure.text;
  }, []);
  const stableChanged = useCallback(() => handlers.current.onChanged(), []);

  const pages = allowedPages(company.permissions);
  const allowed = canOpen(page, company.permissions);
  // Assinatura é da CONTA: só o titular a vê (o site acrescenta a permissão de conta a ele).
  const holder = company.permissions.includes(BILLING_PERMISSION);
  const openSubscription = useCallback(() => onNavigate('assinatura'), [onNavigate]);
  const needed = moduleOfPage(page);
  const locked = needed !== null && !hasModule(entitlements, needed);

  return (
    <>
      {page !== 'assinatura' && (
        <AccessNotice
          entitlements={entitlements}
          holder={holder}
          onOpenSubscription={openSubscription}
        />
      )}
      {!allowed && page === 'assinatura' ? (
        <p className="m-0 py-2">
          Esta conta não tem assinatura própria (ela é da pessoa titular da conta) ou a cobrança não
          está habilitada neste ambiente.
        </p>
      ) : !allowed ? (
        <p className="m-0 py-2">
          {pages.length === 0
            ? 'Você não tem permissão para usar nenhuma tela desta empresa.'
            : 'Você não tem permissão para ver esta tela.'}
        </p>
      ) : page === 'conversas' ? (
        route.kind === 'list' ? (
          <ConversationsPage
            key={company.companyId}
            companyId={company.companyId}
            permissions={company.permissions}
            settle={settle}
            onOpen={onOpenConversation}
            onNavigate={onNavigate}
            onOpenStep={(step) => onWizardStep(step, false)}
          />
        ) : (
          <ConversationPage
            key={`${company.companyId}:${route.kind === 'detail' ? route.id : 'invalida'}`}
            companyId={company.companyId}
            conversationId={route.kind === 'detail' ? route.id : null}
            settle={settle}
            onChanged={stableChanged}
            onBack={onBackToConversations}
            canResolve={company.permissions.includes('notification:resolve')}
            onHandoffResolved={onNotificationsChanged}
          />
        )
      ) : page === 'notificacoes' ? (
        <NotificationsPage
          key={company.companyId}
          companyId={company.companyId}
          canResolve={company.permissions.includes('notification:resolve')}
          settle={settle}
          onOpenConversation={onOpenConversation}
          onChanged={onNotificationsChanged}
        />
      ) : locked && needed !== null ? (
        <ModuleInvite module={needed} holder={holder} onOpenSubscription={openSubscription} />
      ) : page === 'assinatura' ? (
        <SubscriptionPage
          checkoutReturn={checkoutReturn}
          onReturnConsumed={onReturnConsumed}
          onChanged={onBillingChanged}
          onSession={onSession}
          onOpenCompanies={onOpenCompanies}
        />
      ) : page === 'primeirosPassos' ? (
        <OnboardingPage
          key={company.companyId}
          companyId={company.companyId}
          permissions={company.permissions}
          settle={settle}
          step={wizardStep}
          onStep={onWizardStep}
          onNavigate={onNavigate}
          entitlements={entitlements}
        />
      ) : page === 'agenda' ? (
        <AgendaPage
          key={company.companyId}
          companyId={company.companyId}
          settle={settle}
          permissions={company.permissions}
          onConfigure={() => onNavigate('agendaConfig')}
        />
      ) : page === 'agendaConfig' ? (
        <AgendaConfigPage
          key={company.companyId}
          companyId={company.companyId}
          settle={settle}
          onBack={() => onNavigate('agenda')}
        />
      ) : page === 'canal' ? (
        <ChannelPage
          key={company.companyId}
          companyId={company.companyId}
          canManage={company.permissions.includes('channel:manage')}
          settle={settle}
          onChanged={stableChanged}
        />
      ) : page === 'persona' ? (
        <PersonaPage key={company.companyId} companyId={company.companyId} settle={settle} />
      ) : page === 'conhecimento' ? (
        <KnowledgePage
          key={company.companyId}
          companyId={company.companyId}
          settle={settle}
          canSample={company.permissions.includes('inventory:manage')}
        />
      ) : page === 'estoque' ? (
        <EstoquePage
          key={company.companyId}
          companyId={company.companyId}
          settle={settle}
          canSample={company.permissions.includes('knowledge:manage')}
        />
      ) : page === 'equipe' ? (
        <TeamPage
          key={company.companyId}
          companyId={company.companyId}
          actor={{ role: company.role, membershipId: company.membershipId }}
          permissions={company.permissions}
          settle={settle}
          onChanged={stableChanged}
        />
      ) : (
        <TestPage key={company.companyId} companyId={company.companyId} settle={settle} />
      )}
    </>
  );
}
