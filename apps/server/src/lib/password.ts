import { randomBytes, randomInt } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/**
 * Hash argon2id format PHC (`$argon2id$v=19$m=…`). Format ini juga bisa
 * diverifikasi oleh crate `argon2` di Rust (client desktop, login offline).
 */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

/** Hash yang lebih ringan untuk data massal yang dikirim ke desktop (password peserta, token sesi). */
export async function hashPasswordLight(plain: string): Promise<string> {
  return hash(plain, { memoryCost: 4_096, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(phc: string, plain: string): Promise<boolean> {
  try {
    return await verify(phc, plain);
  } catch {
    return false;
  }
}

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // tanpa karakter mirip (0/O, 1/I)

/** Kode acak mudah dibaca (password peserta, token sesi). */
export function randomCode(length = 6): string {
  let s = "";
  for (let i = 0; i < length; i++) s += ALNUM[randomInt(ALNUM.length)];
  return s;
}

/** Secret acak untuk titik ujian. */
export function randomSecret(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
