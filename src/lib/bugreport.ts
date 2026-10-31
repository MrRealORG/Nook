/**
 * 1.3.1 bug-report builder. Pure functions (unit-tested from Playwright):
 *  • `redact()` / `stripSecrets()` — API keys, tokens, passwords, auth headers are removed from
 *    logs, settings and free text. Nothing that looks like a secret is ever put in a report.
 *  • `buildReport()` — markdown title + body (what happened, steps, system info, settings
 *    summary, recent logs).
 *  • `githubIssueUrl()` — https://github.com/MrRealORG/Nook/issues/new?title=…&body=… trimmed so
 *    the whole URL stays under GitHub's practical limit (~8 KB).
 */

export const ISSUES_URL = "https://github.com/MrRealORG/Nook/issues/new";
export const MAX_URL = 7800;

const SECRET_KEY = /(api[-_]?key|apikey|token|secret|passw(or)?d|pass_?hash|auth|cookie|credential|bearer|private[-_]?key|session)/i;

/** patterns of secret VALUES (wherever they appear: logs, notes, error messages) */
const SECRET_VALUE: RegExp[] = [
  /\bsk-(?:or-|proj-|ant-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / OpenRouter / Anthropic
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bhf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, // JWT
  /\b[0-9a-f]{32}\.[A-Za-z0-9]{12,}\b/g, // Zhipu GLM id.secret
  /(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:api[-_]?key|apikey|token|secret|password|passwd|authorization|x-api-key|key)\s*["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi,
  /([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi,
];

export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text;
  for (const s of extraSecrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  for (const re of SECRET_VALUE) out = out.replace(re, (_m, prefix?: string) => (typeof prefix === "string" && prefix && !/^\d+$/.test(prefix) ? `${prefix}[redacted]` : "[redacted]"));
  return out;
}

/** deep copy without secret-looking keys; string values are redacted too */
export function stripSecrets<T>(v: T, depth = 0): T {
  if (depth > 6) return undefined as T;
  if (typeof v === "string") return redact(v) as T;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => stripSecrets(x, depth + 1)) as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) continue;
      if (typeof val === "string" && val.startsWith("data:")) {
        o[k] = `[data url, ${val.length} chars]`;
        continue;
      }
      o[k] = stripSecrets(val, depth + 1);
    }
    return o as T;
  }
  return v;
}

export type SysInfo = { version?: string; os?: string; osVersion?: string; arch?: string; webview?: string; userAgent?: string; [k: string]: unknown };

export type ReportInput = {
  what: string;
  steps?: string;
  includeLogs: boolean;
  sys?: SysInfo;
  settings?: Record<string, unknown>;
  logs?: string;
  crash?: string;
  hasScreenshot?: boolean;
  extraSecrets?: string[];
};

export function buildReport(r: ReportInput): { title: string; body: string } {
  const sec = r.extraSecrets ?? [];
  const what = redact(r.what.trim(), sec);
  const firstLine = what.split("\n")[0].slice(0, 90) || "Bug report";
  const title = `[Bug] ${firstLine}`;
  const parts: string[] = ["### What happened", what || "_(no description)_"];
  if (r.steps?.trim()) parts.push("", "### Steps to reproduce", redact(r.steps.trim(), sec));
  if (r.crash) parts.push("", "### Crash", "```", redact(r.crash, sec).slice(0, 2000), "```");
  if (r.hasScreenshot) parts.push("", "_A screenshot is attached to the saved report (drag it into this issue)._");
  if (r.includeLogs) {
    const s = stripSecrets(r.sys ?? {});
    parts.push(
      "",
      "### System",
      `- Nook: ${s.version ?? "?"}`,
      `- OS: ${[s.os, s.osVersion, s.arch].filter(Boolean).join(" ") || "?"}`,
      `- WebView: ${s.webview ?? "?"}`,
      s.userAgent ? `- UA: ${s.userAgent}` : "",
    );
    if (r.settings) parts.push("", "<details><summary>Settings (secrets stripped)</summary>", "", "```json", JSON.stringify(stripSecrets(r.settings), null, 1), "```", "</details>");
    if (r.logs?.trim()) parts.push("", "<details><summary>Recent logs</summary>", "", "```", redact(r.logs, sec), "```", "</details>");
  }
  return { title, body: parts.filter((x) => x !== "").join("\n").replace(/\n{3,}/g, "\n\n") };
}

/** prefilled GitHub issue URL; the body is cut (from the logs end first) to fit MAX_URL */
export function githubIssueUrl(title: string, body: string, max = MAX_URL): string {
  const make = (b: string) => `${ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}`;
  let url = make(body);
  if (url.length <= max) return url;
  const note = "\n\n…(truncated — the full report with logs was saved/copied from Nook; please attach it)";
  let lo = 0, hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (make(body.slice(0, mid) + note).length <= max) lo = mid;
    else hi = mid - 1;
  }
  url = make(body.slice(0, lo) + note);
  return url;
}

/** a whitelist of non-sensitive settings for the report */
export function settingsSummary(s: Record<string, unknown>): Record<string, unknown> {
  const keys = ["theme", "uiStyle", "iconStyle", "layout", "features", "voiceModel", "railPos", "petEnabled", "appScale", "font", "cleanMode", "muted", "effects", "grain", "onboarded"];
  const o: Record<string, unknown> = {};
  for (const k of keys) if (k in s) o[k] = s[k];
  return stripSecrets(o);
}
