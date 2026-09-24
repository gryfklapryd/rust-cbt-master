import { and, asc, count, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { participants, sites } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { IdParams, likePattern, PageQuery, paged, paginate } from "../lib/http.js";
import { hashPasswordLight, randomCode } from "../lib/password.js";
import { currentUser } from "../plugins/auth.js";

const ParticipantNumber = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._\-/]+$/, "Nomor peserta hanya huruf, angka, . _ - /");

const ParticipantInput = z.object({
  number: ParticipantNumber,
  name: z.string().trim().min(1).max(200),
  groupName: z.string().trim().max(100).nullish(),
  gender: z.enum(["L", "P"]).nullish(),
  birthDate: z.iso.date().nullish(),
  siteId: z.uuid().nullish(),
  photoAssetId: z.uuid().nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
  /** Bila kosong saat membuat peserta, password dibuat otomatis. */
  password: z.string().min(4).max(100).optional(),
});

const ImportRow = z.object({
  number: ParticipantNumber,
  name: z.string().trim().min(1).max(200),
  groupName: z.string().trim().max(100).nullish(),
  gender: z.enum(["L", "P"]).nullish(),
  birthDate: z.iso.date().nullish(),
  /** Kode lokasi asal (opsional). */
  siteCode: z.string().trim().max(64).nullish(),
  password: z.string().min(4).max(100).nullish(),
});

const ListQuery = PageQuery.extend({
  groupName: z.string().optional(),
  siteId: z.uuid().optional(),
});

const columns = {
  id: participants.id,
  number: participants.number,
  name: participants.name,
  groupName: participants.groupName,
  gender: participants.gender,
  birthDate: participants.birthDate,
  siteId: participants.siteId,
  photoAssetId: participants.photoAssetId,
  metadata: participants.metadata,
  active: participants.active,
  createdAt: participants.createdAt,
  updatedAt: participants.updatedAt,
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get("/", { onRequest: app.requireUser(), schema: { tags: ["participants"], querystring: ListQuery } }, async (req) => {
    const q = req.query;
    const conds: SQL[] = [];
    if (q.q) conds.push(or(ilike(participants.number, likePattern(q.q)), ilike(participants.name, likePattern(q.q)))!);
    if (q.groupName) conds.push(eq(participants.groupName, q.groupName));
    if (q.siteId) conds.push(eq(participants.siteId, q.siteId));
    const where = conds.length ? and(...conds) : undefined;
    const { limit, offset } = paginate(q);
    const [items, [total]] = await Promise.all([
      db.select(columns).from(participants).where(where).orderBy(asc(participants.number)).limit(limit).offset(offset),
      db.select({ n: count() }).from(participants).where(where),
    ]);
    return paged(items, total!.n, q);
  });

  app.get("/groups", { onRequest: app.requireUser(), schema: { tags: ["participants"] } }, async () => {
    const rows = await db
      .selectDistinct({ groupName: participants.groupName })
      .from(participants)
      .orderBy(asc(participants.groupName));
    return rows.map((r) => r.groupName).filter((g): g is string => !!g);
  });

  app.get("/:id", { onRequest: app.requireUser(), schema: { tags: ["participants"], params: IdParams } }, async (req) => {
    const [p] = await db.select(columns).from(participants).where(eq(participants.id, req.params.id));
    if (!p) throw app.httpErrors.notFound("Peserta tidak ditemukan");
    return p;
  });

  app.post(
    "/",
    { onRequest: app.requireUser("admin"), schema: { tags: ["participants"], body: ParticipantInput } },
    async (req, reply) => {
      const { password: given, ...rest } = req.body;
      const password = given ?? randomCode(6);
      const [p] = await db
        .insert(participants)
        .values({ ...rest, passwordHash: await hashPasswordLight(password) })
        .returning(columns);
      await audit(db, { type: "user", id: currentUser(req).sub }, "participant.create", "participant", p!.id);
      return reply.status(201).send({ ...p, password });
    },
  );

  app.patch(
    "/:id",
    {
      onRequest: app.requireUser("admin"),
      schema: { tags: ["participants"], params: IdParams, body: ParticipantInput.partial() },
    },
    async (req) => {
      const { password, ...rest } = req.body;
      const [p] = await db
        .update(participants)
        .set({ ...rest, ...(password ? { passwordHash: await hashPasswordLight(password) } : {}) })
        .where(eq(participants.id, req.params.id))
        .returning(columns);
      if (!p) throw app.httpErrors.notFound("Peserta tidak ditemukan");
      return p;
    },
  );

  app.delete(
    "/:id",
    { onRequest: app.requireUser("admin"), schema: { tags: ["participants"], params: IdParams } },
    async (req, reply) => {
      const res = await db.delete(participants).where(eq(participants.id, req.params.id)).returning({ id: participants.id });
      if (!res.length) throw app.httpErrors.notFound("Peserta tidak ditemukan");
      await audit(db, { type: "user", id: currentUser(req).sub }, "participant.delete", "participant", req.params.id);
      return reply.status(204).send();
    },
  );

  /**
   * Impor massal (hasil parsing CSV/Excel di panel admin). Upsert berdasarkan nomor peserta.
   * Password baru (yang dibuat otomatis) dikembalikan SEKALI di respons untuk dicetak di kartu peserta.
   */
  app.post(
    "/import",
    {
      onRequest: app.requireUser("admin"),
      schema: {
        tags: ["participants"],
        body: z.object({
          rows: z.array(ImportRow).min(1).max(20_000),
          /** Perbarui data peserta yang nomornya sudah ada (password tidak diubah kecuali diisi). */
          updateExisting: z.boolean().default(true),
        }),
      },
    },
    async (req) => {
      const { rows, updateExisting } = req.body;
      const numbers = rows.map((r) => r.number);
      if (new Set(numbers).size !== numbers.length) throw app.httpErrors.badRequest("Ada nomor peserta duplikat di data impor");

      const siteCodes = [...new Set(rows.map((r) => r.siteCode?.toUpperCase()).filter((c): c is string => !!c))];
      const siteRows = siteCodes.length
        ? await db.select({ id: sites.id, code: sites.code }).from(sites).where(inArray(sites.code, siteCodes))
        : [];
      const siteByCode = new Map(siteRows.map((s) => [s.code, s.id]));
      const unknownSites = siteCodes.filter((c) => !siteByCode.has(c));
      if (unknownSites.length) throw app.httpErrors.badRequest(`Kode lokasi tidak dikenal: ${unknownSites.join(", ")}`);

      const existing = new Set<string>();
      for (let i = 0; i < numbers.length; i += 5_000) {
        const chunk = numbers.slice(i, i + 5_000);
        const found = await db.select({ number: participants.number }).from(participants).where(inArray(participants.number, chunk));
        found.forEach((f) => existing.add(f.number));
      }

      const credentials: { number: string; name: string; password: string }[] = [];
      const prepared = await mapLimit(rows, 8, async (r) => {
        const isNew = !existing.has(r.number);
        let password = r.password ?? null;
        if (isNew && !password) password = randomCode(6);
        if (password) credentials.push({ number: r.number, name: r.name, password });
        // Kolom yang tidak dikirim (undefined) tidak menimpa data lama saat update.
        const optional = {
          groupName: r.groupName,
          gender: r.gender,
          birthDate: r.birthDate,
          siteId: r.siteCode === undefined ? undefined : r.siteCode ? siteByCode.get(r.siteCode.toUpperCase())! : null,
        };
        const provided = Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined));
        return {
          isNew,
          values: {
            number: r.number,
            name: r.name,
            ...(isNew ? { groupName: null, gender: null, birthDate: null, siteId: null } : {}),
            ...provided,
            ...(password ? { passwordHash: await hashPasswordLight(password) } : {}),
          },
        };
      });

      let created = 0;
      let updated = 0;
      let skipped = 0;
      await db.transaction(async (tx) => {
        for (const { isNew, values } of prepared) {
          if (isNew) {
            await tx.insert(participants).values(values);
            created++;
          } else if (updateExisting) {
            const { number, ...rest } = values;
            await tx.update(participants).set(rest).where(eq(participants.number, number));
            updated++;
          } else {
            skipped++;
          }
        }
      });
      await audit(db, { type: "user", id: currentUser(req).sub }, "participant.import", "participant", undefined, {
        created,
        updated,
        skipped,
      });
      return { created, updated, skipped, credentials: credentials.sort((a, b) => a.number.localeCompare(b.number)) };
    },
  );

  /** Buat ulang password untuk sekumpulan peserta (mis. untuk mencetak kartu). */
  app.post(
    "/reset-passwords",
    {
      onRequest: app.requireUser("admin"),
      schema: {
        tags: ["participants"],
        body: z
          .object({
            participantIds: z.array(z.uuid()).max(20_000).optional(),
            groupName: z.string().optional(),
            length: z.number().int().min(4).max(20).default(6),
          })
          .refine((b) => b.participantIds?.length || b.groupName, "Isi participantIds atau groupName"),
      },
    },
    async (req) => {
      const { participantIds, groupName, length } = req.body;
      const where = participantIds?.length ? inArray(participants.id, participantIds) : eq(participants.groupName, groupName!);
      const targets = await db.select({ id: participants.id, number: participants.number, name: participants.name }).from(participants).where(where);
      const credentials = await mapLimit(targets, 8, async (t) => {
        const password = randomCode(length);
        await db.update(participants).set({ passwordHash: await hashPasswordLight(password) }).where(eq(participants.id, t.id));
        return { number: t.number, name: t.name, password };
      });
      await audit(db, { type: "user", id: currentUser(req).sub }, "participant.reset_passwords", "participant", undefined, {
        count: credentials.length,
      });
      return { credentials: credentials.sort((a, b) => a.number.localeCompare(b.number)) };
    },
  );
};

export default routes;
