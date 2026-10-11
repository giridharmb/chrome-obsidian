// Pure markdown helpers: formatting entries, inserting under headings, parsing the bookmarks note,
// and a tiny safe renderer for previews. No chrome.* APIs here so it can be unit-tested in Node.

const pad = (n) => String(n).padStart(2, '0');

export const fmtDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fmtTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Letters/digits only, lowercase — so "💻 Dev" and "dev" compare equal. */
export const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export const slug = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const escapeLinkText = (t) => (t || '').replace(/\s+/g, ' ').replace(/([[\]])/g, '\\$1').trim();
export const escapeUrl = (u) => (u || '').trim().replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
const wikiSafe = (t) => (t || '').replace(/[|[\]#^]/g, ' ').replace(/\s+/g, ' ').trim();

/** Canonical form for duplicate detection. */
export const canonUrl = (u) => escapeUrl(u).replace(/\/+$/, '');

/** Safe file name for a note (no path separators or Obsidian-reserved characters). */
export function safeFileName(title, max = 80) {
  const s = (title || 'Untitled')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return s || 'Untitled';
}

export function normTag(t) {
  const s = (t || '')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_/-]/gu, '');
  // Obsidian tags must contain at least one non-numeric character.
  return s && !/^[\d/_-]+$/.test(s) ? `#${s}` : '';
}

export function parseTagInput(input) {
  return (input || '')
    .split(/[\s,]+/)
    .map(normTag)
    .filter(Boolean);
}

export function categoryTag(settings, category) {
  const c = slug(category);
  if (!c) return '';
  return settings.tagPrefix ? `#${slug(settings.tagPrefix)}/${c}` : `#${c}`;
}

export function buildTags(settings, category, tags = []) {
  const all = [];
  if (settings.addCategoryTag) all.push(categoryTag(settings, category));
  for (const t of tags) all.push(normTag(t));
  return [...new Set(all.filter(Boolean))];
}

/** Map "Dev" → "💻 Dev" if such a category exists. */
export function resolveCategory(name, categories) {
  const n = norm(name);
  return categories.find((c) => norm(c) === n) || name;
}

export function parseDomainRules(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return { pattern: l.slice(0, i).trim().toLowerCase(), category: l.slice(i + 1).trim() };
    })
    .filter((r) => r.pattern && r.category);
}

export function categorize(url, settings) {
  const host = domainOf(url).toLowerCase();
  const full = (url || '').toLowerCase();
  for (const r of parseDomainRules(settings.domainRules)) {
    const hit = r.pattern.includes('/') ? full.includes(r.pattern) : host.includes(r.pattern);
    if (hit) return resolveCategory(r.category, settings.categories);
  }
  return settings.defaultCategory;
}

export function quoteBlock(text, indent = '\t') {
  return (text || '')
    .trim()
    .split('\n')
    .map((l) => `${indent}> ${l.trimEnd()}`.trimEnd())
    .join('\n');
}

/** One bookmark list line (plus optional indented highlight quote). */
export function renderEntry(settings, e) {
  const date = e.date || fmtDate();
  const link = e.clipPath
    ? `[[${e.clipPath.replace(/\.md$/, '')}|${wikiSafe(e.title)}]] [↗](${escapeUrl(e.url)})`
    : `[${escapeLinkText(e.title || e.url)}](${escapeUrl(e.url)})`;
  const vars = {
    checkbox: e.readLater ? '[ ] ' : '',
    link,
    title: escapeLinkText(e.title),
    url: escapeUrl(e.url),
    domain: domainOf(e.url),
    date: settings.linkDate ? `[[${date}]]` : date,
    time: e.time || fmtTime(),
    tags: buildTags(settings, e.category, e.tags).join(' '),
    note: e.note ? ` — ${e.note.replace(/\s+/g, ' ').trim()}` : '',
    category: e.category || '',
  };
  let line = (settings.entryTemplate || '- {{link}}').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  line = line
    .replace(/(\s·)+\s*·/g, ' ·') // empty fields between separators
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s·\s*$/, '')
    .trimEnd();
  if (!/^\s*[-*+] /.test(line)) line = `- ${line}`;
  return e.selection ? `${line}\n${quoteBlock(e.selection)}` : line;
}

export function renderImageEntry(settings, { embed, pageTitle, pageUrl, tags = [], date }) {
  const t = buildTags(settings, settings.imageCategory, tags).join(' ');
  const src = pageUrl ? ` from [${escapeLinkText(pageTitle || domainOf(pageUrl))}](${escapeUrl(pageUrl)})` : '';
  return `- ${embed}${src} ${t} · ${date || fmtDate()}`.replace(/[ \t]{2,}/g, ' ').trimEnd();
}

export function renderClipping(settings, c) {
  const y = (v) => JSON.stringify(v ?? '');
  const tags = buildTags(settings, c.category, c.tags).map((t) => `  - ${t.slice(1)}`);
  const fm = [
    '---',
    `title: ${y(c.title)}`,
    `source: ${y(c.url)}`,
    `domain: ${y(domainOf(c.url))}`,
    `category: ${y(c.category)}`,
    tags.length ? `tags:\n${tags.join('\n')}` : 'tags: []',
    `created: ${fmtDate()} ${fmtTime()}`,
    c.description ? `description: ${y(c.description)}` : null,
    c.image ? `image: ${y(c.image)}` : null,
    `status: ${c.readLater ? 'unread' : 'read'}`,
    '---',
  ].filter((l) => l !== null);
  const body = [`# ${c.title}`, ''];
  if (c.image) body.push(`![](${escapeUrl(c.image)})`, '');
  body.push(`🔗 [${escapeLinkText(domainOf(c.url) || c.url)}](${escapeUrl(c.url)})`, '');
  if (c.description) body.push(`> ${c.description.replace(/\s+/g, ' ')}`, '');
  body.push('## Highlights', '');
  if (c.selection) body.push(quoteBlock(c.selection, ''), '');
  body.push('## Notes', '', c.note || '', '');
  return `${fm.join('\n')}\n${body.join('\n')}`;
}

export function newBookmarksFile(settings) {
  const prefix = slug(settings.tagPrefix) || 'bookmark';
  const head = [
    '---',
    'tags:',
    `  - ${prefix}s`,
    'cssclasses:',
    '  - bookmarks',
    '---',
    '# 🔖 Bookmarks',
    '',
    '> [!info] Saved from Chrome with Obsidian Bookmarker',
    `> Sections are categories. \`- [ ]\` items are *read later* — tick them off when done.`,
    `> Every entry is tagged \`#${prefix}/<category>\` so you can query across your vault.`,
    '',
  ];
  const sections = (settings.categories || []).flatMap((c) => [`## ${c}`, '']);
  return [...head, ...sections].join('\n');
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** Insert `block` under the heading matching `heading` (emoji/case-insensitive). Creates the section if missing. */
export function insertUnderHeading(content, heading, block, { newestFirst = true } = {}) {
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  const want = norm(heading);
  let start = -1;
  let level = 2;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = HEADING.exec(lines[i]);
    if (m && norm(m[2]) === want) {
      start = i;
      level = m[1].length;
      break;
    }
  }

  const blockLines = block.split('\n');

  if (start === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return [...lines, '', `## ${heading}`, '', ...blockLines, ''].join('\n');
  }

  let end = lines.length;
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = HEADING.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }

  // Rebuild the section body: heading, blank, entries, blank, next heading.
  const body = lines.slice(start + 1, end);
  while (body.length && body[0].trim() === '') body.shift();
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  const isListish = (l) => /^\s*([-*+]|\d+\.)\s/.test(l) || /^\s+\S/.test(l);
  let newBody;
  if (!body.length) newBody = blockLines;
  else if (newestFirst) newBody = [...blockLines, ...(isListish(body[0]) ? [] : ['']), ...body];
  else newBody = [...body, ...(isListish(body[body.length - 1]) ? [] : ['']), ...blockLines];
  return [...lines.slice(0, start + 1), '', ...newBody, '', ...lines.slice(end)].join('\n');
}

const LIST_ITEM = /^([-*+])\s+(?:\[([ xX])\]\s+)?(.*)$/;

/** Parse the bookmarks note into entries grouped by their nearest heading. */
export function parseBookmarks(content) {
  const out = [];
  const sections = [];
  let section = '';
  let inFence = false;
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  let fm = lines[0] === '---';
  lines.forEach((line, i) => {
    if (fm) {
      if (i > 0 && line === '---') fm = false;
      return;
    }
    if (FENCE.test(line)) inFence = !inFence;
    if (inFence) return;
    const h = HEADING.exec(line);
    if (h) {
      if (h[1].length > 1) {
        section = h[2];
        sections.push(section);
      }
      return;
    }
    const m = LIST_ITEM.exec(line); // top-level items only
    if (!m) return;
    const rest = m[3];
    const links = [...rest.matchAll(/(!?)\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g)].filter((x) => !x[1]);
    const urlLink = links.find((x) => /^https?:/i.test(x[3]));
    if (!urlLink) return;
    const wiki = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(rest);
    const isImage = /^!\[/.test(rest);
    const title = (wiki && !isImage ? wiki[2] || wiki[1] : urlLink[2]).replace(/\\([[\]])/g, '$1');
    const plain = rest.replace(/!?\[\[[^\]]*\]\]/g, ' ').replace(/!?\[(?:\\.|[^\]\\])*\]\([^)]*\)/g, ' ');
    const tags = [...plain.matchAll(/(?:^|\s)(#[\p{L}\p{N}_/-]+)/gu)].map((x) => x[1]);
    const note = (/ — (.+)$/.exec(plain) || [])[1] || '';
    out.push({
      section,
      title,
      url: urlLink[3],
      done: m[2] ? m[2].toLowerCase() === 'x' : null,
      tags,
      note: note.trim(),
      date: (/(\d{4}-\d{2}-\d{2})/.exec(rest) || [])[1] || '',
      notePath: wiki && !isImage ? wiki[1] : null,
      image: isImage,
      line: i,
    });
  });
  return { entries: out, sections };
}

/** Toggle `- [ ]` ↔ `- [x]` on the first entry with this URL. Returns null if not found. */
export function toggleEntry(content, url) {
  const lines = content.split('\n');
  const target = canonUrl(url);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([-*+]\s+)\[([ xX])\](.*)$/.exec(lines[i]);
    if (!m) continue;
    const urls = [...m[3].matchAll(/\]\(([^)\s]+)\)/g)].map((x) => canonUrl(x[1]));
    if (urls.includes(target)) {
      lines[i] = `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${m[3]}`;
      return lines.join('\n');
    }
  }
  return null;
}

/* ---------- Tiny, safe markdown → HTML renderer for previews ---------- */

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeHref = (u) => (/^(https?:|mailto:)/i.test(u) ? u : '#');

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  s = s
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '<span class="md-embed">🖼 $1</span>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img alt="${a}" src="${safeHref(u)}">`)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, p, a) => `<a class="md-wiki" data-path="${p}">${a || p}</a>`)
    .replace(/\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${safeHref(u)}" target="_blank" rel="noopener">${t.replace(/\\([[\]])/g, '$1')}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/(^|\s)(#[\p{L}_][\p{L}\p{N}_/-]*)/gu, '$1<span class="md-tag">$2</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

export function renderMarkdown(md) {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      // key: value pairs; YAML list items ("  - x") are folded into the preceding key.
      const props = [];
      for (const l of lines.slice(1, end)) {
        const kv = /^(\w[\w-]*):\s*(.*)$/.exec(l);
        const li = /^\s+-\s+(.*)$/.exec(l);
        if (kv) props.push([kv[1], kv[2].replace(/^"|"$/g, '')]);
        else if (li && props.length) {
          const last = props[props.length - 1];
          last[1] = last[1] ? `${last[1]}, ${li[1]}` : li[1];
        }
      }
      if (props.length) {
        html.push('<dl class="md-props">');
        for (const [k, v] of props) html.push(`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`);
        html.push('</dl>');
      }
      i = end + 1;
    }
  }
  let list = null;
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (FENCE.test(l)) {
      closeList();
      const buf = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) buf.push(lines[i]);
      html.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    let m;
    if ((m = HEADING.exec(l))) {
      closeList();
      html.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if ((m = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(l))) {
      if (list !== 'ul') {
        closeList();
        html.push('<ul>');
        list = 'ul';
      }
      const box = m[1] ? `<input type="checkbox" disabled ${m[1] !== ' ' ? 'checked' : ''}> ` : '';
      html.push(`<li>${box}${inline(m[2])}</li>`);
    } else if ((m = /^\s*\d+\.\s+(.*)$/.exec(l))) {
      if (list !== 'ol') {
        closeList();
        html.push('<ol>');
        list = 'ol';
      }
      html.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^\s*>\s?(.*)$/.exec(l))) {
      closeList();
      const text = m[1].replace(/^\[!(\w+)\][-+]?\s*/, (_, t) => `<b>${t.toUpperCase()}</b> `);
      html.push(`<blockquote>${text.startsWith('<b>') ? text.replace(/^(<b>\w+<\/b> )(.*)$/, (_, b, r) => b + inline(r)) : inline(text)}</blockquote>`);
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) {
      closeList();
      html.push('<hr>');
    } else if (l.trim() === '') {
      closeList();
    } else {
      closeList();
      html.push(`<p>${inline(l)}</p>`);
    }
  }
  closeList();
  return html.join('\n');
}
