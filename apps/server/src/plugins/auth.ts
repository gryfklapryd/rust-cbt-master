import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import type { UserRole } from "../db/schema.js";

export type AuthUser =
  | { kind: "user"; sub: string; role: UserRole; username: string }
  | { kind: "site"; sub: string; siteCode: string; deviceId?: string };

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** Hook `onRequest`: wajib token admin; opsional batasi peran. `admin` selalu diizinkan. */
    requireUser: (...roles: UserRole[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Hook `onRequest`: wajib token titik ujian (aplikasi desktop). */
    requireSite: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (app) => {
  await app.register(fastifyJwt, { secret: config.JWT_SECRET });

  app.decorate("requireUser", (...roles: UserRole[]) => async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw app.httpErrors.unauthorized("Token tidak valid atau kedaluwarsa");
    }
    const u = req.user;
    if (u.kind !== "user") throw app.httpErrors.forbidden("Hanya untuk pengguna panel admin");
    if (roles.length && u.role !== "admin" && !roles.includes(u.role)) {
      throw app.httpErrors.forbidden("Peran Anda tidak diizinkan untuk aksi ini");
    }
  });

  app.decorate("requireSite", async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw app.httpErrors.unauthorized("Token lokasi tidak valid atau kedaluwarsa");
    }
    if (req.user.kind !== "site") throw app.httpErrors.forbidden("Hanya untuk aplikasi titik ujian");
  });
});

/** Ambil user admin dari request yang sudah lolos `requireUser`. */
export function currentUser(req: FastifyRequest) {
  const u = req.user;
  if (u.kind !== "user") throw new Error("bukan user");
  return u;
}

/** Ambil lokasi dari request yang sudah lolos `requireSite`. */
export function currentSite(req: FastifyRequest) {
  const u = req.user;
  if (u.kind !== "site") throw new Error("bukan site");
  return u;
}
