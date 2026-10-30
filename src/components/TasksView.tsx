
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { MicButton } from "@/components/MicButton";
import { PetView } from "@/components/PetView";
import { useStore, type Task, type TaskList } from "@/lib/store";
import { levelOf } from "@/lib/pet";
const KanbanBoard = lazy(() => import("@/components/KanbanBoard"));

const LISTS: { id: TaskList; label: string; icon: IconName; hint: string }[] = [
  { id: "today", label: "Today", icon: "sun", hint: "Do these before bed" },
  { id: "upcoming", label: "Upcoming", icon: "calendar", hint: "Scheduled & soon" },
  { id: "someday", label: "Someday", icon: "moon-star", hint: "The maybe pile" },
];

const PRIORITY: { v: 0 | 1 | 2; label: string; color: string }[] = [
  { v: 0, label: "low", color: "var(--faint)" },
  { v: 1, label: "normal", color: "var(--accent)" },
  { v: 2, label: "high", color: "#e0684f" },
];

function fmtDue(due: number): string {
  const d = new Date(due);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days < 0) return `${-days}d overdue`;
  if (days <= 6) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** render task titles with clickable [@Task](task:id) / [@Note](note:id) mention chips */
function TitleWithMentions({ title }: { title: string }) {
  const st = useStore.getState;
  const parts: (string | { kind: string; id: string; label: string })[] = [];
  let last = 0;
  for (const m of title.matchAll(/\[(@?[^\]\n]+)\]\((task|note):([\w-]+)\)/g)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(title.slice(last, idx));
    parts.push({ kind: m[2], id: m[3], label: m[1].replace(/^@\s*/, "") });
    last = idx + m[0].length;
  }
  if (last < title.length) parts.push(title.slice(last));
  if (parts.length === 1 && typeof parts[0] === "string") return <>{parts[0]}</>;
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <span
            key={i}
            className="mention-chip mx-0.5 !inline-flex max-w-[220px] align-middle text-[11px]"
            title={p.kind === "task" ? "Open this task" : "Open this note"}
            onClick={(e) => {
              e.stopPropagation();
              if (p.kind === "task") st().jumpToTask(p.id);
              else st().openNote(p.id);
            }}
          >
            <Icon name={p.kind === "task" ? "checkbox-on" : "note"} size={10} />
            {p.kind === "task" && <i className="mention-at">@</i>}
            <span className="truncate">{p.label}</span>
          </span>
        ),
      )}
    </>
  );
}

function TagAdd({ taskId, tags }: { taskId: string; tags: string[] }) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState("");
  if (!adding)
    return (
      <button className="chip !py-0 !text-[10px] opacity-0 transition-opacity [.task-row:hover_&]:opacity-70" onClick={(e) => { e.stopPropagation(); setAdding(true); }} title="Add a tag">
        <Icon name="label" size={10} /> + tag
      </button>
    );
  return (
    <input
      className="input !h-[20px] !w-[92px] !py-0 !text-[10px]"
      placeholder="tag…"
      autoFocus
      value={val}
      maxLength={24}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => { if (val.trim()) useStore.getState().setTaskTags(taskId, [...tags, val.trim()]); setAdding(false); setVal(""); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { if (val.trim()) useStore.getState().setTaskTags(taskId, [...tags, val.trim()]); setAdding(false); setVal(""); }
        if (e.key === "Escape") { setAdding(false); setVal(""); }
      }}
    />
  );
}

function TaskRow({ t, i }: { t: Task; i: number }) {
  const st = useStore.getState;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const note = useStore((s) => s.notes.find((n) => n.id === t.noteId));
  const jumped = useStore((s) => s.taskJump === t.id);
  const overdue = t.due && !t.done && t.due < Date.now();
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (jumped) rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [jumped]);
  return (
    <div
      ref={rowRef}
      className="task-row"
      data-done={t.done}
      data-jump={jumped}
      style={{ animation: "rise .35s var(--ease-soft) both", animationDelay: `${Math.min(i, 12) * 30}ms` }}
    >
      <button className="task-check" data-done={t.done} onClick={() => st().toggleTask(t.id)} aria-label={t.done ? "Mark undone" : "Mark done"}>
        <Icon name={t.done ? "checkbox-on" : "checkbox"} size={16} />
      </button>
      {editing ? (
        <input
          className="input !py-1 !text-[14px]"
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => { setEditing(false); if (title.trim()) st().updateTask(t.id, { title: title.trim() }); }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <div className="min-w-0 flex-1 text-left">
          <button className="block w-full truncate text-left text-[14.5px] leading-snug" onDoubleClick={() => setEditing(true)} onClick={() => setEditing(true)} title="Click to edit">
            <TitleWithMentions title={t.title} />
          </button>
          <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
            {t.by === "ai" && <span className="chip !py-0 !text-[10px]" title="Created by your AI companion"><Icon name="sparkles" size={10} /> ai</span>}
            {t.by === "agent" && <span className="chip !py-0 !text-[10px]" data-on="true" title="Created by a connected MCP agent (Claude Code / Cursor / Codex…)"><Icon name="cpu" size={10} /> agent</span>}
            {t.priority === 2 && <span className="chip !py-0 !text-[10px]" style={{ color: "#e0684f" }}><Icon name="zap" size={10} /> high</span>}
            {t.priority === 0 && <span className="chip !py-0 !text-[10px]">low</span>}
            {t.due && <span className="chip !py-0 !text-[10px]" data-on={!!overdue} style={overdue ? { color: "#e0684f" } : undefined}><Icon name="clock" size={10} /> {fmtDue(t.due)}</span>}
            {note && (
              <button className="chip !py-0 !text-[10px]" onClick={(e) => { e.stopPropagation(); st().openNote(note.id); }} title="Open the linked note">
                <Icon name="note" size={10} /> {note.title.slice(0, 18)}
              </button>
            )}
            {(t.tags ?? []).map((tag) => (
              <span key={tag} className="chip !py-0 !text-[10px]" data-on="true" title={`Tag: ${tag}`}>
                #{tag}
                <button
                  className="ml-0.5 opacity-40 transition-opacity hover:opacity-100"
                  onClick={(e) => { e.stopPropagation(); st().setTaskTags(t.id, (t.tags ?? []).filter((x) => x !== tag)); }}
                  aria-label={`Remove tag ${tag}`}
                >
                  ×
                </button>
              </span>
            ))}
            <TagAdd taskId={t.id} tags={t.tags ?? []} />
          </span>
        </div>
      )}
      <button className="icon-btn !h-7 !w-7 opacity-0 [.task-row:hover_&]:opacity-70" title="Delete task" onClick={() => st().deleteTask(t.id)}>
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

export function TasksView() {
  const tasks = useStore((s) => s.tasks);
  const tasksLoaded = useStore((s) => s.tasksLoaded);
  const notes = useStore((s) => s.notes);
  const pet = useStore((s) => s.pet);
  const aiBusy = useStore((s) => s.aiBusy);
  const [q, setQ] = useState("");
  const [list, setList] = useState<TaskList>("today");
  const [priority, setPriority] = useState<0 | 1 | 2>(1);
  const [showDone, setShowDone] = useState(false);
  const [board, setBoardState] = useState(() => localStorage.getItem("nook:tasks-board") === "1");
  const setBoard = (b: boolean) => {
    setBoardState(b);
    localStorage.setItem("nook:tasks-board", b ? "1" : "0");
  };
  const [atIdx, setAtIdx] = useState(0);
  const st = useStore.getState;

  // @ mention autocomplete inside the quick-add input (shows while the caret sits on an @token)
  const atMatch = /(^|\s)@([\w .-]{0,24})$/.exec(q);
  const atSugg = useMemo(() => {
    if (!atMatch) return [];
    const qq = atMatch[2].trim().toLowerCase();
    const out: { label: string; sub: string; icon: IconName; insert: string }[] = [];
    for (const t of tasks.filter((t) => !t.done && t.title.toLowerCase().includes(qq)).slice(0, 4))
      out.push({ label: t.title, sub: "task", icon: "checkbox-on", insert: `[@${t.title}](task:${t.id})` });
    for (const n of notes.filter((n) => n.title.toLowerCase().includes(qq)).slice(0, 4))
      out.push({ label: n.title, sub: "note", icon: "note", insert: `[@${n.title}](note:${n.id})` });
    const me = st().profile.displayName || "You";
    if ("you me".includes(qq) || me.toLowerCase().includes(qq)) out.push({ label: me, sub: "person", icon: "user", insert: `@${me}` });
    const pet = st().pet;
    if (pet.name.toLowerCase().includes(qq)) out.push({ label: pet.name, sub: "companion", icon: "sparkle", insert: `@${pet.name}` });
    return out.slice(0, 8);
  }, [atMatch, tasks, notes, st]);

  const acceptAt = (i: number) => {
    if (!atMatch || !atSugg[i]) return;
    const start = q.length - atMatch[0].length + atMatch[1].length;
    setQ(q.slice(0, start) + atSugg[i].insert + " ");
    setAtIdx(0);
  };

  useEffect(() => {
    if (!tasksLoaded) void st().loadTasks();
  }, [tasksLoaded]);

  const byList = useMemo(() => {
    const m: Record<TaskList, Task[]> = { today: [], upcoming: [], someday: [] };
    for (const t of tasks) if (!t.done && m[t.list]) m[t.list].push(t);
    for (const l of LISTS) m[l.id].sort((a, b) => b.priority - a.priority || (a.due ?? Infinity) - (b.due ?? Infinity));
    return m;
  }, [tasks]);

  const doneTasks = useMemo(() => tasks.filter((t) => t.done).slice(0, 20), [tasks]);
  const open = tasks.filter((t) => !t.done).length;
  const doneToday = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return tasks.filter((t) => t.completedAt && t.completedAt >= start.getTime()).length;
  }, [tasks]);

  // open checkbox-tasks that live inside notes
  const noteTasks = useMemo(() => {
    const out: { noteId: string; noteTitle: string; open: number; total: number }[] = [];
    for (const n of notes) {
      const lines = n.content.split("\n").filter((l) => /^\s*[-*]\s*\[[ x]\]/i.test(l));
      if (!lines.length) continue;
      const openN = lines.filter((l) => /\[\s?\]/.test(l)).length;
      if (openN > 0) out.push({ noteId: n.id, noteTitle: n.title, open: openN, total: lines.length });
    }
    return out.slice(0, 5);
  }, [notes]);

  const add = () => {
    const title = q.trim();
    if (!title) return;
    st().createTask({ title, list, priority });
    setQ("");
  };

  const plan = () => {
    if (aiBusy) return;
    void st().runAi("agent", {
      question: `Plan my day: look at my vault, notes and open tasks, then create up to 5 focused tasks for today that make sense together. Briefly say why.`,
    });
  };

  const lvl = levelOf(pet.xp).level;
  const pct = tasks.length ? doneToday / Math.max(1, doneToday + byList.today.length) : 0;

  return (
    <div className="scroll h-full">
      <div className={`mx-auto px-1 pb-10 ${board ? "max-w-[1180px]" : "max-w-[860px]"}`}>
        {/* header */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div>
            <div className="pixel-font text-[26px] leading-tight">Tasks</div>
            <div className="text-[13px] text-dim">{open} open · {doneToday} done today — small wins stack.</div>
          </div>
          <div className="flex-1" />
          <div className="seg" role="tablist" aria-label="Task layout">
            <button role="tab" aria-selected={!board} data-on={!board} onClick={() => setBoard(false)}><Icon name="bulletlist" size={12} /> List</button>
            <button role="tab" aria-selected={board} data-on={board} onClick={() => setBoard(true)} data-testid="kanban-toggle"><Icon name="layout" size={12} /> Board</button>
          </div>
          <div className="goal-ring" style={{ ["--p" as string]: Math.round(pct * 100) }} title={`${doneToday} of today's tasks done`}>
            <span className="pixel-font text-[13px]">{Math.round(pct * 100)}%</span>
          </div>
        </div>

        {/* quick add */}
        <div className="paper p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1">
              <input
                className="input w-full"
                placeholder="Add a task… type @ to mention, Enter to save"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setAtIdx(0);
                }}
                onKeyDown={(e) => {
                  if (atMatch && atSugg.length) {
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      setAtIdx((i) => (i + (e.key === "ArrowDown" ? 1 : atSugg.length - 1)) % atSugg.length);
                      return;
                    }
                    if (e.key === "Enter" || e.key === "Tab") {
                      e.preventDefault();
                      acceptAt(atIdx);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setQ(q.replace(/@([\w .-]{0,24})$/, ""));
                      return;
                    }
                  }
                  if (e.key === "Enter") add();
                }}
              />
              {atMatch && atSugg.length > 0 && (
                <div className="menu panel panel-solid absolute z-30 mt-1 w-[300px] p-1.5" style={{ backdropFilter: "none" }}>
                  <div className="label px-2 pb-1 pt-0.5">Mention a task, note or person</div>
                  {atSugg.map((s, i) => (
                    <button
                      key={s.sub + s.label + i}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptAt(i);
                      }}
                      onMouseEnter={() => setAtIdx(i)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13.5px]"
                      style={{ background: i === atIdx ? "var(--hl)" : "transparent" }}
                    >
                      <Icon name={s.icon} size={13} className="flex-none text-accent" />
                      <span className="truncate">{s.label}</span>
                      <span className="ml-auto chip !py-0 !text-[9.5px]">{s.sub}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="seg seg-compact">
              {LISTS.map((l) => (
                <button key={l.id} data-on={list === l.id} onClick={() => setList(l.id)} title={l.hint}>
                  <Icon name={l.icon} size={12} /> {l.label}
                </button>
              ))}
            </div>
            <button
              className="chip"
              onClick={() => setPriority(PRIORITY[(PRIORITY.findIndex((p) => p.v === priority) + 1) % 3].v)}
              title="Cycle priority"
              style={{ color: PRIORITY.find((p) => p.v === priority)!.color }}
            >
              <Icon name="flag" size={12} /> {PRIORITY.find((p) => p.v === priority)!.label}
            </button>
            <button className="btn btn-accent btn-sm" onClick={add} disabled={!q.trim()}>
              <Icon name="plus" size={13} /> Add
            </button>
            <MicButton onText={(text) => { setQ(q ? `${q} ${text}` : text); }} />
          </div>
          {/* AI plan row */}
          <div className="mt-2.5 flex items-center gap-2.5 rounded-xl border border-line bg-panel2 px-2.5 py-2">
            <div className="grid h-8 w-8 flex-none place-items-end overflow-hidden rounded-lg" style={{ background: "color-mix(in srgb, var(--hl) 40%, transparent)" }}>
              <PetView species={pet.species} tint={pet.look} hat={pet.hat} mood={aiBusy ? "think" : "idle"} scale={1.05} fps={6} style={{ marginBottom: -2 }} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="pixel-font text-[13.5px]">Ask {pet.name} to plan the day</div>
              <div className="text-[11px] text-faint">{aiBusy ? "researching your vault & writing tasks…" : "the AI harness reads your notes and files real tasks here"}</div>
            </div>
            <button className="btn btn-sm" onClick={plan} disabled={aiBusy}>
              <Icon name="sparkles" size={13} /> {aiBusy ? "Working…" : "Plan my day"}
            </button>
          </div>
        </div>

        {board ? (
          <Suspense fallback={<div className="pixel-font p-6 text-dim">loading…</div>}>
            <KanbanBoard />
          </Suspense>
        ) : (
        <>
        {/* lists */}
        {LISTS.map((l) => {
          const rows = byList[l.id];
          if (!rows.length) return null;
          return (
            <div key={l.id} className="paper mt-4 p-4">
              <div className="mb-2 flex items-center gap-2">
                <Icon name={l.icon} size={13} className="text-accent" />
                <span className="label">{l.label}</span>
                <span className="chip">{rows.length}</span>
                <span className="flex-1" />
                <span className="text-[11px] text-faint">{l.hint}</span>
              </div>
              <div className="space-y-1">{rows.map((t, i) => <TaskRow key={t.id} t={t} i={i} />)}</div>
            </div>
          );
        })}

        {/* checkbox tasks inside notes */}
        {noteTasks.length > 0 && (
          <div className="paper mt-4 p-4">
            <div className="mb-2 flex items-center gap-2">
              <Icon name="file-text" size={13} className="text-accent" />
              <span className="label">Open checkboxes in notes</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {noteTasks.map((n) => (
                <button key={n.noteId} className="pulse-chip" onClick={() => st().openNote(n.noteId)} title="Open note">
                  <Icon name="note" size={12} className="text-accent" />
                  <span className="pixel-font">{n.noteTitle}</span>
                  <span className="opacity-70">{n.open} open</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* done */}
        {doneTasks.length > 0 && (
          <div className="paper mt-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <button className="flex items-center gap-2" onClick={() => setShowDone(!showDone)}>
                <Icon name={showDone ? "chevron-down" : "chevron-right"} size={13} className="text-faint" />
                <span className="label">Finished</span>
              </button>
              <span className="chip" data-on="true">{doneTasks.length}</span>
              <span className="flex-1" />
              <button className="btn btn-sm" onClick={() => st().clearDoneTasks()}>
                <Icon name="trash" size={12} /> Clear done
              </button>
            </div>
            {showDone && (
              <div className="mt-2 space-y-1 opacity-75">
                {doneTasks.map((t, i) => <TaskRow key={t.id} t={t} i={i} />)}
              </div>
            )}
          </div>
        )}

        </>
        )}

        {!board && tasksLoaded && tasks.length === 0 && (
          <div className="paper mt-4 grid place-items-center gap-2 p-8 text-center">
            <PetView species={pet.species} tint={pet.look} hat={pet.hat} mood="happy" scale={3} fps={6} />
            <div className="pixel-font text-[16px]">A clean slate!</div>
            <div className="max-w-[300px] text-[12.5px] text-dim">Add your first task above — or press <b>Plan my day</b> and {pet.name} (Lv {lvl}) will research your vault and file real tasks for you.</div>
          </div>
        )}
      </div>
    </div>
  );
}
