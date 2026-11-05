/**
 * Dados de exemplo da "Loja Exemplo" (spec 026, E3): fictícios, texto fixo em código, sem dado pessoal
 * real. Os SKUs começam com `EX-`. Nada daqui depende de empresa nem de entrada do usuário.
 */
export interface SampleDocument {
  readonly title: string;
  readonly content: string;
}

export interface SampleProduct {
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly quantity: number;
  readonly lowStockThreshold: number;
}

export const SAMPLE_SKU_PREFIX = 'EX-';

export const SAMPLE_DOCUMENTS: readonly SampleDocument[] = [
  {
    title: 'Política de trocas e devoluções (Exemplo)',
    content: [
      'A Loja Exemplo aceita trocas e devoluções em até 7 dias corridos depois do recebimento do produto, desde que ele esteja sem uso e com a etiqueta.',
      'O reembolso é feito no mesmo meio de pagamento em até 10 dias úteis depois que o produto chega de volta à loja. Produtos em promoção podem ser trocados por outro tamanho ou cor, mas não são devolvidos em dinheiro.',
      'Para pedir uma troca ou devolução, informe o número do pedido e o motivo. O prazo de troca começa na data de entrega.',
    ].join('\n\n'),
  },
  {
    title: 'Horários, entrega e pagamento (Exemplo)',
    content: [
      'A Loja Exemplo atende de segunda a sexta, das 9h às 18h, e aos sábados, das 9h às 13h. Não abrimos aos domingos nem em feriados.',
      'A entrega leva até 5 dias úteis para capitais e até 10 dias úteis para o interior. O frete é grátis em compras acima de R$ 199,00.',
      'Aceitamos Pix, cartão de crédito em até 6 parcelas sem juros, cartão de débito e boleto.',
    ].join('\n\n'),
  },
];

export const SAMPLE_PRODUCTS: readonly SampleProduct[] = [
  {
    sku: 'EX-CAM-AZ',
    name: 'Camiseta Azul',
    description: 'Algodão, tamanhos P, M e G',
    priceCents: 5990,
    quantity: 12,
    lowStockThreshold: 5,
  },
  {
    sku: 'EX-CAM-BR',
    name: 'Camiseta Branca',
    description: 'Algodão, tamanhos P, M e G',
    priceCents: 4990,
    quantity: 3,
    lowStockThreshold: 5,
  },
  {
    sku: 'EX-CAL-JE',
    name: 'Calça Jeans',
    description: 'Corte reto, tamanhos 38 ao 46',
    priceCents: 12990,
    quantity: 8,
    lowStockThreshold: 3,
  },
  {
    sku: 'EX-BON-PR',
    name: 'Boné Preto',
    description: 'Aba curva, ajustável',
    priceCents: 3990,
    quantity: 0,
    lowStockThreshold: 3,
  },
  {
    sku: 'EX-TEN-RN',
    name: 'Tênis Runner',
    description: 'Para corrida, solado amortecido',
    priceCents: 24990,
    quantity: 6,
    lowStockThreshold: 2,
  },
  {
    sku: 'EX-MOL-CZ',
    name: 'Moletom Cinza',
    description: 'Com capuz, flanelado por dentro',
    priceCents: 15990,
    quantity: 10,
    lowStockThreshold: 3,
  },
  {
    sku: 'EX-MEI-KT',
    name: 'Kit de 3 pares de meias',
    description: 'Cano médio, algodão',
    priceCents: 2490,
    quantity: 40,
    lowStockThreshold: 10,
  },
  {
    sku: 'EX-MOC-UR',
    name: 'Mochila Urbana',
    description: 'Cabe notebook de 15 polegadas',
    priceCents: 18990,
    quantity: 5,
    lowStockThreshold: 2,
  },
];
