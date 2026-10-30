/**
 * Journal — daily notes on a pixel calendar. Click a day to open (or create from the Daily
 * template) its note; dots show journal entries, edits and tasks due.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Markdown } from "@/components/Markdown";
import { useStore } from "@/lib/store";
import type { Note } from "@/lib/types";

type DayInfo = { daily?: string; words?: number; edited: number; due: number; tasks?: { id: string; title: string; done: boolean }[] };
type Cal = { month: string; firstWeekday: number; daysInMonth: number; days: Record<string, DayInfo>; today: string };

const pad = (n: number) => String(n).padStart(2, "0");
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const localKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Open (creating if needed) the daily note for `date` and jump to it. */
export async function openDaily(date = localKey()): Promise<string | null> {
  const r = await fetch(`/api/daily?date=${date}`);
  if (!r.ok) return null;
  const j = (await r.json()) as { note: Note; created: boolean };
  const st = useStore.getState();
  if (j.created || !st.notes.some((n) => n.id === j.note.id)) useStore.setState({ notes: [j.note, ...st.notes.filter((n) => n.id !== j.note.id)] });
  st.openNote(j.note.id);
  st.setView("notes");
  return j.note.id;
}

export default function CalendarView() {
  const notes = useStore((s) => s.notes);
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [cal, setCal] = useState<Cal | null>(null);
  const [sel, setSel] = useState(localKey());

  const load = useCallback(async () => {
    try {
      setCal((await (await fetch(`/api/calendar?month=${month}`)).json()) as Cal);
    } catch {
      /* retry on next nav */
    }
  }, [month]);
  useEffect(() => {
    void load();
  }, [load, notes.length]);

  const shift = (d: number) => {
    const [y, m] = month.split("-").map(Number);
    setMonth(monthKey(new Date(y, m - 1 + d, 1)));
  };
  const selInfo = cal?.days[sel];
  const selNote = useMemo(() => notes.find((n) => n.title === sel), [notes, sel]);
  const streak = useMemo(() => {
    const titles = new Set(notes.map((n) => n.title));
    let n = 0;
    const d = new Date();
    if (!titles.has(localKey(d))) d.setDate(d.getDate() - 1);
    while (titles.has(localKey(d))) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }, [notes]);

  const [y, m] = month.split("-").map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" });

  return (
    <div className="scroll h-full" data-testid="calendar">
      <div className="mx-auto grid max-w-[1100px] gap-4 px-1 pb-10 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <div>
              <div className="pixel-font flex items-center gap-2 text-[26px] leading-tight"><Icon name="calendar" size={22} className="text-accent" /> Journal</div>
              <div className="text-[13px] text-dim">One note a day. {streak > 0 ? `${streak}-day writing streak.` : "Start a streak today."}</div>
            </div>
            <span className="flex-1" />
            <button className="btn btn-accent btn-sm" onClick={() => void openDaily()} data-testid="open-today"><Icon name="pencil" size={13} /> Today's note</button>
          </div>
          <div className="paper p-4">
            <div className="mb-3 flex items-center gap-2">
              <button className="icon-btn" onClick={() => shift(-1)} title="Previous month" aria-label="Previous month"><Icon name="chevron-left" size={15} /></button>
              <div className="pixel-font min-w-[160px] text-center text-[17px]" data-testid="cal-month">{label}</div>
              <button className="icon-btn" onClick={() => shift(1)} title="Next month" aria-label="Next month"><Icon name="chevron-right" size={15} /></button>
              <span className="flex-1" />
              <button className="btn btn-sm" onClick={() => { setMonth(monthKey(new Date())); setSel(localKey()); }}>Today</button>
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="tiny-font pb-1 text-center text-[10px] text-faint">{d}</div>)}
              {Array.from({ length: cal?.firstWeekday ?? 0 }, (_, i) => <div key={`e${i}`} />)}
              {Array.from({ length: cal?.daysInMonth ?? 0 }, (_, i) => {
                const key = `${month}-${pad(i + 1)}`;
                const info = cal?.days[key];
                const isToday = key === cal?.today;
                return (
                  <button
                    key={key}
                    data-day={key}
                    data-on={sel === key}
                    className="cal-day group relative flex aspect-[1.15] flex-col items-start rounded-[10px] border p-1.5 text-left transition-colors"
                    style={{ borderColor: sel === key ? "var(--accent)" : "var(--line)", background: info?.daily ? "color-mix(in srgb, var(--accent) 12%, var(--panel2))" : "var(--panel2)" }}
                    onClick={() => setSel(key)}
                    onDoubleClick={() => void openDaily(key)}
                    title={info?.daily ? `Journal entry · ${info.words ?? 0} words` : "Double-click to start this day's note"}
                  >
                    <span className="pixel-font text-[13px]" style={{ color: isToday ? "var(--accent)" : undefined }}>{i + 1}</span>
                    <span className="mt-auto flex gap-1">
                      {info?.daily && <i className="block h-[6px] w-[6px] rounded-[1px]" style={{ background: "var(--accent)" }} />}
                      {(info?.edited ?? 0) > 0 && <i className="block h-[6px] w-[6px] rounded-[1px]" style={{ background: "#8fb7c9" }} />}
                      {(info?.due ?? 0) > 0 && <i className="block h-[6px] w-[6px] rounded-[1px]" style={{ background: "#e0a05a" }} />}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-faint">
              <span className="flex items-center gap-1"><i className="inline-block h-[7px] w-[7px]" style={{ background: "var(--accent)" }} /> journal entry</span>
              <span className="flex items-center gap-1"><i className="inline-block h-[7px] w-[7px]" style={{ background: "#8fb7c9" }} /> notes edited</span>
              <span className="flex items-center gap-1"><i className="inline-block h-[7px] w-[7px]" style={{ background: "#e0a05a" }} /> tasks due</span>
              <span className="ml-auto">double-click a day to write</span>
            </div>
          </div>
        </div>

        <aside className="paper flex min-h-[300px] flex-col p-4" data-testid="cal-side">
          <div className="pixel-font text-[17px]">{new Date(sel + "T12:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</div>
          <div className="mb-3 text-[12px] text-faint">{selInfo?.edited ? `${selInfo.edited} note(s) edited` : "No edits"} · {selInfo?.due ?? 0} task(s) due</div>
          <button className="btn btn-sm mb-3 self-start" onClick={() => void openDaily(sel)} data-testid="open-day">
            <Icon name={selNote ? "file-text" : "plus"} size={13} /> {selNote ? "Open journal entry" : "Write this day"}
          </button>
          {selInfo?.tasks?.length ? (
            <div className="mb-3">
              <div className="label mb-1">Due</div>
              {selInfo.tasks.map((t) => (
                <button key={t.id} className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-[12.5px] hover:bg-panel2" onClick={() => useStore.getState().jumpToTask(t.id)}>
                  <Icon name={t.done ? "checkbox-on" : "checkbox"} size={13} className="text-accent" />
                  <span className={t.done ? "text-faint line-through" : ""}>{t.title}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="label mb-1">Entry</div>
          <div className="selectable min-h-0 flex-1 overflow-auto text-[12.5px]">
            {selNote ? <Markdown source={selNote.content.slice(0, 2000)} titles={new Set(notes.map((n) => n.title.toLowerCase()))} onLink={(t) => useStore.getState().openByTitle(t)} /> : <div className="text-faint">Nothing written yet.</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}
