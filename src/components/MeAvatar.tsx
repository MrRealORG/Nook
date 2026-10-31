/** 1.3.1 — the user's profile picture (or initial) for chat bubbles, title bar, etc. */
import { useStore } from "@/lib/store";

export function MeAvatar({ size = 28, className = "" }: { size?: number; className?: string }) {
  const avatar = useStore((s) => s.profile.avatar);
  const name = useStore((s) => s.profile.displayName);
  return (
    <span className={`me-avatar ${className}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }} title={name || "You"} data-testid="me-avatar">
      {avatar ? <img src={avatar} alt="" /> : <b>{(name.trim()[0] ?? "Y").toUpperCase()}</b>}
    </span>
  );
}
