import { parseMoney } from './money';

/** Situação do estoque de um produto: sempre mostrada com texto e ícone, nunca só por cor. */
export type StockStatus = 'out' | 'low' | 'ok';

/** `0` = sem estoque; `quantity <= threshold` com `threshold > 0` = baixo; senão normal. */
export function stockStatus(quantity: number, lowStockThreshold: number): StockStatus {
  if (quantity <= 0) return 'out';
  if (lowStockThreshold > 0 && quantity <= lowStockThreshold) return 'low';
  return 'ok';
}

export const STATUS_LABELS: Readonly<Record<StockStatus, string>> = {
  out: 'Sem estoque',
  low: 'Estoque baixo',
  ok: 'Em estoque',
};

export const REASON_LABELS = {
  INITIAL: 'Estoque inicial',
  ENTRY: 'Entrada',
  EXIT: 'Saída',
  LOSS: 'Perda',
  COUNT_CORRECTION: 'Correção de contagem',
  IMPORT: 'Importação',
} as const;

export type AdjustKind = 'ENTRY' | 'EXIT' | 'LOSS' | 'COUNT_CORRECTION';
export const ADJUST_KINDS: readonly AdjustKind[] = ['ENTRY', 'EXIT', 'LOSS', 'COUNT_CORRECTION'];
export const ADJUST_MAX = 100_000;

/**
 * Quantidade digitada para o `delta` do servidor: entrada soma, saída e perda subtraem, e a
 * correção de contagem aceita sinal (`-3` ou `+3`). Inteiro de 1 a 100.000; qualquer outra coisa é `null`.
 */
export function deltaFor(kind: AdjustKind, text: string): number | null {
  const trimmed = text.trim();
  const pattern = kind === 'COUNT_CORRECTION' ? /^[+-]?\d{1,6}$/ : /^\d{1,6}$/;
  if (!pattern.test(trimmed)) return null;
  const amount = Number(trimmed);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > ADJUST_MAX) return null;
  if (kind === 'COUNT_CORRECTION') return amount;
  return kind === 'ENTRY' ? amount : -amount;
}

export interface ProductFormValues {
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly price: string;
  readonly quantity: string;
  readonly threshold: string;
}

export const SKU_PATTERN = /^[A-Z0-9._-]{1,40}$/;

/** Primeiro problema do formulário de produto (mensagem de tela), ou `null`. O servidor revalida tudo. */
export function productFormProblem(values: ProductFormValues, creating: boolean): string | null {
  if (creating && !SKU_PATTERN.test(values.sku.trim().toUpperCase())) {
    return 'SKU: use de 1 a 40 letras, números, ponto, hífen ou sublinhado.';
  }
  const name = values.name.trim();
  if (name.length === 0 || name.length > 120) return 'Informe o nome (até 120 caracteres).';
  if (values.description.trim().length > 500) return 'A descrição passa de 500 caracteres.';
  if (parseMoney(values.price) === null) return 'Preço inválido. Exemplo: 59,90.';
  if (creating && !/^\d{1,7}$/.test(values.quantity.trim())) return 'Quantidade inválida.';
  if (creating && Number(values.quantity) > 1_000_000) return 'Quantidade acima de 1.000.000.';
  if (values.threshold.trim() !== '' && !/^\d{1,7}$/.test(values.threshold.trim())) {
    return 'Alerta de estoque baixo inválido.';
  }
  return null;
}
