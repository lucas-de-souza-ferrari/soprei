/**
 * Mantém o event loop vivo enquanto um teste espera um timer com `unref()` (ex.: o de
 * `withTimeout`) sobre uma promise que nunca resolve. Sem isto, o Node 22 encerra o arquivo
 * de teste com "Promise resolution is still pending but the event loop has already resolved".
 * Devolve a função que libera.
 */
export function keepEventLoopAlive(): () => void {
  const timer = setInterval(() => undefined, 1_000);
  return () => {
    clearInterval(timer);
  };
}
