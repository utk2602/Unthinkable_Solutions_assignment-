import { NotificationStatus, NotificationType } from '@prisma/client';
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';

const transporter = env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS
  ? nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } })
  : null;

export async function deliverPendingNotifications() {
  const retryBefore = new Date(Date.now() - 5 * 60_000);
  const notifications = await prisma.notification.findMany({
    where: {
      attemptCount: { lt: 3 },
      OR: [
        { status: NotificationStatus.PENDING },
        { status: NotificationStatus.FAILED, lastAttemptAt: null },
        { status: NotificationStatus.FAILED, lastAttemptAt: { lte: retryBefore } }
      ]
    },
    take: 25,
    orderBy: { createdAt: 'asc' },
    include: { booking: true, offer: true }
  });
  for (const notification of notifications) {
    if (!transporter) {
      await prisma.notification.updateMany({ where: { id: notification.id }, data: { status: NotificationStatus.FAILED, error: 'SMTP is not configured.', attemptCount: { increment: 1 }, lastAttemptAt: new Date() } });
      continue;
    }
    try {
      const offerLink = notification.offer ? `${env.FRONTEND_ORIGIN}/waitlist/offer/${notification.offer.token}` : undefined;
      const attachments = notification.type === NotificationType.BOOKING_CONFIRMATION && notification.booking
        ? [{ filename: `${notification.booking.reference}.png`, content: await QRCode.toBuffer(notification.booking.qrPayload), cid: 'ticket-qr' }]
        : undefined;
      const html = notification.type === NotificationType.BOOKING_CONFIRMATION && notification.booking
        ? `<p>${notification.body}</p><p>Booking reference: <strong>${notification.booking.reference}</strong></p><img src="cid:ticket-qr" alt="QR code ticket" />`
        : `<p>${notification.body}</p>${offerLink ? `<p><a href="${offerLink}">Complete booking</a></p>` : ''}`;
      await transporter.sendMail({ from: env.EMAIL_FROM, to: notification.recipient, subject: notification.subject, html, attachments });
      await prisma.notification.updateMany({ where: { id: notification.id }, data: { status: NotificationStatus.SENT, sentAt: new Date(), error: null, attemptCount: { increment: 1 }, lastAttemptAt: new Date() } });
    } catch (error) {
      await prisma.notification.updateMany({ where: { id: notification.id }, data: { status: NotificationStatus.FAILED, error: error instanceof Error ? error.message : 'Unknown delivery error', attemptCount: { increment: 1 }, lastAttemptAt: new Date() } });
    }
  }
}
