import type { Role } from '@prisma/client';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: {
      id: string;
      email: string;
      role: Role;
    };
  }
}

export {};
