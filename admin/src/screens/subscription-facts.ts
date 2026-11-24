import type { Subscription } from '../contracts';
import { formatDate, label } from '../format';

/** Módulos ligados (`{ schedule, inventory }`), em português. */
export function modulesText(modules: {
  readonly schedule: boolean;
  readonly inventory: boolean;
}): string {
  const on = [modules.schedule ? 'Agenda' : null, modules.inventory ? 'Estoque' : null].filter(
    (name) => name !== null,
  );
  return on.length === 0 ? 'nenhum' : on.join(', ');
}

/** Linhas da assinatura (detalhe da empresa e da conta), só estados, datas e códigos fixos. */
export function subscriptionFacts(sub: Subscription): (readonly [string, string])[] {
  return [
    ['Plano', `${label(sub.plan.code)} (${label(sub.cycle)})`],
    [
      'Estado',
      `${label(sub.state)} · ${label(sub.access)}${
        sub.status === sub.state ? '' : ` (gravado: ${label(sub.status)})`
      }`,
    ],
    ['Período', `${formatDate(sub.currentPeriodStart)} a ${formatDate(sub.currentPeriodEnd)}`],
    ['Teste até', formatDate(sub.trialEndsAt)],
    ['Cancela no fim do período', sub.cancelAtPeriodEnd ? 'Sim' : 'Não'],
    ['Módulos contratados', modulesText(sub.modules)],
    [
      'Troca na próxima renovação',
      sub.pendingChange === null
        ? '—'
        : `${label(sub.pendingChange.planCode)} (${label(sub.pendingChange.cycle)}), módulos: ${modulesText(
            { schedule: sub.pendingChange.agenda, inventory: sub.pendingChange.stock },
          )}`,
    ],
  ];
}
