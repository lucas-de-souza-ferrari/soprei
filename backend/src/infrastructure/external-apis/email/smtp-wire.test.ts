import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { test } from 'node:test';
import { SmtpVerificationMailer, type SmtpMailerOptions } from './smtp-verification-mailer.js';

/** Servidor SMTP mínimo e falso (só loopback, sem STARTTLS anunciado); nenhum e-mail real. */
interface Captured {
  mailFrom: string[];
  rcptTo: string[];
  data: string;
  authLines: string[];
  sawStartTls: boolean;
}

async function startFakeSmtp(): Promise<{
  port: number;
  captured: Captured;
  close: () => Promise<void>;
}> {
  const captured: Captured = {
    mailFrom: [],
    rcptTo: [],
    data: '',
    authLines: [],
    sawStartTls: false,
  };
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let authStep: 'plain' | 'login-user' | 'login-pass' | undefined;
    const reply = (line: string): void => {
      socket.write(`${line}\r\n`);
    };
    reply('220 fake.local ESMTP');
    const onLine = (line: string): void => {
      if (inData) {
        if (line === '.') {
          inData = false;
          reply('250 2.0.0 queued');
        } else {
          captured.data += `${line}\n`;
        }
        return;
      }
      if (authStep !== undefined) {
        captured.authLines.push(line);
        authStep = authStep === 'login-user' ? 'login-pass' : undefined;
        if (authStep === 'login-pass') reply('334 UGFzc3dvcmQ6');
        else reply('235 2.7.0 ok');
        return;
      }
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        socket.write('250-fake.local\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
      } else if (upper.startsWith('STARTTLS')) {
        captured.sawStartTls = true;
        reply('454 TLS not available');
      } else if (upper.startsWith('AUTH PLAIN ')) {
        captured.authLines.push(line);
        reply('235 2.7.0 ok');
      } else if (upper === 'AUTH PLAIN') {
        authStep = 'plain';
        reply('334 ');
      } else if (upper === 'AUTH LOGIN') {
        authStep = 'login-user';
        reply('334 VXNlcm5hbWU6');
      } else if (upper.startsWith('MAIL FROM:')) {
        captured.mailFrom.push(line);
        reply('250 ok');
      } else if (upper.startsWith('RCPT TO:')) {
        captured.rcptTo.push(line);
        reply('250 ok');
      } else if (upper === 'DATA') {
        inData = true;
        reply('354 go ahead');
      } else if (upper === 'QUIT') {
        socket.end('221 bye\r\n');
      } else {
        reply('250 ok');
      }
    };
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\r\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        onLine(line);
        index = buffer.indexOf('\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    port: address.port,
    captured,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

function optionsFor(port: number, extra: Partial<SmtpMailerOptions> = {}): SmtpMailerOptions {
  return {
    host: '127.0.0.1',
    port,
    secure: false,
    requireTLS: false,
    from: 'noreply@example.test',
    ...extra,
  };
}

test('SMTP falso: envia em texto puro, sem AUTH, com remetente, destinatário e código', async () => {
  const smtp = await startFakeSmtp();
  try {
    await new SmtpVerificationMailer(optionsFor(smtp.port)).sendVerification(
      'pessoa@example.test',
      'codigo-1234',
    );
    assert.equal(smtp.captured.authLines.length, 0);
    assert.equal(smtp.captured.sawStartTls, false);
    assert.match(smtp.captured.mailFrom.join(' '), /noreply@example\.test/);
    assert.match(smtp.captured.rcptTo.join(' '), /pessoa@example\.test/);
    assert.ok(smtp.captured.data.includes('codigo-1234'));
    assert.match(smtp.captured.data, /Soprei/);
  } finally {
    await smtp.close();
  }
});

test('SMTP falso: com usuário e senha o AUTH é enviado em loopback sem TLS', async () => {
  const smtp = await startFakeSmtp();
  try {
    await new SmtpVerificationMailer(
      optionsFor(smtp.port, { auth: { user: 'usuario-x', pass: 'senha-x' } }),
    ).sendVerification('pessoa@example.test', 'codigo-5678');
    assert.ok(smtp.captured.authLines.length >= 1);
    const decoded = smtp.captured.authLines
      .map((line) => Buffer.from(line.split(' ').pop() ?? '', 'base64').toString('utf8'))
      .join('|');
    assert.ok(decoded.includes('usuario-x'));
    assert.ok(decoded.includes('senha-x'));
    assert.ok(smtp.captured.data.includes('codigo-5678'));
  } finally {
    await smtp.close();
  }
});

test('SMTP falso: STARTTLS exigido e não oferecido falha sem enviar nada em texto puro', async () => {
  const smtp = await startFakeSmtp();
  try {
    await assert.rejects(
      new SmtpVerificationMailer(optionsFor(smtp.port, { requireTLS: true })).sendVerification(
        'pessoa@example.test',
        'codigo-9999',
      ),
    );
    assert.equal(smtp.captured.rcptTo.length, 0);
    assert.equal(smtp.captured.data, '');
  } finally {
    await smtp.close();
  }
});

test('SMTP falso: contato comercial com Reply-To só com o endereço e assunto fixo (spec 040)', async () => {
  const smtp = await startFakeSmtp();
  try {
    await new SmtpVerificationMailer(optionsFor(smtp.port)).sendSalesContact(
      'vendas@example.test',
      {
        subject: 'Novo contato comercial pelo site do Soprei',
        text: 'Nome: Maria\nMensagem:\nOi',
        replyTo: 'maria@empresa.test',
      },
    );
    assert.match(smtp.captured.rcptTo.join(' '), /vendas@example\.test/);
    assert.doesNotMatch(smtp.captured.rcptTo.join(' '), /maria@empresa\.test/);
    const headers = smtp.captured.data.split('\n\n')[0] ?? '';
    assert.match(headers, /^Reply-To: maria@empresa\.test$/m);
    assert.match(headers, /^Subject: Novo contato comercial pelo site do Soprei$/m);
    assert.doesNotMatch(headers, /^(Cc|Bcc):/im);
  } finally {
    await smtp.close();
  }
});
