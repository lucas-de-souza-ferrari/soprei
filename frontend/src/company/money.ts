/** Preço máximo aceito pelo servidor (centavos): R$ 1.000.000,00. */
export const PRICE_MAX_CENTS = 100_000_000;

/**
 * Preço digitado em reais para centavos, sem aritmética de ponto flutuante. Aceita `59,90`,
 * `1.234,50`, `59`, `59.90` (ponto com 1 ou 2 casas é decimal) e `R$ 59,90`. Entrada inválida,
 * negativa ou acima do teto devolve `null`.
 */
export function parseMoney(text: string): number | null {
  const cleaned = text.replace(/^R\$\s*/i, '').trim();
  let whole: string;
  let fraction = '';
  if (cleaned.includes(',')) {
    const match = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{1,2})$/.exec(cleaned);
    if (match === null) return null;
    whole = (match[1] ?? '').replaceAll('.', '');
    fraction = match[2] ?? '';
  } else if (/^\d+\.\d{1,2}$/.test(cleaned)) {
    const [integer = '', decimals = ''] = cleaned.split('.');
    whole = integer;
    fraction = decimals;
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(cleaned) || /^\d+$/.test(cleaned)) {
    whole = cleaned.replaceAll('.', '');
  } else {
    return null;
  }
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= PRICE_MAX_CENTS ? cents : null;
}

const FORMAT = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

/** Centavos para `R$ 59,90` (com o espaço comum no lugar do não separável). */
export function formatMoney(cents: number): string {
  return FORMAT.format(cents / 100).replaceAll(String.fromCharCode(0xa0), ' ');
}

/** Centavos para o campo de edição: `59,90` (sem símbolo e sem milhar). */
export function moneyInputValue(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}
