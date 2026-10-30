
import { memo, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { titleKey } from "@/lib/util";

type Ctx = {
  titles: Set<string>;
  onLink: (title: string) => void;
  onTag?: (tag: string) => void;
  onToggle?: (line: number) => void;
  /** click a [@Task](task:id) / [@Note](note:id) mention chip */
  onMention?: (kind: "task" | "note", id: string) => void;
  /** Obsidian-style live table editing: replace `lineCount` lines at `startLine` with the new markdown rows */
  onTableEdit?: (startLine: number, lineCount: number, rows: string[][]) => void;
};

const INLINE =
  /(\[\[[^\]\n]+\]\])|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\s][^*\n]*\*)|(!\[[^\]\n]*\]\([^)\n]+\))|(\[[^\]\n]+\]\([^)\n]+\))|((?<=^|\s|\()#[A-Za-z][\w-]{1,30})|((?<=^|\s|\()@[A-Za-z][\w .-]{0,28}[\w])|(https?:\/\/[^\s<)]+)/g;

const safe = (u: string) => /^(https?:|mailto:|\/|#|task:|note:)/i.test(u.trim());

function inline(text: string, ctx: Ctx, kp = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const s = m[0];
    const key = `${kp}${k++}`;
    if (m[1]) {
      const [t, alias] = s.slice(2, -2).split("|");
      const target = t.split("#")[0].trim();
      const ghost = !ctx.titles.has(titleKey(target));
      out.push(
        <span key={key} className="wl" data-ghost={ghost} title={ghost ? "Create this note" : "Open note"} onClick={() => ctx.onLink(target)}>
          {(alias ?? t).trim()}
        </span>,
      );
    } else if (m[2]) out.push(<code key={key}>{s.slice(1, -1)}</code>);
    else if (m[3]) out.push(<strong key={key}>{inline(s.slice(2, -2), ctx, key + "b")}</strong>);
    else if (m[4]) out.push(<del key={key}>{inline(s.slice(2, -2), ctx, key + "d")}</del>);
    else if (m[5]) out.push(<em key={key}>{inline(s.slice(1, -1), ctx, key + "i")}</em>);
    else if (m[6]) {
      const mm = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(s);
      if (mm && safe(mm[2])) out.push(<img key={key} src={mm[2]} alt={mm[1]} loading="lazy" decoding="async" />);
    } else if (m[7]) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(s);
      if (mm && safe(mm[2])) {
        const mention = /^(task|note):(.+)$/.exec(mm[2]);
        if (mention) {
          const kind = mention[1] as "task" | "note";
          const label = mm[1].replace(/^@\s*/, "");
          out.push(
            <span key={key} className="mention-chip" title={kind === "task" ? "Open this task" : "Open this note"} onClick={() => ctx.onMention?.(kind, mention[2])}>
              <Icon name={kind === "task" ? "checkbox-on" : "note"} size={10} />
              {kind === "task" ? <i className="mention-at">@</i> : null}
              <span className="truncate">{label}</span>
            </span>,
          );
        } else out.push(<a key={key} href={mm[2]} target="_blank" rel="noreferrer noopener">{mm[1]}</a>);
      } else if (mm) out.push(mm[1]);
    } else if (m[8]) {
      out.push(<span key={key} className="tg" onClick={() => ctx.onTag?.(s.slice(1).toLowerCase())}>{s}</span>);
    } else if (m[9]) {
      // a bare @Name person mention — rendered as a soft chip
      out.push(
        <span key={key} className="mention-chip person" title="Mention">
          <Icon name="user" size={10} />
          <span>{s.slice(1)}</span>
        </span>,
      );
    } else if (m[10]) out.push(<a key={key} href={s} target="_blank" rel="noreferrer noopener">{s}</a>);
    last = idx + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Item = { indent: number; ordered: boolean; text: string; line: number; task: null | boolean };
const LIST = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const isBlockStart = (l: string) => /^(#{1,6}\s|```|>\s?|(-{3,}|\*{3,}|_{3,})\s*$)/.test(l) || LIST.test(l);

function renderList(items: Item[], ctx: Ctx, kp: string): ReactNode {
  const build = (from: number, indent: number): [ReactNode, number] => {
    const ordered = items[from].ordered;
    const kids: ReactNode[] = [];
    let i = from;
    while (i < items.length && items[i].indent === indent) {
      const it = items[i++];
      let nested: ReactNode = null;
      if (i < items.length && items[i].indent > indent) {
        const [n, ni] = build(i, items[i].indent);
        nested = n;
        i = ni;
      }
      if (it.task !== null) {
        kids.push(
          <li key={`${kp}${i}`} className={`task${it.task ? " done" : ""}`}>
            <div className="trow">
              <button type="button" className="cb" data-on={it.task} onClick={() => ctx.onToggle?.(it.line)} aria-label="toggle task">
                {it.task && <Icon name="check" size={12} />}
              </button>
              <span>{inline(it.text, ctx, `${kp}${i}t`)}</span>
            </div>
            {nested}
          </li>,
        );
      } else {
        kids.push(<li key={`${kp}${i}`}>{inline(it.text, ctx, `${kp}${i}t`)}{nested}</li>);
      }
    }
    const Tag = ordered ? "ol" : "ul";
    return [<Tag key={`${kp}L${from}`}>{kids}</Tag>, i];
  };
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const [n, ni] = build(i, items[i].indent);
    nodes.push(n);
    i = ni > i ? ni : i + 1;
  }
  return <>{nodes}</>;
}

function blocks(src: string, ctx: Ctx, base = 0, kp = ""): ReactNode[] {
  const lines = src.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `${kp}b${k++}`;
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(<pre key={key}><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = (`h${Math.min(h[1].length, 3)}`) as "h1" | "h2" | "h3";
      out.push(<Tag key={key}>{inline(h[2], ctx, key)}</Tag>);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push(<hr key={key} />); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(<blockquote key={key}>{blocks(buf.join("\n"), ctx, 0, key)}</blockquote>);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      const allRows = [head, ...rows];
      const startLine = base + (i - rows.length - 2);
      const lineCount = rows.length + 2;
      const clean = (s: string) => s.replace(/[\n\r|]/g, " ").trim();
      const commit = (next: string[][]) => ctx.onTableEdit?.(startLine, lineCount, next.map((r) => r.map(clean)));
      const editCell = (r: number, c: number, el: HTMLElement) => {
        const v = clean(el.innerText);
        if (v === allRows[r][c]) return;
        const next = allRows.map((row) => [...row]);
        next[r][c] = v;
        commit(next);
      };
      const editableProps = (r: number, c: number) => ({
        contentEditable: true as const,
        suppressContentEditableWarning: true as const,
        spellCheck: false,
        onBlur: (e: React.FocusEvent<HTMLElement>) => editCell(r, c, e.currentTarget),
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
          if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === "Escape") { e.currentTarget.textContent = allRows[r][c]; e.currentTarget.blur(); }
        },
      });
      out.push(
        <div key={key} className="tbl-wrap scroll">
          {ctx.onTableEdit && (
            <button className="tbl-add-col" title="Add column to the right" aria-label="Add column to the right" onClick={() => commit(allRows.map((r) => [...r, ""]))}>
              <Icon name="plus" size={14} />
            </button>
          )}
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={{ position: "relative" }}>
                    {ctx.onTableEdit ? <span {...editableProps(0, j)}>{inline(c, ctx, `${key}h${j}`)}</span> : inline(c, ctx, `${key}h${j}`)}
                    {ctx.onTableEdit && head.length > 1 && (
                      <button className="tbl-del" data-k="col" title="Delete column" aria-label={`Delete column ${j + 1}`} onClick={() => commit(allRows.map((r) => r.filter((_, x) => x !== j)))}>
                        <Icon name="close" size={11} />
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, a) => (
                <tr key={a} style={{ position: "relative" }}>
                  {ctx.onTableEdit && (
                    <button
                      className="tbl-del"
                      data-k="row"
                      title="Delete row"
                      aria-label={`Delete row ${a + 1}`}
                      style={{ position: "absolute", left: -24, top: "50%", transform: "translateY(-50%)" }}
                      onClick={() => commit(allRows.filter((_, x) => x !== a + 1))}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  )}
                  {r.map((c, j) => (
                    <td key={j}>{ctx.onTableEdit ? <span {...editableProps(a + 1, j)}>{inline(c, ctx, `${key}${a}-${j}`)}</span> : inline(c, ctx, `${key}${a}-${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {ctx.onTableEdit && (
            <button className="tbl-add-row" onClick={() => commit([...allRows, head.map(() => "")])} title="Add row">
              <Icon name="plus" size={12} /> Add row
            </button>
          )}
        </div>,
      );
      continue;
    }
    if (LIST.test(line)) {
      const items: Item[] = [];
      while (i < lines.length && LIST.test(lines[i])) {
        const m = LIST.exec(lines[i])!;
        const t = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
        items.push({ indent: m[1].replace(/\t/g, "  ").length, ordered: /\d/.test(m[2]), text: t ? t[2] : m[3], line: base + i, task: t ? t[1] !== " " : null });
        i++;
      }
      out.push(<div key={key}>{renderList(items, ctx, key)}</div>);
      continue;
    }
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    out.push(
      <p key={key}>
        {buf.map((l, j) => (
          <span key={j}>{j > 0 && <br />}{inline(l, ctx, `${key}p${j}`)}</span>
        ))}
      </p>,
    );
  }
  return out;
}

export const Markdown = memo(function Markdown({ source, ...ctx }: { source: string } & Ctx) {
  return <div className="md selectable">{blocks(source, ctx)}</div>;
});
