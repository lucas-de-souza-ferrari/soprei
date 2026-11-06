import { useCallback, useRef } from 'react';
import { AgendaConfigPage } from './AgendaConfigPage';
import { AgendaPage } from './AgendaPage';
import { ChannelPage } from './ChannelPage';
import { allowedPages, canOpen, type ConversasRoute, type AreaPage } from './company-nav';
import { ConversationPage } from './ConversationPage';
import { EstoquePage } from './EstoquePage';
import { KnowledgePage } from './KnowledgePage';
import { ConversationsPage } from './ConversationsPage';
import { failureOf } from './company-api';
import { OnboardingPage } from './OnboardingPage';
import type { WizardStepId } from './onboarding-steps';
import { PersonaPage } from './PersonaPage';
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
  /** 401: a sessão acabou; o site volta ao login. */
  readonly onSession: () => void;
  /** 404: a empresa selecionada mudou (outra aba, suspensão); o site recarrega e volta à lista. */
  readonly onChanged: () => void;
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
  onSession,
  onChanged,
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

  return (
    <>
      {!allowed ? (
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
          />
        )
      ) : page === 'primeirosPassos' ? (
        <OnboardingPage
          key={company.companyId}
          companyId={company.companyId}
          permissions={company.permissions}
          settle={settle}
          step={wizardStep}
          onStep={onWizardStep}
          onNavigate={onNavigate}
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
