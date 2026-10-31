/**
 * 1.3.1 — error boundary around the onboarding and every view. A render crash shows a small
 * recovery card (try again / go to notes / skip onboarding / report a bug) instead of a blank
 * window, and the error is logged. The bug report is only opened from the card's button (never
 * auto-opened: a modal on top would cover "Try again" / "Skip onboarding"), (and so lands in %APPDATA%/Nook/logs on desktop).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { push } from "@/lib/logger";

type Props = { children: ReactNode; name: string; onReset?: () => void; actions?: { label: string; run: () => void; testId?: string }[] };
type State = { err: Error | null; key: number };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null, key: 0 };

  static getDerivedStateFromError(err: Error): Partial<State> {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    push("error", `${this.props.name} crashed: ${err.message}\n${(info.componentStack ?? "").split("\n").slice(0, 6).join("\n")}`, "boundary");
  }

  reset = () => {
    (window as unknown as { __nookCrash?: string }).__nookCrash = undefined; // E2E crash switch
    this.props.onReset?.();
    this.setState((s) => ({ err: null, key: s.key + 1 }));
  };

  render() {
    if (!this.state.err) return <div key={this.state.key} style={{ display: "contents" }}>{this.props.children}</div>;
    const report = () => {
      const msg = this.state.err?.message ?? "";
      void import("@/components/BugReport").then((m) => m.openBugReport(`${this.props.name} crashed: ${msg}`, msg));
    };
    return (
      <div className="err-boundary" role="alert" data-testid="error-boundary">
        <div className="err-card">
          <div className="pixel-font text-[18px]">Oops — {this.props.name} hit a snag</div>
          <div className="mt-1 text-[12.5px] text-dim">Nothing was lost. You can try again, or report it so we can fix it.</div>
          <pre className="err-msg">{this.state.err.message}</pre>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <button className="btn btn-primary" onClick={this.reset} data-testid="err-retry">Try again</button>
            {(this.props.actions ?? []).map((a) => (
              <button key={a.label} className="btn" data-testid={a.testId} onClick={() => { (window as unknown as { __nookCrash?: string }).__nookCrash = undefined; a.run(); this.setState((s) => ({ err: null, key: s.key + 1 })); }}>{a.label}</button>
            ))}
            <button className="btn" onClick={report} data-testid="err-report">Report this bug</button>
          </div>
        </div>
      </div>
    );
  }
}

/** E2E-only crash switch: throws while `window.__nookCrash === name` (never set in normal use). */
export function CrashProbe({ name }: { name: string }) {
  const w = window as unknown as { __NOOK_E2E__?: boolean; __nookCrash?: string };
  if (w.__NOOK_E2E__ && w.__nookCrash === name) {
    throw new Error(`test crash in ${name}`);
  }
  return null;
}
