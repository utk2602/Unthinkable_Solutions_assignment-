import { Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';

const registrationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(8).max(128),
  role: z.enum([Role.CUSTOMER, Role.ORGANISER]).default(Role.CUSTOMER)
});

const loginSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(1)
});

function publicUser(user: { id: string; name: string; email: string; role: Role; createdAt: Date }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt };
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/register', async (request, reply) => {
    const input = registrationSchema.parse(request.body);
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) return reply.conflict('An account with this email already exists.');

    const user = await prisma.user.create({
      data: { name: input.name, email: input.email, passwordHash: await bcrypt.hash(input.password, 12), role: input.role }
    });
    const token = await reply.jwtSign({ id: user.id, email: user.email, role: user.role });
    return reply.code(201).send({ user: publicUser(user), token });
  });

  app.post('/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      return reply.unauthorized('Invalid email or password.');
    }
    const token = await reply.jwtSign({ id: user.id, email: user.email, role: user.role });
    return { user: publicUser(user), token };
  });

  app.get('/me', { preHandler: authenticate }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (!user) return reply.unauthorized('Account no longer exists.');
    return { user: publicUser(user) };
  });
};
