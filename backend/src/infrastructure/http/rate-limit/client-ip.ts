import { isIP } from 'node:net';
import { normalizeIP } from '@fastify/rate-limit';

/** Chave usada quando não há um IP utilizável (nunca ocorre com o IP do socket). */
export const UNKNOWN_CLIENT_IP = 'unknown';

const BRACKETED = /^\[([^\]]+)\](?::\d+)?$/;
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/;

/**
 * IP do cliente (quem chama) em forma canônica para virar chave de limite. Mantém a normalização do plugin
 * (`normalizeIP`: IPv4 mapeado em IPv6 vira IPv4; IPv6 agrupado em /64) e acrescenta o que ela
 * não cobre: colchetes e porta (`[::1]:8080`, `1.2.3.4:80`) e zona de IPv6 (`fe80::1%eth0`)
 * são removidos antes. Nunca lança: o que não for IP vira `unknown`.
 */
export function normalizeClientIp(raw: string | undefined): string {
  if (raw === undefined) return UNKNOWN_CLIENT_IP;
  let ip = raw.trim();
  const bracketed = BRACKETED.exec(ip);
  if (bracketed?.[1] !== undefined) {
    ip = bracketed[1];
  } else {
    const withPort = IPV4_WITH_PORT.exec(ip);
    if (withPort?.[1] !== undefined) ip = withPort[1];
  }
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (isIP(ip) === 0) return UNKNOWN_CLIENT_IP;
  try {
    return normalizeIP(ip);
  } catch {
    return UNKNOWN_CLIENT_IP;
  }
}

/**
 * IP de uma requisição para a chave de limite. Usa `request.ip` (que já considera
 * `trustProxy`); se ele não for um IP utilizável (ex.: `X-Forwarded-For` malformado vindo de um
 * proxy confiado), cai no endereço do socket, nunca lança.
 */
export function clientIpOf(request: {
  readonly ip: string;
  readonly socket: { readonly remoteAddress?: string | undefined };
}): string {
  const ip = normalizeClientIp(request.ip);
  return ip === UNKNOWN_CLIENT_IP ? normalizeClientIp(request.socket.remoteAddress) : ip;
}
