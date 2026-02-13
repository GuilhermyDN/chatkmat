// src/chat.ts
import type { FastifyInstance } from "fastify";
import { q } from "./db.ts";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";


const SendMessageBody = z.object({
  conversationId: z.string().uuid(),
  type: z.enum(["text", "image", "video", "audio"]),
  text: z.string().optional(),
  mediaUrl: z.string().optional(),
  mediaMeta: z.any().optional(),
});

function ensureUploadsDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

type WsClient = {
  uid: string;
  conversationId: string;
  socket: any;
};

const wsClients: WsClient[] = [];

async function isParticipant(conversationId: string, uid: string) {
  const rows = await q<{ ok: boolean }>(
    `select true as ok
     from conversations
     where id=$1 and (user_a_id=$2 or user_b_id=$2)
     limit 1`,
    [conversationId, uid],
  );
  return !!rows[0]?.ok;
}

export async function chatRoutes(app: FastifyInstance) {
  const uploadsDir = path.resolve(process.cwd(), "uploads");
  ensureUploadsDir(uploadsDir);

  // Histórico
  app.get(
    "/conversations/:id/messages",
    { preHandler: app.requireAuth },
    async (req: any, reply) => {
      const conversationId = req.params.id as string;
      const uid = req.user.uid as string;

      if (!(await isParticipant(conversationId, uid))) {
        return reply.code(403).send({ message: "Sem acesso a esta conversa" });
      }

      const rows = await q(
        `select id,
                sender_id as "senderId",
                type,
                text,
                media_url as "mediaUrl",
                media_meta as "mediaMeta",
                created_at as "createdAt"
         from messages
         where conversation_id=$1
         order by created_at asc
         limit 500`,
        [conversationId],
      );

      return { messages: rows };
    },
  );

  // Enviar mensagem (texto ou mídia já com URL)
  app.post(
    "/messages",
    { preHandler: app.requireAuth },
    async (req: any, reply) => {
      const parsed = SendMessageBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ message: "Dados inválidos" });

      const { conversationId, type, text, mediaUrl, mediaMeta } = parsed.data;
      const uid = req.user.uid as string;

      if (!(await isParticipant(conversationId, uid))) {
        return reply.code(403).send({ message: "Sem acesso a esta conversa" });
      }

      if (type === "text") {
        if (!text || !text.trim()) return reply.code(400).send({ message: "Texto obrigatório" });
      } else {
        if (!mediaUrl) return reply.code(400).send({ message: "mediaUrl obrigatório para mídia" });
      }

      const rows = await q<{ id: string }>(
        `insert into messages (conversation_id, sender_id, type, text, media_url, media_meta)
         values ($1,$2,$3,$4,$5,$6)
         returning id`,
        [conversationId, uid, type, text ?? null, mediaUrl ?? null, mediaMeta ?? null],
      );

      const messageId = rows[0]!.id;

      // broadcast WS pros participantes conectados nessa conversa
      wsClients
        .filter((c) => c.conversationId === conversationId)
        .forEach((c) => {
          try {
            c.socket.send(
              JSON.stringify({
                event: "message:new",
                data: {
                  id: messageId,
                  conversationId,
                  senderId: uid,
                  type,
                  text: text ?? null,
                  mediaUrl: mediaUrl ?? null,
                  mediaMeta: mediaMeta ?? null,
                },
              }),
            );
          } catch {}
        });

      return { ok: true, id: messageId };
    },
  );

  // Upload (audio/foto/video). Retorna mediaUrl pronto pra salvar como mensagem.
  app.post(
    "/upload",
    { preHandler: app.requireAuth },
    async (req: any, reply) => {
      const uid = req.user.uid as string;

      const mp = await req.file();
      if (!mp) return reply.code(400).send({ message: "Arquivo ausente" });

      const safeName = `${Date.now()}_${mp.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const fullPath = path.join(uploadsDir, safeName);

      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(fullPath);
        mp.file.pipe(ws);
        mp.file.on("error", reject);
        ws.on("finish", () => resolve());
        ws.on("error", reject);
      });

      // URL pública via static (serve /files/*)
      const mediaUrl = `/files/${safeName}`;

      return {
        ok: true,
        mediaUrl,
        mediaMeta: {
          filename: mp.filename,
          mime: mp.mimetype,
          uploadedBy: uid,
        },
      };
    },
  );

  // WebSocket realtime
  // Conecta via browser em:
  // ws://HOST/ws?conversationId=...&token=JWT
  // (aceita token em query pq browser não envia Authorization header)
  app.get("/ws", { websocket: true }, async (connection, req: any) => {
    const auth = req.headers.authorization as string | undefined;
    const tokenFromHeader = auth?.startsWith("Bearer ")
      ? auth.slice("Bearer ".length)
      : null;
    const tokenFromQuery = (req.query?.token as string) || null;

    const token = tokenFromHeader || tokenFromQuery;
    if (!token) {
      connection.socket.close();
      return;
    }

    let payload: any;
    try {
      payload = await app.jwt.verify(token);
    } catch {
      connection.socket.close();
      return;
    }

    const conversationId = (req.query?.conversationId as string) || "";
    if (!conversationId) {
      connection.socket.close();
      return;
    }

    const uid = payload.uid as string;

    if (!(await isParticipant(conversationId, uid))) {
      connection.socket.close();
      return;
    }

    const client: WsClient = { uid, conversationId, socket: connection.socket };
    wsClients.push(client);

    connection.socket.on("close", () => {
      const idx = wsClients.indexOf(client);
      if (idx >= 0) wsClients.splice(idx, 1);
    });
  });
}
