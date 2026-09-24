import { z } from "zod";

export const IdParams = z.object({ id: z.uuid() });

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  q: z.string().trim().max(200).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

export function paginate({ page, pageSize }: { page: number; pageSize: number }) {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

export function paged<T>(items: T[], total: number, q: { page: number; pageSize: number }) {
  return { items, total, page: q.page, pageSize: q.pageSize };
}

/** Escape pola LIKE agar input pencarian tidak dianggap wildcard. */
export function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Kode error PostgreSQL yang dipetakan ke HTTP 409. */
export function pgErrorToHttp(err: unknown): { statusCode: number; message: string } | null {
  const e = (err as { cause?: unknown }).cause ?? err;
  const code = (e as { code?: string }).code;
  const detail = (e as { detail?: string }).detail;
  if (code === "23505") return { statusCode: 409, message: `Data sudah ada${detail ? `: ${detail}` : ""}` };
  if (code === "23503") {
    return { statusCode: 409, message: `Data masih dirujuk / rujukan tidak ada${detail ? `: ${detail}` : ""}` };
  }
  return null;
}

/** Error 400 yang membawa rincian issue Zod (untuk validasi manual di handler). */
export class ValidationError extends Error {
  statusCode = 400;
  issues: { path: string; message: string }[];
  constructor(message: string, error: z.ZodError) {
    super(message);
    this.name = "Bad Request";
    this.issues = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  }
}
