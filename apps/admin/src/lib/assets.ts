import { useEffect, useMemo, useState } from "react";
import { collectAssetIds } from "@cbt/shared";
import { api } from "./api";

const cache = new Map<string, { url: string; exp: number }>();

/**
 * Resolve rujukan `asset://<id>` di sebuah nilai (konten soal, dsb) menjadi URL
 * bertanda tangan dari server. Mengembalikan fungsi resolver untuk komponen soal.
 */
export function useAssetResolver(value: unknown) {
  const ids = useMemo(() => [...collectAssetIds(value)].sort(), [value]);
  const key = ids.join(",");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const now = Date.now() / 1000;
    const missing = ids.filter((id) => !cache.has(id) || cache.get(id)!.exp < now + 60);
    if (!missing.length) return;
    let cancelled = false;
    api
      .post<Record<string, string>>("/assets/signed-urls", { ids: missing })
      .then((urls) => {
        for (const [id, url] of Object.entries(urls)) {
          const exp = Number(new URL(url, location.origin).searchParams.get("exp") ?? 0);
          cache.set(id, { url, exp });
        }
        if (!cancelled) setVersion((v) => v + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (id: string) => cache.get(id)?.url, [key, version]);
}
