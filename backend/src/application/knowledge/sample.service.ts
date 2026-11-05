import {
  type CompanyId,
  type KnowledgeDocumentRepository,
  type ProductRepository,
} from '../../domain/index.js';
import { ConflictError } from '../../shared/errors/index.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import type { KnowledgeService } from './knowledge.service.js';
import { SAMPLE_DOCUMENTS, SAMPLE_PRODUCTS } from './sample-data.js';

export const SAMPLE_REQUIRES_EMPTY = 'SAMPLE_REQUIRES_EMPTY';

export interface SampleLoadResult {
  /** Algo foi criado agora (documentos ou produtos); falso = tudo já estava lá (200). */
  readonly created: boolean;
}

export interface SampleDeps {
  readonly documents: KnowledgeDocumentRepository;
  readonly products: ProductRepository;
  readonly knowledge: Pick<KnowledgeService, 'create'>;
  readonly inventory: Pick<InventoryService, 'create' | 'update' | 'adjust'>;
}

/**
 * Dados de exemplo da "Loja Exemplo" (spec 026, E3). **Só em empresa vazia** (documento ou produto que
 * não seja de exemplo recusa com `SAMPLE_REQUIRES_EMPTY`), idempotente (repetir não duplica) e
 * removível (apaga os documentos de exemplo e **desativa** os produtos de exemplo; carregar de novo os
 * reativa e restaura preço e quantidade). O `CompanyId` vem da identidade; nada do conteúdo é logado.
 */
export class SampleDataService {
  constructor(private readonly deps: SampleDeps) {}

  async load(companyId: CompanyId, membershipId: string): Promise<SampleLoadResult> {
    const { documents, products, knowledge, inventory } = this.deps;
    const [docTotal, docSamples, productTotal, productSamples] = await Promise.all([
      documents.countDocuments(companyId),
      documents.countSamples(companyId),
      products.count(companyId),
      products.listSamples(companyId),
    ]);
    if (docTotal > docSamples || productTotal > productSamples.length) {
      throw new ConflictError('O exemplo só carrega em empresa vazia', {
        code: SAMPLE_REQUIRES_EMPTY,
      });
    }
    let created = false;
    if (docSamples === 0) {
      for (const document of SAMPLE_DOCUMENTS) {
        await knowledge.create(companyId, membershipId, document, { isSample: true });
      }
      created = true;
    }
    const bySku = new Map(productSamples.map((product) => [product.sku, product]));
    for (const sample of SAMPLE_PRODUCTS) {
      const existing = bySku.get(sample.sku);
      if (existing === undefined) {
        await inventory.create(companyId, membershipId, sample, { isSample: true });
        created = true;
        continue;
      }
      // Já existe (talvez desativado ou editado): restaura os valores do exemplo.
      const changed =
        !existing.active ||
        existing.name !== sample.name ||
        existing.description !== sample.description ||
        existing.priceCents !== sample.priceCents ||
        existing.lowStockThreshold !== sample.lowStockThreshold;
      if (changed) {
        await inventory.update(companyId, existing.id, {
          name: sample.name,
          description: sample.description,
          priceCents: sample.priceCents,
          lowStockThreshold: sample.lowStockThreshold,
          active: true,
        });
      }
      if (existing.quantity !== sample.quantity) {
        await inventory.adjust(companyId, membershipId, existing.id, {
          delta: sample.quantity - existing.quantity,
          reason: 'COUNT_CORRECTION',
        });
      }
    }
    return { created };
  }

  /** Apaga os documentos de exemplo e desativa os produtos de exemplo. Devolve quantos de cada. */
  async remove(
    companyId: CompanyId,
  ): Promise<{ readonly documents: number; readonly products: number }> {
    const { documents, products, inventory } = this.deps;
    const removed = await documents.deleteSamples(companyId);
    let deactivated = 0;
    for (const product of await products.listSamples(companyId)) {
      if (!product.active) continue;
      await inventory.update(companyId, product.id, { active: false });
      deactivated += 1;
    }
    return { documents: removed, products: deactivated };
  }
}
