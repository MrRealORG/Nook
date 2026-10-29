"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { Markdown } from "@/components/Markdown";
import { PetView } from "@/components/PetView";
import { performTrick } from "@/lib/petActions";
import { levelOf, TRICKS } from "@/lib/pet";
import { useStore } from "@/lib/store";
import { sfx } from "@/lib/sfx";
import type { AiResult } from "@/lib/types";

const QUICK: { q: string; label: string; icon: IconName }[] = [
  { q: "What should I do next? Check my tasks, notes and time, then tell me.", label: "What's next?", icon: "lightbulb" },
  { q: "Status report: vault stats, open tasks, my pet and today's tracked time.", label: "Status", icon: "gauge" },
  { q: "Research the best ways to stay focused and save me 3 tips as a task list.", label: "Focus tips", icon: "target" },
  { q: "Make a note listing every open task with the TODO marker in my notes, then tell me the top 3.", label: "Sweep TODOs", icon: "tasklist" },
  { q: "Suggest one note idea I should write today based on my vault, and create a stub note for it.", label: "Note idea", icon: "note" },
];

/** tiny speech box that opens when you click the pet anywhere — the harness in miniature */
export function PetQuickChat() {
  const quickChat = useStore((s) => s.quickChat);
  const pet = useStore((s) => s.pet);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<{ text: string; tools?: number; mode?: string } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const seq = useStore((s) => s.aiLog.length);

  useEffect(() => {
    if (quickChat) {
      setReply(null);
      setQ("");
      setTimeout(() => boxRef.current?.querySelector("input")?.focus(), 60);
    }
  }, [quickChat?.kind, quickChat?.x, quickChat?.y]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [busy, reply]);

  useEffect(() => {
    if (!quickChat) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useStore.getState().closeQuickChat();
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) useStore.getState().closeQuickChat();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [quickChat]);

  if (!quickChat) return null;

  const send = async (text?: string) => {
    const msg = (text ?? q).trim();
    if (!msg || busy) return;
    setQ("");
    setBusy(true);
    setReply(null);
    useStore.getState().doAct("think", 24000);
    const pos = seq;
    try {
      const r = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "agent", question: msg, persona: { name: pet.name, species: pet.species } }),
      });
      const res = (await r.json()) as AiResult;
      setReply({ text: res.text, tools: res.tools?.length, mode: res.mode });
      // mirror into the main chat log so history keeps together
      useStore.setState((s) => ({
        aiLog: [
          ...s.aiLog.slice(-30),
          { id: 100000 + pos, role: "user" as const, text: msg, action: "agent", fresh: false },
          { id: 100001 + pos, role: "ai" as const, text: res.text, res, action: "agent", fresh: false },
        ],
      }));
      useStore.getState().applyEffects(res.effects);
      if (res.tools?.length) {
        useStore.getState().questProgress("agent");
        useStore.getState().unlock("tool-user", "Teamwork!", "Your AI companion ran a real tool for you", "sparkles");
      }
      sfx("receive");
      useStore.getState().doAct("happy", 1600);
    } catch {
      setReply({ text: "My wires got tangled — try again?", mode: "local" });
    } finally {
      setBusy(false);
    }
  };

  // anchor: desktop pet bottom-left / den pet panel / rail middle
  const style: React.CSSProperties =
    quickChat.kind === "desktop"
      ? { left: Math.min(Math.max(12, quickChat.x - 130), window.innerWidth - 292), bottom: 62 }
      : quickChat.kind === "rail"
        ? { left: 76, top: Math.min(Math.max(80, quickChat.y - 100), window.innerHeight - 380) }
        : { left: Math.min(Math.max(12, quickChat.x - 150), window.innerWidth - 292), bottom: Math.min(quickChat.y + 20, window.innerHeight - 380) };

  return (
    <div ref={boxRef} className="panel panel-solid pet-chat-pop" style={style} role="dialog" aria-label={`Quick chat with ${pet.name}`}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="grid h-7 w-7 place-items-end overflow-hidden rounded-lg bg-panel2">
          <PetView species={pet.species} tint={pet.look} hat={pet.hat} mood={busy ? "think" : "happy"} scale={0.85} fps={8} style={{ marginBottom: -2 }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="pixel-font truncate text-[13.5px]">{pet.name}</span>
            <span className="tiny-font rounded-md bg-accent px-1 py-px text-[9px] text-accent-ink">L{levelOf(pet.xp).level}</span>
          </div>
          <div className="text-[10px] text-faint">{busy ? "researching…" : "with tools — ask me to DO things"}</div>
        </div>
        <button
          className="icon-btn !h-6 !w-6"
          title="Open the full chat"
          onClick={() => { useStore.setState({ rightOpen: true, rightTab: "ai" }); useStore.getState().closeQuickChat(); }}
        >
          <Icon name="expand" size={12} />
        </button>
        <button className="icon-btn !h-6 !w-6" title={`Pet ${pet.name}`} onClick={() => { void import("@/lib/petActions").then((m) => m.patPet()); }}>
          <Icon name="heart" size={12} />
        </button>
        <button className="icon-btn !h-6 !w-6" onClick={() => useStore.getState().closeQuickChat()} aria-label="Close">
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="max-h-[190px] min-h-[64px] overflow-y-auto px-3 py-2">
        {busy ? (
          <div className="py-1">
            <div className="research-line"><i /></div>
            <div className="pixel-font typing mt-1.5 text-[12px] text-dim">sniffing through your vault</div>
          </div>
        ) : reply ? (
          <div className="space-y-1.5">
            {!!reply.tools && (
              <div className="tool-mini" data-ok="true">
                <Icon name="sparkles" size={11} /> ran {reply.tools} tool{reply.tools > 1 ? "s" : ""} for real
              </div>
            )}
            <div className="text-[12.5px] leading-relaxed [&_.md]:text-[12.5px] [&_.md]:leading-[1.6] [&_.md_li]:my-0.5 [&_b]:text-ink">
              <Markdown source={reply.text} titles={new Set()} onLink={() => useStore.getState().closeQuickChat()} />
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5 pb-0.5 pt-0.5">
            {QUICK.map((x) => (
              <button key={x.label} className="chip" onClick={() => void send(x.q)}>
                <Icon name={x.icon} size={11} className="text-accent" /> {x.label}
              </button>
            ))}
            {pet.tricks?.map((id) => {
              const t = TRICKS.find((x) => x.id === id);
              if (!t) return null;
              return (
                <button key={id} className="chip" title={`Perform: ${t.name}`} onClick={() => performTrick(id)}>
                  <Icon name={t.icon} size={11} className="text-accent" /> {t.name}
                </button>
              );
            })}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex items-center gap-1.5 border-t border-line px-2.5 py-2">
        <input
          className="input !py-1.5 !text-[13px]"
          placeholder={`Ask ${pet.name} to do something…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          aria-label="Message"
        />
        <button className="btn btn-accent btn-sm !w-[32px] !px-0" onClick={() => void send()} disabled={busy || !q.trim()} aria-label="Send">
          <Icon name="send" size={13} />
        </button>
      </div>
    </div>
  );
}
