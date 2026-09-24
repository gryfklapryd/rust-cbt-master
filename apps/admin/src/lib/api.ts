/** Klien HTTP ke server pusat. Token disimpan di localStorage. */
const TOKEN_KEY = "cbt.admin.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* abaikan */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: { path: string; message: string }[] | unknown,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: { message?: string; issues?: unknown } = {};
  try {
    body = await res.json();
  } catch {
    /* bukan JSON */
  }
  return new ApiError(res.status, body.message ?? res.statusText, body.issues);
}

export async function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: { raw?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload, signal: opts.signal });
  if (res.status === 401 && token) onUnauthorized?.();
  if (!res.ok) throw await parseError(res);
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  get: <T = unknown>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, { signal }),
  post: <T = unknown>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T = unknown>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T = unknown>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T = unknown>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};

/** Susun query string, abaikan nilai kosong. */
export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Unduh berkas dari endpoint yang butuh Authorization. */
export async function download(path: string, filename: string) {
  const res = await request<Response>("GET", path, undefined, { raw: true });
  const blob = await res.blob();
  saveBlob(blob, filename);
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = Array.isArray(err.issues)
      ? err.issues
          .slice(0, 8)
          .map((i: { path?: string; message?: string; index?: number; issues?: unknown[] }) =>
            i.index !== undefined ? `#${i.index + 1}: ${(i.issues as { message: string }[])?.[0]?.message ?? ""}` : `${i.path ? `${i.path}: ` : ""}${i.message}`,
          )
          .join("\n")
      : "";
    return issues ? `${err.message}\n${issues}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
