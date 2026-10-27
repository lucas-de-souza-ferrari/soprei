import { isIP } from 'node:net';

/**
 * Valor de `TRUST_PROXY` já interpretado, no formato que o `trustProxy` do Fastify aceita:
 * - `false`: ignora `X-Forwarded-For` (o IP é o do socket);
 * - `true`: confia em TODA a cadeia (spoofável: o cliente escolhe o IP; só para ambiente fechado);
 * - lista de IPs/CIDRs: só esses proxies são confiados (o proxy-addr valida o peer imediato).
 *
 * Não existe valor inteiro ("n proxies à frente"): o Fastify 5.12.7 o trata como fail-closed (nunca
 * confia, de propósito: contagem de saltos sozinha não valida o peer imediato) e a função
 * equivalente `(addr, hop) => hop < n` reabriria o spoofing de `X-Forwarded-For`.
 */
export type TrustProxySetting = boolean | readonly string[];

export type TrustProxyParseResult =
  | { readonly ok: true; readonly value: TrustProxySetting }
  | { readonly ok: false; readonly message: string };

const INTEGER = /^\d+$/;

function invalidEntry(entry: string): string {
  return `entrada inválida "${entry}": use um IP (1.2.3.4) ou um CIDR (10.0.0.0/8)`;
}

/** `ip` ou `ip/prefixo`, com prefixo entre 1 e 32 (IPv4) ou 1 e 128 (IPv6). */
function validateAddress(entry: string): string | undefined {
  const slash = entry.indexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(address);
  if (family === 0) return invalidEntry(entry);
  if (slash === -1) return undefined;
  const prefixText = entry.slice(slash + 1);
  if (!INTEGER.test(prefixText)) return invalidEntry(entry);
  const prefix = Number(prefixText);
  const max = family === 4 ? 32 : 128;
  if (prefix < 1) {
    return `entrada "${entry}" confiaria em qualquer endereço; use TRUST_PROXY=true se é isso mesmo`;
  }
  if (prefix > max) return invalidEntry(entry);
  return undefined;
}

/**
 * Interpreta `TRUST_PROXY`: `false`, `true` ou lista de IPs/CIDRs separados
 * por vírgula. Vazio vale como `false`. Qualquer outra coisa é rejeitada (nada de palavras-chave
 * do proxy-addr como `loopback`, para a configuração ser explícita).
 */
export function parseTrustProxy(raw: string | undefined): TrustProxyParseResult {
  const text = (raw ?? '').trim();
  if (text === '' || text === 'false') return { ok: true, value: false };
  if (text === 'true') return { ok: true, value: true };

  if (INTEGER.test(text)) {
    return {
      ok: false,
      message:
        'inteiro não é aceito (o Fastify não confia em contagem de saltos); liste os IPs/CIDRs dos proxies, ex.: 127.0.0.1,::1',
    };
  }

  const entries = text.split(',').map((entry) => entry.trim());
  for (const entry of entries) {
    if (entry === '') return { ok: false, message: 'lista com entrada vazia' };
    const problem = validateAddress(entry);
    if (problem !== undefined) return { ok: false, message: problem };
  }
  return { ok: true, value: entries };
}
