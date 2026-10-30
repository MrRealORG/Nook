import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { attachmentUrl } from "@/lib/apiShim";
import { saveFile } from "@/lib/platform";

/** `<img>` for a note attachment — bytes come from the vault through the API layer. */
export function AttImg({ id, alt }: { id: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void attachmentUrl(id).then((u) => alive && setSrc(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  return src ? <img src={src} alt={alt} loading="lazy" /> : <span className="shimmer block h-full w-full" aria-label={alt} />;
}

/** Thumbnail that opens a full-size lightbox (images) or saves the file (others). */
export function AttLink({ id, name, image, className, title, children }: { id: string; name: string; image: boolean; className: string; title: string; children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const onClick = async (e: MouseEvent) => {
    e.preventDefault();
    if (image) setOpen(await attachmentUrl(id));
    else {
      const r = await fetch(`/api/attachments/${encodeURIComponent(id)}`);
      if (r.ok) await saveFile(name, await r.blob());
    }
  };
  return (
    <>
      <a className={className} href="#" onClick={(e) => void onClick(e)} title={title}>
        {children}
      </a>
      {open &&
        createPortal(
          <div className="att-lightbox" onClick={() => setOpen(null)} role="dialog" aria-label={name}>
            <img src={open} alt={name} />
          </div>,
          document.body,
        )}
    </>
  );
}
