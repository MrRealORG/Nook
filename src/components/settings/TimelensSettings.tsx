/**
 * Settings tabs for v1.1: Timelens (tracking, privacy, categories, goals), encrypted Backup,
 * and Import (Markdown / Obsidian vault folders). All state lives in Rust — these panels only
 * read and PUT the same endpoints the desktop app uses.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useStore } from "@/lib/store";

type Rule = { match: string; field: "app" | "title" | "any"; cat: "productive" | "neutral" | "distracting" };
type Goal = { id: string; target: string; kind: "goal" | "limit"; mins: number };
type TlConfig = {
  enabled: boolean; paused: boolean; afkSecs: number; intervalSecs: number; exclude: string[]; redactTitles: boolean;
  retentionDays: number; rules: Rule[]; goals: Goal[]; autoJournal: boolean; defaultRules: Rule[];
};

const j = async <T,>(url: string, init?: RequestInit) => (await (await fetch(url, init)).json()) as T;
const put = (url: string, body: unknown, method = "PUT") => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const toast = (m: string, icon = "check") => useStore.getState().toast(m, icon as never);

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5">
      <span>
        <span className="block text-[13.5px]">{label}</span>
        {hint && <span className="block text-[12px] text-dim">{hint}</span>}
      </span>
      <input type="checkbox" className="h-4 w-4 accent-[color:var(--accent)]" checked={on} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
    </label>
  );
}

/* ------------------------------------------------------------------ Timelens */

export function TimelensSettings() {
  const [cfg, setCfg] = useState<TlConfig | null>(null);
  const [excl, setExcl] = useState("");
  const [rule, setRule] = useState<Rule>({ match: "", field: "any", cat: "productive" });
  const [goal, setGoal] = useState({ target: "productive", kind: "goal" as "goal" | "limit", mins: 120 });

  const load = useCallback(async () => {
    try {
      setCfg(await j<TlConfig>("/api/timelens/config"));
    } catch {
      /* backend restarting */
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const patch = async (p: Partial<TlConfig>) => {
    setCfg((c) => (c ? { ...c, ...p } : c));
    const r = await put("/api/timelens/config", p);
    if (r.ok) setCfg(await r.json());
    else toast("Couldn't save Timelens settings", "close");
  };

  if (!cfg) return <div className="paper p-5 text-dim">Loading Timelens…</div>;

  const addExclude = () => {
    const v = excl.trim();
    if (!v || cfg.exclude.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    void patch({ exclude: [...cfg.exclude, v] });
    setExcl("");
  };
  const addRule = () => {
    if (!rule.match.trim()) return;
    void patch({ rules: [...cfg.rules, { ...rule, match: rule.match.trim() }] });
    setRule({ ...rule, match: "" });
  };
  const addGoal = () => {
    if (goal.mins <= 0) return;
    void patch({ goals: [...cfg.goals, { id: `g-${Date.now().toString(36)}`, ...goal }] });
  };
  const prune = async () => {
    const r = await j<{ deleted: number }>("/api/timelens/prune", { method: "POST" });
    toast(`Pruned ${r.deleted ?? 0} old spans`, "trash");
  };
  const wipe = async () => {
    if (!confirm("Delete ALL Timelens history? This can't be undone.")) return;
    await fetch("/api/timelens/spans", { method: "DELETE" });
    toast("Timelens history cleared", "trash");
  };

  return (
    <div className="space-y-4" data-testid="settings-timelens">
      <div className="paper p-5">
        <div className="label mb-2">Tracking</div>
        <Toggle on={cfg.enabled} onChange={(v) => void patch({ enabled: v })} label="Track active windows" hint="Windows only — samples the foreground app every few seconds. Everything stays in your local vault." />
        <Toggle on={cfg.paused} onChange={(v) => void patch({ paused: v })} label="Pause tracking" hint="Also available from the tray menu and the widget." />
        <Toggle on={cfg.autoJournal} onChange={(v) => void patch({ autoJournal: v })} label="Add a time summary to today's daily note" />
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="tiny-font mb-1 block text-[9.5px] text-faint">AWAY AFTER (SECONDS IDLE)</span>
            <input className="input" type="number" min={30} max={3600} value={cfg.afkSecs} onChange={(e) => void patch({ afkSecs: Number(e.target.value) || 180 })} aria-label="AFK threshold seconds" />
          </label>
          <label className="block">
            <span className="tiny-font mb-1 block text-[9.5px] text-faint">SAMPLE EVERY (SECONDS)</span>
            <input className="input" type="number" min={1} max={30} value={cfg.intervalSecs} onChange={(e) => void patch({ intervalSecs: Number(e.target.value) || 2 })} aria-label="Sample interval seconds" />
          </label>
        </div>
      </div>

      <div className="paper p-5">
        <div className="label mb-2">Privacy</div>
        <Toggle on={cfg.redactTitles} onChange={(v) => void patch({ redactTitles: v })} label="Redact window titles" hint="Store only the app name, never the document or page title." />
        <div className="mt-3">
          <span className="tiny-font mb-1 block text-[9.5px] text-faint">NEVER TRACK THESE APPS / TITLES</span>
          <div className="flex gap-2">
            <input className="input flex-1" placeholder="e.g. KeePass, banking, incognito" value={excl} onChange={(e) => setExcl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addExclude()} aria-label="Exclude app" />
            <button className="btn btn-sm" onClick={addExclude}><Icon name="plus" size={12} /> add</button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {cfg.exclude.length === 0 && <span className="text-[12px] text-dim">Nothing excluded.</span>}
            {cfg.exclude.map((x) => (
              <span key={x} className="chip flex items-center gap-1">
                {x}
                <button aria-label={`Remove ${x}`} onClick={() => void patch({ exclude: cfg.exclude.filter((y) => y !== x) })}><Icon name="close" size={10} /></button>
              </span>
            ))}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="tiny-font mb-1 block text-[9.5px] text-faint">KEEP HISTORY (DAYS)</span>
            <input className="input w-32" type="number" min={1} max={3650} value={cfg.retentionDays} onChange={(e) => void patch({ retentionDays: Number(e.target.value) || 90 })} aria-label="Retention days" />
          </label>
          <button className="btn btn-sm" onClick={() => void prune()}><Icon name="trash" size={12} /> prune now</button>
          <button className="btn btn-sm" style={{ color: "#e0684f" }} onClick={() => void wipe()}><Icon name="trash" size={12} /> delete all history</button>
        </div>
      </div>

      <div className="paper p-5">
        <div className="label mb-2">Categories</div>
        <div className="mb-2 text-[12px] text-dim">Your rules win over the {cfg.defaultRules.length} built-in ones. Matching is case-insensitive “contains”.</div>
        <div className="flex flex-wrap gap-2">
          <input className="input min-w-[160px] flex-1" placeholder="match text (e.g. jira)" value={rule.match} onChange={(e) => setRule({ ...rule, match: e.target.value })} onKeyDown={(e) => e.key === "Enter" && addRule()} aria-label="Rule match" />
          <select className="input w-auto" value={rule.field} onChange={(e) => setRule({ ...rule, field: e.target.value as Rule["field"] })} aria-label="Rule field">
            <option value="any">app or title</option><option value="app">app</option><option value="title">title</option>
          </select>
          <select className="input w-auto" value={rule.cat} onChange={(e) => setRule({ ...rule, cat: e.target.value as Rule["cat"] })} aria-label="Rule category">
            <option value="productive">productive</option><option value="neutral">neutral</option><option value="distracting">distracting</option>
          </select>
          <button className="btn btn-sm" onClick={addRule}><Icon name="plus" size={12} /> add rule</button>
        </div>
        <ul className="mt-2 space-y-1">
          {cfg.rules.map((r, i) => (
            <li key={`${r.match}-${i}`} className="flex items-center gap-2 text-[13px]">
              <span className="chip">{r.cat}</span><span className="truncate">“{r.match}” in {r.field}</span>
              <button className="ml-auto text-faint" aria-label={`Delete rule ${r.match}`} onClick={() => void patch({ rules: cfg.rules.filter((_, k) => k !== i) })}><Icon name="trash" size={12} /></button>
            </li>
          ))}
        </ul>
      </div>

      <div className="paper p-5">
        <div className="label mb-2">Goals &amp; limits</div>
        <div className="flex flex-wrap gap-2">
          <select className="input w-auto" value={goal.kind} onChange={(e) => setGoal({ ...goal, kind: e.target.value as "goal" | "limit" })} aria-label="Goal kind">
            <option value="goal">at least</option><option value="limit">at most</option>
          </select>
          <input className="input w-24" type="number" min={5} value={goal.mins} onChange={(e) => setGoal({ ...goal, mins: Number(e.target.value) })} aria-label="Goal minutes" />
          <span className="self-center text-[13px] text-dim">min/day of</span>
          <input className="input w-auto min-w-[140px]" list="tl-goal-targets" value={goal.target} onChange={(e) => setGoal({ ...goal, target: e.target.value })} aria-label="Goal target" />
          <datalist id="tl-goal-targets"><option value="productive" /><option value="neutral" /><option value="distracting" /><option value="focus" /></datalist>
          <button className="btn btn-sm" onClick={addGoal}><Icon name="plus" size={12} /> add goal</button>
        </div>
        <ul className="mt-2 space-y-1">
          {cfg.goals.map((g) => (
            <li key={g.id} className="flex items-center gap-2 text-[13px]">
              <span className="chip">{g.kind === "goal" ? "≥" : "≤"} {g.mins}m</span><span>{g.target}</span>
              <button className="ml-auto text-faint" aria-label={`Delete goal ${g.target}`} onClick={() => void patch({ goals: cfg.goals.filter((x) => x.id !== g.id) })}><Icon name="trash" size={12} /></button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Backup */

type BackupCfg = { dir: string | null; auto: boolean; hasPassword: boolean; last: number | null; backups: { name: string; path: string; size: number }[] };

export function BackupSettings() {
  const [cfg, setCfg] = useState<BackupCfg | null>(null);
  const [dir, setDir] = useState("");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const c = await j<BackupCfg>("/api/backup");
      setCfg(c);
      setDir(c.dir ?? "");
    } catch {}
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const save = async (extra: Record<string, unknown> = {}) => {
    const body: Record<string, unknown> = { dir: dir.trim() || null, ...extra };
    if (pw) body.password = pw;
    const r = await put("/api/backup", body);
    if (r.ok) {
      setCfg(await r.json());
      setPw("");
      setMsg("Backup settings saved.");
    } else setMsg("Couldn't save backup settings.");
  };
  const runNow = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (dir.trim()) body.dir = dir.trim();
      if (pw) body.password = pw;
      const r = await put("/api/backup", body, "POST");
      const d = (await r.json()) as { file?: string; error?: string };
      setMsg(r.ok ? `Encrypted backup written: ${d.file}` : `Backup failed: ${d.error ?? r.status}`);
      if (r.ok) toast("Encrypted backup saved", "download");
      void load();
    } finally {
      setBusy(false);
    }
  };
  const restore = async (file: string) => {
    if (!confirm(`Restore ${file}? Your current vault will be replaced.`)) return;
    const body: Record<string, unknown> = { file };
    if (pw) body.password = pw;
    const r = await put("/api/restore", body, "POST");
    setMsg(r.ok ? "Restored — reloading…" : `Restore failed: ${((await r.json()) as { error?: string }).error ?? r.status}`);
    if (r.ok) setTimeout(() => location.reload(), 800);
  };

  const list = cfg?.backups ?? [];
  return (
    <div className="paper p-5" data-testid="settings-backup">
      <div className="label mb-2">Encrypted backup</div>
      <div className="mb-3 text-[12px] text-dim">ChaCha20-Poly1305 with a key derived from your password (PBKDF2). Without the password a backup can't be opened — Nook can't recover it for you.</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="tiny-font mb-1 block text-[9.5px] text-faint">BACKUP FOLDER</span>
          <input className="input" placeholder="e.g. D:\\OneDrive\\Nook backups" value={dir} onChange={(e) => setDir(e.target.value)} aria-label="Backup folder" />
        </label>
        <label className="block">
          <span className="tiny-font mb-1 block text-[9.5px] text-faint">PASSWORD {cfg?.hasPassword ? "(saved — type to change)" : ""}</span>
          <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Backup password" />
        </label>
      </div>
      <Toggle on={!!cfg?.auto} onChange={(v) => void save({ auto: v })} label="Back up automatically every day" hint="Runs during daily maintenance while Nook is open." />
      <div className="mt-2 flex flex-wrap gap-2">
        <button className="btn btn-sm" onClick={() => void save()}><Icon name="check" size={12} /> save settings</button>
        <button className="btn btn-sm" disabled={busy} onClick={() => void runNow()}><Icon name="download" size={12} /> back up now</button>
      </div>
      {cfg?.last ? <div className="mt-2 text-[12px] text-dim">Last backup: {new Date(cfg.last).toLocaleString()}</div> : null}
      {msg && <div className="mt-2 text-[12.5px]" role="status">{msg}</div>}
      {list.length > 0 && (
        <ul className="mt-3 space-y-1">
          {list.slice(0, 10).map((b) => (
            <li key={b.path} className="flex items-center gap-2 text-[12.5px]">
              <Icon name="database" size={12} /><span className="truncate">{b.name}</span>
              <span className="text-faint">{Math.max(1, Math.round(b.size / 1024))} KB</span>
              <button className="btn btn-sm ml-auto" onClick={() => void restore(b.path)}>restore</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Import */

export function ImportSettings() {
  const dirRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState("");
  const run = async (files: FileList | null) => {
    if (!files?.length) return;
    const payload: { path: string; content: string }[] = [];
    for (const f of Array.from(files)) {
      if (!/\.(md|markdown|txt)$/i.test(f.name) || f.size > 5_000_000) continue;
      payload.push({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, content: await f.text() });
    }
    if (!payload.length) {
      setMsg("No Markdown or text files found.");
      return;
    }
    const r = await put("/api/import", { files: payload }, "POST");
    const d = (await r.json()) as { created?: number; skipped?: number };
    setMsg(`Imported ${d.created ?? 0} notes${d.skipped ? `, skipped ${d.skipped}` : ""}.`);
    try {
      const fresh = await j<unknown[]>("/api/notes");
      if (Array.isArray(fresh)) useStore.setState({ notes: fresh as never });
      const folders = await j<unknown[]>("/api/folders");
      if (Array.isArray(folders)) useStore.setState({ folders: folders as never });
    } catch {}
    toast(`Imported ${d.created ?? 0} notes`, "upload");
  };
  return (
    <div className="paper p-5" data-testid="settings-import">
      <div className="label mb-2">Import notes</div>
      <div className="mb-3 text-[12px] text-dim">Bring in an Obsidian vault or any folder of Markdown. Sub-folders become Nook folders; [[wikilinks]] and #tags keep working.</div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-sm" onClick={() => dirRef.current?.click()}><Icon name="folder" size={12} /> import a folder / vault</button>
        <button className="btn btn-sm" onClick={() => fileRef.current?.click()}><Icon name="upload" size={12} /> import .md files</button>
      </div>
      <input ref={dirRef} type="file" className="hidden" multiple {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(e) => void run(e.target.files)} aria-label="Import folder" />
      <input ref={fileRef} type="file" className="hidden" multiple accept=".md,.markdown,.txt" onChange={(e) => void run(e.target.files)} aria-label="Import files" />
      {msg && <div className="mt-2 text-[12.5px]" role="status">{msg}</div>}
    </div>
  );
}
