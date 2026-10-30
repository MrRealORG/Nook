/** Small UI state for the 1.1 dialogs (kept out of the big store so its persistence stays untouched). */
import { create } from "zustand";

type Ui11 = {
  searchOpen: boolean;
  /** note id whose version history is open */
  versionsFor: string | null;
  templatesOpen: boolean;
  /** pending hand-off into the AI chat view ("ask my notes" from the editor) */
  chatSeed: { mode: "asknotes" | "chat"; text: string; noteId?: string; send?: boolean } | null;
  set: (p: Partial<Omit<Ui11, "set">>) => void;
};

export const useUi11 = create<Ui11>((set) => ({ searchOpen: false, versionsFor: null, templatesOpen: false, chatSeed: null, set: (p) => set(p) }));

/** Open the AI chat in "ask my notes" mode. With a selection the question is prefilled and sent. */
export function askMyNotes(opts: { selection?: string; noteId?: string; noteTitle?: string }, setView: (v: "chat") => void) {
  const sel = (opts.selection ?? "").trim().slice(0, 500);
  const text = sel ? `What do my notes say about: "${sel}"?` : "";
  useUi11.getState().set({ chatSeed: { mode: "asknotes", text, noteId: opts.noteId, send: !!sel } });
  setView("chat");
}
