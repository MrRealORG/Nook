"use client";

import { useStore } from "@/lib/store";

/** Opens a file picker and runs the store's importNotes on the chosen JSON backup. */
export function pickImportFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.style.display = "none";
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void useStore.getState().importNotes(f);
    input.remove();
  };
  document.body.appendChild(input);
  input.click();
}
