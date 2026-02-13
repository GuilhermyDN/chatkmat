// src/auth.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcrypt";
import { q } from "./db.js";

// Aceita username/senha (novo) e também userKey (antigo) pra não quebrar o front
const LoginBody = z.union([
  z.object({
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({
    userKey: z.enum(["me", "parceiro"]),
  }),
]);

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/login", async (req, reply) => {
    // Debug (remova depois)
    console.log("LOGIN BODY:", req.body);

    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      console.log("LOGIN ZOD ERROR:", parsed.error.flatten());
      return reply.code(400).send({ message: "Dados inválidos" });
    }

    // --- NOVO: username + password ---
    if ("username" in parsed.data) {
      const { username, password } = parsed.data;

      const rows = await q<{
        id: string;
        username: string;
        password_hash: string | null;
      }>(
        "select id, username, password_hash from users where username=$1 limit 1",
        [username],
      );

      const user = rows[0];
      if (!user || !user.password_hash) {
        return reply.code(401).send({ message: "Credenciais inválidas" });
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        return reply.code(401).send({ message: "Credenciais inválidas" });
      }

      const token = await reply.jwtSign(
        { uid: user.id, username: user.username },
        { expiresIn: "7d" },
      );

      return {
        token,
        user: { id: user.id, username: user.username },
      };
    }

    // --- ANTIGO: userKey mockado ---
    const { userKey } = parsed.data;

    const rows = await q<{
      id: string;
      user_key: string;
      display_name: string;
      username: string | null;
    }>(
      "select id, user_key, display_name, username from users where user_key=$1 limit 1",
      [userKey],
    );

    const user = rows[0];
    if (!user) {
      return reply.code(401).send({ message: "Usuário mockado não existe no banco" });
    }

    const token = await reply.jwtSign(
      { uid: user.id, userKey: user.user_key, username: user.username ?? user.user_key, name: user.display_name },
      { expiresIn: "7d" },
    );

    return {
      token,
      user: {
        id: user.id,
        username: user.username ?? user.user_key,
        name: user.display_name,
      },
    };
  });

  // Middleware de auth
  app.decorate("requireAuth", async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ message: "Não autenticado" });
    }
  });
}

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (req: any, reply: any) => Promise<any>;
  }
}
