import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { prisma } from '../lib/db.js';
import { agentManager } from '../agents/manager.js';

export async function agentRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/agent/connect',
    { websocket: true },
    async (socket: WebSocket, request) => {
      // Auth: Authorization: Bearer <agent_uuid>
      // The agent's UUID (Agent.id) is the API key — no separate key column needed.
      const authHeader = (request.headers as Record<string, string>).authorization ?? '';
      const apiKey = authHeader.replace(/^Bearer\s+/i, '').trim();

      if (!apiKey) {
        socket.close(4001, 'Unauthorized: missing API key');
        return;
      }

      const agent = await prisma.agent.findUnique({
        where: { id: apiKey },
        select: { id: true, venue_id: true },
      });

      if (!agent) {
        socket.close(4001, 'Unauthorized: invalid API key');
        return;
      }

      const { venue_id } = agent;

      agentManager.register(venue_id, socket);

      await prisma.agent.update({
        where: { id: apiKey },
        data: { status: 'ONLINE', last_heartbeat: new Date() },
      });

      fastify.log.info({ event: 'agent_connected', venue_id, agent_id: apiKey });

      socket.on('message', async (raw: Buffer) => {
        let msg: { type: string; [k: string]: unknown };
        try {
          msg = JSON.parse(raw.toString()) as { type: string; [k: string]: unknown };
        } catch {
          return;
        }

        switch (msg.type) {
          case 'HEARTBEAT': {
            await prisma.agent.update({
              where: { id: apiKey },
              data: {
                last_heartbeat: new Date(),
                status: 'ONLINE',
                schema_ok: (msg.schema_ok as boolean) ?? true,
              },
            }).catch(() => {});
            break;
          }

          case 'ORDER_RESULT': {
            fastify.log.info({
              event: 'agent_order_result',
              order_id: msg.order_id,
              status: msg.status,
              tier: msg.tier,
              venue_id,
            });
            break;
          }
        }
      });

      socket.on('close', async () => {
        agentManager.unregister(venue_id);
        await prisma.agent
          .update({ where: { id: apiKey }, data: { status: 'OFFLINE' } })
          .catch(() => {});
        fastify.log.info({ event: 'agent_disconnected', venue_id, agent_id: apiKey });
      });

      socket.on('error', (err: Error) => {
        fastify.log.error({ event: 'agent_socket_error', venue_id, error: err.message });
      });
    },
  );
}
