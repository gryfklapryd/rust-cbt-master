import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { currentUser } from "../plugins/auth.js";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/login",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        security: [],
        body: z.object({ username: z.string().min(1), password: z.string().min(1) }),
      },
    },
    async (req) => {
      const { username, password } = req.body;
      const user = await db.query.users.findFirst({ where: eq(users.username, username.toLowerCase()) });
      if (!user || !user.active || !(await verifyPassword(user.passwordHash, password))) {
        throw app.httpErrors.unauthorized("Username atau password salah");
      }
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      const token = app.jwt.sign(
        { kind: "user", sub: user.id, role: user.role, username: user.username },
        { expiresIn: config.JWT_ADMIN_TTL },
      );
      return {
        token,
        user: { id: user.id, username: user.username, name: user.name, role: user.role, email: user.email },
      };
    },
  );

  app.get("/me", { onRequest: app.requireUser(), schema: { tags: ["auth"] } }, async (req) => {
    const u = currentUser(req);
    const user = await db.query.users.findFirst({
      where: eq(users.id, u.sub),
      columns: { passwordHash: false },
    });
    if (!user || !user.active) throw app.httpErrors.unauthorized();
    return user;
  });

  app.post(
    "/change-password",
    {
      onRequest: app.requireUser(),
      schema: {
        tags: ["auth"],
        body: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) }),
      },
    },
    async (req) => {
      const u = currentUser(req);
      const user = await db.query.users.findFirst({ where: eq(users.id, u.sub) });
      if (!user || !(await verifyPassword(user.passwordHash, req.body.currentPassword))) {
        throw app.httpErrors.badRequest("Password lama salah");
      }
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(req.body.newPassword) })
        .where(eq(users.id, u.sub));
      return { ok: true };
    },
  );
};

export default routes;
