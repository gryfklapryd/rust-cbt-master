import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/**
 * URL bertanda tangan untuk konten aset, supaya `<img src>` / `<audio src>` di
 * panel admin bisa memuat media tanpa header Authorization.
 */
export function signAsset(assetId: string, ttlSeconds = 3600): { exp: number; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { exp, sig: sign(assetId, exp) };
}

export function verifyAssetSignature(assetId: string, exp: number, sig: string): boolean {
  if (exp < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(sign(assetId, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function sign(assetId: string, exp: number) {
  return createHmac("sha256", config.JWT_SECRET).update(`asset:${assetId}:${exp}`).digest("base64url");
}
