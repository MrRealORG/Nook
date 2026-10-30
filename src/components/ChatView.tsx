/**
 * AI chat — full-page conversations with your notes. Streaming with a typing indicator,
 * markdown + code blocks with copy, stop & regenerate, saved conversations, a model picker,
 * @note mentions as context, "ask my notes" (RAG over FTS5) and the tool-using agent whose
 * tool calls render as readable cards.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { Markdown } from "@/components/Markdown";
import { PetView } from "@/components/PetView";
import { useStore } from "@/lib/store";
import type { AiResult, AiTool } from "@/lib/types";
import { uid } from "@/lib/util";

type Mode = "chat" | "asknotes" | "agent";
type Msg = { id: string; role: "user" | "assistant"; text: string; mode?: Mode; tools?: AiTool[]; sources?: { id: string; title: string }[]; error?: boolean; cloud?: boolean; mentions?: string[]; at: number };
type ConvMeta = { id: string; title: string; model: string; updatedAt: number; count: number };
type Preset = { id: string; name: string; model: string; baseUrl: string; hasKey: boolean; needsKey: boolean };
type Cfg = { provider: string; baseUrl: string; model: string; usable: boolean; hasKey: boolean; presets: Preset[] };

const MODES: { id: Mode; label: string; icon: IconName; hint: string }[] = [
  { id: "chat", label: "Chat", icon: "message-text", hint: "talk it through — @mention notes for context" },
  { id: "asknotes", label: "Ask my notes", icon: "search", hint: "answers only from your vault, with sources" },
  { id: "agent", label: "Agent", icon: "cpu", hint: "acts for real: notes, tasks, timelens, web" },
];

const MODEL_SUGGESTIONS: Record<string, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  openrouter: ["openai/gpt-4o-mini", "anthropic/claude-3.5-haiku", "google/gemini-flash-1.5", "meta-llama/llama-3.1-8b-instruct"],
  groq: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
  gemini: ["gemini-1.5-flash", "gemini-1.5-pro"],
  ollama: ["llama3.2", "qwen2.5", "mistral"],
  lmstudio: ["local-model"],
};

/** Assistant text: markdown with fenced code blocks that get a copy button. */
export function MessageBody({ text, titles, onLink }: { text: string; titles: Set<string>; onLink: (t: string) => void }) {
  const parts = useMemo(() => {
    const out: { code: boolean; lang: string; body: string }[] = [];
    const re = /```([\w+-]*)\n?([\s\S]*?)(```|$)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ code: false, lang: "", body: text.slice(last, m.index) });
      out.push({ code: true, lang: m[1], body: m[2].replace(/\n$/, "") });
      last = re.lastIndex;
      if (m[0].length === 0) break;
    }
    if (last < text.length) out.push({ code: false, lang: "", body: text.slice(last) });
    return out;
  }, [text]);
  return (
    <div className="chat-md selectable">
      {parts.map((p, i) =>
        p.code ? (
          <CodeBlock key={i} lang={p.lang} code={p.body} />
        ) : (
          <Markdown key={i} source={p.body} titles={titles} onLink={onLink} />
        ),
      )}
    </div>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="chat-code">
      <div className="chat-code-head">
        <span className="tiny-font">{lang || "code"}</span>
        <button
          className="chat-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(code).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          aria-label="Copy code"
        >
          <Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

export function ToolCards({ tools }: { tools: AiTool[] }) {
  return (
    <div className="mt-2 grid gap-1.5" data-testid="tool-cards">
      {tools.map((t, i) => (
        <details key={i} className="tool-card" data-ok={t.ok}>
          <summary>
            <Icon name={t.ok ? "check" : "alert"} size={12} style={{ color: t.ok ? "#7fc48f" : "#e08a6a" }} />
            <b className="pixel-font text-[12.5px]">{t.name.replace(/_/g, " ")}</b>
            <span className="min-w-0 flex-1 truncate text-dim">{t.summary}</span>
            {typeof t.ms === "number" && <span className="tiny-font text-faint">{t.ms}ms</span>}
          </summary>
          <pre className="selectable">{JSON.stringify(t.args ?? {}, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}

export function TypingDots() {
  return (
    <span className="typing-dots" aria-label="typing">
      <i />
      <i />
      <i />
    </span>
  );
}

const persist = (id: string, messages: Msg[], model: string) =>
  fetch(`/api/conversations/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages, model }) }).catch(() => {});

export default function ChatView() {
  const st = useStore.getState;
  const notes = useStore((s) => s.notes);
  const pet = useStore((s) => s.pet);
  const [convs, setConvs] = useState<ConvMeta[]>([]);
  const [convId, setConvId] = useState<string>(() => `chat-${uid(8)}`);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("chat");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [mentions, setMentions] = useState<{ id: string; title: string }[]>([]);
  const [pop, setPop] = useState<{ q: string; sel: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const titles = useMemo(() => new Set(notes.map((n) => n.title.trim().toLowerCase())), [notes]);

  const loadConvs = useCallback(async () => {
    try {
      const r = await (await fetch("/api/conversations")).json();
      setConvs(Array.isArray(r) ? r : []);
    } catch {
      /* ignore */
    }
  }, []);
  const loadCfg = useCallback(async () => {
    try {
      setCfg((await (await fetch("/api/ai-config")).json()) as Cfg);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    void loadConvs();
    void loadCfg();
  }, [loadConvs, loadCfg]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs.length, streaming]);

  const openConv = async (id: string) => {
    if (busy) return;
    const r = await fetch(`/api/conversations/${id}`);
    if (!r.ok) return;
    const c = await r.json();
    setConvId(id);
    setMsgs(Array.isArray(c.messages) ? c.messages : []);
    setMentions([]);
  };
  const newChat = () => {
    if (busy) abortRef.current?.abort();
    setConvId(`chat-${uid(8)}`);
    setMsgs([]);
    setMentions([]);
    setInput("");
    taRef.current?.focus();
  };
  const delConv = async (id: string) => {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (id === convId) newChat();
    void loadConvs();
  };

  const run = async (question: string, history: Msg[], m: Mode, ment: { id: string; title: string }[]) => {
    const userMsg: Msg = { id: uid(), role: "user", text: question, mode: m, mentions: ment.map((x) => x.id), at: Date.now() };
    const base = [...history, userMsg];
    setMsgs(base);
    setBusy(true);
    setStreaming("");
    const ac = new AbortController();
    abortRef.current = ac;
    let res: AiResult | null = null;
    let error = false;
    try {
      const { handleAiRequest } = await import("@/server/aiRoute");
      res = await handleAiRequest(
        {
          action: m === "agent" ? "agent" : m,
          question,
          mentions: ment.map((x) => x.id),
          history: history.filter((x) => !x.error).map((x) => ({ role: x.role, content: x.text })),
          persona: { name: pet.name, species: pet.species },
        },
        (full) => !ac.signal.aborted && setStreaming(full),
        ac.signal,
      );
    } catch {
      error = true;
    }
    const stopped = ac.signal.aborted;
    const text = error ? "Something went wrong talking to the AI." : stopped ? (streamRef.current || res?.text || "") + "\n\n_(stopped)_" : (res?.text ?? "");
    const reply: Msg = { id: uid(), role: "assistant", text, mode: m, tools: res?.tools, sources: res?.sources, cloud: res?.mode === "cloud", error, at: Date.now() };
    const next = [...base, reply];
    setMsgs(next);
    setStreaming("");
    setBusy(false);
    abortRef.current = null;
    if (res?.tools?.length) {
      void st().loadTasks();
      void fetch("/api/notes").then((r) => r.json()).then((n) => Array.isArray(n) && useStore.setState({ notes: n })).catch(() => {});
    }
    await persist(convId, next, cfg?.model ?? "");
    void loadConvs();
  };
  const streamRef = useRef("");
  useEffect(() => {
    streamRef.current = streaming;
  }, [streaming]);

  const send = () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    const ment = mentions.filter((x) => q.includes(`@${x.title}`));
    setMentions([]);
    void run(q, msgs, mode, ment);
  };
  const stop = () => abortRef.current?.abort();
  const regenerate = () => {
    if (busy) return;
    const lastUser = [...msgs].reverse().find((x) => x.role === "user");
    if (!lastUser) return;
    const idx = msgs.lastIndexOf(lastUser);
    const ment = (lastUser.mentions ?? []).map((id) => ({ id, title: notes.find((n) => n.id === id)?.title ?? "" }));
    void run(lastUser.text, msgs.slice(0, idx), lastUser.mode ?? mode, ment);
  };

  // @mention popup
  const popNotes = useMemo(() => {
    if (!pop) return [];
    const q = pop.q.toLowerCase();
    return notes.filter((n) => n.title.toLowerCase().includes(q)).slice(0, 7);
  }, [pop, notes]);
  const onInput = (v: string) => {
    setInput(v);
    const caret = taRef.current?.selectionStart ?? v.length;
    const m = /(^|\s)@([^\s@]{0,40})$/.exec(v.slice(0, caret));
    setPop(m ? { q: m[2], sel: 0 } : null);
  };
  const pickMention = (n: { id: string; title: string }) => {
    const caret = taRef.current?.selectionStart ?? input.length;
    const before = input.slice(0, caret).replace(/@([^\s@]{0,40})$/, `@${n.title} `);
    setInput(before + input.slice(caret));
    setMentions((ms) => (ms.some((x) => x.id === n.id) ? ms : [...ms, n]));
    setPop(null);
    taRef.current?.focus();
  };

  const setModel = async (model: string) => {
    if (!cfg) return;
    const r = await fetch("/api/ai-config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: cfg.provider, baseUrl: cfg.baseUrl, model }) });
    if (r.ok) {
      setCfg((await r.json()) as Cfg);
      st().toast(`Model: ${model}`, "cpu");
    }
  };
  const setupProvider = () => {
    st().setView("settings");
    st().set({ settingsSection: "ai" });
  };

  const offline = !cfg || cfg.provider === "local" || !cfg.usable;
  const preset = cfg?.presets.find((p) => p.id === cfg.provider);
  const models = Array.from(new Set([cfg?.model, preset?.model, ...(MODEL_SUGGESTIONS[cfg?.provider ?? ""] ?? [])].filter((x): x is string => !!x)));
  const lastIsAssistant = msgs.length > 0 && msgs[msgs.length - 1].role === "assistant";
  const openLink = (t: string) => st().openByTitle(t);

  return (
    <div className="flex h-full min-h-0 gap-3" data-testid="chat-view">
      {/* conversations */}
      <aside className="panel hidden w-[230px] shrink-0 flex-col p-2 md:flex">
        <button className="btn btn-accent mb-2 w-full justify-center" onClick={newChat} data-testid="new-chat"><Icon name="plus" size={13} /> New chat</button>
        <div className="label px-1 pb-1">History</div>
        <div className="scroll min-h-0 flex-1" data-testid="conv-list">
          {convs.length === 0 && <div className="px-2 py-3 text-[12px] text-faint">Your chats are saved here.</div>}
          {convs.map((c) => (
            <div key={c.id} className="conv-item group" data-on={c.id === convId}>
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => void openConv(c.id)} title={c.title}>
                <span className="block truncate text-[12.5px]">{c.title}</span>
                <span className="block text-[10.5px] text-faint">{c.count} msgs · {new Date(c.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
              </button>
              <button className="icon-btn !h-6 !w-6 opacity-0 group-hover:opacity-100" title="Delete chat" aria-label="Delete chat" onClick={() => void delConv(c.id)}><Icon name="trash" size={12} /></button>
            </div>
          ))}
        </div>
      </aside>

      {/* thread */}
      <section className="panel flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <PetView species={pet.species} tint={pet.look} hat={pet.hat} mood={busy ? "think" : "idle"} scale={1.4} />
          <div className="min-w-0">
            <div className="pixel-font truncate text-[15px]">{convs.find((c) => c.id === convId)?.title ?? "New chat"}</div>
            <div className="text-[11px] text-faint">{MODES.find((x) => x.id === mode)?.hint}</div>
          </div>
          <span className="flex-1" />
          <div className="seg" role="tablist" aria-label="Chat mode">
            {MODES.map((x) => (
              <button key={x.id} role="tab" aria-selected={mode === x.id} data-on={mode === x.id} onClick={() => setMode(x.id)} title={x.hint}>
                <Icon name={x.icon} size={12} /> {x.label}
              </button>
            ))}
          </div>
          {offline ? (
            <span className="chip !text-[11px]" data-testid="model-offline"><Icon name="cpu" size={11} /> offline brain</span>
          ) : (
            <select className="input !h-8 !w-auto max-w-[220px] !text-[12px]" value={cfg?.model ?? ""} onChange={(e) => void setModel(e.target.value)} aria-label="Model" data-testid="model-picker">
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
        </header>

        {offline && (
          <div className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel2 px-3 py-2 text-[12.5px]" data-testid="provider-banner">
            <Icon name="alert" size={14} className="text-accent" />
            <span className="min-w-0 flex-1">No AI provider is set up — {pet.name} answers from your notes with the offline brain. Add a key for real conversations.</span>
            <button className="btn btn-sm" onClick={setupProvider} data-testid="setup-provider"><Icon name="sliders" size={12} /> Set up provider</button>
          </div>
        )}

        <div className="scroll min-h-0 flex-1 px-4 py-3" data-testid="chat-thread">
          {msgs.length === 0 && !busy && (
            <div className="mx-auto mt-10 max-w-[460px] text-center">
              <PetView species={pet.species} tint={pet.look} hat={pet.hat} mood="happy" scale={3} />
              <div className="pixel-font mt-3 text-[18px]">What's on your mind?</div>
              <div className="mt-1 text-[12.5px] text-dim">Type <b>@</b> to attach a note, switch to <b>Ask my notes</b> to search your vault, or <b>Agent</b> to get things done.</div>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {["Summarize what I wrote this week", "What's in my notes about the pixel garden?", "Plan my day from my open tasks"].map((s) => (
                  <button key={s} className="chip hover:border-[var(--accent)]" onClick={() => { setInput(s); taRef.current?.focus(); }}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={m.id} className={`chat-row ${m.role}`} data-testid={`msg-${m.role}`}>
              {m.role === "user" ? (
                <div className="chat-bubble user selectable">{m.text}</div>
              ) : (
                <div className={`chat-bubble assistant ${m.error ? "error" : ""}`}>
                  <MessageBody text={m.text} titles={titles} onLink={openLink} />
                  {m.tools?.length ? <ToolCards tools={m.tools} /> : null}
                  {m.sources?.length ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {m.sources.map((s) => (
                        <button key={s.id} className="chip !text-[11px] hover:border-[var(--accent)]" onClick={() => { st().openNote(s.id); st().setView("notes"); }}><Icon name="file-text" size={10} /> {s.title}</button>
                      ))}
                    </div>
                  ) : null}
                  <div className="chat-meta">
                    <span>{m.cloud ? "cloud" : "offline"} · {m.mode ?? "chat"}</span>
                    <button onClick={() => void navigator.clipboard?.writeText(m.text).catch(() => {})} title="Copy reply"><Icon name="copy" size={11} /> Copy</button>
                    {i === msgs.length - 1 && !busy && <button onClick={regenerate} data-testid="regenerate" title="Regenerate"><Icon name="refresh" size={11} /> Regenerate</button>}
                    {m.error && <button onClick={setupProvider}><Icon name="sliders" size={11} /> Set up provider</button>}
                  </div>
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="chat-row assistant" data-testid="msg-streaming">
              <div className="chat-bubble assistant">
                {streaming ? <MessageBody text={streaming + " ▍"} titles={titles} onLink={openLink} /> : <TypingDots />}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <footer className="relative border-t border-line p-3">
          {pop && popNotes.length > 0 && (
            <div className="panel panel-solid absolute bottom-[100%] left-3 z-30 mb-1 w-[300px] rounded-xl p-1" data-testid="mention-pop">
              <div className="tiny-font px-2 py-1 text-[10px] text-faint">ATTACH A NOTE</div>
              {popNotes.map((n, k) => (
                <button key={n.id} data-on={k === pop.sel} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-panel2 data-[on=true]:bg-panel2" onMouseDown={(e) => { e.preventDefault(); pickMention(n); }}>
                  <Icon name="file-text" size={12} className="text-accent" /> <span className="truncate">{n.title}</span>
                </button>
              ))}
            </div>
          )}
          {mentions.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {mentions.map((n) => <span key={n.id} className="chip !text-[11px]"><Icon name="link" size={10} /> {n.title}</span>)}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={taRef}
              className="input min-h-[42px] flex-1 resize-none !py-2.5"
              rows={Math.min(6, Math.max(1, input.split("\n").length))}
              placeholder={mode === "asknotes" ? "Ask anything about your notes…" : mode === "agent" ? "Tell the agent what to do…" : "Message… (@ to attach a note, Enter to send)"}
              value={input}
              onChange={(e) => onInput(e.target.value)}
              onKeyDown={(e) => {
                if (pop && popNotes.length) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setPop({ ...pop, sel: (pop.sel + 1) % popNotes.length }); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setPop({ ...pop, sel: (pop.sel - 1 + popNotes.length) % popNotes.length }); return; }
                  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(popNotes[pop.sel]); return; }
                  if (e.key === "Escape") { setPop(null); return; }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              aria-label="Chat message"
              data-testid="chat-input"
            />
            {busy ? (
              <button className="btn" onClick={stop} data-testid="stop"><Icon name="close" size={13} /> Stop</button>
            ) : (
              <button className="btn btn-accent" onClick={send} disabled={!input.trim()} data-testid="send"><Icon name="send" size={13} /> Send</button>
            )}
          </div>
          {!busy && lastIsAssistant && <div className="mt-1 text-[10.5px] text-faint">Shift+Enter for a new line · chats are saved on this PC</div>}
        </footer>
      </section>
    </div>
  );
}
