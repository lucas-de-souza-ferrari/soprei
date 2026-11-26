import nodemailer, { type SendMailOptions } from 'nodemailer';
import {
  INVITATION_MAIL_SUBJECT,
  invitationMailText,
} from '../../../application/invitations/invitation-mail.js';
import type {
  BillingMailer,
  BillingNoticeMail,
} from '../../../application/ports/billing-mailer.js';
import type {
  SalesContactMail,
  SalesContactMailer,
} from '../../../application/ports/sales-contact.js';
import type {
  CompanyInvitationMail,
  InvitationMailer,
  AccountDeletionMailer,
  PasswordResetMailer,
  VerificationMailer,
} from '../../../application/ports/account-session.js';
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
/** Aviso de conta excluída (spec 032, E7; spec 045, E6). */
export const ACCOUNT_DELETED_SUBJECT = 'Sua conta do Soprei foi excluída';
export const ACCOUNT_DELETED_TEXT =
  'A sua conta do Soprei foi excluída: o e-mail e a senha deixaram de valer e todas as sessões foram encerradas. Os registros de cobrança ficam guardados pelo prazo da lei. Se você não pediu a exclusão, responda a este e-mail.';

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

export class SmtpVerificationMailer
  implements
    VerificationMailer,
    PasswordResetMailer,
    InvitationMailer,
    BillingMailer,
    SalesContactMailer,
    AccountDeletionMailer
{
  private readonly transport: MailTransport;
  private readonly from: string;

  constructor(options: SmtpMailerOptions, transport?: MailTransport) {
    this.from = options.from;
    this.transport = transport ?? nodemailer.createTransport(buildTransportOptions(options));
  }

  /** Envia texto simples; qualquer falha vira erro fixo, sem eco do destinatário, texto ou código. */
  private async send(
    email: string,
    subject: string,
    lines: readonly string[],
    failure: string,
  ): Promise<void> {
    try {
      await this.transport.sendMail({
        from: { name: 'Soprei', address: this.from },
        to: email,
        subject,
        text: lines.join('\n'),
      });
    } catch {
      throw new ServiceUnavailableError(failure);
    }
  }

  sendVerification(email: string, code: string): Promise<void> {
    return this.send(
      email,
      'Seu código de confirmação do Soprei',
      [
        'Seu código de confirmação é:',
        '',
        code,
        '',
        'Ele vale por 15 minutos. Se você não pediu este cadastro, ignore esta mensagem.',
      ],
      'Não foi possível enviar a confirmação. Tente reenviar mais tarde.',
    );
  }

  sendPasswordReset(email: string, code: string): Promise<void> {
    return this.send(
      email,
      'Seu código para redefinir a senha do Soprei',
      [
        'Seu código para redefinir a senha é:',
        '',
        code,
        '',
        'Ele vale por 15 minutos. Se você não pediu isso, ignore esta mensagem; sua senha continua a mesma.',
      ],
      'Não foi possível enviar o código de recuperação.',
    );
  }

  sendCompanyInvitation(email: string, mail: CompanyInvitationMail): Promise<void> {
    // Falha fixa: nunca ecoa destinatário, nome da empresa, papel nem link.
    return this.send(
      email,
      INVITATION_MAIL_SUBJECT,
      [invitationMailText(mail)],
      'Não foi possível enviar o convite.',
    );
  }

  sendBillingNotice(email: string, mail: BillingNoticeMail): Promise<void> {
    // Falha fixa: nunca ecoa destinatário, texto nem link.
    return this.send(
      email,
      mail.subject,
      [mail.text],
      'Não foi possível enviar o aviso de cobrança.',
    );
  }

  /**
   * Contato comercial (spec 040, E4): para a caixa comercial, com `Reply-To` só com o endereço do interessado
   * (objeto do nodemailer, sem nome de exibição). Nenhum outro cabeçalho recebe dado do formulário.
   */
  async sendSalesContact(to: string, mail: SalesContactMail): Promise<void> {
    try {
      await this.transport.sendMail({
        from: { name: 'Soprei', address: this.from },
        to,
        replyTo: { name: '', address: mail.replyTo },
        subject: mail.subject,
        text: mail.text,
      });
    } catch {
      // Falha fixa: nunca ecoa destinatário, texto nem o endereço de resposta.
      throw new ServiceUnavailableError('Não foi possível enviar o contato comercial.');
    }
  }

  /** Spec 032, E7 / 045, E6: assunto e texto fixos, sem código, senha, link nem quem pediu. */
  sendAccountDeleted(email: string): Promise<void> {
    return this.send(
      email,
      ACCOUNT_DELETED_SUBJECT,
      [ACCOUNT_DELETED_TEXT],
      'Não foi possível enviar o aviso de conta excluída.',
    );
  }

  sendPasswordChanged(email: string): Promise<void> {
    return this.send(
      email,
      'Sua senha do Soprei foi alterada',
      [
        'A senha da sua conta foi alterada e todas as sessões abertas foram encerradas. Se foi você, não precisa fazer nada. Se não foi, redefina a senha de novo e confira o acesso ao seu e-mail.',
      ],
      'Não foi possível enviar o aviso de senha alterada.',
    );
  }
}
