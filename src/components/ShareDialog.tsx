"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { useStore } from "@/lib/store";
import { copyShareLink, createShare, getShare, revokeShare, shareUrl, type ShareMode, type ShareRecord } from "@/lib/shareKit";
import { timeAgo } from "@/lib/util";

const MODES: { mode: ShareMode; icon: IconName; title: string; blurb: string }[] = [
  { mode: "read", icon: "eye", title: "Read only", blurb: "Anyone with the link can read the note — nothing else." },
  { mode: "collab", icon: "tasklist", title: "Work order", blurb: "Send the todo list to a worker — they check items off, you see live progress." },
];

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--panel2)] border border-[var(--line)]">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }}
        />
      </div>
      <span className="label !text-[10px]">{done}/{total} done</span>
    </div>
  );
}

export default function ShareDialog({ noteId, noteTitle, onClose }: { noteId: string; noteTitle: string; onClose: () => void }) {
  const [record, setRecord] = useState<ShareRecord | null>(null);
  const [busy, setBusy] = useState<ShareMode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const toast = useStore((s) => s.toast);
  const notify = useCallback((text: string, icon?: string) => toast(text, (icon ?? "copy") as IconName), [toast]);
  const overlayRef = useRef<HTMLDivElement>(null);

  // create (or idempotently fetch) a share for the chosen mode
  const pick = useCallback(
    async (mode: ShareMode) => {
      setBusy(mode);
      setErr(null);
      setConfirmRevoke(false);
      try {
        const rec = await createShare(noteId, mode);
        setRecord(rec);
        notify(mode === "collab" ? "Work order link ready — workers need no account" : "Read-only link ready");
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not create the share");
      } finally {
        setBusy(null);
      }
    },
    [noteId, notify],
  );

  // live worker progress — poll while the dialog is open (collab only)
  useEffect(() => {
    if (!record || record.mode !== "collab" || record.revoked) return;
    const id = record.id;
    const t = setInterval(async () => {
      try {
        const fresh = await getShare(id);
        setRecord((cur) => (cur && cur.id === id ? fresh : cur));
      } catch {
        /* transient poll errors are silently ignored */
      }
    }, 5000);
    return () => clearInterval(t);
  }, [record]);

  // Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const other: ShareMode = record?.mode === "collab" ? "read" : "collab";
  const doneCount = record?.items.filter((i) => i.done).length ?? 0;

  const revoke = async () => {
    if (!record || !confirmRevoke) return;
    try {
      const rec = await revokeShare(record.id);
      setRecord(rec);
      notify("Link revoked — workers can no longer open it", "unlink");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Revoke failed");
    }
    setConfirmRevoke(false);
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[3px]"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Share “${noteTitle}”`}
    >
      <div
        className="panel panel-solid rounded-2xl w-[min(560px,92vw)] max-h-[86vh] overflow-y-auto p-5"
        style={{ animation: "pop .18s var(--ease-soft) both", filter: "drop-shadow(0 18px 50px rgba(0,0,0,.45))" }}
      >
        {/* header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="label mb-1 flex items-center gap-1.5"><Icon name="link" size={11} /> Share note</div>
            <div className="truncate text-[15px] font-semibold">{noteTitle}</div>
          </div>
          <button className="chip !px-1.5" onClick={onClose} title="Close (Esc)" aria-label="Close share dialog">
            <Icon name="close" size={12} />
          </button>
        </div>

        {err && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-[#e5484d40] bg-[#e5484d14] px-3 py-2 text-[12px] text-[#e5484d]">
            <Icon name="alert" size={12} /> {err}
          </div>
        )}

        {/* step 1 — pick a mode (big cards) */}
        {!record && (
          <div className="flex flex-col gap-2.5">
            {MODES.map((m) => (
              <button
                key={m.mode}
                className="group flex w-full items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel2)] p-4 text-left transition-all hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--line))]"
                disabled={busy !== null}
                onClick={() => void pick(m.mode)}
              >
                <span
                  className="flex h-10 w-10 flex-none items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--panel)] transition-colors group-hover:text-[var(--accent)]"
                  style={{ color: busy === m.mode ? "var(--accent)" : undefined }}
                >
                  <Icon name={m.icon} size={20} />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-[14px] font-semibold">
                    {m.title}
                    {busy === m.mode && <Icon name="reload" size={12} className="animate-spin" />}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-snug opacity-60">{m.blurb}</span>
                </span>
              </button>
            ))}
            <div className="mt-1 flex items-center gap-1.5 text-[11px] opacity-50">
              <Icon name="shield" size={11} /> Links work for anyone — no Nook account needed.
            </div>
          </div>
        )}

        {/* step 2 — share created */}
        {record && (
          <div className="flex flex-col gap-3.5">
            {/* status chips */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="chip" data-on="true">
                <Icon name={record.mode === "collab" ? "tasklist" : "eye"} size={11} />
                {record.mode === "collab" ? "Work order" : "Read only"}
              </span>
              {record.revoked ? (
                <span className="chip" style={{ color: "#e5484d", borderColor: "#e5484d55" }}><Icon name="unlink" size={11} /> Revoked</span>
              ) : (
                <span className="chip"><Icon name="clock" size={11} /> created {timeAgo(record.createdAt)}</span>
              )}
              <span className="chip"><Icon name="eye" size={11} /> {record.views} view{record.views === 1 ? "" : "s"}</span>
            </div>

            {record.revoked && (
              <div className="rounded-lg border border-[#e5484d40] bg-[#e5484d12] px-3 py-2 text-[12px] text-[#e5484d]">
                This link was revoked — nobody can open it anymore. Create a fresh link below; worker progress from before is kept on the old one.
              </div>
            )}

            {/* link row */}
            {!record.revoked && (
              <div className="flex items-center gap-1.5">
                <input className="input !h-[32px] flex-1 !text-[11px]" readOnly value={shareUrl(record.id)} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
                <button className="btn btn-accent btn-sm !h-[32px]" onClick={() => void copyShareLink(record, notify)}>
                  <Icon name="copy" size={12} /> Copy
                </button>
                <button className="btn btn-sm !h-[32px]" onClick={() => window.open(shareUrl(record.id), "_blank")} title="Open the shared view">
                  <Icon name="external-link" size={12} /> Open
                </button>
              </div>
            )}

            {/* mode switch (creates/gets the other share) */}
            {!record.revoked && (
              <button className="btn btn-sm w-full" disabled={busy !== null} onClick={() => void pick(other)}>
                <Icon name={other === "collab" ? "tasklist" : "eye"} size={12} />
                Switch to {other === "collab" ? "Work order" : "Read only"}
                {busy === other && <Icon name="reload" size={11} className="animate-spin" />}
              </button>
            )}

            {/* worker progress (collab mode) */}
            {record.mode === "collab" && (
              <div className="flex flex-col gap-2">
                <div className="label flex items-center gap-1.5"><Icon name="user" size={11} /> Worker progress</div>
                <Progress done={doneCount} total={record.items.length} />
                {record.items.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[var(--line)] px-3 py-3 text-[12px] opacity-60">
                    No todo items in this note yet — add <code className="chip !px-1 !py-0 !text-[10px]">- [ ] task</code> lines and re-share to build a work order.
                  </div>
                ) : (
                  <div className="scroll max-h-56 overflow-y-auto rounded-lg border border-[var(--line)]">
                    {record.items.map((it, i) => (
                      <div key={i} className="flex items-center gap-2.5 border-b border-[var(--line)] px-3 py-2 last:border-b-0" data-done={it.done}>
                        <span className="flex-none" style={{ color: it.done ? "var(--accent)" : "var(--faint)" }}>
                          <Icon name={it.done ? "checkbox-on" : "checkbox"} size={15} />
                        </span>
                        <span className={`min-w-0 flex-1 truncate text-[12.5px] ${it.done ? "line-through opacity-50" : ""}`}>{it.text}</span>
                        {it.done && it.doneBy && (
                          <span className="label flex-none !text-[9.5px] normal-case tracking-normal">
                            {it.doneBy} · {it.doneAt ? timeAgo(it.doneAt) : ""}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-start gap-1.5 text-[11px] leading-snug opacity-55">
                  <Icon name="sparkle" size={11} className="mt-0.5 flex-none" />
                  Workers need no account — they open the link, type a name and check items off. Updates appear here live (refreshes every 5s).
                </div>
              </div>
            )}

            {/* danger zone */}
            {!record.revoked && (
              <button
                className="btn btn-sm w-full"
                style={{ color: "#e5484d", borderColor: "#e5484d55" }}
                onClick={() => (confirmRevoke ? void revoke() : setConfirmRevoke(true))}
                onBlur={() => setConfirmRevoke(false)}
              >
                <Icon name="unlink" size={12} />
                {confirmRevoke ? "Really revoke? Workers lose access" : "Revoke link"}
              </button>
            )}
            {record.revoked && (
              <button className="btn btn-accent btn-sm w-full" disabled={busy !== null} onClick={() => void pick(record.mode)}>
                <Icon name="refresh" size={12} /> Create a fresh {record.mode === "collab" ? "work order" : "read-only"} link
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
