import { and, asc, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { proctorActions, siteProctors, sites, users } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { IdParams, likePattern, PageQuery, paged, paginate } from "../lib/http.js";
import { hashPassword, randomSecret } from "../lib/password.js";
import { currentUser } from "../plugins/auth.js";

const SiteInput = z.object({
  code: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/)
    .transform((s) => s.toUpperCase()),
  name: z.string().min(1).max(200),
  address: z.string().max(1000).nullish(),
  capacity: z.number().int().min(0).nullish(),
  active: z.boolean().default(true),
});

const columns = {
  id: sites.id,
  code: sites.code,
  name: sites.name,
  address: sites.address,
  capacity: sites.capacity,
  active: sites.active,
  lastSeenAt: sites.lastSeenAt,
  lastSeenInfo: sites.lastSeenInfo,
  createdAt: sites.createdAt,
  updatedAt: sites.updatedAt,
};

/** Proktor yang ditugaskan per lokasi. */
async function proctorsOf(siteIds: string[]) {
  if (!siteIds.length) return new Map<string, { id: string; username: string; name: string; active: boolean }[]>();
  const rows = await db
    .select({ siteId: siteProctors.siteId, id: users.id, username: users.username, name: users.name, active: users.active })
    .from(siteProctors)
    .innerJoin(users, eq(users.id, siteProctors.userId))
    .where(inArray(siteProctors.siteId, siteIds))
    .orderBy(asc(users.username));
  const map = new Map<string, { id: string; username: string; name: string; active: boolean }[]>();
  for (const { siteId, ...u } of rows) map.set(siteId, [...(map.get(siteId) ?? []), u]);
  return map;
}

const ProctorLogQuery = PageQuery.extend({ attemptId: z.uuid().optional() });

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get("/", { onRequest: app.requireUser(), schema: { tags: ["sites"], querystring: PageQuery } }, async (req) => {
    const q = req.query;
    const where = q.q ? or(ilike(sites.code, likePattern(q.q)), ilike(sites.name, likePattern(q.q))) : undefined;
    const { limit, offset } = paginate(q);
    const [items, [total]] = await Promise.all([
      db.select(columns).from(sites).where(where).orderBy(asc(sites.code)).limit(limit).offset(offset),
      db.select({ n: count() }).from(sites).where(where),
    ]);
    const proctors = await proctorsOf(items.map((s) => s.id));
    return paged(
      items.map((s) => ({ ...s, proctors: proctors.get(s.id) ?? [] })),
      total!.n,
      q,
    );
  });

  app.get("/:id", { onRequest: app.requireUser(), schema: { tags: ["sites"], params: IdParams } }, async (req) => {
    const [site] = await db.select(columns).from(sites).where(eq(sites.id, req.params.id));
    if (!site) throw app.httpErrors.notFound("Lokasi tidak ditemukan");
    return { ...site, proctors: (await proctorsOf([site.id])).get(site.id) ?? [] };
  });

  /**
   * Tetapkan daftar proktor lokasi (menggantikan daftar lama). Server lokal mengambil
   * akun ini lewat /api/sync/proctors saat sinkronisasi berikutnya.
   */
  app.put(
    "/:id/proctors",
    {
      onRequest: app.requireUser("admin"),
      schema: { tags: ["sites"], params: IdParams, body: z.object({ userIds: z.array(z.uuid()).max(200) }) },
    },
    async (req) => {
      const site = await db.query.sites.findFirst({ where: eq(sites.id, req.params.id) });
      if (!site) throw app.httpErrors.notFound("Lokasi tidak ditemukan");
      const userIds = [...new Set(req.body.userIds)];
      if (userIds.length) {
        const found = await db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, userIds));
        if (found.length !== userIds.length) throw app.httpErrors.badRequest("Ada pengguna yang tidak ditemukan");
        const wrong = found.filter((u) => u.role !== "proctor" && u.role !== "admin");
        if (wrong.length) throw app.httpErrors.badRequest("Hanya pengguna dengan peran proktor atau admin yang bisa ditugaskan");
      }
      await db.transaction(async (tx) => {
        await tx.delete(siteProctors).where(eq(siteProctors.siteId, site.id));
        if (userIds.length) await tx.insert(siteProctors).values(userIds.map((userId) => ({ siteId: site.id, userId })));
      });
      await audit(db, { type: "user", id: currentUser(req).sub }, "site.proctors", "site", site.id, { userIds });
      return { proctors: (await proctorsOf([site.id])).get(site.id) ?? [] };
    },
  );

  /** Log aksi proktor yang dikirim server lokal lokasi ini. */
  app.get(
    "/:id/proctor-actions",
    { onRequest: app.requireUser(), schema: { tags: ["sites"], params: IdParams, querystring: ProctorLogQuery } },
    async (req) => {
      const q = req.query;
      const where = and(eq(proctorActions.siteId, req.params.id), q.attemptId ? eq(proctorActions.attemptId, q.attemptId) : undefined);
      const { limit, offset } = paginate(q);
      const [items, [total]] = await Promise.all([
        db.select().from(proctorActions).where(where).orderBy(desc(proctorActions.at)).limit(limit).offset(offset),
        db.select({ n: count() }).from(proctorActions).where(where),
      ]);
      return paged(items, total!.n, q);
    },
  );

  /** Membuat lokasi baru. `secret` hanya ditampilkan sekali, masukkan ke konfigurasi aplikasi desktop. */
  app.post("/", { onRequest: app.requireUser("admin"), schema: { tags: ["sites"], body: SiteInput } }, async (req, reply) => {
    const secret = randomSecret();
    const [site] = await db
      .insert(sites)
      .values({ ...req.body, address: req.body.address ?? null, capacity: req.body.capacity ?? null, secretHash: await hashPassword(secret) })
      .returning(columns);
    await audit(db, { type: "user", id: currentUser(req).sub }, "site.create", "site", site!.id);
    return reply.status(201).send({ ...site, secret });
  });

  app.patch(
    "/:id",
    { onRequest: app.requireUser("admin"), schema: { tags: ["sites"], params: IdParams, body: SiteInput.partial() } },
    async (req) => {
      const [site] = await db.update(sites).set(req.body).where(eq(sites.id, req.params.id)).returning(columns);
      if (!site) throw app.httpErrors.notFound("Lokasi tidak ditemukan");
      await audit(db, { type: "user", id: currentUser(req).sub }, "site.update", "site", site.id);
      return site;
    },
  );

  /** Ganti secret lokasi (mis. bila bocor). Token lama tetap berlaku sampai kedaluwarsa. */
  app.post(
    "/:id/rotate-secret",
    { onRequest: app.requireUser("admin"), schema: { tags: ["sites"], params: IdParams } },
    async (req) => {
      const secret = randomSecret();
      const [site] = await db
        .update(sites)
        .set({ secretHash: await hashPassword(secret) })
        .where(eq(sites.id, req.params.id))
        .returning(columns);
      if (!site) throw app.httpErrors.notFound("Lokasi tidak ditemukan");
      await audit(db, { type: "user", id: currentUser(req).sub }, "site.rotate_secret", "site", site.id);
      return { ...site, secret };
    },
  );

  app.delete("/:id", { onRequest: app.requireUser("admin"), schema: { tags: ["sites"], params: IdParams } }, async (req, reply) => {
    const res = await db.delete(sites).where(eq(sites.id, req.params.id)).returning({ id: sites.id });
    if (!res.length) throw app.httpErrors.notFound("Lokasi tidak ditemukan");
    await audit(db, { type: "user", id: currentUser(req).sub }, "site.delete", "site", req.params.id);
    return reply.status(204).send();
  });
};

export default routes;
