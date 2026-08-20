import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(24),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:5173'),
  SEAT_HOLD_MINUTES: z.coerce.number().int().positive().default(10),
  WAITLIST_OFFER_MINUTES: z.coerce.number().int().positive().default(30),
  EMAIL_FROM: z.string().default('Ticket Booking <no-reply@example.com>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional()
});

export const env = envSchema.parse(process.env);
