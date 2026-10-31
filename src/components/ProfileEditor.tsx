/**
 * 1.3.1 profile: picture (upload + circular crop with drag/zoom, or a preset Mochi avatar), name
 * and an optional dashboard banner. Used by the onboarding's first step and Settings ▸ Profile.
 * Everything is stored locally (prefs): the avatar is downscaled to 256 px WebP, the banner to
 * ≤ 1600 px wide WebP.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { SPECIES_PALETTES } from "@/components/PetView";
import { drawPet, makePalette, SH, SW, type Species } from "@/lib/sprite";
import { useStore } from "@/lib/store";

export const AVATAR_PX = 256;
export const BANNER_MAX_W = 1600;

const PRESETS: { id: string; species: Species; bg: string; label: string }[] = [
  { id: "mochi", species: "cat", bg: "#b9a7ff", label: "Mochi" },
  { id: "bun", species: "bunny", bg: "#ffc6d9", label: "Bun" },
  { id: "kit", species: "fox", bg: "#ffd59e", label: "Kit" },
  { id: "bao", species: "panda", bg: "#bfe8d4", label: "Bao" },
  { id: "hop", species: "frog", bg: "#c9ecff", label: "Hop" },
  { id: "boo", species: "ghost", bg: "#e4dcff", label: "Boo" },
];

function toWebp(cv: HTMLCanvasElement, q = 0.86): string {
  const webp = cv.toDataURL("image/webp", q);
  return webp.startsWith("data:image/webp") ? webp : cv.toDataURL("image/png");
}

/** a preset avatar: the pixel pet, upscaled nearest-neighbour onto a soft circle */
export function presetAvatar(species: Species, bg: string): string {
  const sprite = document.createElement("canvas");
  sprite.width = SW;
  sprite.height = SH;
  const sctx = sprite.getContext("2d")!;
  const sp = SPECIES_PALETTES[species];
  const pal = makePalette(sp?.ramp ?? ["#141018", "#3d3550", "#7a6f96", "#c4bce0", "#f7f4ff"], sp?.accent ?? "#a58cff");
  drawPet(sctx, species, { mood: "happy", t: 0.35, facing: 1 }, pal, "none");
  const cv = document.createElement("canvas");
  cv.width = cv.height = AVATAR_PX;
  const g = cv.getContext("2d")!;
  g.fillStyle = bg;
  g.beginPath();
  g.arc(AVATAR_PX / 2, AVATAR_PX / 2, AVATAR_PX / 2, 0, Math.PI * 2);
  g.fill();
  g.imageSmoothingEnabled = false;
  const s = 5;
  g.drawImage(sprite, Math.round((AVATAR_PX - SW * s) / 2), Math.round((AVATAR_PX - SH * s) / 2 + 14), SW * s, SH * s);
  return toWebp(cv);
}

async function loadImage(f: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("That file isn't an image Nook can read"));
    img.src = url;
  });
  return img;
}

/** downscale a banner image to ≤ 1600 px wide WebP */
export async function bannerFromFile(f: Blob): Promise<string> {
  const img = await loadImage(f);
  const s = Math.min(1, BANNER_MAX_W / img.naturalWidth);
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(img.naturalWidth * s));
  cv.height = Math.max(1, Math.round(img.naturalHeight * s));
  const g = cv.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, cv.width, cv.height);
  URL.revokeObjectURL(img.src);
  return toWebp(cv, 0.8);
}

/** circular crop with drag + zoom → 256 px WebP */
function Cropper({ img, onDone, onCancel }: { img: HTMLImageElement; onDone: (dataUrl: string) => void; onCancel: () => void }) {
  const VIEW = 220;
  const base = useMemo(() => VIEW / Math.min(img.naturalWidth, img.naturalHeight), [img]);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const scale = base * zoom;
  const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
  // keep the circle covered
  const clamp = (o: { x: number; y: number }) => ({ x: Math.min((w - VIEW) / 2, Math.max(-(w - VIEW) / 2, o.x)), y: Math.min((h - VIEW) / 2, Math.max(-(h - VIEW) / 2, o.y)) });
  useEffect(() => setOff((o) => clamp(o)), [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  const done = () => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = AVATAR_PX;
    const g = cv.getContext("2d")!;
    g.beginPath();
    g.arc(AVATAR_PX / 2, AVATAR_PX / 2, AVATAR_PX / 2, 0, Math.PI * 2);
    g.clip();
    g.imageSmoothingQuality = "high";
    const k = AVATAR_PX / VIEW;
    const left = (VIEW - w) / 2 + off.x, top = (VIEW - h) / 2 + off.y;
    g.drawImage(img, left * k, top * k, w * k, h * k);
    onDone(toWebp(cv));
  };

  return (
    <div className="pf-crop" data-testid="avatar-cropper">
      <div
        className="pf-crop-view"
        style={{ width: VIEW, height: VIEW }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
        }}
        onPointerMove={(e) => drag.current && setOff(clamp({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y }))}
        onPointerUp={() => (drag.current = null)}
        onWheel={(e) => setZoom((z) => Math.min(4, Math.max(1, z - e.deltaY * 0.0015)))}
      >
        <img src={img.src} alt="" draggable={false} style={{ width: w, height: h, transform: `translate(${(VIEW - w) / 2 + off.x}px, ${(VIEW - h) / 2 + off.y}px)` }} />
        <div className="pf-crop-mask" />
      </div>
      <label className="pf-zoom">
        <Icon name="search" size={12} />
        <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" data-testid="avatar-zoom" />
      </label>
      <div className="flex gap-2">
        <button className="btn btn-sm btn-primary" onClick={done} data-testid="avatar-crop-done">Use photo</button>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function ProfileEditor({ compact = false, onAvatar, showBanner = true }: { compact?: boolean; onAvatar?: () => void; showBanner?: boolean }) {
  const profile = useStore((s) => s.profile);
  const [crop, setCrop] = useState<HTMLImageElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);
  const presets = useMemo(() => PRESETS.map((p) => ({ ...p, url: presetAvatar(p.species, p.bg) })), []);
  const patch = (p: Partial<typeof profile>) => useStore.getState().patchProfile(p as never);

  const pick = async (f: File) => {
    setErr(null);
    try {
      setCrop(await loadImage(f));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const pickBanner = async (f: File) => {
    setErr(null);
    try {
      patch({ banner: await bannerFromFile(f) } as never);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="pf" data-compact={compact} data-testid="profile-editor">
      <div className="pf-row">
        <div className="pf-avatar" data-testid="profile-avatar">
          {profile.avatar ? <img src={profile.avatar} alt="Your profile picture" /> : <Icon name="user" size={34} />}
        </div>
        <div className="pf-fields">
          <label className="ob-field !mb-2 !max-w-none">
            <span>Your name</span>
            <input className="input" value={profile.displayName} maxLength={32} placeholder="What should Mochi call you?" onChange={(e) => patch({ displayName: e.target.value })} data-testid="profile-name" data-autofocus />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-sm" onClick={() => fileRef.current?.click()} data-testid="profile-upload"><Icon name="upload" size={12} /> Upload photo</button>
            {profile.avatar && <button className="btn btn-sm" onClick={() => patch({ avatar: "" })}><Icon name="trash" size={12} /> Remove</button>}
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pick(f); }} data-testid="profile-file" />
        </div>
      </div>
      {crop && (
        <Cropper
          img={crop}
          onCancel={() => setCrop(null)}
          onDone={(url) => {
            patch({ avatar: url });
            URL.revokeObjectURL(crop.src);
            setCrop(null);
            onAvatar?.();
          }}
        />
      )}
      {!crop && (
        <>
          <div className="pf-label">…or pick a Mochi</div>
          <div className="pf-presets" role="radiogroup" aria-label="Preset avatars">
            {presets.map((p) => (
              <button key={p.id} role="radio" aria-checked={profile.avatar === p.url} className="pf-preset" title={p.label} onClick={() => { patch({ avatar: p.url }); onAvatar?.(); }} data-testid={`avatar-preset-${p.id}`}>
                <img src={p.url} alt={p.label} />
              </button>
            ))}
          </div>
        </>
      )}
      {showBanner && (
        <div className="pf-banner-row">
          <div className="pf-label">Dashboard banner (optional)</div>
          <div className="pf-banner" style={(profile as { banner?: string }).banner ? { backgroundImage: `url(${(profile as { banner?: string }).banner})` } : undefined} data-testid="profile-banner">
            {!(profile as { banner?: string }).banner && <span className="text-[11.5px] text-faint">No banner</span>}
          </div>
          <div className="flex gap-2">
            <button className="btn btn-sm" onClick={() => bannerRef.current?.click()} data-testid="banner-upload"><Icon name="image" size={12} /> {(profile as { banner?: string }).banner ? "Change" : "Pick image"}</button>
            {(profile as { banner?: string }).banner && <button className="btn btn-sm" onClick={() => patch({ banner: "" } as never)}><Icon name="trash" size={12} /> Remove</button>}
          </div>
          <input ref={bannerRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pickBanner(f); }} data-testid="banner-file" />
        </div>
      )}
      {err && <div className="mt-1 text-[11.5px]" style={{ color: "#e0684f" }}>{err}</div>}
    </div>
  );
}
