import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { openExternal } from "@/lib/platform";
import { sfx } from "@/lib/sfx";
import { useStore } from "@/lib/store";

type Preset = { id: string; name: string; baseUrl: string; model: string; needsKey: boolean; keyUrl: string; hasKey: boolean };
type Cfg = { provider: string; baseUrl: string; model: string; temperature: number | null; hasKey: boolean; usable: boolean; presets: Preset[] };

/** Settings → AI: pick any OpenAI-compatible provider. Keys go to the OS keyring via Rust. */
export function AiProviderCard() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [provider, setProvider] = useState("local");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    const r = await fetch("/api/ai-config");
    const j = (await r.json()) as Cfg;
    setCfg(j);
    setProvider(j.provider || "local");
    setBaseUrl(j.baseUrl ?? "");
    setModel(j.model ?? "");
  };
  useEffect(() => {
    void load();
  }, []);

  const preset = cfg?.presets.find((p) => p.id === provider);
  const pick = (id: string) => {
    setProvider(id);
    setTest(null);
    const p = cfg?.presets.find((x) => x.id === id);
    setBaseUrl(p?.baseUrl ?? "");
    setModel(p?.model ?? "");
    setKey("");
  };

  const save = async (clearKey = false) => {
    setBusy(true);
    const body: Record<string, unknown> = { provider, baseUrl, model };
    if (key.trim() || clearKey) body.apiKey = clearKey ? "" : key.trim();
    const r = await fetch("/api/ai-config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) {
      useStore.getState().toast(j.error ?? "Could not save", "close");
      return;
    }
    setKey("");
    setCfg(j as Cfg);
    useStore.getState().toast(provider === "local" ? "Using the offline brain" : `AI provider saved — ${preset?.name ?? provider}`, "sparkles");
    sfx("pop");
  };

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    const r = await fetch("/api/ai-test", { method: "POST" });
    const j = (await r.json()) as { ok: boolean; reply?: string; ms?: number; error?: string };
    setBusy(false);
    setTest(j.ok ? { ok: true, text: `“${j.reply}” in ${j.ms} ms` } : { ok: false, text: j.error ?? "failed" });
    sfx(j.ok ? "win" : "error");
  };

  if (!cfg) return <div className="paper p-5 text-[12px] text-faint">loading AI settings…</div>;
  return (
    <div className="paper p-5" data-testid="ai-provider">
      <div className="mb-1 flex items-center gap-2">
        <Icon name="cpu" size={14} className="text-accent" />
        <span className="label">AI provider</span>
        <span className="chip" data-on={cfg.usable}>{cfg.usable ? `cloud · ${cfg.model}` : "offline brain"}</span>
      </div>
      <div className="mb-3 text-[12px] text-dim">
        Works with no key at all (the offline brain). Add any OpenAI-compatible provider for smarter answers and the full tool-using agent — keys are stored in your OS keychain, never in the vault.
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        <button className="chip" data-on={provider === "local"} onClick={() => pick("local")}>Offline only</button>
        {cfg.presets.map((p) => (
          <button key={p.id} className="chip" data-on={provider === p.id} onClick={() => pick(p.id)} title={p.baseUrl}>
            {p.name} {p.hasKey && <Icon name="lock" size={10} />}
          </button>
        ))}
      </div>
      {provider !== "local" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-[11.5px] text-faint">
            Base URL
            <input className="input mt-1 w-full" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" aria-label="Base URL" />
          </label>
          <label className="text-[11.5px] text-faint">
            Model
            <input className="input mt-1 w-full" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" aria-label="Model" />
          </label>
          <label className="text-[11.5px] text-faint sm:col-span-2">
            API key {preset && !preset.needsKey && "(optional for local servers)"} {preset?.hasKey && "· a key is saved — leave blank to keep it"}
            <input className="input mt-1 w-full" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={preset?.hasKey ? "••••••••" : "sk-…"} aria-label="API key" autoComplete="off" />
          </label>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn btn-sm" onClick={() => void save()} disabled={busy}>
          <Icon name="save" size={12} /> Save
        </button>
        {provider !== "local" && (
          <button className="btn btn-sm" onClick={() => void runTest()} disabled={busy}>
            <Icon name="zap" size={12} /> Test
          </button>
        )}
        {preset?.hasKey && (
          <button className="btn btn-sm" onClick={() => void save(true)} disabled={busy}>
            <Icon name="trash" size={12} /> Forget key
          </button>
        )}
        {preset?.keyUrl && (
          <button className="btn btn-sm ml-auto" onClick={() => void openExternal(preset.keyUrl)}>
            <Icon name="external-link" size={12} /> {preset.needsKey ? "Get a key" : "Download"}
          </button>
        )}
      </div>
      {test && (
        <div className="inset mt-2 px-3 py-2 text-[12px]" style={{ borderColor: test.ok ? "#7fc48f" : "#a5594f" }}>
          {test.ok ? "Connected: " : "Failed: "}
          {test.text}
        </div>
      )}
    </div>
  );
}
