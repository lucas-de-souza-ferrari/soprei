import type { CompanyId } from '../../domain/index.js';

/**
 * Medição de uso por assinatura (spec 031, E2). Só números: **nunca** texto de mensagem, contato nem
 * `contactRef`. O `CompanyId` vem do contexto do atendimento (nunca de header, corpo ou argumento de
 * ferramenta) e a implementação o resolve para a assinatura no servidor. Falha de medição nunca derruba
 * a resposta nem o envio: quem chama captura o erro, loga só ids e conta `usage_meter_errors_total`.
 */
export interface UsageMeter {
  /** Soma `tokens` (`inputTokens + outputTokens` do `usage` do provedor) à janela atual. */
  record(companyId: CompanyId, tokens: number): Promise<void>;
  /** Conta uma mensagem de saída ao contato efetivamente enviada (a que a Meta cobra). */
  recordSent(companyId: CompanyId): Promise<void>;
}
