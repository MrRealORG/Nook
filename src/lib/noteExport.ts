/** Note export: Markdown (with front matter) / HTML from Rust, PDF via the native print dialog. */
import { flushAll, useStore } from "@/lib/store";
import { saveFile } from "@/lib/platform";

export async function exportNote(id: string, format: "md" | "html"): Promise<boolean> {
  await flushAll();
  const r = await fetch(`/api/notes/${id}/export?format=${format}`);
  if (!r.ok) return false;
  const cd = r.headers.get("content-disposition") ?? "";
  const title = useStore.getState().notes.find((n) => n.id === id)?.title ?? "note";
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? `${title.replace(/[\\/:*?"<>|]/g, "").slice(0, 60) || "note"}.${format}`;
  const ok = await saveFile(decodeURIComponent(name), await r.blob(), format === "md" ? "text/markdown" : "text/html");
  if (ok) useStore.getState().toast(`Exported as ${format === "md" ? "Markdown" : "HTML"}`, "download");
  return ok;
}

/** Print the note's HTML in a hidden frame → "Save as PDF" in the system print dialog. */
export async function printNote(id: string): Promise<void> {
  await flushAll();
  const html = await (await fetch(`/api/notes/${id}/export?format=html`)).text();
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.setAttribute("data-testid", "print-frame");
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      setTimeout(() => frame.remove(), 60_000);
    }
  }, 150);
}
