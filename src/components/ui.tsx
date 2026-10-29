"use client";

import { useRef, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";

export function Tilt({ children, className = "", max = 7, style, ...rest }: { children: ReactNode; max?: number; className?: string; style?: CSSProperties } & HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className={`tilt ${className}`}
      style={style}
      onPointerMove={(e) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--ry", `${((e.clientX - r.left) / r.width - 0.5) * max}deg`);
        el.style.setProperty("--rx", `${-((e.clientY - r.top) / r.height - 0.5) * max}deg`);
        el.dataset.hot = "true";
      }}
      onPointerLeave={() => {
        const el = ref.current;
        if (!el) return;
        el.style.setProperty("--ry", "0deg");
        el.style.setProperty("--rx", "0deg");
        el.dataset.hot = "false";
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Bar({ value, segments = 10, low = 25 }: { value: number; segments?: number; low?: number }) {
  const on = Math.round((value / 100) * segments);
  return (
    <div className="bar" data-low={value < low}>
      {Array.from({ length: segments }, (_, i) => (
        <i key={i} data-on={i < on} />
      ))}
    </div>
  );
}

export function Empty({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="grid place-items-center gap-2 py-10 text-center text-dim">
      {icon}
      <div className="pixel-font text-[15px] text-ink">{title}</div>
      {hint && <div className="max-w-[220px] text-[12.5px]">{hint}</div>}
    </div>
  );
}
