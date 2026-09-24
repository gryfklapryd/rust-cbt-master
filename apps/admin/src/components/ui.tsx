import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { errorMessage } from "../lib/api";

// ------------------------------------------------------------------ tombol
type Variant = "primary" | "secondary" | "danger" | "ghost";
export function Button({
  variant = "secondary",
  size,
  loading,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm"; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={`btn btn-${variant}${size ? ` btn-${size}` : ""} ${className}`}
    >
      {loading ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ form
export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`input ${p.className ?? ""}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`input ${p.className ?? ""}`} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...p} className={`input ${p.className ?? ""}`} />
);

export function Checkbox({ label, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...p} />
      <span>{label}</span>
    </label>
  );
}

// ------------------------------------------------------------------ tata letak
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <div className="card-header">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "success" | "warning" | "danger" | "info"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const STATUS_TONES: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  ready: "success",
  published: "success",
  complete: "success",
  processed: "success",
  submitted: "success",
  graded: "success",
  manual: "success",
  active: "success",
  draft: "neutral",
  archived: "neutral",
  closed: "neutral",
  superseded: "neutral",
  ungraded: "neutral",
  building: "info",
  processing: "info",
  received: "info",
  in_progress: "info",
  pending: "warning",
  partial: "warning",
  pending_manual: "warning",
  timed_out: "warning",
  unanswered: "neutral",
  failed: "danger",
  invalid: "danger",
  terminated: "danger",
};
const STATUS_LABELS: Record<string, string> = {
  ready: "siap",
  published: "terbit",
  complete: "lengkap",
  processed: "diproses",
  submitted: "dikumpulkan",
  graded: "dinilai",
  manual: "dikoreksi",
  draft: "draf",
  archived: "arsip",
  closed: "ditutup",
  superseded: "digantikan",
  ungraded: "tidak dinilai",
  building: "dibangun",
  processing: "diproses",
  received: "diterima",
  in_progress: "berlangsung",
  pending: "menunggu",
  partial: "sebagian",
  pending_manual: "perlu koreksi",
  timed_out: "waktu habis",
  unanswered: "kosong",
  failed: "gagal",
  invalid: "tidak valid",
  terminated: "dihentikan",
};
export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="muted">-</span>;
  return <Badge tone={STATUS_TONES[status] ?? "neutral"}>{STATUS_LABELS[status] ?? status}</Badge>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return (
    <div className="empty">
      <span className="spinner" /> Memuat…
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <pre className="error-box">{errorMessage(error)}</pre>;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination">
      <span className="muted">
        {total.toLocaleString("id-ID")} data · halaman {page} / {pages}
      </span>
      <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ Sebelumnya
      </Button>
      <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Berikutnya ›
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ modal
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`modal${wide ? " modal-wide" : ""}`} onClose={onClose} onCancel={onClose}>
      {open ? (
        <>
          <div className="modal-header">
            <h2>{title}</h2>
            <button type="button" className="icon-btn" aria-label="Tutup" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="modal-body">{children}</div>
          {footer ? <div className="modal-footer">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}

// ------------------------------------------------------------------ toast
interface Toast {
  id: number;
  tone: "success" | "danger" | "info";
  text: string;
}
const ToastContext = createContext<(tone: Toast["tone"], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "danger" ? 8000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  return {
    success: (text: string) => push("success", text),
    info: (text: string) => push("info", text),
    error: (err: unknown) => push("danger", errorMessage(err)),
  };
}

// ------------------------------------------------------------------ lain-lain
/** Tombol yang meminta konfirmasi sebelum menjalankan aksi. */
export function ConfirmButton({
  confirm,
  onConfirm,
  children,
  ...rest
}: Omit<Parameters<typeof Button>[0], "onClick"> & { confirm: string; onConfirm: () => unknown }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      {...rest}
      loading={busy}
      onClick={async () => {
        if (!window.confirm(confirm)) return;
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </Button>
  );
}

/** Editor JSON sederhana: textarea + indikator valid/tidak. */
export function JsonEditor({
  value,
  onChange,
  rows = 14,
  error,
}: {
  value: string;
  onChange: (text: string) => void;
  rows?: number;
  error?: string | null;
}) {
  const id = useId();
  let parseError: string | null = null;
  try {
    JSON.parse(value);
  } catch (e) {
    parseError = (e as Error).message;
  }
  return (
    <div className="json-editor">
      <textarea id={id} className="input mono" rows={rows} spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />
      {parseError ? <div className="field-error">JSON tidak valid: {parseError}</div> : error ? <div className="field-error">{error}</div> : null}
    </div>
  );
}

export function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-text">
      <code>{text}</code>
      <button
        type="button"
        className="icon-btn"
        title="Salin"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={`tab${value === t.id ? " is-active" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
