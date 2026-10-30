/** Kanban board for tasks: drag cards between To do / Doing / Done; reminders + repeats per card. */
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { useStore, type Task } from "@/lib/store";

const COLS: { id: "todo" | "doing" | "done"; label: string; color: string }[] = [
  { id: "todo", label: "To do", color: "#8fb7c9" },
  { id: "doing", label: "Doing", color: "#e0a05a" },
  { id: "done", label: "Done", color: "#7fc48f" },
];
const REPEATS = [["", "No repeat"], ["daily", "Daily"], ["weekdays", "Weekdays"], ["weekly", "Weekly"], ["monthly", "Monthly"]] as const;
const statusOf = (t: Task) => (t.done ? "done" : (t.status ?? "todo"));
const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

function Card({ t, onDrag }: { t: Task; onDrag: (id: string | null) => void }) {
  const st = useStore.getState;
  const [edit, setEdit] = useState(false);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className="kb-card"
      draggable
      data-dragging={dragging}
      data-task={t.id}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task", t.id);
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
        onDrag(t.id);
      }}
      onDragEnd={() => {
        setDragging(false);
        onDrag(null);
      }}
    >
      <div className="flex items-start gap-2">
        <span className={`min-w-0 flex-1 break-words ${t.done ? "text-faint line-through" : ""}`}>{t.title}</span>
        <button className="icon-btn !h-6 !w-6 shrink-0" title="Reminder & repeat" aria-label="Reminder and repeat" onClick={() => setEdit((v) => !v)}><Icon name="more-horizontal" size={12} /></button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-faint">
        {t.priority === 2 && <span className="text-accent">!! high</span>}
        {t.due && <span><Icon name="calendar" size={10} /> {new Date(t.due).toLocaleDateString([], { month: "short", day: "numeric" })}</span>}
        {t.remindAt && <span title={new Date(t.remindAt).toLocaleString()}><Icon name="bell" size={10} /> {new Date(t.remindAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
        {t.repeat && <span><Icon name="refresh" size={10} /> {t.repeat}</span>}
        <span className="ml-auto">{t.list}</span>
      </div>
      {edit && (
        <div className="mt-2 grid gap-1.5 border-t border-line pt-2 text-[11.5px]" onMouseDown={(e) => e.stopPropagation()}>
          <label className="flex items-center gap-2">
            <Icon name="bell" size={11} /> Remind
            <input
              type="datetime-local"
              className="input !h-7 flex-1 !text-[11.5px]"
              value={t.remindAt ? toLocalInput(t.remindAt) : ""}
              onChange={(e) => st().updateTask(t.id, { remindAt: e.target.value ? new Date(e.target.value).getTime() : null })}
              aria-label="Reminder time"
            />
          </label>
          <label className="flex items-center gap-2">
            <Icon name="refresh" size={11} /> Repeat
            <select className="input !h-7 flex-1 !text-[11.5px]" value={t.repeat ?? ""} onChange={(e) => st().updateTask(t.id, { repeat: e.target.value, due: t.due ?? Date.now() })} aria-label="Repeat">
              {REPEATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <button className="btn btn-sm justify-self-start" onClick={() => st().deleteTask(t.id)}><Icon name="trash" size={11} /> Delete</button>
        </div>
      )}
    </div>
  );
}

export default function KanbanBoard() {
  const tasks = useStore((s) => s.tasks);
  const [over, setOver] = useState<string | null>(null);
  const [, setDragId] = useState<string | null>(null);
  const [adding, setAdding] = useState<Record<string, string>>({});
  const st = useStore.getState;
  const move = (id: string, status: "todo" | "doing" | "done") => {
    const t = st().tasks.find((x) => x.id === id);
    if (!t || statusOf(t) === status) return;
    if (status === "done") st().toggleTask(id); // coins + confetti like ticking it off
    else st().updateTask(id, { status });
  };
  return (
    <div className="mt-4 grid gap-3 md:grid-cols-3" data-testid="kanban">
      {COLS.map((c) => {
        const rows = tasks.filter((t) => statusOf(t) === c.id).sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt);
        return (
          <div
            key={c.id}
            className="kb-col"
            data-col={c.id}
            data-over={over === c.id}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(c.id);
            }}
            onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData("text/task");
              if (id) move(id, c.id);
            }}
          >
            <div className="mb-2 flex items-center gap-2 px-1">
              <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c.color }} />
              <span className="pixel-font text-[14px]">{c.label}</span>
              <span className="text-[11px] text-faint">{rows.length}</span>
            </div>
            <div className="grid min-h-[60px] content-start gap-2">
              {rows.length === 0 && <div className="rounded-lg border border-dashed border-line px-2 py-4 text-center text-[11.5px] text-faint">Drop tasks here</div>}
              {rows.slice(0, 80).map((t) => <Card key={t.id} t={t} onDrag={setDragId} />)}
            </div>
            {c.id !== "done" && (
              <input
                className="input mt-2 !h-8 !text-[12px]"
                placeholder="+ Add a card"
                value={adding[c.id] ?? ""}
                onChange={(e) => setAdding({ ...adding, [c.id]: e.target.value })}
                onKeyDown={(e) => {
                  const v = (adding[c.id] ?? "").trim();
                  if (e.key === "Enter" && v) {
                    const id = st().createTask({ title: v });
                    if (c.id === "doing") setTimeout(() => st().updateTask(id, { status: "doing" }), 400);
                    setAdding({ ...adding, [c.id]: "" });
                  }
                }}
                aria-label={`Add a card to ${c.label}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
