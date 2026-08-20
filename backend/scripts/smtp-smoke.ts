import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import { env } from '../src/config/env.js';

assert.ok(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS, 'SMTP_HOST, SMTP_USER, and SMTP_PASS are required.');
const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
});

try {
  await transport.verify();
  const reference = `SMTP-SMOKE-${Date.now()}`;
  const qr = await QRCode.toBuffer(JSON.stringify({ bookingReference: reference }));
  const result = await transport.sendMail({
    from: env.EMAIL_FROM,
    to: env.SMTP_USER,
    subject: 'Ticketly email and QR delivery check',
    html: `<p>Ticketly SMTP delivery is working.</p><p>Test reference: <strong>${reference}</strong></p><img src="cid:ticket-qr" alt="QR code ticket" />`,
    attachments: [{ filename: `${reference}.png`, content: qr, cid: 'ticket-qr' }]
  });
  assert.ok(result.accepted.length > 0, 'SMTP server did not accept the test message.');
  console.log('SMTP smoke passed: authentication succeeded and the QR email was accepted for delivery to the configured mailbox.');
} finally {
  transport.close();
}
