import { useCallback, useRef } from 'react';
import { Button } from '../components/motion/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/motion/tabs';
import { ChannelPage } from './ChannelPage';
import {
  allowedPages,
  AREA_LABELS,
  canOpen,
  type ConversasRoute,
  isAreaPage,
  type AreaPage,
} from './company-nav';
import { ConversationPage } from './ConversationPage';
import { ConversationsPage } from './ConversationsPage';
import { failureOf } from './company-api';
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
  readonly onOpenConversation: (conversationId: string) => void;
  readonly onBackToConversations: () => void;
  readonly onNavigate: (page: AreaPage) => void;
  readonly onSwitch: () => void;
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
  onOpenConversation,
  onBackToConversations,
  onNavigate,
  onSwitch,
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
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-sm text-muted-foreground">
          Você está na empresa <strong className="text-foreground">{company.name}</strong>.
        </p>
        <Button variant="outline" size="sm" onClick={onSwitch}>
          Trocar de empresa
        </Button>
      </div>
      <Tabs
        value={page}
        onValueChange={(value) => {
          if (isAreaPage(value)) onNavigate(value);
        }}
      >
        {pages.length > 0 && (
          <TabsList aria-label="Menu da empresa">
            {pages.map((item) => (
              <TabsTrigger
                key={item}
                value={item}
                className="focus-visible:outline-3 focus-visible:outline-ring"
              >
                {AREA_LABELS[item]}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
        <TabsContent value={page}>
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
