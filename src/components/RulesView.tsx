
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { PetView } from "@/components/PetView";
import { CAT_COLOR, CATS, fmt, DOCK } from "@/components/ActivityView";
import { todayKey } from "@/lib/quests";
import { categorize, useStore, type AppCat } from "@/lib/store";
import { inQuiet } from "@/lib/rules";
import { ShieldEngine } from "@/components/rules/ShieldEngine";

/** every rule the admin manager controls, as a nav chip */
type RuleTab = "shield" | "blocklist" | "limits" | "quiet" | "cats" | "admin";

const TABS: { id: RuleTab; label: string; icon: IconName; hint: string }[] = [
  { id: "shield", label: "Shield", icon: "shield", hint: "master switch — enforce everything below" },
  { id: "blocklist", label: "Blocked sites", icon: "block", hint: "bounce apps & sites you don't want" },
  { id: "limits", label: "App limits", icon: "hourglass", hint: "daily budgets per app" },
  { id: "quiet", label: "Quiet hours", icon: "moon", hint: "outside hours, only productive apps" },
  { id: "cats", label: "Categories", icon: "label", hint: "auto-triage apps by keyword" },
  { id: "admin", label: "Admin PIN", icon: "lock", hint: "lock the rulebook behind a code" },
];

export function RulesView() {
  const rules = useStore((s) => s.rules);
  const adminUnlocked = useStore((s) => s.adminUnlocked);
  const blockedAttempts = useStore((s) => s.blockedAttempts);
  const appUse = useStore((s) => s.appUse);
  const appCat = useStore((s) => s.appCat);
  const customDock = useStore((s) => s.customDock);
  const pet = useStore((s) => s.pet);
  const currentApp = useStore((s) => s.currentApp);
  const [tab, setTab] = useState<RuleTab>("shield");
  const [pinInput, setPinInput] = useState("");
  const [pinErr, setPinErr] = useState(false);
  const [newSite, setNewSite] = useState("");
  const [limitApp, setLimitApp] = useState("");
  const [limitMins, setLimitMins] = useState("60");
  const [pattern, setPattern] = useState("");
  const [patternCat, setPatternCat] = useState<AppCat>("productive");
  const st = useStore.getState;

  // today's usage per app for the limit bars
  const usedToday = useMemo(() => {
    const m = new Map<string, number>();
    for (const [k, v] of Object.entries(appUse)) {
      if (!k.startsWith(todayKey())) continue;
      const app = k.slice(11);
      m.set(app, (m.get(app) ?? 0) + v);
    }
    return m;
  }, [appUse]);

  const catOf = (app: string) => categorize(app, appCat, rules.patterns);
  const limitEntries = useMemo(() => Object.entries(rules.limits).sort((a, b) => b[1] - a[1]), [rules.limits]);
  const dockApps = useMemo(() => [...DOCK.map((d) => d.id), ...customDock, "nook:arcade"], [customDock]);

  // PIN gate: derived — show the lock whenever a PIN exists and this session isn't unlocked
  const showGate = !!rules.pinHash && !adminUnlocked && tab !== "shield";

  const unlock = async () => {
    const ok = await st().verifyAdmin(pinInput);
    if (ok) {
      setPinInput("");
      setPinErr(false);
    } else {
      setPinErr(true);
      setTimeout(() => setPinErr(false), 1500);
    }
  };

  const verdictNow = currentApp ? st().checkAppRules(currentApp) : null;
  const quietNow = inQuiet(new Date().getHours(), rules.quiet);

  return (
    <div className="scroll h-full">
      <div className="mx-auto max-w-[900px] px-1 pb-10">
        {/* header */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div>
            <div className="pixel-font flex items-center gap-2 text-[26px] leading-tight">
              <Icon name="shield" size={22} className="text-accent" /> Rules
            </div>
            <div className="text-[13px] text-dim">Your personal rulebook — what the tracker bounces, budgets and triages while you work.</div>
          </div>
          <div className="flex-1" />
          {rules.pinHash && (
            <span className="chip !text-[11.5px]" title="Rulebook is PIN-protected">
              <Icon name={adminUnlocked ? "unlock" : "lock"} size={12} /> {adminUnlocked ? "unlocked" : "locked"}
            </span>
          )}
        </div>

        {/* shield master — always visible, top of page */}
        <div className="paper relative overflow-hidden p-5" style={{ borderColor: rules.shieldOn ? "color-mix(in srgb, #7fc48f 55%, transparent)" : undefined }}>
          {rules.shieldOn && <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ background: "repeating-linear-gradient(-45deg, #7fc48f 0 14px, transparent 14px 28px)" }} />}
          <div className="flex flex-wrap items-center gap-4">
            <button
              className="relative grid h-[64px] w-[64px] flex-none place-items-center rounded-2xl border-2 transition-all"
              style={{ borderColor: rules.shieldOn ? "#7fc48f" : "var(--line)", background: rules.shieldOn ? "color-mix(in srgb, #7fc48f 14%, var(--panel2))" : "var(--panel2)", boxShadow: rules.shieldOn ? "0 0 22px color-mix(in srgb, #7fc48f 35%, transparent)" : "none" }}
              onClick={() => {
                const next = !rules.shieldOn;
                st().setRules({ shieldOn: next });
                st().toast(next ? "Shield up — rules are enforced" : "Shield down — tracking only", "shield");
                if (next) {
                  st().unlock("bodyguard", "Bodyguard", "Turned on the shield", "shield");
                  st().say("Shield's up! I'll bounce the naughty apps.");
                } else st().say("Shield's down. I'll keep tracking quietly.");
              }}
              role="switch"
              aria-checked={rules.shieldOn}
              aria-label="Shield mode"
            >
              <Icon name={rules.shieldOn ? "shield-on" : "shield"} size={30} style={{ color: rules.shieldOn ? "#7fc48f" : "var(--faint)" }} />
            </button>
            <div className="min-w-[200px] flex-1">
              <div className="pixel-font text-[17px]">Shield mode {rules.shieldOn ? "is UP" : "is down"}</div>
              <div className="mt-0.5 text-[12.5px] text-dim">
                With the shield up, the background engine enforces your rules even when Nook is closed to the tray: blocked apps and sites are bounced, daily limits cut off when spent, and quiet hours allow only productive apps.
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                <span className="chip !text-[11px]">{rules.blocklist.filter((b) => b.enabled).length} blocked</span>
                <span className="chip !text-[11px]">{Object.keys(rules.limits).length} limited</span>
                <span className="chip !text-[11px]">{rules.patterns.length} category rules</span>
                {rules.quiet.enabled && <span className="chip !text-[11px]" data-on>{quietNow ? "quiet hours NOW" : `quiet ${String(rules.quiet.from).padStart(2, "0")}:00–${String(rules.quiet.to).padStart(2, "0")}:00`}</span>}
                {blockedAttempts > 0 && <span className="chip !text-[11px]" style={{ color: "#e08a6a" }}>{blockedAttempts} bounced today</span>}
              </div>
            </div>
            <PetView species={pet.species} tint={pet.look} hat={pet.hat} mood={rules.shieldOn ? "happy" : "think"} scale={2.6} fps={6} />
          </div>
          {verdictNow && currentApp && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel2 px-3 py-2 text-[12px]" data-rule-live>
              <span className="tiny-font text-[10px] uppercase tracking-wider text-faint">live check</span>
              <b className="pixel-font text-[13px]">{currentApp}</b>
              {verdictNow.blocked ? (
                <span className="chip !text-[11px]" style={{ color: "#e08a6a", borderColor: "#e08a6a" }}><Icon name="block" size={11} /> blocked by your list</span>
              ) : verdictNow.limited ? (
                <span className="chip !text-[11px]" style={verdictNow.over ? { color: "#e08a6a" } : undefined}>
                  {verdictNow.over ? "over limit" : "limit"} {Math.round(verdictNow.limitPct * 100)}% of {verdictNow.limitMins}m
                </span>
              ) : (
                <span className="chip !text-[11px]">no restrictions · {catOf(currentApp)}</span>
              )}
            </div>
          )}
        </div>

        {/* v1.4: the real engine — banner, actions, live status */}
        <ShieldEngine />

        {/* section tabs */}
        <div className="seg mt-4 flex-wrap" role="tablist" aria-label="Rule sections">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} data-on={tab === t.id} onClick={() => setTab(t.id)} title={t.hint}>
              <Icon name={t.icon} size={12} /> {t.label}
            </button>
          ))}
        </div>

        {/* PIN gate over the rule lists */}
        {showGate ? (
          <div className="paper mt-4 grid place-items-center p-8 text-center">
            <Icon name="lock" size={26} className="mb-3 text-accent" />
            <div className="pixel-font text-[17px]">This rulebook is PIN-locked</div>
            <div className="mt-1 text-[12.5px] text-dim">Enter the admin PIN to view & edit these rules.</div>
            <div className="mt-4 flex items-center gap-2">
              <input
                className="input pixel-font !w-[150px] tracking-[0.4em]"
                type="password"
                inputMode="numeric"
                maxLength={8}
                placeholder="••••"
                value={pinInput}
                style={pinErr ? { borderColor: "#e08a6a" } : undefined}
                onChange={(e) => setPinInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void unlock()}
                aria-label="Admin PIN"
              />
              <button className="btn btn-accent" onClick={() => void unlock()}>
                <Icon name="unlock" size={13} /> Unlock
              </button>
            </div>
            {pinErr && <div className="mt-2 text-[12px]" style={{ color: "#e08a6a" }}>Wrong PIN — try again</div>}
          </div>
        ) : (
          <>
            {tab === "shield" && (
              <div className="paper mt-4 grid gap-3 p-5 sm:grid-cols-2" data-testid="shield-overview">
                {TABS.filter((t) => t.id !== "shield").map((t) => (
                  <button key={t.id} className="flex items-start gap-3 rounded-xl border border-line bg-panel2 p-3 text-left hover:border-[var(--accent)]" onClick={() => setTab(t.id)}>
                    <Icon name={t.icon} size={18} className="mt-0.5 text-accent" />
                    <span className="min-w-0">
                      <span className="pixel-font block text-[14px]">{t.label}</span>
                      <span className="block text-[12px] text-dim">{t.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {/* ---------------- blocklist ---------------- */}
            {tab === "blocklist" && (
              <div className="paper mt-4 p-5">
                <div className="label mb-1">Blocked sites & apps</div>
                <div className="mb-3 text-[12.5px] text-dim">Anything whose name <b className="text-ink">contains</b> a blocked word gets bounced while the shield is up (e.g. <code>reddit</code> blocks <code>reddit.com</code> and the app).</div>
                <div className="flex flex-wrap gap-2">
                  <input className="input !w-[240px]" placeholder="site or app to block…" value={newSite} onChange={(e) => setNewSite(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (st().addBlock(newSite), setNewSite(""))} aria-label="New blocked site" />
                  <button className="btn btn-accent" disabled={!newSite.trim()} onClick={() => { st().addBlock(newSite); setNewSite(""); }}>
                    <Icon name="block" size={13} /> Block it
                  </button>
                  <div className="flex-1" />
                  {DOCK.slice(0, 5).map((d) => (
                    <button key={d.id} className="btn btn-sm" disabled={rules.blocklist.some((b) => b.match === d.id)} onClick={() => st().addBlock(d.id)} title={`Block ${d.label}`}>
                      <Icon name={d.icon} size={12} /> {d.label}
                    </button>
                  ))}
                </div>
                <div className="mt-4 space-y-1.5">
                  {rules.blocklist.length === 0 && <div className="pixel-font rounded-2xl border border-dashed border-line px-4 py-6 text-center text-[13.5px] text-faint">Nothing blocked yet. A calmer day starts with one honest block.</div>}
                  {rules.blocklist.map((b, i) => {
                    const used = usedToday.get(b.match) ?? 0;
                    return (
                      <div key={b.id} className="inset flex items-center gap-3 px-3 py-2" style={{ animation: "rise .3s var(--ease-soft) both", animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                        <button className="icon-btn !h-7 !w-7" data-on={b.enabled} onClick={() => st().toggleBlock(b.id)} title={b.enabled ? "Pause this rule" : "Enable this rule"} role="switch" aria-checked={b.enabled}>
                          <Icon name={b.enabled ? "block" : "eye"} size={14} style={b.enabled ? { color: "#e08a6a" } : undefined} />
                        </button>
                        <span className="pixel-font min-w-0 flex-1 truncate text-[14.5px]" style={b.enabled ? undefined : { textDecoration: "line-through", opacity: 0.5 }}>{b.match}</span>
                        {used > 0 && <span className="chip !text-[10.5px]" title="Tracked before you blocked it">{fmt(used)} logged today</span>}
                        <button className="icon-btn !h-7 !w-7" onClick={() => st().removeBlock(b.id)} title="Delete rule"><Icon name="trash" size={14} /></button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ---------------- limits ---------------- */}
            {tab === "limits" && (
              <div className="paper mt-4 p-5">
                <div className="label mb-1">Daily app budgets</div>
                <div className="mb-3 text-[12.5px] text-dim">Set how long you <i>want</i> to allow an app each day. The tracker fills the bar live; past 100% the pet starts nagging.</div>
                <div className="flex flex-wrap gap-2">
                  <input className="input !w-[190px]" list="dock-apps" placeholder="app name…" value={limitApp} onChange={(e) => setLimitApp(e.target.value)} aria-label="App to limit" />
                  <datalist id="dock-apps">{dockApps.map((a) => <option key={a} value={a} />)}</datalist>
                  <input className="input !w-[86px]" type="number" min={5} max={720} step={5} value={limitMins} onChange={(e) => setLimitMins(e.target.value)} aria-label="Limit minutes" />
                  <span className="text-[12px] text-faint self-center">min/day</span>
                  <button className="btn btn-accent" disabled={!limitApp.trim()} onClick={() => { st().setLimit(limitApp.trim(), Number(limitMins) || 60); setLimitApp(""); }}>
                    <Icon name="hourglass" size={13} /> Set limit
                  </button>
                </div>
                <div className="mt-4 space-y-2.5">
                  {limitEntries.length === 0 && <div className="pixel-font rounded-2xl border border-dashed border-line px-4 py-6 text-center text-[13.5px] text-faint">No budgets yet — try limiting the usual suspects.</div>}
                  {limitEntries.map(([app, mins], i) => {
                    const used = usedToday.get(app) ?? 0;
                    const pct = Math.min(1, used / (mins * 60));
                    const over = used > mins * 60;
                    const cat = catOf(app);
                    return (
                      <div key={app} className="inset p-3" style={{ animation: "rise .3s var(--ease-soft) both", animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                        <div className="flex flex-wrap items-center gap-2">
                          <b className="pixel-font min-w-0 flex-1 truncate text-[14.5px]">{app}</b>
                          <i className="inline-block h-[8px] w-[8px] flex-none" style={{ background: CAT_COLOR[cat] }} title={cat} />
                          <span className="pixel-font text-[13px]" style={over ? { color: "#e08a6a" } : undefined}>{fmt(used)} / {mins}m{over ? " · over!" : ""}</span>
                          <button className="icon-btn !h-7 !w-7" onClick={() => st().setLimit(app, mins + 15)} title="+15 min"><Icon name="plus" size={13} /></button>
                          <button className="icon-btn !h-7 !w-7" onClick={() => st().setLimit(app, Math.max(5, mins - 15))} title="−15 min"><Icon name="minus" size={13} /></button>
                          <button className="icon-btn !h-7 !w-7" onClick={() => st().setLimit(app, 0)} title="Remove limit"><Icon name="trash" size={14} /></button>
                        </div>
                        <div className="limit-bar mt-2">
                          <i style={{ width: `${pct * 100}%`, background: over ? "#e08a6a" : CAT_COLOR[cat], boxShadow: over ? "0 0 10px #e08a6a88" : "none" }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ---------------- quiet hours ---------------- */}
            {tab === "quiet" && (
              <div className="paper mt-4 p-5">
                <div className="label mb-1">Quiet hours</div>
                <div className="mb-3 text-[12.5px] text-dim">During this window (while the shield is up), non-productive apps get a gentle bounce. Great for mornings, deep work, and after dinner.</div>
                <div className="flex flex-wrap items-center gap-3">
                  <button className="btn" data-on={rules.quiet.enabled} onClick={() => st().setRules({ quiet: { ...rules.quiet, enabled: !rules.quiet.enabled } })} role="switch" aria-checked={rules.quiet.enabled}>
                    <Icon name={rules.quiet.enabled ? "moon-star" : "moon"} size={14} /> {rules.quiet.enabled ? "Enabled" : "Disabled"}
                  </button>
                  <label className="flex items-center gap-1.5 text-[13px]">
                    from
                    <input className="input !w-[76px]" type="number" min={0} max={23} value={rules.quiet.from} onChange={(e) => st().setRules({ quiet: { ...rules.quiet, from: Math.max(0, Math.min(23, Number(e.target.value) || 0)) } })} aria-label="Quiet from hour" />
                    :00
                  </label>
                  <label className="flex items-center gap-1.5 text-[13px]">
                    to
                    <input className="input !w-[76px]" type="number" min={0} max={23} value={rules.quiet.to} onChange={(e) => st().setRules({ quiet: { ...rules.quiet, to: Math.max(0, Math.min(23, Number(e.target.value) || 0)) } })} aria-label="Quiet until hour" />
                    :00
                  </label>
                  <div className="flex-1" />
                  <span className="chip !text-[11.5px]" data-on={quietNow}>{quietNow ? "🌙 quiet right now" : "regular hours"}</span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {([["Deep morning", 6, 12], ["Lunch guard", 12, 14], ["After-dinner", 19, 23], ["Night owl", 22, 6]] as [string, number, number][]).map(([label, from, to]) => (
                    <button key={label} className="btn btn-sm" data-on={rules.quiet.from === from && rules.quiet.to === to} onClick={() => st().setRules({ quiet: { ...rules.quiet, enabled: true, from, to } })}>
                      {label} <span className="text-faint">{String(from).padStart(2, "0")}–{String(to).padStart(2, "0")}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-4 grid grid-cols-12 gap-[3px]" aria-hidden>
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="grid h-8 place-items-center rounded-[4px] border text-[9.5px]" style={{ borderColor: inQuiet(h, rules.quiet) ? "#7fc48f66" : "var(--line)", background: inQuiet(h, rules.quiet) ? "color-mix(in srgb, #7fc48f 16%, transparent)" : "transparent", color: inQuiet(h, rules.quiet) ? "#7fc48f" : "var(--faint)" }}>{String(h).padStart(2, "0")}</div>
                  ))}
                </div>
              </div>
            )}

            {/* ---------------- categories ---------------- */}
            {tab === "cats" && (
              <div className="paper mt-4 p-5">
                <div className="label mb-1">Auto-triage patterns</div>
                <div className="mb-3 text-[12.5px] text-dim">Any tracked app containing a keyword is classified automatically — on top of the built-in presets and your manual per-app picks in Activity.</div>
                <div className="flex flex-wrap gap-2">
                  <input className="input !w-[190px]" placeholder="keyword, e.g. docs…" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="Category keyword" />
                  <div className="seg">
                    {CATS.map((c) => (
                      <button key={c.id} data-on={patternCat === c.id} onClick={() => setPatternCat(c.id)} style={patternCat === c.id ? { color: CAT_COLOR[c.id] } : undefined}>
                        <i className="inline-block h-[7px] w-[7px]" style={{ background: CAT_COLOR[c.id] }} /> {c.label}
                      </button>
                    ))}
                  </div>
                  <button className="btn btn-accent" disabled={!pattern.trim()} onClick={() => { st().addPattern(pattern, patternCat); setPattern(""); }}>
                    <Icon name="label" size={13} /> Add rule
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className="text-[11.5px] text-faint self-center mr-1">quick:</span>
                  {([["github", "productive"], ["stackoverflow", "productive"], ["wiki", "productive"], ["twitch", "distraction"], ["reels", "distraction"], ["music", "neutral"]] as [string, AppCat][]).map(([w, c]) => (
                    <button key={w} className="chip !text-[11px] hover:!border-accent" onClick={() => st().addPattern(w, c)}>+{w} → {c}</button>
                  ))}
                </div>
                <div className="mt-4 space-y-1.5">
                  {rules.patterns.length === 0 && <div className="pixel-font rounded-2xl border border-dashed border-line px-4 py-6 text-center text-[13.5px] text-faint">No custom patterns yet — built-in presets still handle the classics.</div>}
                  {rules.patterns.map((p, i) => (
                    <div key={p.id} className="inset flex items-center gap-3 px-3 py-2" style={{ animation: "rise .3s var(--ease-soft) both", animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                      <i className="inline-block h-[9px] w-[9px] flex-none" style={{ background: CAT_COLOR[p.cat] }} />
                      <span className="pixel-font min-w-0 flex-1 truncate text-[14px]">“{p.match}”</span>
                      <span className="text-[12px]" style={{ color: CAT_COLOR[p.cat] }}>{p.cat}</span>
                      <button className="icon-btn !h-7 !w-7" onClick={() => st().removePattern(p.id)} title="Delete rule"><Icon name="trash" size={14} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ---------------- admin pin ---------------- */}
            {tab === "admin" && (
              <div className="paper mt-4 p-5">
                <div className="label mb-1">Admin PIN</div>
                <div className="mb-3 text-[12.5px] text-dim">Optional: lock the rulebook so a quick glance (or a cheeky future-you) can't silently un-block things. The PIN is hashed and stays in this browser.</div>
                <PinAdmin />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function PinAdmin() {
  const rules = useStore((s) => s.rules);
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [err, setErr] = useState("");
  const st = useStore.getState;
  if (rules.pinHash) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="chip !text-[12px]" data-on><Icon name="lock" size={12} /> PIN is set</span>
        <button className="btn btn-sm" style={{ color: "#e0684f" }} onClick={() => void st().setAdminPin(null)}>
          <Icon name="trash" size={12} /> Remove PIN
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input className="input pixel-font !w-[120px] tracking-[0.4em]" type="password" inputMode="numeric" maxLength={8} placeholder="PIN" value={p1} onChange={(e) => setP1(e.target.value)} aria-label="New PIN" />
      <input className="input pixel-font !w-[120px] tracking-[0.4em]" type="password" inputMode="numeric" maxLength={8} placeholder="repeat" value={p2} style={err ? { borderColor: "#e08a6a" } : undefined} onChange={(e) => setP2(e.target.value)} aria-label="Repeat PIN" />
      <button
        className="btn btn-accent"
        disabled={p1.length < 3}
        onClick={() => {
          if (p1 !== p2) {
            setErr("PINs don't match");
            setTimeout(() => setErr(""), 1800);
            return;
          }
          void st().setAdminPin(p1);
          setP1("");
          setP2("");
        }}
      >
        <Icon name="lock" size={13} /> Lock rulebook
      </button>
      {err && <span className="text-[12px]" style={{ color: "#e08a6a" }}>{err}</span>}
    </div>
  );
}
