/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Endereços legais publicados (spec 032, D2), separados por vírgula: o plugin `soprei-legal-pages` do
   * `vite.config.ts` lê a `situacao` dos textos e define este valor no build e no desenvolvimento.
   */
  readonly SOPREI_LEGAL_PUBLISHED?: string;
}
