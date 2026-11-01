/** The current view's content (shared by the Nook layout and the Obsidian layout). Heavy views are
 *  code-split: each loads on first visit (and never, if its feature is switched off). */
import { lazy, Suspense, type ComponentType } from "react";
import { Dashboard } from "@/components/Dashboard";
import { Editor } from "@/components/Editor";
import { NoteTabs } from "@/components/NoteTabs";
import { useStore } from "@/lib/store";
import { viewEnabled } from "@/lib/features";
import { CrashProbe, ErrorBoundary } from "@/components/ErrorBoundary";

export const Loading = () => (
  <div className="grid h-full place-items-center">
    <div className="pixel-font text-dim shimmer rounded-xl px-5 py-3">loading…</div>
  </div>
);
/** code-split heavy views: each loads on first visit, with the same pixel "loading…" placeholder */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyView(load: () => Promise<{ default: ComponentType<any> }>) {
  const L = lazy(load);
  const View = () => (
    <Suspense fallback={<Loading />}>
      <L />
    </Suspense>
  );
  return View;
}
const GraphView = lazyView(() => import("@/components/GraphView").then((m) => ({ default: m.GraphView })));
const CanvasView = lazyView(() => import("@/components/CanvasView").then((m) => ({ default: m.CanvasView })));
const PetDen = lazyView(() => import("@/components/PetDen").then((m) => ({ default: m.PetDen })));
const FocusView = lazyView(() => import("@/components/FocusView").then((m) => ({ default: m.FocusView })));
const ArcadeView = lazyView(() => import("@/components/ArcadeView").then((m) => ({ default: m.ArcadeView })));
const TeamView = lazyView(() => import("@/components/TeamView").then((m) => ({ default: m.TeamView })));
const MarketView = lazyView(() => import("@/components/MarketView").then((m) => ({ default: m.MarketView })));
const TasksView = lazyView(() => import("@/components/TasksView").then((m) => ({ default: m.TasksView })));
const ActivityView = lazyView(() => import("@/components/ActivityView").then((m) => ({ default: m.ActivityView })));
const RulesView = lazyView(() => import("@/components/RulesView").then((m) => ({ default: m.RulesView })));
const SettingsView = lazyView(() => import("@/components/SettingsView").then((m) => ({ default: m.SettingsView })));
// 1.1 views — lazy so the startup bundle stays small
const CalendarView = lazyView(() => import("@/components/CalendarView"));
const TimelensView = lazyView(() => import("@/components/TimelensView"));
const ChatView = lazyView(() => import("@/components/ChatView"));
// 1.4
const MeetingsView = lazyView(() => import("@/components/MeetingsView"));

export function ViewHost({ tabs = true }: { tabs?: boolean }) {
  const view0 = useStore((s) => s.view);
  const features = useStore((s) => s.features);
  const activeId = useStore((s) => s.activeId);
  const view = viewEnabled(features, view0) ? view0 : "notes";
  return (
    <section key={view} data-view={view} className="view-enter relative min-w-0 flex-1 overflow-hidden">
      <ErrorBoundary name={`The ${view} view`} actions={view !== "notes" ? [{ label: "Go to notes", run: () => useStore.getState().setView("notes"), testId: "err-notes" }] : []}>
      <CrashProbe name={view} />
      {view === "notes" && (
        <div className="flex h-full min-h-0 flex-col">
          {tabs && <NoteTabs />}
          <div className="min-h-0 flex-1">{activeId ? <Editor key={activeId} id={activeId} /> : <Dashboard />}</div>
        </div>
      )}
      {view === "graph" && <GraphView />}
      {view === "canvas" && <CanvasView />}
      {view === "den" && <PetDen />}
      {view === "focus" && <FocusView />}
      {view === "arcade" && <ArcadeView />}
      {view === "team" && <TeamView />}
      {view === "market" && <MarketView />}
      {view === "tasks" && <TasksView />}
      {view === "activity" && <ActivityView />}
      {view === "rules" && <RulesView />}
      {view === "settings" && <SettingsView />}
      {view === "calendar" && <CalendarView />}
      {view === "timelens" && <TimelensView />}
      {view === "chat" && <ChatView />}
      {view === "meetings" && <MeetingsView />}
      </ErrorBoundary>
    </section>
  );
}
