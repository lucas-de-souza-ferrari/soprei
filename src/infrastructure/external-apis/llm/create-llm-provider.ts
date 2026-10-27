import type { LlmProvider } from '../../../application/ports/llm-provider.js';
import type { Config } from '../../config/index.js';
import { MockLlmProvider } from './mock-llm.provider.js';

/** Um construtor por valor de `LLM_PROVIDER`: o compilador exige um para cada provedor novo. */
const PROVIDERS: Readonly<Record<Config['LLM_PROVIDER'], () => LlmProvider>> = {
  mock: () => new MockLlmProvider(),
};

/** Escolhe o provedor pela configuração (`LLM_PROVIDER`). Trocar de modelo é mudar a variável. */
export function createLlmProvider(config: Pick<Config, 'LLM_PROVIDER'>): LlmProvider {
  return PROVIDERS[config.LLM_PROVIDER]();
}
