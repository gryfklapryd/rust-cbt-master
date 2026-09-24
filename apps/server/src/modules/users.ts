import { count, desc, eq, ilike, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { USER_ROLES, users } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { IdParams, likePattern, PageQuery, paged, paginate } from "../lib/http.js";
import { hashPassword } from "../lib/password.js";
import { currentUser } from "../plugins/auth.js";

const Username = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9._-]+$/i)
  .transform((s) => s.toLowerCase());

const UserInput = z.object({
  username: Username,
  name: z.string().min(1).max(200),
  email: z.email().nullish(),
  role: z.enum(USER_ROLES),
  password: z.string().min(8).max(200),
  active: z.boolean().default(true),
});

const publicColumns = {
  id: users.id,
  username: users.username,
  name: users.name,
  email: users.email,
  role: users.role,
  active: users.active,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
};

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("onRequest", app.requireUser("admin"));

  app.get("/", { schema: { tags: ["users"], querystring: PageQuery } }, async (req) => {
    const q = req.query;
    const where = q.q ? or(ilike(users.username, likePattern(q.q)), ilike(users.name, likePattern(q.q))) : undefined;
    const { limit, offset } = paginate(q);
    const [items, [total]] = await Promise.all([
      db.select(publicColumns).from(users).where(where).orderBy(desc(users.createdAt)).limit(limit).offset(offset),
      db.select({ n: count() }).from(users).where(where),
    ]);
    return paged(items, total!.n, q);
  });

  app.post("/", { schema: { tags: ["users"], body: UserInput } }, async (req, reply) => {
    const { password, ...rest } = req.body;
    const [user] = await db
      .insert(users)
      .values({ ...rest, email: rest.email ?? null, passwordHash: await hashPassword(password) })
      .returning(publicColumns);
    await audit(db, { type: "user", id: currentUser(req).sub }, "user.create", "user", user!.id);
    return reply.status(201).send(user);
  });

  app.patch(
    "/:id",
    {
      schema: {
        tags: ["users"],
        params: IdParams,
        body: UserInput.partial().extend({ password: z.string().min(8).max(200).optional() }),
      },
    },
    async (req) => {
      const { password, ...rest } = req.body;
      const me = currentUser(req);
      if (req.params.id === me.sub && (rest.active === false || (rest.role && rest.role !== "admin"))) {
        throw app.httpErrors.badRequest("Tidak bisa menonaktifkan / menurunkan peran akun sendiri");
      }
      const [user] = await db
        .update(users)
        .set({ ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}) })
        .where(eq(users.id, req.params.id))
        .returning(publicColumns);
      if (!user) throw app.httpErrors.notFound("User tidak ditemukan");
      await audit(db, { type: "user", id: me.sub }, "user.update", "user", user.id, { fields: Object.keys(req.body) });
      return user;
    },
  );

  app.delete("/:id", { schema: { tags: ["users"], params: IdParams } }, async (req, reply) => {
    const me = currentUser(req);
    if (req.params.id === me.sub) throw app.httpErrors.badRequest("Tidak bisa menghapus akun sendiri");
    const res = await db.delete(users).where(eq(users.id, req.params.id)).returning({ id: users.id });
    if (!res.length) throw app.httpErrors.notFound("User tidak ditemukan");
    await audit(db, { type: "user", id: me.sub }, "user.delete", "user", req.params.id);
    return reply.status(204).send();
  });
};

export default routes;
