import { isIP } from 'node:net';
import type { SmtpMailerOptions } from '../external-apis/email/smtp-verification-mailer.js';
import type { Config } from './env.schema.js';

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** Hostname ou IP puro: sem esquema, caminho, porta, espaço nem `@` (nada de URL). */
export function isValidSmtpHost(host: string): boolean {
  if (isIP(host) !== 0) return true;
  return host.length <= 253 && HOSTNAME.test(host);
}

/** Loopback: `localhost`, 127.0.0.0/8 e `::1`. Nome DNS arbitrário nunca conta. */
export function isLoopbackHost(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  return host === '::1';
}

/**
 * Exige STARTTLS? `secure` (TLS implícito) não precisa. Com `secure=false`: produção sempre exige;
 * fora dela só o loopback aceita texto puro oportunista.
 */
export function smtpRequireTls(
  nodeEnv: Config['NODE_ENV'],
  secure: boolean,
  host: string,
): boolean {
  if (secure) return false;
  if (nodeEnv === 'production') return true;
  return !isLoopbackHost(host);
}

/** Opções do mailer a partir da config (só chamar com `ACCOUNTS_ENABLED=true`, já validada). */
export function smtpMailerOptions(config: Config): SmtpMailerOptions {
  const host = config.EMAIL_PROVIDER_HOST ?? '';
  const user = config.EMAIL_PROVIDER_USER;
  const pass = config.EMAIL_PROVIDER_PSWD;
  return {
    host,
    port: config.EMAIL_PROVIDER_PORT ?? 0,
    secure: config.EMAIL_PROVIDER_SECURE,
    requireTLS: smtpRequireTls(config.NODE_ENV, config.EMAIL_PROVIDER_SECURE, host),
    from: config.EMAIL_PROVIDER_FROM ?? '',
    ...(user && pass ? { auth: { user, pass } } : {}),
  };
}
