import nodemailer, { type SendMailOptions } from 'nodemailer';
import type { VerificationMailer } from '../../../application/ports/account-session.js';
import { ServiceUnavailableError } from '../../../shared/errors/index.js';

/** Opções já validadas pela config (spec 019); a decisão de `requireTLS` vem de `config/email.ts`. */
export interface SmtpMailerOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTLS: boolean;
  readonly from: string;
  readonly auth?: { readonly user: string; readonly pass: string };
}

export interface MailTransport {
  sendMail(options: SendMailOptions): Promise<unknown>;
}

/** Opções do `createTransport`: `auth` só existe com usuário e senha; certificado sempre verificado. */
export function buildTransportOptions(options: SmtpMailerOptions): Record<string, unknown> {
  return {
    host: options.host,
    port: options.port,
    secure: options.secure,
    // Com `secure: true` o TLS já é implícito; `requireTLS` só vale para STARTTLS.
    requireTLS: options.secure ? false : options.requireTLS,
    ...(options.auth ? { auth: { user: options.auth.user, pass: options.auth.pass } } : {}),
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    logger: false,
    debug: false,
  };
}

export class SmtpVerificationMailer implements VerificationMailer {
  private readonly transport: MailTransport;
  private readonly from: string;

  constructor(options: SmtpMailerOptions, transport?: MailTransport) {
    this.from = options.from;
    this.transport = transport ?? nodemailer.createTransport(buildTransportOptions(options));
  }

  async sendVerification(email: string, code: string): Promise<void> {
    try {
      await this.transport.sendMail({
        from: { name: 'Soprei', address: this.from },
        to: email,
        subject: 'Seu código de confirmação do Soprei',
        text: [
          'Seu código de confirmação é:',
          '',
          code,
          '',
          'Ele vale por 15 minutos. Se você não pediu este cadastro, ignore esta mensagem.',
        ].join('\n'),
      });
    } catch {
      throw new ServiceUnavailableError(
        'Não foi possível enviar a confirmação. Tente reenviar mais tarde.',
      );
    }
  }
}
