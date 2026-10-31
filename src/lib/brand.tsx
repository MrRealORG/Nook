/**
 * 1.3 app icon (glassy squircle, kitten over a cloud). The dark master is the exe / taskbar /
 * installer / tray icon; inside the app the light or dark copy follows the current theme.
 * Only small web copies ship (128 / 256 px webp, 32 px favicons) — never the 1024 px masters.
 */
import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { THEMES } from "@/lib/themes";

import { brandSrc, type BrandTone } from "@/lib/brandSrc";
export { brandSrc, type BrandTone };

/** the brand tone for the current theme (Obsidian light counts as light) */
export function useBrandTone(): BrandTone {
  return useStore((s) => {
    if (s.uiStyle === "obsidian") return s.obsLight ? "light" : "dark";
    return THEMES[s.theme]?.dark === false ? "light" : "dark";
  });
}

/** the app icon at any CSS size; a 2× source keeps it sharp on HiDPI */
export function BrandIcon({ size = 32, className, testId }: { size?: number; className?: string; testId?: string }) {
  const tone = useBrandTone();
  return <img src={brandSrc(tone, size > 64 ? 256 : 128)} alt="" aria-hidden width={size} height={size} className={className} data-testid={testId} data-tone={tone} draggable={false} style={{ width: size, height: size }} />;
}

/** keeps the favicon in step with the theme (mounted once, in the main app) */
export function useBrandFavicon() {
  const tone = useBrandTone();
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-brand]');
    if (link) link.href = `/brand/favicon-${tone}-32.png`;
  }, [tone]);
}
