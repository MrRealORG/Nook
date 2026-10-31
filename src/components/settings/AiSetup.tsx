/**
 * 1.3 AI setup — provider cards shared by the onboarding "AI setup" step and Settings ▸ AI.
 * Gemini, GLM (bigmodel.cn or z.ai), Ollama (installed models auto-detected via /api/tags),
 * the other OpenAI-compatible providers, or the offline brain. Every card has a key field,
 * a model picker and "Test connection"; tests run on the draft settings without saving.
 * Keys go straight to the Rust key store (the OS keychain on desktop) — never logged, never
 * echoed back (the API only reports whether a key is stored).
 */
import { useEffect, useState } from "react";
import "@/looks.css";
import { Icon } from "@/components/Icon";
import { openExternal } from "@/lib/platform";
import { sfx } from "@/lib/sfx";
import { useStore } from "@/lib/store";

type Preset = { id: string; name: string; baseUrl: string; model: string; needsKey: boolean; keyUrl: string; hasKey: boolean; models: string[] };
type Cfg = { provider: string; baseUrl: string; model: string; hasKey: boolean; usable: boolean; presets: Preset[] };
type CardId = "gemini" | "glm" | "ollama" | "other";

/** 1.3.1: every request is bounded (AbortController) so a hung backend / Ollama / provider can
 *  never leave the onboarding or Settings stuck on a spinner. */
async function timedFetch(url: string, init: RequestInit = {}, ms = 4000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    // race as well as abort: the desktop API shim routes /api/* through IPC, which ignores signals
    return await Promise.race([
      fetch(url, { ...init, signal: ac.signal }),
      new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error("aborted")))),
    ]);
  } catch (e) {
    if (ac.signal.aborted) throw new Error(`timed out after ${Math.round(ms / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const post = async <T,>(url: string, body: unknown, method = "POST", ms = 4000): Promise<T> => {
  const r = await timedFetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, ms);
  return (await r.json()) as T;
};

const CARDS: { id: CardId; name: string; blurb: string; badge: string; logo: string }[] = [
  { id: "gemini", name: "Google Gemini", blurb: "Free tier — gemini-2.0-flash, gemini-1.5-flash. Get a key in AI Studio.", badge: "free key", logo: "✦" },
  { id: "glm", name: "GLM / Zhipu", blurb: "glm-4-flash is free. bigmodel.cn or the international z.ai endpoint.", badge: "free model", logo: "智" },
  { id: "ollama", name: "Ollama", blurb: "Runs on your machine — private, offline, no key. Models auto-detected.", badge: "local", logo: "🦙" },
  { id: "other", name: "More providers", blurb: "OpenRouter, OpenAI, Groq, LM Studio or any OpenAI-compatible URL.", badge: "keys", logo: "⋯" },
];
const OTHER = ["openrouter", "openai", "groq", "lmstudio", "custom"];

function providerOfCard(card: CardId, glmHost: "glm" | "zai", other: string) {
  return card === "glm" ? glmHost : card === "other" ? other : card;
}

export function AiSetup({ compact, onSaved }: { compact?: boolean; onSaved?: (provider: string) => void }) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [open, setOpen] = useState<CardId | "offline" | null>(null);
  const [glmHost, setGlmHost] = useState<"glm" | "zai">("glm");
  const [other, setOther] = useState("openrouter");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "test" | "models" | "save">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void timedFetch("/api/ai-config")
      .then((r) => r.json())
      .then((j: Cfg) => {
        setCfg(j);
        const p = j.provider;
        if (p === "local" || !p) setOpen(compact ? null : "offline");
        else if (p === "glm" || p === "zai") {
          setGlmHost(p);
          setOpen("glm");
        } else if (p === "gemini" || p === "ollama") setOpen(p);
        else {
          setOther(p);
          setOpen("other");
        }
      })
      .catch(() => setCfg({ provider: "local", baseUrl: "", model: "", hasKey: false, usable: false, presets: [] }));
  }, [compact]);

  const provider = open && open !== "offline" ? providerOfCard(open, glmHost, other) : "local";
  const preset = cfg?.presets.find((p) => p.id === provider);

  // when the selected provider changes: reset the draft to the preset (or the saved config)
  useEffect(() => {
    if (!cfg || !open || open === "offline") return;
    const saved = cfg.provider === provider;
    setBaseUrl(saved && cfg.baseUrl ? cfg.baseUrl : (preset?.baseUrl ?? ""));
    setModel(saved && cfg.model ? cfg.model : (preset?.model ?? ""));
    setModels(preset?.models ?? []);
    setKey("");
    setMsg(null);
    if (provider === "ollama") void findModels(saved && cfg.baseUrl ? cfg.baseUrl : preset?.baseUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, cfg]);

  const draft = (url?: string) => ({ provider, baseUrl: url ?? baseUrl, model, ...(key.trim() ? { apiKey: key.trim() } : {}) });

  async function findModels(url?: string) {
    setBusy("models");
    try {
      const r = await post<{ ok: boolean; models: string[]; error?: string }>("/api/ai-models", draft(url));
      if (r.ok && r.models.length) {
        setModels(r.models);
        if (provider === "ollama" && !r.models.includes(model)) setModel(r.models[0]);
        setMsg(provider === "ollama" ? { ok: true, text: `Found ${r.models.length} installed model${r.models.length === 1 ? "" : "s"}` } : null);
      } else if (r.ok) setMsg({ ok: false, text: provider === "ollama" ? "Ollama is running but has no models yet — pull one below." : "No models listed." });
      else setMsg({ ok: false, text: r.error ?? "Could not list models" });
    } catch (e) {
      setMsg({ ok: false, text: provider === "ollama" ? `Ollama didn't answer (${(e as Error).message ?? e}) — is it running?` : `Could not list models (${(e as Error).message ?? e})` });
    }
    setBusy("");
  }

  async function test() {
    setBusy("test");
    setMsg(null);
    try {
      const r = await post<{ ok: boolean; reply?: string; ms?: number; error?: string }>("/api/ai-test", draft(), "POST", 20000);
      setMsg(r.ok ? { ok: true, text: `Connected — “${r.reply}” in ${r.ms} ms` } : { ok: false, text: r.error ?? "failed" });
      sfx(r.ok ? "win" : "error");
    } catch (e) {
      setMsg({ ok: false, text: `Test failed: ${(e as Error).message ?? e}` });
      sfx("error");
    }
    setBusy("");
  }

  async function use() {
    setBusy("save");
    try {
      const body = provider === "local" ? { provider: "local" } : draft();
      const r = await timedFetch("/api/ai-config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 6000);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not save");
      setCfg(j as Cfg);
      setKey("");
      useStore.getState().toast(provider === "local" ? "Using the offline brain" : `AI ready — ${preset?.name ?? provider} · ${model}`, "sparkles");
      sfx("pop");
      onSaved?.(provider);
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message ?? e) });
    }
    setBusy("");
  }

  if (!cfg) return <div className="ai-setup text-[12px] text-faint">loading AI providers…</div>;
  const savedHere = (p: string) => cfg.provider === p && (p === "local" || cfg.usable);
  return (
    <div className={compact ? "ai-setup ai-setup-compact" : "ai-setup"} data-testid="ai-setup">
      <div className="ai-cards">
        {CARDS.map((c) => {
          const pid = providerOfCard(c.id, glmHost, other);
          return (
            <button key={c.id} className="ai-card" data-on={open === c.id} data-testid={`ai-card-${c.id}`} onClick={() => setOpen(open === c.id && !compact ? null : c.id)} aria-expanded={open === c.id}>
              <span className="ai-card-logo" data-p={c.id}>{c.logo}</span>
              <span className="min-w-0 flex-1 text-left">
                <span className="ai-card-name">{c.name} {savedHere(pid) && <Icon name="check" size={12} className="text-accent" />}</span>
                <span className="ai-card-blurb">{c.blurb}</span>
              </span>
              <span className="ai-card-badge">{c.badge}</span>
            </button>
          );
        })}
        <button className="ai-card" data-on={open === "offline"} data-testid="ai-offline" onClick={() => setOpen("offline")}>
          <span className="ai-card-logo" data-p="offline">☁︎</span>
          <span className="min-w-0 flex-1 text-left">
            <span className="ai-card-name">Skip — use the offline brain {savedHere("local") && <Icon name="check" size={12} className="text-accent" />}</span>
            <span className="ai-card-blurb">Search, summaries and the pet's chat work with no account. Add a model anytime in Settings ▸ AI.</span>
          </span>
        </button>
      </div>

      {open && open !== "offline" && (
        <div className="ai-form" data-testid={`ai-form-${open}`}>
          {open === "glm" && (
            <div className="seg mb-2" role="radiogroup" aria-label="GLM endpoint">
              <button data-on={glmHost === "glm"} onClick={() => setGlmHost("glm")} data-testid="glm-host-bigmodel">open.bigmodel.cn</button>
              <button data-on={glmHost === "zai"} onClick={() => setGlmHost("zai")} data-testid="glm-host-zai">api.z.ai</button>
            </div>
          )}
          {open === "other" && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {OTHER.map((id) => (
                <button key={id} className="chip" data-on={other === id} onClick={() => setOther(id)}>
                  {cfg.presets.find((p) => p.id === id)?.name ?? id}
                </button>
              ))}
            </div>
          )}
          <div className="ai-grid">
            {(preset?.needsKey || open === "other") && (
              <label className="ai-field ai-span">
                <span>API key {preset?.hasKey && <em>· a key is saved — leave blank to keep it</em>}</span>
                <input className="input" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={preset?.hasKey ? "••••••••" : open === "gemini" ? "AIza…" : "paste your key"} aria-label="API key" data-testid={`ai-key-${open}`} />
              </label>
            )}
            <label className="ai-field">
              <span>Model</span>
              <span className="flex gap-1.5">
                {models.length ? (
                  <select className="input" value={models.includes(model) ? model : ""} onChange={(e) => setModel(e.target.value)} aria-label="Model" data-testid={`ai-model-${open}`}>
                    {!models.includes(model) && <option value="">{model || "pick a model"}</option>}
                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" aria-label="Model" data-testid={`ai-model-${open}`} />
                )}
                <button className="btn btn-sm !h-8" onClick={() => void findModels()} disabled={busy !== ""} title={open === "ollama" ? "Detect installed models" : "List the provider's models"} data-testid={`ai-models-${open}`}>
                  <Icon name="reload" size={12} />
                </button>
              </span>
            </label>
            <label className="ai-field">
              <span>Endpoint</span>
              <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" aria-label="Base URL" />
            </label>
          </div>
          {open === "ollama" && (
            <div className="ai-hint">
              <Icon name="terminal" size={12} /> No models? Run <code>ollama pull llama3.2</code> (or <code>qwen2.5:3b</code>) in a terminal, then press <Icon name="reload" size={10} />.
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button className="btn btn-sm" onClick={() => void test()} disabled={busy !== ""} data-testid={`ai-test-${open}`}>
              <Icon name="zap" size={12} /> {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            <button className="btn btn-sm btn-accent" onClick={() => void use()} disabled={busy !== ""} data-testid={`ai-use-${open}`}>
              <Icon name="check" size={12} /> Use this
            </button>
            {preset?.keyUrl && (
              <button className="btn btn-sm ml-auto" onClick={() => void openExternal(preset.keyUrl)}>
                <Icon name="external-link" size={12} /> {preset.needsKey ? "Get a key" : "Download"}
              </button>
            )}
          </div>
          {msg && (
            <div className="ai-msg" data-ok={msg.ok} data-testid={`ai-result-${open}`} role="status">
              {msg.ok ? "✓ " : "✕ "}
              {msg.text}
            </div>
          )}
        </div>
      )}
      {open === "offline" && !savedHere("local") && (
        <div className="ai-form">
          <button className="btn btn-sm" onClick={() => void use()} data-testid="ai-use-offline">
            <Icon name="check" size={12} /> Use the offline brain
          </button>
        </div>
      )}
    </div>
  );
}
