import Fastify from "fastify";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import "dotenv/config";
import cors from "@fastify/cors";
import { authRoutes } from "./auth";
import { chatRoutes } from "./chat";

import { q } from "./db";

const app = Fastify({ logger: true });

app.register(jwt, { secret: process.env.JWT_SECRET ?? "dev_secret" });
app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB
app.register(websocket);

app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), "uploads"),
    prefix: "/files/",
});



app.get("/health", async () => ({ ok: true }));

async function main() {
    await app.register(cors, {
        origin: true, // libera qualquer origin em dev
        credentials: true,
    });

    await authRoutes(app);
    await chatRoutes(app);

    const port = Number(process.env.PORT ?? 3001);

    await app.listen({ port, host: "0.0.0.0" });
}

main().catch((err) => {
    app.log.error(err);
    process.exit(1);
});
