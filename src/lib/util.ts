export function uid(n = 10): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

export function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m || 1}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
}

export type NoteMeta = {
  links: string[];
  tags: string[];
  words: number;
  snippet: string;
  headings: { level: number; text: string; line: number }[];
  tasks: { done: number; total: number };
};

const LINK_RE = /\[\[([^\]\n|#]+?)(?:[#|][^\]\n]*)?\]\]/g;
const TAG_RE = /(?:^|[\s(])#([A-Za-z][\w-]{1,30})\b/g;

export const titleKey = (t: string) => t.trim().toLowerCase();

export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a)
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__|~~|\*|_)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function countWords(s: string): number {
  const m = s.match(/[\p{L}\p{N}'’-]+/gu);
  return m ? m.length : 0;
}

const cache = new Map<string, NoteMeta>();

export function parseNote(content: string): NoteMeta {
  const hit = cache.get(content);
  if (hit) return hit;
  const links: string[] = [];
  for (const m of content.matchAll(LINK_RE)) {
    const t = m[1].trim();
    if (t && !links.some((l) => titleKey(l) === titleKey(t))) links.push(t);
  }
  const tags: string[] = [];
  for (const m of content.matchAll(TAG_RE)) {
    const t = m[1].toLowerCase();
    if (!tags.includes(t)) tags.push(t);
  }
  const headings: NoteMeta["headings"] = [];
  let done = 0;
  let total = 0;
  let inCode = false;
  content.split("\n").forEach((line, i) => {
    if (line.startsWith("```")) inCode = !inCode;
    if (inCode) return;
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) headings.push({ level: h[1].length, text: h[2].trim(), line: i });
    const t = /^\s*[-*+]\s+\[([ xX])\]/.exec(line);
    if (t) {
      total++;
      if (t[1] !== " ") done++;
    }
  });
  const text = plain(content);
  const body = plain(content.replace(/^\s*#{1,6}\s+.*(\n|$)/, ""));
  const meta: NoteMeta = {
    links,
    tags,
    words: countWords(text),
    snippet: (body || text).slice(0, 150),
    headings,
    tasks: { done, total },
  };
  if (cache.size > 600) cache.clear();
  cache.set(content, meta);
  return meta;
}
