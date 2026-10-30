/** Small UI state for the 1.1 dialogs (kept out of the big store so its persistence stays untouched). */
import { create } from "zustand";

type Ui11 = {
  searchOpen: boolean;
  /** note id whose version history is open */
  versionsFor: string | null;
  templatesOpen: boolean;
  set: (p: Partial<Omit<Ui11, "set">>) => void;
};

export const useUi11 = create<Ui11>((set) => ({ searchOpen: false, versionsFor: null, templatesOpen: false, set: (p) => set(p) }));
