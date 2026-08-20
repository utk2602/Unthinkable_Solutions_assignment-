import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';

let io: Server | undefined;

export function startRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: env.FRONTEND_ORIGIN, credentials: true } });
  io.on('connection', (socket) => {
    socket.on('event:join', (eventId: string) => socket.join(`event:${eventId}`));
    socket.on('event:leave', (eventId: string) => socket.leave(`event:${eventId}`));
  });
  return io;
}

export function emitSeatMapChanged(eventId: string) {
  io?.to(`event:${eventId}`).emit('seat-map:changed', { eventId, occurredAt: new Date().toISOString() });
}
