const dtf = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" });

export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return "-";
  const d = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? "-" : dtf.format(d);
}

export function fmtNum(v: number | string | null | undefined, digits = 2): string {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("id-ID", { maximumFractionDigits: digits }) : "-";
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n && n !== 0) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** Nilai untuk <input type="datetime-local"> dari ISO. */
export function toLocalInput(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string {
  return new Date(v).toISOString();
}

export function stripHtml(html: string | null | undefined, max = 120): string {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  const t = (div.textContent ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
