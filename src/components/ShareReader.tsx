
import { BrandIcon } from "@/lib/brand";
import { everyActive } from "@/lib/power";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Markdown } from "@/components/Markdown";
import { getShare, TODO_RE, toggleItem, type ShareRecord } from "@/lib/shareKit";

/**
 * Public reader for shared notes — mounted by the app when the URL contains
 * ?share=<id>. Read-only shares render the note body; "collab" (work order)
 * shares show big live checkboxes any worker can tick (no account needed).
 */

const WORKER_KEY = "nook:worker-name";

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-2 flex-1 overflow-hidden rounded-full border border-[var(--line)] bg-[var(--panel2)]">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, background: "var(--accent)", boxShadow: "0 0 10px var(--accent)" }}
        />
      </div>
      <span className="label !text-[10px]">{done}/{total} done</span>
    </div>
  );
}

function FailState({ icon, title, hint, onExit }: { icon: "unlink" | "alert" | "search"; title: string; hint: string; onExit: () => void }) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--line)] bg-[var(--panel)] opacity-70">
        <Icon name={icon} size={26} />
      </span>
      <div className="text-[17px] font-semibold">{title}</div>
      <div className="max-w-[380px] text-[12.5px] leading-relaxed opacity-60">{hint}</div>
      <button className="btn btn-sm mt-2" onClick={onExit}>
        <Icon name="arrow-left" size={12} /> Back to Nook
      </button>
    </div>
  );
}

export default function ShareReader({ shareId, onExit }: { shareId: string; onExit: () => void }) {
  const [record, setRecord] = useState<ShareRecord | null>(null);
  // reader mounts fresh per share (the app unmounts it via onExit), so "loading" is the only valid start
  const [state, setState] = useState<"loading" | "ready" | "missing" | "revoked" | "error">("loading");
  // lazy init avoids a synchronous setState-in-effect for the stored worker name
  const [worker, setWorker] = useState(() => {
    if (typeof window === "undefined") return "Worker";
    try {
      const saved = localStorage.getItem(WORKER_KEY);
      return saved && saved.trim() ? saved.trim().slice(0, 40) : "Worker";
    } catch {
      return "Worker";
    }
  });
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const aliveRef = useRef(true);

  // initial load — countView bumps the share's view counter exactly once
  useEffect(() => {
    aliveRef.current = true;
    getShare(shareId, true)
      .then((rec) => {
        if (!aliveRef.current) return;
        if (rec.revoked) setState("revoked");
        else {
          setRecord(rec);
          setState("ready");
        }
      })
      .catch(() => aliveRef.current && setState("missing"));
    return () => {
      aliveRef.current = false;
    };
  }, [shareId]);

  // live sync — poll every 5s so the owner sees worker progress in real time
  useEffect(() => {
    if (state !== "ready") return;
    return everyActive(async () => {
      try {
        const fresh = await getShare(shareId);
        if (!aliveRef.current || fresh.revoked) return;
        setRecord(fresh);
      } catch {
        /* transient poll errors are silently ignored */
      }
    }, 5000);
  }, [shareId, state]);

  // Escape exits the reader
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onExit();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  const ctx = useMemo(() => ({ titles: new Set<string>(), onLink: () => {} }), []);

  // in collab mode the todo lines live in the interactive checklist below —
  // strip them from the markdown body so they don't appear twice
  const body = useMemo(() => {
    if (!record) return "";
    if (record.mode !== "collab") return record.content;
    return record.content.split("\n").filter((l) => !TODO_RE.test(l)).join("\n");
  }, [record]);

  const words = record ? (record.content.trim().match(/\S+/g) || []).length : 0;
  const readMins = Math.max(1, Math.round(words / 200));
  const items = record?.items ?? [];
  const doneCount = items.filter((i) => i.done).length;

  const flip = async (index: number, next: boolean) => {
    if (!record || busyIdx !== null) return;
    setBusyIdx(index);
    // optimistic — feel instant even on a slow link
    setRecord({ ...record, items: record.items.map((it, i) => (i === index ? { ...it, done: next, doneBy: next ? worker : null, doneAt: next ? Date.now() : null } : it)) });
    try {
      const fresh = await toggleItem(record.id, index, next, worker);
      setRecord(fresh);
    } catch {
      setRecord(record); // roll back on failure; the 5s poll will re-sync anyway
    }
    setBusyIdx(null);
  };

  return (
    <div className="fixed inset-0 z-[300] overflow-y-auto bg-[var(--bg)]" role="dialog" aria-label="Shared note reader">
      {/* slim top bar */}
      <header className="sticky top-0 z-10 flex h-12 items-center gap-2.5 border-b border-[var(--line)] bg-[var(--panel)]/90 px-4 backdrop-blur-md">
        <BrandIcon size={24} />
        <span className="pixel-font text-[14px] font-semibold tracking-wide">Nook</span>
        <span className="label mt-0.5">· shared note</span>
        <span className="flex-1" />
        <button className="btn btn-sm" onClick={onExit}>
          <Icon name="close" size={11} /> Exit
        </button>
      </header>

      {state === "loading" && (
        <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3">
          <span className="h-3 w-3 animate-ping rounded-full" style={{ background: "var(--accent)" }} />
          <span className="label">Opening shared note…</span>
        </div>
      )}

      {state === "missing" && (
        <FailState icon="search" title="This share link doesn't exist" hint="The link may have been mistyped, or the owner deleted the note's share. Ask them for a fresh link." onExit={onExit} />
      )}
      {state === "revoked" && (
        <FailState icon="unlink" title="This link was revoked" hint="The owner turned this share link off, so the note can no longer be viewed here. Ask them for a new link if you still need it." onExit={onExit} />
      )}
      {state === "error" && (
        <FailState icon="alert" title="Something went wrong" hint="The shared note could not be loaded. Check your connection and try again." onExit={onExit} />
      )}

      {state === "ready" && record && (
        <main className="mx-auto w-full max-w-[720px] px-5 pb-24 pt-7">
          {/* cover */}
          {record.cover && (
            <div className="relative mb-5 h-40 overflow-hidden rounded-2xl border border-[var(--line)] sm:h-52">
              {/* plain <img> like Editor — covers may be data: URLs or remote */}
              <img src={record.cover} alt="" className="h-full w-full object-cover" />
            </div>
          )}

          {/* title + meta */}
          <h1 className="text-balance text-[26px] font-bold leading-tight tracking-tight sm:text-[32px]">{record.noteTitle}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="chip !text-[10.5px]"><Icon name="note" size={10} /> Shared from Nook</span>
            <span className="chip !text-[10.5px]"><Icon name="clock" size={10} /> ~{readMins} min read</span>
            <span className="chip !text-[10.5px]" data-on={record.mode === "collab" ? "true" : undefined}>
              <Icon name={record.mode === "collab" ? "tasklist" : "eye"} size={10} />
              {record.mode === "collab" ? "Work order" : "Read only"}
            </span>
            {record.folderColor && (
              <span className="flex items-center gap-1.5 text-[11px] opacity-50">
                <span className="h-2 w-2 rounded-full" style={{ background: record.folderColor }} />
                folder
              </span>
            )}
          </div>

          {/* collab — worker name + live checklist */}
          {record.mode === "collab" && (
            <section className="mt-6 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4" aria-label="Work order checklist">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="label flex items-center gap-1.5"><Icon name="tasklist" size={11} /> Work order</div>
                <span className="flex-1" />
                <label className="flex items-center gap-1.5 text-[11px] opacity-70">
                  <Icon name="user" size={11} />
                  <input
                    className="input !h-[26px] !w-[130px] !py-0 !text-[11px]"
                    value={worker}
                    maxLength={40}
                    placeholder="Your name"
                    aria-label="Your name (shown to the note owner)"
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setWorker(v);
                      try {
                        localStorage.setItem(WORKER_KEY, v.trim().slice(0, 40) || "Worker");
                      } catch {}
                    }}
                  />
                </label>
              </div>
              <div className="mb-3">
                <Progress done={doneCount} total={items.length} />
              </div>
              {items.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[var(--line)] px-3 py-3 text-[12px] opacity-60">
                  The owner hasn&apos;t added any todo items to this note yet.
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {items.map((it, i) => (
                    <button
                      key={i}
                      className="flex w-full items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel2)] px-3.5 py-3 text-left transition-all hover:border-[color-mix(in_srgb,var(--accent)_40%,var(--line))] disabled:opacity-70"
                      data-done={it.done}
                      disabled={busyIdx === i}
                      onClick={() => void flip(i, !it.done)}
                      aria-pressed={it.done}
                      aria-label={`${it.done ? "Uncheck" : "Check"} “${it.text}”`}
                    >
                      <span
                        className="flex h-6 w-6 flex-none items-center justify-center rounded-md border-2 transition-colors"
                        style={{
                          borderColor: it.done ? "var(--accent)" : "var(--line)",
                          background: it.done ? "var(--accent)" : "transparent",
                          color: it.done ? "var(--accent-ink)" : "var(--faint)",
                        }}
                      >
                        {it.done && <Icon name="check" size={13} />}
                      </span>
                      <span className={`min-w-0 flex-1 text-[14px] ${it.done ? "line-through opacity-50" : ""}`}>{it.text}</span>
                      {it.done && it.doneBy && (
                        <span className="flex-none text-[10px] opacity-50">
                          {it.doneBy}{it.doneAt ? ` · ${new Date(it.doneAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-3 flex items-start gap-1.5 text-[11px] leading-snug opacity-50">
                <Icon name="sparkle" size={11} className="mt-0.5 flex-none" />
                Tick items off as you finish them — {worker ? `${worker}'s` : "your"} name is shown to the owner. No account needed.
              </div>
            </section>
          )}

          {/* note body */}
          <article className="mt-6">
            <Markdown source={body} {...ctx} />
          </article>
        </main>
      )}
    </div>
  );
}
