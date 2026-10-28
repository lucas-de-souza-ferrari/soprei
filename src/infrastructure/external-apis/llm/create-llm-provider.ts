import type { LlmProvider } from '../../../application/ports/llm-provider.js';
import { ValidationError } from '../../../shared/errors/index.js';
import type { Config } from '../../config/index.js';
import { AnthropicLlmProvider } from './anthropic-llm.provider.js';
import { MockLlmProvider } from './mock-llm.provider.js';

type LlmConfig = Pick<
  Config,
  | 'LLM_PROVIDER'
  | 'LLM_TIMEOUT_MS'
  | 'LLM_MODEL'
  | 'LLM_EFFORT'
  | 'LLM_MAX_OUTPUT_TOKENS'
  | 'LLM_MAX_RETRIES'
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_BASE_URL'
>;

/** Um construtor por valor de `LLM_PROVIDER`: o compilador exige um para cada provedor novo. */
const PROVIDERS: Readonly<Record<Config['LLM_PROVIDER'], (config: LlmConfig) => LlmProvider>> = {
  mock: () => new MockLlmProvider(),
  anthropic: (config) => {
    // A config já exige a chave com `LLM_PROVIDER=anthropic`; isto só estreita o tipo.
    if (config.ANTHROPIC_API_KEY === undefined) {
      throw new ValidationError('ANTHROPIC_API_KEY ausente com LLM_PROVIDER=anthropic', {
        context: { variable: 'ANTHROPIC_API_KEY' },
      });
    }
    return new AnthropicLlmProvider({
      apiKey: config.ANTHROPIC_API_KEY,
      baseUrl: config.ANTHROPIC_BASE_URL,
      model: config.LLM_MODEL,
      effort: config.LLM_EFFORT,
      maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
      maxRetries: config.LLM_MAX_RETRIES,
      timeoutMs: config.LLM_TIMEOUT_MS,
    });
  },
};

/** Escolhe o provedor pela configuração (`LLM_PROVIDER`). Trocar de modelo é mudar a variável. */
export function createLlmProvider(config: LlmConfig): LlmProvider {
  return PROVIDERS[config.LLM_PROVIDER](config);
}
