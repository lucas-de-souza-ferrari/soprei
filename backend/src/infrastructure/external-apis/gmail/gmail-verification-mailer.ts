import nodemailer, { type SendMailOptions } from 'nodemailer';
import type { VerificationMailer } from '../../../application/ports/account-session.js';
import { ServiceUnavailableError } from '../../../shared/errors/index.js';

export class GmailVerificationMailer implements VerificationMailer {
  private readonly transport: { sendMail(options: SendMailOptions): Promise<unknown> };
  constructor(
    private readonly user: string,
    password: string,
    transport?: { sendMail(options: SendMailOptions): Promise<unknown> },
  ) {
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user, pass: password },
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 10000,
        logger: false,
        debug: false,
      });
  }
  async sendVerification(email: string, token: string): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.user,
        to: email,
        subject: 'Confirme sua conta no Soprei',
        text: [
          'Para confirmar sua conta, copie este código na tela de confirmação do Soprei:',
          token,
          'Ele expira em 30 minutos. Se você não solicitou o cadastro, ignore esta mensagem.',
        ].join(String.fromCharCode(10, 10)),
      });
    } catch {
      throw new ServiceUnavailableError(
        'Não foi possível enviar a confirmação. Tente reenviar mais tarde.',
      );
    }
  }
}
