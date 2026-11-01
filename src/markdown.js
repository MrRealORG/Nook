// Tiny, safe markdown renderer. Escapes HTML first, then formats.
// Supports: # headings, **bold**, *italic*, `code`, ``` blocks,
// - / 1. lists, > quotes, --- rules, [links](url),
// ==highlight== · ~~strikethrough~~ · | tables |,
// ![alt](nookimg://id) images · ![alt](https://…) web images ·
// [[Note title]] wiki-links between notes.

function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// app.js assigns this at boot: id -> <img src> (convertFileSrc in Tauri,
// mock map in the browser). Markdown itself stays framework-free.
let imgResolver = null;
export function setImgResolver(fn) {
  imgResolver = typeof fn === 'function' ? fn : null;
}

function imgSrc(id) {
  if (imgResolver) return imgResolver(id);
  return `nookimg://${id}`;
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // images first, so links don't swallow them
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => {
      const safeAlt = alt;
      if (/^nookimg:\/\/([A-Za-z0-9_-]+)$/.test(src)) {
        const id = src.replace(/^nookimg:\/\//, '');
        // data-nook-img lets the app patch in the real bytes once the
        // async cache has them (keeps preview instant, never blocking)
        return `<img class="md-img" data-nook-img="${esc(id)}" src="${esc(imgSrc(id))}" alt="${esc(safeAlt)}" loading="lazy" />`;
      }
      if (/^https?:\/\/[^)\s]+$/.test(src)) {
        return `<img class="md-img md-img-web" src="${esc(src)}" alt="${esc(safeAlt)}" loading="lazy" />`;
      }
      return m; // unknown protocol — leave untouched (already escaped)
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[\[([^\[\]]+)\]\]/g, (m, title) => {
      const clean = title.trim();
      if (!clean) return m;
      return `<a href="#" class="md-mention" data-mention="${esc(clean)}">${esc(clean)}</a>`;
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const TABLE_SEP = /^[\s|:-]+$/;

export function renderMarkdown(src) {
  const lines = esc(String(src || '')).split(/\r?\n/);
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  let quote = [];
  let code = null;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join('<br>'))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${inline(quote.join('<br>'))}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw;

    if (code !== null) {
      if (/^```/.test(line.trim())) {
        out.push(`<pre><code>${code.join('\n')}</code></pre>`);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }

    const t = line.trim();

    if (/^```/.test(t)) {
      flushAll();
      code = [];
      continue;
    }

    // | tables | — a row followed by a ---|--- separator line
    if (t.includes('|') && li + 1 < lines.length) {
      const nxt = lines[li + 1].trim();
      if (nxt.includes('-') && nxt.includes('|') && TABLE_SEP.test(nxt)) {
        flushAll();
        const head = splitTableRow(t);
        let ri = li + 2;
        const rows = [];
        while (ri < lines.length && lines[ri].trim() !== '' && lines[ri].includes('|')) {
          rows.push(splitTableRow(lines[ri]));
          ri++;
        }
        out.push(
          `<div class="md-tablewrap"><table>` +
            `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
            `<tbody>${rows
              .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
              .join('')}</tbody>` +
            `</table></div>`
        );
        li = ri - 1;
        continue;
      }
    }

    if (t === '') {
      flushAll();
      continue;
    }

    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushAll();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }

    if (/^(---+|\*\*\*+)$/.test(t)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    const cb = t.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (cb) {
      flushPara();
      flushQuote();
      if (list !== 'ul') {
        flushList();
        out.push('<ul>');
        list = 'ul';
      }
      const on = cb[1] !== ' ';
      out.push(`<li class="md-task${on ? ' on' : ''}"><span class="md-box">${on ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>' : ''}</span><span>${inline(cb[2])}</span></li>`);
      continue;
    }

    const ul = t.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      flushQuote();
      if (list !== 'ul') {
        flushList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    const ol = t.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      flushQuote();
      if (list !== 'ol') {
        flushList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    // v0.19 — blockquote fix: esc() runs BEFORE the line loop, so ">" arrives
    // pre-escaped as &gt; and the old /^>\s?/ pattern never matched (every quote
    // block rendered as literal "> text"). Accept the escaped form first.
    const bq = t.match(/^(?:&gt;|>)\s?(.*)$/);
    if (bq) {
      flushPara();
      flushList();
      quote.push(bq[1]);
      continue;
    }

    flushList();
    flushQuote();
    para.push(t);
  }

  if (code !== null) {
    out.push(`<pre><code>${code.join('\n')}</code></pre>`);
  }
  flushAll();

  return out.join('\n');
}
