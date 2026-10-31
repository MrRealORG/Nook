/** Feature toggle cards — onboarding "Features" step and Settings ▸ Features. */
import "@/looks.css";
import { Icon } from "@/components/Icon";
import { PixelIcon, hasPixelSprite } from "@/components/PixelIcon";
import { FEATURES, type FeatureDef } from "@/lib/features";
import { useIconFamily } from "@/lib/iconStyle";
import { useStore } from "@/lib/store";

const SPRITE: Partial<Record<string, string>> = {
  tasks: "tasks", journal: "calendar", chat: "chat", graph: "graph", canvas: "canvas", focus: "focus", timelens: "timelens",
  activity: "activity", rules: "rules", reminders: "bell", pet: "den", arcade: "arcade", market: "market", team: "team", widget: "sparkle", backups: "folder",
};
const GROUPS: { id: FeatureDef["group"]; label: string }[] = [
  { id: "core", label: "Notes + thinking" },
  { id: "time", label: "Time + focus" },
  { id: "fun", label: "Fun" },
  { id: "system", label: "System" },
];

export function FeatureGrid({ compact }: { compact?: boolean }) {
  const features = useStore((s) => s.features);
  const family = useIconFamily();
  const off = Object.values(features).filter((v) => v === false).length;
  return (
    <div className={compact ? "feat-grid-wrap feat-compact" : "feat-grid-wrap"} data-testid="feature-grid">
      {GROUPS.map((g) => (
        <div key={g.id} className="feat-group">
          <div className="label feat-group-label">{g.label}</div>
          <div className="feat-grid">
            {FEATURES.filter((f) => f.group === g.id).map((f) => {
              const on = features[f.id] !== false;
              const spr = SPRITE[f.id];
              return (
                <button
                  key={f.id}
                  className="feat-card"
                  data-on={on}
                  role="switch"
                  aria-checked={on}
                  aria-label={f.label}
                  data-testid={`feature-${f.id}`}
                  onClick={() => useStore.getState().setFeature(f.id, !on)}
                >
                  <span className="feat-icon">{family === "pixel" && spr && hasPixelSprite(spr) ? <PixelIcon name={spr} size={24} /> : <Icon name={f.icon} size={18} />}</span>
                  <span className="feat-text">
                    <span className="feat-name">{f.label}</span>
                    <span className="feat-desc">{f.desc}</span>
                  </span>
                  <span className="feat-switch" aria-hidden><i /></span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="feat-foot text-[11.5px] text-faint">
        {off ? `${off} feature${off === 1 ? "" : "s"} off — hidden everywhere and doing no background work. Nothing is deleted.` : "Everything is on. Switch off what you don't need — it disappears and stops all background work."}
      </div>
    </div>
  );
}
