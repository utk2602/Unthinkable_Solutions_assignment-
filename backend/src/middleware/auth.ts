import type { Role } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';

export async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
  await request.jwtVerify();
}

export function requireRole(...roles: Role[]) {
  return async function authorize(request: FastifyRequest, reply: FastifyReply) {
    if (!roles.includes(request.user.role)) {
      return reply.forbidden('You do not have permission to perform this action.');
    }
  };
}
