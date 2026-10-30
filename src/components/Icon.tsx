
import { memo } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ICONS, type IconName } from "@/components/icons";
import { ICON_PACKS, usePackStore, type IconPackStyle } from "@/lib/packs";
import { LUCIDE } from "@/lib/lucideMap";
import { useIconFamily } from "@/lib/iconStyle";

const ICON_PACK_STYLES: Record<string, IconPackStyle> = Object.fromEntries(ICON_PACKS.map((p) => [p.id, p.style]));

/** deterministic per-icon hash (drives rotate jitter + wobble seeds) */
function nameHash(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function styleSvg(style: IconPackStyle | null, id: string): { props: Record<string, unknown>; extra?: ReactNode } {
  if (!style) return { props: {} };
  const props: Record<string, unknown> = {};
  const inner: ReactNode[] = [];
  if (style.gradient) {
    const gid = style.gradientId ?? `pk-${id}`;
    const [a, b] = style.gradient;
    inner.push(
      <defs key="g">
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          {style.gradientHard ? (
            // origami fold: hard 50/50 two-tone split
            <>
              <stop offset="0" stopColor={a} />
              <stop offset="0.5" stopColor={a} />
              <stop offset="0.5" stopColor={b} />
              <stop offset="1" stopColor={b} />
            </>
          ) : (
            <>
              <stop offset="0" stopColor={a} />
              <stop offset="1" stopColor={b} />
            </>
          )}
        </linearGradient>
      </defs>,
    );
    props.fill = `url(#${gid})`;
  }
  // tile packs fill glyphs with currentColor (the wrapper sets it to tile.fg) so the
  // glyph is "knocked out" in the tile's contrast color instead of default black
  if (style.tile && !style.stroke && !style.gradient && !style.invert) props.fill = "currentColor";
  if (style.invert) {
    props.fill = "var(--panel)";
    props.stroke = "currentColor";
    props.strokeWidth = 1.1;
  }
  if (style.stroke) {
    props.fill = "none";
    props.stroke = "currentColor";
    props.strokeWidth = style.strokeWidth ?? 1.5;
    props.strokeLinecap = "round";
    props.strokeLinejoin = "round";
    if (style.dash) props.strokeDasharray = "2.4 1.8";
  }
  if (style.outline) {
    props.stroke = style.outline;
    props.strokeWidth = style.outlineWidth ?? 1.2;
    props.paintOrder = "stroke";
    props.strokeLinejoin = "round";
  }
  if (style.sticker) {
    props.stroke = "color-mix(in srgb, var(--panel-solid, #fff) 92%, white)";
    props.strokeWidth = 3.2;
    props.paintOrder = "stroke";
    props.strokeLinejoin = "round";
  }
  if (style.sketchWobble) {
    // hand-drawn wobble: per-icon seeded turbulence displacement
    const wid = `pk-wobble-${id}`;
    const seed = nameHash(id) % 97;
    inner.push(
      <defs key="w">
        <filter id={wid} x="-25%" y="-25%" width="150%" height="150%">
          <feTurbulence type="fractalNoise" baseFrequency="0.22" numOctaves="2" seed={seed} result="wobble-n" />
          <feDisplacementMap in="SourceGraphic" in2="wobble-n" scale="1.6" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>,
    );
    props.filter = `url(#${wid})`;
  }
  if (style.crisp !== false && !style.stroke && !style.gradient && !style.invert) props.shapeRendering = "crispEdges";
  return { props, extra: inner.length ? <>{inner}</> : undefined };
}

function cssStyle(style: IconPackStyle | null, name: string, size: number): CSSProperties {
  if (!style) return {};
  const s: CSSProperties = {};
  if (style.opacity != null) s.opacity = style.opacity;
  const jitter = style.rotateJitter ? (nameHash(name) % (style.rotateJitter * 2 + 1)) - style.rotateJitter : 0;
  const rot = (style.rotate ?? 0) + jitter;
  const tf: string[] = [];
  if (rot) tf.push(`rotate(${rot}deg)`);
  if (style.skewX) tf.push(`skewX(${style.skewX}deg)`);
  if (style.scale != null && style.scale !== 1) tf.push(`scale(${style.scale}${style.stretchY != null ? `, ${style.stretchY}` : ""})`);
  if (tf.length) s.transform = tf.join(" ");
  if (style.filter) s.filter = style.filter;
  if (style.glow) s.filter = `${style.filter ?? ""} drop-shadow(0 0 ${(size / 8).toFixed(1)}px color-mix(in srgb, currentColor 55%, transparent))`.trim();
  if (style.shadow) s.filter = `${style.filter ?? ""} drop-shadow(0 ${style.shadowColor ? "2px 2px" : "1.5px 1px"} ${style.shadowColor ?? "rgba(0,0,0,.45)"})`.trim();
  return s;
}

export const Icon = memo(function Icon({ name, size = 16, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  // subscribe so a pack switch repaints every glyph once (both selectors are stable otherwise)
  const customIcons = usePackStore((s) => s.customPacks.find((p) => p.id === s.iconPack)?.icons ?? null);
  const packStyle = usePackStore((s) => (s.iconPack === "pixel" ? null : ICON_PACK_STYLES[s.iconPack] ?? null));
  const defaultPack = usePackStore((s) => s.iconPack === "pixel");
  const family = useIconFamily();
  const url = customIcons?.[name];
  // 1.2: Clean / Obsidian styles draw crisp lucide glyphs unless the user picked an icon pack
  const Crisp = family === "crisp" && defaultPack && !url ? LUCIDE[name] : undefined;
  if (Crisp) {
    return <Crisp size={size} strokeWidth={size <= 14 ? 2 : 1.75} absoluteStrokeWidth={false} className={className} style={{ flex: "none", ...style }} aria-hidden />;
  }
  if (url) {
    return (
      <img
        src={url}
        width={size}
        height={size}
        alt=""
        aria-hidden
        className={className}
        style={{ flex: "none", width: size, height: size, objectFit: "contain", ...style }}
        draggable={false}
      />
    );
  }

  // emoji render path: the pack replaces the SVG with a curated emoji glyph
  const emoji = packStyle?.emoji?.[name];
  if (emoji) {
    return (
      <span
        aria-hidden
        className={className}
        style={{
          flex: "none",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          fontSize: Math.round(size * 0.84),
          lineHeight: 1,
          userSelect: "none",
          ...style,
        }}
      >
        {emoji}
      </span>
    );
  }

  const { props, extra } = styleSvg(packStyle, name);
  const wrapKind: "tile" | "lamp" | "scan" | null = packStyle?.tile ? "tile" : packStyle?.lamp ? "lamp" : packStyle?.scanlines ? "scan" : null;
  const svg = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={wrapKind ? undefined : className} // inside wrappers the className moves up (color must come from the wrapper)
      style={{ flex: "none", ...cssStyle(packStyle, name, size), ...style }}
      {...props}
      aria-hidden
    >
      {extra}
      <path d={ICONS[name]} />
    </svg>
  );

  if (wrapKind === "tile" && packStyle?.tile) {
    const tile = packStyle.tile;
    const pad = Math.max(1, Math.round(size * 0.18));
    const box = size + pad * 2;
    return (
      <span
        aria-hidden
        className={className}
        style={{
          flex: "none",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: box,
          height: box,
          background: tile.bg,
          color: tile.fg,
          borderRadius: tile.radius ?? Math.max(3, Math.round(box * 0.24)),
          ...style,
        }}
      >
        {svg}
      </span>
    );
  }

  if (wrapKind === "lamp" && packStyle?.lamp) {
    const lamp = packStyle.lamp;
    const pad = Math.max(2, Math.round(size * 0.2));
    return (
      <span
        aria-hidden
        className={className}
        style={{
          flex: "none",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: pad,
          borderRadius: "36%",
          background: `radial-gradient(circle at 32% 28%, ${lamp} 0%, color-mix(in srgb, ${lamp} 42%, transparent) 52%, transparent 74%)`,
          ...style,
        }}
      >
        {svg}
      </span>
    );
  }

  if (wrapKind === "scan") {
    return (
      <span aria-hidden className={className} style={{ position: "relative", display: "inline-flex", flex: "none", ...style }}>
        {svg}
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 3,
            pointerEvents: "none",
            background: "repeating-linear-gradient(0deg, rgba(15,2,24,0.34) 0px, rgba(15,2,24,0.34) 1px, transparent 1px, transparent 2.5px)",
          }}
        />
      </span>
    );
  }

  return svg;
});
