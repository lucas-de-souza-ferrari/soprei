/**
 * Assistente de primeiros passos (spec 030): regras puras, sem rede nem tela. O progresso vem do
 * servidor (`GET .../onboarding`, só booleanos) e nada é guardado no navegador. Um passo que a
 * resposta não traz é **oculto** (quem pede não tem a permissão dele).
 */
export const WIZARD_PATH = '/painel/primeiros-passos';

/** Passos com tela própria (e com endereço): o passo 1 (empresa) já foi feito para se chegar aqui. */
export const WIZARD_STEP_IDS = ['persona', 'documentos', 'servicos', 'estoque', 'testar'] as const;
export type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

/** Chaves do estado que o servidor devolve. */
export type StateKey = 'persona' | 'knowledge' | 'schedule' | 'inventory';

export interface OnboardingState {
  readonly dismissed: boolean;
  readonly steps: Readonly<Partial<Record<StateKey, boolean>>>;
}

const STATE_KEY: Readonly<Record<Exclude<WizardStepId, 'testar'>, StateKey>> = {
  persona: 'persona',
  documentos: 'knowledge',
  servicos: 'schedule',
  estoque: 'inventory',
};

export const STEP_LABELS: Readonly<Record<WizardStepId | 'empresa', string>> = {
  empresa: 'Empresa',
  persona: 'Persona do atendente',
  documentos: 'Documentos',
  servicos: 'Serviços',
  estoque: 'Estoque',
  testar: 'Testar o atendente',
};

const OPTIONAL: ReadonlySet<WizardStepId> = new Set<WizardStepId>(['servicos', 'estoque']);

/** Permissão do passo "Testar" (o simulador). Os demais vêm da própria resposta do servidor. */
const TEST_PERMISSION = 'conversation:simulate';
export const ONBOARDING_PERMISSION = 'onboarding:manage';

export function isWizardStepId(value: string): value is WizardStepId {
  return (WIZARD_STEP_IDS as readonly string[]).includes(value);
}

/** Endereço de um passo; sem passo, o endereço base (a tela escolhe o primeiro pendente). */
export function wizardPath(step?: WizardStepId): string {
  return step === undefined ? WIZARD_PATH : `${WIZARD_PATH}/${step}`;
}

/** Caminho do assistente (base ou qualquer sufixo)? */
export function isWizardPath(pathname: string): boolean {
  return pathname === WIZARD_PATH || pathname.startsWith(`${WIZARD_PATH}/`);
}

/**
 * Passo pedido pelo endereço. Qualquer valor fora do conjunto fixo (e o endereço base) é `null`: a tela
 * cai no primeiro pendente e nunca consulta nada por causa do texto da URL.
 */
export function wizardStepForPath(pathname: string): WizardStepId | null {
  if (!pathname.startsWith(`${WIZARD_PATH}/`)) return null;
  const rest = pathname.slice(WIZARD_PATH.length + 1);
  return isWizardStepId(rest) ? rest : null;
}

export interface WizardStep {
  readonly id: 'empresa' | WizardStepId;
  /** Posição na lista visível (1 a M). */
  readonly number: number;
  readonly label: string;
  readonly optional: boolean;
  /** Feito segundo o servidor (empresa: sempre; testar: nunca, só vale na memória da tela). */
  readonly done: boolean;
}

/** Passos visíveis, na ordem, com o 1 (empresa) sempre primeiro e já feito. */
export function visibleSteps(
  state: OnboardingState,
  permissions: readonly string[],
): readonly WizardStep[] {
  const list: Omit<WizardStep, 'number'>[] = [
    { id: 'empresa', label: STEP_LABELS.empresa, optional: false, done: true },
  ];
  for (const id of WIZARD_STEP_IDS) {
    if (id === 'testar') {
      if (!permissions.includes(TEST_PERMISSION)) continue;
      list.push({ id, label: STEP_LABELS.testar, optional: false, done: false });
      continue;
    }
    const value = state.steps[STATE_KEY[id]];
    if (value === undefined) continue;
    list.push({ id, label: STEP_LABELS[id], optional: OPTIONAL.has(id), done: value });
  }
  return list.map((step, index) => ({ ...step, number: index + 1 }));
}

/** Passos com tela (tudo menos a empresa). */
export function navigableSteps(steps: readonly WizardStep[]): readonly WizardStep[] {
  return steps.filter((step) => step.id !== 'empresa');
}

/**
 * Primeiro passo que ainda falta: o primeiro de dados que não está feito; se todos estão feitos, o teste
 * final (ou o último passo que existir). `null` se não há nenhum passo com tela.
 */
export function firstPending(steps: readonly WizardStep[]): WizardStepId | null {
  const screens = navigableSteps(steps);
  const pending = screens.find((step) => step.id !== 'testar' && !step.done);
  const chosen = pending ?? screens.at(-1);
  return chosen === undefined || chosen.id === 'empresa' ? null : chosen.id;
}

/** O passo da URL se ele é visível; senão o primeiro pendente. */
export function resolveStep(
  steps: readonly WizardStep[],
  requested: WizardStepId | null,
): WizardStepId | null {
  if (requested !== null && steps.some((step) => step.id === requested)) return requested;
  return firstPending(steps);
}

export interface ChecklistItem {
  readonly step: Exclude<WizardStepId, 'testar'>;
  readonly label: string;
  readonly optional: boolean;
  readonly done: boolean;
}

/** Itens da lista "Configuração": só os que o servidor devolveu. */
export function checklistItems(state: OnboardingState): readonly ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const step of ['persona', 'documentos', 'servicos', 'estoque'] as const) {
    const value = state.steps[STATE_KEY[step]];
    if (value === undefined) continue;
    items.push({ step, label: STEP_LABELS[step], optional: OPTIONAL.has(step), done: value });
  }
  return items;
}

export function checklistCounts(items: readonly ChecklistItem[]): {
  readonly done: number;
  readonly total: number;
} {
  return { done: items.filter((item) => item.done).length, total: items.length };
}

/**
 * Mostra o cartão "Configuração"? Só com a permissão, enquanto não foi dispensado e enquanto falta
 * algum item dos que a pessoa vê (some sozinho quando tudo está feito).
 */
export function showChecklist(state: OnboardingState, permissions: readonly string[]): boolean {
  if (!permissions.includes(ONBOARDING_PERMISSION) || state.dismissed) return false;
  const { done, total } = checklistCounts(checklistItems(state));
  return total > 0 && done < total;
}

/**
 * Modelo de persona do botão "Usar modelo" (D12): texto fixo do site, só preenche a caixa; nada é salvo
 * sem a pessoa clicar em salvar. A redação final é do dono (revisar).
 */
export const PERSONA_TEMPLATE = [
  'Você é o assistente de atendimento da [nome da empresa].',
  'Responda em português, de forma educada, clara e curta.',
  'Ajude com dúvidas sobre [o que a empresa vende ou faz].',
  'Se não souber a resposta, diga que vai pedir para a equipe confirmar.',
  'Não invente preços, prazos nem promessas.',
].join('\n');

/** Rascunho não salvo de um passo: o assistente só o salva (`Salvar e continuar`) ou descarta. */
export interface StepDraft {
  /** Grava o rascunho; `true` se gravou (a tela do passo mostra o erro, se falhar). */
  readonly save: () => Promise<boolean>;
  /** O texto ainda tem colchetes do modelo (opcional; só a persona usa). */
  readonly hasPlaceholders?: () => boolean;
}

/**
 * Pontes **opcionais** que o assistente passa às telas que reaproveita (spec 030, D11). Sem elas a tela
 * se comporta como sempre. Nada aqui carrega texto da empresa: só avisos de "algo mudou" e do rascunho.
 */
export interface StepBridge {
  /** Algo foi gravado ou apagado: o assistente relê o progresso. */
  readonly onProgress?: () => void;
  /** Há (objeto) ou não há (`null`) rascunho não salvo. Deve ser estável (a tela o usa em efeitos). */
  readonly onDraft?: (draft: StepDraft | null) => void;
}

/** Colchetes do modelo (ex.: "[nome da empresa]"), extraídos do próprio PERSONA_TEMPLATE. */
const TEMPLATE_PLACEHOLDERS: readonly string[] = PERSONA_TEMPLATE.match(/\[[^\]\n]+\]/g) ?? [];

/** O texto ainda contém alguma lacuna do modelo, sem editar? (só detecção; nada é bloqueado) */
export function hasTemplatePlaceholders(text: string): boolean {
  return TEMPLATE_PLACEHOLDERS.some((placeholder) => text.includes(placeholder));
}

export const PLACEHOLDER_WARNING =
  'O texto ainda tem trechos entre colchetes do modelo, como [nome da empresa]. Troque-os pelas informações reais antes de salvar.';
