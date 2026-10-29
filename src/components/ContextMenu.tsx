"use client";

/**
 * Obsidian-style right-click context menus.
 *
 *   openCtx(items, { x, y }, header?)  — open a menu at a viewport position
 *   <ContextMenuHost />                — mount once in App
 *
 * Items support submenus (hover to open), separators, danger items, disabled
 * items, icons and keyboard shortcut hints — matching the reference menu:
 * Add link / Format ▸ / Paragraph ▸ / Insert ▸ / Cut / Copy / Paste / …
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";

export type CtxItem =
  | { sep: true }
  | {
      sep?: false;
      icon?: IconName;
      label: string;
      shortcut?: string;
      sub?: CtxItem[];
      danger?: boolean;
      disabled?: boolean;
      /** custom node rendered between icon and label (e.g. a color dot) */
      lead?: ReactNode;
      run?: () => void;
    };

type OpenReq = { items: CtxItem[]; x: number; y: number; header?: { icon?: IconName; title: string } };

let listeners: ((r: OpenReq | null) => void)[] = [];

export function openCtx(items: CtxItem[], pos?: { x?: number; y?: number }, header?: { icon?: IconName; title: string }) {
  const x = pos?.x ?? 0;
  const y = pos?.y ?? 0;
  listeners.forEach((l) => l({ items, x, y, header }));
}

export function closeCtx() {
  listeners.forEach((l) => l(null));
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

function MenuList({
  items,
  onPick,
  right,
  bottom,
  header,
}: {
  items: CtxItem[];
  onPick: () => void;
  right: number;
  bottom: number;
  header?: { icon?: IconName; title: string };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<{ items: CtxItem[]; x: number; y: number } | null>(null);

  // clamp the menu into the viewport by writing styles directly (no re-render)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let x = right;
    let y = bottom;
    if (x + r.width > window.innerWidth - 8) x = clamp(right - r.width, 8, window.innerWidth - r.width - 8);
    if (y + r.height > window.innerHeight - 8) y = clamp(bottom - r.height, 8, window.innerHeight - r.height - 8);
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, y)}px`;
    el.style.visibility = "visible";
  }, [right, bottom, items]);

  const openSub = (e: React.MouseEvent, it: CtxItem) => {
    if (it.sep || it.disabled || !it.sub?.length) return setSub(null);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setSub({ items: it.sub, x: r.right - 4, y: r.top - 4 });
  };

  return (
    <>
      <div
        ref={ref}
        className="ctx"
        style={{ left: right, top: bottom, visibility: "hidden" }}
        role="menu"
        onContextMenu={(e) => e.preventDefault()}
      >
        {header && (
          <div className="ctx-head">
            {header.icon && <Icon name={header.icon} size={12} />}
            <span className="truncate">{header.title}</span>
          </div>
        )}
        {items.map((it, i) =>
          it.sep ? (
            <div key={`sep${i}`} className="ctx-sep" />
          ) : (
            <button
              key={`${it.label}${i}`}
              className="ctx-item"
              role="menuitem"
              disabled={it.disabled}
              data-danger={it.danger}
              onMouseEnter={(e) => openSub(e, it)}
              onClick={(e) => {
                if (it.disabled) return;
                if (it.sub?.length) {
                  openSub(e as unknown as React.MouseEvent, it);
                  return;
                }
                it.run?.();
                onPick();
              }}
            >
              <span className="ctx-ic">{it.icon ? <Icon name={it.icon} size={14} /> : it.lead}</span>
              <span className="ctx-label">{it.label}</span>
              {it.shortcut && <span className="ctx-key">{it.shortcut}</span>}
              {it.sub?.length ? <span className="ctx-arrow"><Icon name="chevron-right" size={12} /></span> : null}
            </button>
          ),
        )}
      </div>
      {sub && <MenuList items={sub.items} onPick={onPick} right={sub.x} bottom={sub.y} />}
    </>
  );
}

export function ContextMenuHost() {
  const [req, setReq] = useState<OpenReq | null>(null);
  useEffect(() => {
    const l = (r: OpenReq | null) => setReq(r);
    listeners.push(l);
    return () => {
      listeners = listeners.filter((x) => x !== l);
    };
  }, []);
  useEffect(() => {
    if (!req) return;
    const close = (e?: Event) => {
      // ignore pointerdowns inside any open menu (clicks still run their handlers)
      if (e && e.type === "pointerdown") {
        const t = e.target as Element | null;
        if (t && typeof t.closest === "function" && t.closest(".ctx, .ctx-sub")) return;
      }
      setReq(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", close, { capture: true });
    window.addEventListener("keydown", key);
    window.addEventListener("resize", () => close());
    window.addEventListener("blur", () => close());
    return () => {
      window.removeEventListener("pointerdown", close, { capture: true });
      window.removeEventListener("keydown", key);
    };
  }, [req]);
  if (!req) return null;
  return <MenuList key={`${req.x}-${req.y}-${req.items.length}`} items={req.items} right={req.x} bottom={req.y} onPick={() => setReq(null)} header={req.header} />;
}

/** helper: build an onContextMenu handler that opens a menu at the pointer */
export function onCtx(items: CtxItem[] | (() => CtxItem[]), header?: { icon?: IconName; title: string }) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openCtx(typeof items === "function" ? items() : items, { x: e.clientX + 2, y: e.clientY + 2 }, header);
  };
}
