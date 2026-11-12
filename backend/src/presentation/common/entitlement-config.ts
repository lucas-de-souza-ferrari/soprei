import type { ContractModule } from '../../domain/index.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Módulo contratado que a rota de ESCRITA exige (spec 031): `schedule` ou `inventory`. Leitura (`GET`)
     * nunca é barrada por módulo (a pessoa vê o que já tem). Toda rota `schedule/*` e `inventory/*` declara.
     */
    requiresModule?: ContractModule;
    /**
     * A rota de escrita NÃO é barrada por assinatura inativa (spec 031): Assinatura, `entitlements`,
     * desconectar o canal e a gestão de equipe. Sem isto, toda escrita de tenant exige acesso ativo.
     */
    subscriptionExempt?: true;
  }
}

/** `config` de rota de escrita que exige o módulo contratado (além da assinatura ativa). */
export function requireModule(module: ContractModule): { readonly requiresModule: ContractModule } {
  return { requiresModule: module };
}

/** `config` de rota que segue funcionando com a assinatura inativa (lista curta e declarada). */
export function subscriptionExempt(): { readonly subscriptionExempt: true } {
  return { subscriptionExempt: true };
}
