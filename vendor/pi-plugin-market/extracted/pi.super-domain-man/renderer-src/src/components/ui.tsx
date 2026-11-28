/* ============================================================
 * ui.tsx - 通用 UI 组件（直角黑灰白风格）
 * Modal / Toast / Ask(confirm·prompt) / Button / Badge / Card / Field / Empty
 * ============================================================ */
import { ReactNode, useEffect, useSyncExternalStore, useState } from "react";
import {
  getAsks, getToasts, resolveAsk, subscribeAsks, subscribeToasts,
} from "../lib/util";
import type { Level } from "../lib/util";

/* ------------------------------ Button ------------------------------ */

export function Button({
  variant = "default",
  size = "md",
  className = "",
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger";
  size?: "sm" | "md";
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 border select-none whitespace-nowrap transition-colors duration-100 disabled:opacity-40 disabled:cursor-not-allowed";
  const sizes = size === "sm" ? "h-6 px-2.5 text-[11.5px]" : "h-[30px] px-3.5 text-[12.5px]";
  const variants = {
    default: "bg-surface-panel2 text-ink border-line-strong hover:bg-surface-panel hover:border-ink-faint",
    primary: "bg-accent text-accent-on border-accent font-semibold hover:bg-surface-panel2 hover:text-ink hover:border-line-strong",
    danger: "bg-transparent text-danger border-line-strong hover:bg-danger-bg hover:border-ink",
  };
  return (
    <button className={`${base} ${sizes} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/* ------------------------------ Badge ------------------------------ */

const LEVEL_MAP: Record<Level, { text: string; cls: string }> = {
  ok: { text: "正常", cls: "border-transparent text-ink-faint" },
  notice: { text: "提醒", cls: "border-line-strong text-ink-muted" },
  info: { text: "提醒", cls: "border-line-strong text-ink-muted" },
  warning: { text: "警告", cls: "border-ink text-ink" },
  error: { text: "危急", cls: "bg-ink text-surface border-ink" },
  unknown: { text: "未知", cls: "border-transparent text-ink-faint" },
};

export function LevelBadge({ level }: { level: Level }) {
  const m = LEVEL_MAP[level] || LEVEL_MAP.unknown;
  return (
    <span className={`inline-flex h-[18px] items-center px-1.5 text-[10.5px] font-bold tracking-wider border ${m.cls}`}>
      {m.text}
    </span>
  );
}

export function Badge({ solid = false, strong = false, faint = false, children }: { solid?: boolean; strong?: boolean; faint?: boolean; children: ReactNode }) {
  const cls = solid
    ? "bg-ink text-surface border-ink"
    : strong
      ? "border-ink text-ink"
      : faint
        ? "border-transparent text-ink-faint"
        : "border-line-strong text-ink-muted";
  return <span className={`inline-flex h-[18px] items-center px-1.5 text-[10.5px] font-bold tracking-wider border ${cls}`}>{children}</span>;
}

/* ------------------------------ Card ------------------------------ */

export function Card({ title, right, children }: { title?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="border border-line bg-surface-panel mb-3.5">
      {title !== undefined && (
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-line font-semibold text-[13px]">
          <span>{title}</span>
          {right}
        </div>
      )}
      <div className="p-3.5">{children}</div>
    </div>
  );
}

/* ------------------------------ Field ------------------------------ */

export function Field({ label, hint, children, className = "" }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`mb-3 ${className}`}>
      {label && <label className="block text-[11.5px] tracking-wide text-ink-muted mb-1.5">{label}</label>}
      {children}
      {hint && <div className="text-[11px] text-ink-faint mt-1">{hint}</div>}
    </div>
  );
}

export const inputCls =
  "h-[30px] px-2.5 bg-surface-panel text-ink border border-line-strong text-[12.5px] outline-none focus:border-ink placeholder:text-ink-faint";
export const selectCls = `${inputCls} cursor-pointer`;
export const textareaCls =
  "px-2.5 py-2 bg-surface-panel text-ink border border-line-strong text-[12.5px] outline-none focus:border-ink placeholder:text-ink-faint resize-y leading-relaxed";

/* ------------------------------ Empty ------------------------------ */

export function Empty({ title, desc, children }: { title: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="py-10 px-4 text-center text-ink-faint text-[12.5px] border border-dashed border-line-strong">
      <div className="text-[13.5px] text-ink-muted font-semibold mb-1">{title}</div>
      {desc && <div>{desc}</div>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

/* ------------------------------ Modal ------------------------------ */

export function Modal({
  open,
  title,
  size = "md",
  closable = true,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  size?: "sm" | "md" | "lg";
  closable?: boolean;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closable) onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closable, onClose]);

  if (!open) return null;
  const width = size === "sm" ? "max-w-[420px]" : size === "lg" ? "max-w-[860px]" : "max-w-[640px]";
  return (
    <div
      className="fixed inset-x-0 bottom-0 top-[var(--pi-plugin-titlebar-height,46px)] z-[200] overflow-y-auto bg-black/60 flex items-start justify-center p-10"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && closable) onClose?.();
      }}
    >
      <div className={`bg-surface-bg2 border border-line-strong shadow-[0_4px_24px_rgba(0,0,0,0.55)] w-full ${width}`}>
        <div className="flex items-center justify-between h-11 px-4 border-b border-line text-sm font-bold">
          <span>{title}</span>
          {closable && (
            <button className="w-6 h-6 flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-panel" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        <div className="px-4 py-4 max-h-[calc(100vh-var(--pi-plugin-titlebar-height,46px)-180px)] overflow-y-auto">{children}</div>
        {footer !== undefined && (
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-line">{footer}</div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ Toast Host ------------------------------ */

export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return (
    <div className="fixed right-4 bottom-4 z-[800] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`px-4 py-2.5 text-[12.5px] font-medium shadow-[0_4px_24px_rgba(0,0,0,0.55)] min-w-[200px] max-w-[420px] animate-[toastIn_0.16s_ease] ${
            t.isErr ? "bg-surface-bg2 text-ink border border-line-strong" : "bg-ink text-surface"
          }`}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ Ask Host (confirm/prompt) ------------------------------ */

export function AskHost() {
  const asks = useSyncExternalStore(subscribeAsks, getAsks, getAsks);
  const item = asks[0];
  const [value, setValue] = useState("");
  if (!item) return null;

  const close = (result: string | boolean | null) => resolveAsk(item.id, result);

  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--pi-plugin-titlebar-height,46px)] z-[700] bg-black/60 flex items-start justify-center p-10">
      <div className="bg-surface-bg2 border border-line-strong shadow-[0_4px_24px_rgba(0,0,0,0.55)] w-full max-w-[420px]">
        <div className="flex items-center justify-between h-11 px-4 border-b border-line text-sm font-bold">
          <span>{item.title}</span>
        </div>
        <div className="px-4 py-4">
          <div className="whitespace-pre-wrap text-[13px]">{item.message}</div>
          {item.kind === "prompt" && (
            <input
              autoFocus
              className={`${inputCls} w-full mt-3`}
              defaultValue={item.def || ""}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") close(value);
              }}
            />
          )}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-line">
          <Button onClick={() => close(null)}>取消</Button>
          {item.kind === "confirm" ? (
            <Button variant="danger" onClick={() => close(true)}>确认</Button>
          ) : (
            <Button variant="primary" onClick={() => close(value)}>确定</Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 表格外壳 ------------------------------ */

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="border border-line overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="bg-surface-bg2 text-ink-muted font-semibold text-left px-2.5 py-2 border-b border-line whitespace-nowrap text-[11.5px] tracking-wider">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`px-2.5 py-2 border-b border-line align-middle ${className}`}>{children}</td>;
}
