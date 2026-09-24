import { randomUUID } from "node:crypto";
import { count, desc, eq, ilike, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { assets } from "../db/schema.js";
import { IdParams, likePattern, PageQuery, paged, paginate } from "../lib/http.js";
import { deleteObject, getObjectStream, putStream } from "../lib/storage.js";
import { signAsset, verifyAssetSignature } from "../lib/signed-url.js";
import { currentUser } from "../plugins/auth.js";

/** Jenis media yang boleh dipakai di soal. */
const ALLOWED_MIME = /^(image|audio|video)\/|^application\/pdf$/;

export function safeFilename(name: string) {
  return name.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "file";
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/",
    {
      onRequest: app.requireUser(),
      schema: { tags: ["assets"], querystring: PageQuery.extend({ mime: z.string().optional() }) },
    },
    async (req) => {
      const q = req.query;
      const where = q.q ? ilike(assets.filename, likePattern(q.q)) : q.mime ? ilike(assets.mime, `${q.mime}%`) : undefined;
      const { limit, offset } = paginate(q);
      const [items, [total]] = await Promise.all([
        db.select().from(assets).where(where).orderBy(desc(assets.createdAt)).limit(limit).offset(offset),
        db.select({ n: count() }).from(assets).where(where),
      ]);
      return paged(items, total!.n, q);
    },
  );

  /** Unggah media (multipart, field `file`). Rujuk di konten soal dengan `asset://<id>`. */
  app.post("/", { onRequest: app.requireUser("author"), schema: { tags: ["assets"], consumes: ["multipart/form-data"] } }, async (req, reply) => {
    const file = await req.file();
    if (!file) throw app.httpErrors.badRequest("Field `file` wajib diisi");
    if (!ALLOWED_MIME.test(file.mimetype)) {
      file.file.resume();
      throw app.httpErrors.unsupportedMediaType(`Jenis berkas tidak didukung: ${file.mimetype}`);
    }
    const id = randomUUID();
    const objectKey = `assets/${id}`;
    const { size, sha256 } = await putStream(objectKey, file.file, file.mimetype);
    if (file.file.truncated) {
      await deleteObject(objectKey);
      throw app.httpErrors.payloadTooLarge("Berkas melebihi batas ukuran");
    }
    const [asset] = await db
      .insert(assets)
      .values({
        id,
        objectKey,
        filename: safeFilename(file.filename),
        mime: file.mimetype,
        size,
        sha256,
        createdBy: currentUser(req).sub,
      })
      .returning();
    return reply.status(201).send({ ...asset, uri: `asset://${id}` });
  });

  app.get("/:id", { onRequest: app.requireUser(), schema: { tags: ["assets"], params: IdParams } }, async (req) => {
    const asset = await db.query.assets.findFirst({ where: eq(assets.id, req.params.id) });
    if (!asset) throw app.httpErrors.notFound("Aset tidak ditemukan");
    return asset;
  });

  /** Buat URL bertanda tangan (berlaku 1 jam) untuk menampilkan aset di browser. */
  app.post(
    "/signed-urls",
    {
      onRequest: app.requireUser(),
      schema: { tags: ["assets"], body: z.object({ ids: z.array(z.uuid()).min(1).max(500) }) },
    },
    async (req) => {
      const found = await db.select({ id: assets.id }).from(assets).where(inArray(assets.id, req.body.ids));
      const out: Record<string, string> = {};
      for (const { id } of found) {
        const { exp, sig } = signAsset(id);
        out[id] = `/api/assets/${id}/content?exp=${exp}&sig=${sig}`;
      }
      return out;
    },
  );

  /** Konten aset. Akses dengan URL bertanda tangan (tanpa header Authorization). */
  app.get(
    "/:id/content",
    {
      schema: {
        tags: ["assets"],
        security: [],
        params: IdParams,
        querystring: z.object({ exp: z.coerce.number().int(), sig: z.string().min(1) }),
      },
    },
    async (req, reply) => {
      if (!verifyAssetSignature(req.params.id, req.query.exp, req.query.sig)) {
        throw app.httpErrors.forbidden("Tanda tangan URL tidak valid atau kedaluwarsa");
      }
      const asset = await db.query.assets.findFirst({ where: eq(assets.id, req.params.id) });
      if (!asset) throw app.httpErrors.notFound("Aset tidak ditemukan");
      const obj = await getObjectStream(asset.objectKey);
      reply.header("content-type", asset.mime);
      reply.header("content-length", asset.size);
      reply.header("cache-control", "private, max-age=3600");
      reply.header("etag", `"${asset.sha256}"`);
      return reply.send(obj.body);
    },
  );

  app.delete("/:id", { onRequest: app.requireUser("author"), schema: { tags: ["assets"], params: IdParams } }, async (req, reply) => {
    const [asset] = await db.delete(assets).where(eq(assets.id, req.params.id)).returning();
    if (!asset) throw app.httpErrors.notFound("Aset tidak ditemukan");
    await deleteObject(asset.objectKey).catch((err) => req.log.warn({ err }, "gagal menghapus objek aset"));
    return reply.status(204).send();
  });
};

export default routes;
