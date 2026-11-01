/**
 * v1.4 Meetings: record a call (your mic = "You", what you hear = "Them"), get a speaker-labelled
 * transcript, a summary with action items, and a note in the vault.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useStore } from "@/lib/store";
import {
  IDLE, MEETING_HOTKEY, explainStartError, fmtElapsed, isLive, levelBars, meetingsApi, processMeeting, statusLabel, transcriptPlain, warningChips, watchLive,
  type Meeting, type MeetingConfig, type MeetingLive,
} from "@/lib/meetings";

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export default function MeetingsView() {
  const [live, setLive] = useState<MeetingLive>(IDLE);
  const [list, setList] = useState<Meeting[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [runErr, setRunErr] = useState<Record<string, string>>({});
  const [startErr, setStartErr] = useState<{ title: string; hint: string } | null>(null);
  const [cfg, setCfg] = useState<MeetingConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const st = useStore.getState;
  const wasLive = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const l = await meetingsApi.list();
      setList(l);
      setSel((s) => s ?? l[0]?.id ?? null);
    } catch {
      /* vault busy */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void meetingsApi.config().then(setCfg).catch(() => {});
    return watchLive((s) => {
      setLive(s);
      // a recording just ended (here, from the hotkey, the tray or the widget) → pick it up
      if (wasLive.current && !isLive(s) && !stoppingHere.current) void pickUpStopped();
      wasLive.current = isLive(s);
    });
  }, [refresh]);

  // stopped elsewhere (hotkey / tray / widget): select it and run the same pipeline as Stop here
  const stoppingHere = useRef(false);
  const cfgRef = useRef<MeetingConfig | null>(null);
  cfgRef.current = cfg;
  const runRef = useRef<(id: string, s: boolean) => Promise<void>>(async () => {});
  const pickUpStopped = async () => {
    try {
      const l = await meetingsApi.list();
      setList(l);
      const m = l[0];
      if (m && m.status === "recorded" && !m.transcript?.length && Date.now() - (m.endedAt ?? 0) < 60_000) {
        setSel(m.id);
        void runRef.current(m.id, cfgRef.current?.autoSummarize ?? true);
      }
    } catch {
      /* ignore */
    }
  };

  const selected = useMemo(() => list.find((m) => m.id === sel) ?? null, [list, sel]);

  const syncNotes = async () => {
    try {
      const notes = await (await fetch("/api/notes")).json();
      if (Array.isArray(notes)) useStore.setState({ notes });
    } catch {
      /* next sync */
    }
  };

  const run = async (id: string, summarize: boolean) => {
    setBusy((b) => ({ ...b, [id]: "Starting…" }));
    setRunErr((e) => ({ ...e, [id]: "" }));
    const r = await processMeeting(id, { summarize, onStep: (s) => setBusy((b) => ({ ...b, [id]: s })) });
    setBusy((b) => {
      const n = { ...b };
      delete n[id];
      return n;
    });
    await refresh();
    if (r.noteId) {
      await syncNotes();
      st().toast("Meeting summary saved as a note", "notes", { label: "Open", run: () => st().openNote(r.noteId!) });
    } else if (r.error) {
      setRunErr((e) => ({ ...e, [id]: r.error! }));
      st().toast(r.error, "alert", undefined, 7000);
    }
  };

  runRef.current = run;

  const start = async () => {
    setStartErr(null);
    try {
      const s = await meetingsApi.start(title.trim() || undefined);
      setLive(s);
      wasLive.current = true;
      setTitle("");
    } catch (e) {
      setStartErr(explainStartError(e instanceof Error ? e.message : String(e)));
    }
  };
  const stop = async () => {
    stoppingHere.current = true;
    try {
      const m = await meetingsApi.stop();
      wasLive.current = false;
      setLive(IDLE);
      await refresh();
      setSel(m.id);
      void run(m.id, cfg?.autoSummarize ?? true);
    } catch (e) {
      st().toast(e instanceof Error ? e.message : String(e), "alert");
    } finally {
      stoppingHere.current = false;
    }
  };
  const pause = async () => {
    try {
      setLive(await meetingsApi.pause(live.state !== "paused"));
    } catch {
      /* stopped meanwhile */
    }
  };
  const remove = async (m: Meeting) => {
    if (!confirm(`Delete “${m.title}” and its audio? The note (if any) is kept.`)) return;
    await meetingsApi.remove(m.id).catch((e) => st().toast(String(e), "alert"));
    if (sel === m.id) setSel(null);
    await refresh();
  };

  const recording = isLive(live);

  return (
    <div className="scroll h-full" data-testid="meetings-view">
      <div className="tl-wrap">
        <header className="tl-head">
          <div className="min-w-0 flex-1">
            <h1 className="tl-title">Meetings</h1>
            <div className="tl-sub">
              <span className="tl-dot" data-state={live.state === "recording" ? "rec" : live.state === "paused" ? "away" : "off"} />
              {recording ? (live.state === "paused" ? "Paused" : "Recording your mic and system audio") : `Record any call — ${MEETING_HOTKEY} starts and stops from anywhere`}
            </div>
          </div>
        </header>

        {/* recorder */}
        <section className="tl-card mt-recorder" data-state={live.state} data-testid="meeting-recorder">
          {!recording ? (
            <div className="mt-row">
              <input className="input min-w-0 flex-1" placeholder="Meeting title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void start()} aria-label="Meeting title" data-testid="meeting-title" />
              <button className="btn btn-accent mt-rec-btn" onClick={() => void start()} data-testid="meeting-start">
                <span className="mt-rec-dot" /> Record
              </button>
            </div>
          ) : (
            <div className="mt-row">
              <span className="mt-rec-dot" data-live={live.state === "recording"} />
              <b className="mt-timer" data-testid="meeting-timer">{fmtElapsed(live.elapsedMs)}</b>
              <div className="mt-meters">
                <Meter label="You" level={live.levelYou} device={live.devices.you} missing={!live.devices.you} />
                <Meter label="Them" level={live.levelThem} device={live.devices.them} missing={!live.devices.them} />
              </div>
              <button className="btn btn-sm" onClick={() => void pause()} disabled={live.state !== "recording" && live.state !== "paused"} data-testid="meeting-pause">
                <Icon name={live.state === "paused" ? "play" : "pause"} size={14} /> {live.state === "paused" ? "Resume" : "Pause"}
              </button>
              <button className="btn btn-sm btn-accent" onClick={() => void stop()} disabled={live.state === "stopping"} data-testid="meeting-stop">
                <Icon name="stop" size={14} /> Stop
              </button>
            </div>
          )}
          {recording && live.warnings.length > 0 && (
            <div className="mt-warns" data-testid="meeting-warnings">
              {warningChips(live.warnings).map((w, i) => <span key={i} className="mt-chip" data-tone="warn" title={live.warnings[i]}><Icon name="alert" size={12} /> {w}</span>)}
            </div>
          )}
          {!recording && (startErr || live.error) && (
            <div className="mt-error" role="alert" data-testid="meeting-error">
              <Icon name="alert" size={15} />
              <div className="min-w-0">
                <b>{startErr?.title ?? explainStartError(live.error ?? "").title}</b>
                <div className="text-dim">{startErr?.hint ?? explainStartError(live.error ?? "").hint}</div>
              </div>
            </div>
          )}
          {!recording && !startErr && !live.error && (
            <div className="mt-hint">Two tracks are recorded side by side, so the transcript knows who spoke. Audio stays on this PC; only the speech-to-text and summary calls use your configured AI keys.</div>
          )}
        </section>

        <div className="mt-grid">
          {/* list */}
          <section className="tl-card mt-list" data-testid="meeting-list">
            <div className="tl-card-head"><span>Recordings</span><span className="text-faint">{list.length}</span></div>
            {loaded && list.length === 0 && <div className="mt-empty">No meetings yet. Hit <b>Record</b> when your call starts.</div>}
            {list.map((m) => {
              const s = statusLabel(m);
              return (
                <button key={m.id} className="mt-item" data-on={m.id === sel} onClick={() => setSel(m.id)} data-testid="meeting-item">
                  <div className="min-w-0 flex-1">
                    <div className="mt-item-title">{m.title}</div>
                    <div className="mt-item-sub">{day(m.startedAt)} · {clock(m.startedAt)} · {fmtElapsed(m.durationMs)}</div>
                  </div>
                  <span className="mt-chip" data-tone={busy[m.id] ? "busy" : s.tone}>{busy[m.id] ? "Working…" : s.text}</span>
                </button>
              );
            })}
          </section>

          {/* detail */}
          <section className="tl-card mt-detail" data-testid="meeting-detail">
            {!selected ? (
              <div className="mt-empty">Select a meeting to see its transcript and summary.</div>
            ) : (
              <MeetingDetail m={selected} busy={busy[selected.id]} error={runErr[selected.id] || selected.error} onRun={(s) => void run(selected.id, s)} onDelete={() => void remove(selected)} onRenamed={refresh} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Meter({ label, level, device, missing }: { label: string; level: number; device?: string; missing?: boolean }) {
  const lit = levelBars(level);
  return (
    <div className="mt-meter" data-missing={missing} title={missing ? `${label}: no device` : `${label}: ${device}`} data-testid={`meter-${label.toLowerCase()}`}>
      <span className="mt-meter-label">{label}</span>
      <span className="mt-bars" aria-label={`${label} level`} role="meter" aria-valuemin={0} aria-valuemax={12} aria-valuenow={lit}>
        {Array.from({ length: 12 }, (_, i) => <i key={i} data-on={i < lit} />)}
      </span>
    </div>
  );
}

function MeetingDetail({ m, busy, error, onRun, onDelete, onRenamed }: { m: Meeting; busy?: string; error?: string | null; onRun: (summarize: boolean) => void; onDelete: () => void; onRenamed: () => void }) {
  const [tab, setTab] = useState<"summary" | "transcript">(m.summary ? "summary" : "transcript");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(m.title);
  const st = useStore.getState;
  useEffect(() => {
    setTab(m.summary ? "summary" : "transcript");
    setName(m.title);
    setEditing(false);
  }, [m.id, m.summary, m.title]);
  const lines = m.transcript ?? [];
  const sum = m.summary;
  const hasTranscript = lines.length > 0;
  const rename = async () => {
    setEditing(false);
    if (name.trim() && name.trim() !== m.title) {
      await meetingsApi.rename(m.id, name.trim()).catch(() => {});
      onRenamed();
    }
  };
  const audio = (t: "you" | "them") => `/api/meetings/${m.id}/audio/${t}`;

  return (
    <div className="mt-detail-in">
      <div className="mt-detail-head">
        {editing ? (
          <input className="input flex-1" autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()} onKeyDown={(e) => e.key === "Enter" && void rename()} aria-label="Rename meeting" />
        ) : (
          <h2 className="mt-detail-title" onDoubleClick={() => setEditing(true)} title="Double-click to rename">{m.title}</h2>
        )}
        <button className="icon-btn" onClick={() => setEditing(true)} title="Rename" aria-label="Rename"><Icon name="pencil" size={14} /></button>
        <button className="icon-btn" onClick={onDelete} title="Delete meeting" aria-label="Delete meeting" data-testid="meeting-delete"><Icon name="trash" size={14} /></button>
      </div>
      <div className="mt-item-sub">
        {day(m.startedAt)} · {clock(m.startedAt)}{m.endedAt ? `–${clock(m.endedAt)}` : ""} · {fmtElapsed(m.durationMs)}{m.engine ? ` · ${m.engine}` : ""}
      </div>

      <div className="mt-actions">
        {m.noteId && (
          <button className="btn btn-sm btn-accent" onClick={() => st().openNote(m.noteId!)} data-testid="meeting-open-note"><Icon name="notes" size={14} /> Open note</button>
        )}
        {!hasTranscript && (
          <button className="btn btn-sm btn-accent" disabled={!!busy || m.status === "recording"} onClick={() => onRun(true)} data-testid="meeting-transcribe"><Icon name="mic" size={14} /> Transcribe & summarise</button>
        )}
        {hasTranscript && (
          <button className="btn btn-sm" disabled={!!busy} onClick={() => onRun(true)} data-testid="meeting-summarize"><Icon name="sparkles" size={14} /> {sum ? "Re-summarise" : "Summarise"}</button>
        )}
        {hasTranscript && (
          <button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(transcriptPlain(lines)).then(() => st().toast("Transcript copied", "copy"))}><Icon name="copy" size={14} /> Copy</button>
        )}
        {busy && <span className="mt-chip" data-tone="busy" data-testid="meeting-busy">{busy}</span>}
      </div>
      {error && !busy && <div className="mt-error" role="alert" data-testid="meeting-run-error"><Icon name="alert" size={15} /><div className="min-w-0 text-dim">{error}</div></div>}

      <div className="tl-tabs mt-tabs">
        <button data-on={tab === "summary"} onClick={() => setTab("summary")} data-testid="meeting-tab-summary"><Icon name="sparkles" size={14} /> Summary</button>
        <button data-on={tab === "transcript"} onClick={() => setTab("transcript")} data-testid="meeting-tab-transcript"><Icon name="note" size={14} /> Transcript {hasTranscript ? <span className="text-faint">{lines.length}</span> : null}</button>
      </div>

      {tab === "summary" ? (
        sum ? (
          <div className="mt-summary selectable" data-testid="meeting-summary">
            <p>{sum.summary}</p>
            {sum.actionItems.length > 0 && (
              <>
                <h3>Action items</h3>
                <ul className="mt-actions-list" data-testid="meeting-action-items">
                  {sum.actionItems.map((a, i) => (
                    <li key={i}>
                      <Icon name="check" size={13} />
                      <span className="flex-1">{a.task}</span>
                      <span className="mt-chip" data-tone={a.owner === "You" ? "ok" : "muted"}>{a.owner || "Unassigned"}</span>
                      {a.due && <span className="mt-chip" data-tone="muted"><Icon name="clock" size={11} /> {a.due}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {sum.decisions.length > 0 && (<><h3>Decisions</h3><ul>{sum.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></>)}
            {sum.keyPoints.length > 0 && (<><h3>Key points</h3><ul>{sum.keyPoints.map((d, i) => <li key={i}>{d}</li>)}</ul></>)}
            {sum.openQuestions.length > 0 && (<><h3>Open questions</h3><ul>{sum.openQuestions.map((d, i) => <li key={i}>{d}</li>)}</ul></>)}
          </div>
        ) : (
          <div className="mt-empty">{hasTranscript ? "No summary yet — hit Summarise (uses your AI model, or Ollama locally)." : "Transcribe the meeting first."}</div>
        )
      ) : hasTranscript ? (
        <ol className="mt-transcript selectable" data-testid="meeting-transcript">
          {lines.map((l, i) => (
            <li key={i} data-speaker={l.speaker === "You" ? "you" : "them"}>
              <span className="mt-stamp">{fmtElapsed(l.startMs)}</span>
              <span className="mt-speaker">{l.speaker}</span>
              <span className="mt-text">{l.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="mt-empty">{m.status === "recording" ? "Still recording…" : "No transcript yet."}</div>
      )}

      {m.status !== "recording" && (m.chunks?.length ?? 0) > 0 && (
        <details className="mt-audio">
          <summary>Audio</summary>
          <AudioTrack label="You" url={audio("you")} />
          <AudioTrack label="Them" url={audio("them")} />
        </details>
      )}
    </div>
  );
}

/** Desktop has no HTTP origin for `/api/*`, so audio is fetched (through the API shim) into a blob URL on demand. */
function AudioTrack({ label, url }: { label: string; url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => () => void (src && URL.revokeObjectURL(src)), [src]);
  const load = async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status === 404 ? "no audio on this track" : `HTTP ${r.status}`);
      setSrc(URL.createObjectURL(await r.blob()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="mt-row">
      <span className="mt-meter-label">{label}</span>
      {src ? <audio controls autoPlay src={src} /> : err ? <span className="text-faint text-[12px]">{err}</span> : <button className="btn btn-sm" onClick={() => void load()}><Icon name="play" size={13} /> Play</button>}
    </div>
  );
}
