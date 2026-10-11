// Fake chrome.* APIs + sample vault data so the real popup/options pages can be rendered
// in a normal browser tab for README screenshots. Loaded as a module before the page script.
import { parseBookmarks, newBookmarksFile, insertUnderHeading, renderEntry } from '/src/lib/markdown.js';
import { DEFAULTS } from '/src/lib/settings.js';

const params = new URLSearchParams(location.search);
const settings = { ...DEFAULTS, apiKey: 'demo-key', vaultName: 'My Vault', apiUrl: 'https://127.0.0.1:27124' };

const samples = [
  ['💻 Dev', 'coddingtonbear/obsidian-local-rest-api', 'https://github.com/coddingtonbear/obsidian-local-rest-api', ['obsidian', 'api'], 'powers this extension', true],
  ['💻 Dev', 'Vite — Getting Started', 'https://vitejs.dev/guide/', ['frontend'], '', false],
  ['💻 Dev', 'Chrome Extensions: Manifest V3', 'https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3', ['chrome'], '', true],
  ['📚 Reading', 'How to take smart notes', 'https://fortelabs.com/blog/how-to-take-smart-notes/', ['pkm', 'zettelkasten'], 'great intro to Zettelkasten', true],
  ['📚 Reading', 'The Pragmatic Engineer — On writing', 'https://blog.pragmaticengineer.com/writing/', ['writing'], '', false],
  ['🎥 Videos', 'Building a Second Brain in Obsidian', 'https://www.youtube.com/watch?v=OUN8uyQ3dXw', ['pkm'], '', true],
  ['🧪 Research', 'Attention Is All You Need', 'https://arxiv.org/abs/1706.03762', ['ml', 'transformers'], 'the original transformer paper', true],
  ['🛠 Tools', 'Excalidraw', 'https://excalidraw.com/', ['diagrams'], '', false],
];
let doc = newBookmarksFile(settings);
for (const [cat, title, url, tags, note, readLater] of samples.reverse()) {
  const clipPath = title.startsWith('Attention') ? 'Bookmarks/Clippings/Attention Is All You Need.md' : null;
  doc = insertUnderHeading(doc, cat, renderEntry(settings, { title, url, category: cat, tags, note, readLater, clipPath, date: '2026-10-09' }));
}

const NOTE = `---
title: "Attention Is All You Need"
source: "https://arxiv.org/abs/1706.03762"
domain: "arxiv.org"
category: "🧪 Research"
tags:
  - bookmark/research
  - ml
created: 2026-10-09 18:42
status: unread
---
# Attention Is All You Need

🔗 [arxiv.org](https://arxiv.org/abs/1706.03762)

> We propose a new simple network architecture, the **Transformer**, based solely on attention mechanisms.

## Highlights

> Self-attention, sometimes called intra-attention, is an attention mechanism relating different positions of a single sequence.

## Notes

- [ ] Re-read section 3.2 on *multi-head attention*
- Related: [[Transformers]] · #ml #transformers
`;

const SEARCH = [
  { filename: 'Bookmarks/Clippings/Attention Is All You Need.md', score: -0.4, matches: [{ match: { start: 0, end: 0 }, context: 'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms' }] },
  { filename: '02 Concepts/Transformers.md', score: -1.2, matches: [{ match: { start: 0, end: 0 }, context: 'A transformer uses self-attention to weigh the relevance of every token to every other token' }] },
  { filename: '04 Study/Week 12 — Deep learning.md', score: -2.1, matches: [{ match: { start: 0, end: 0 }, context: 'Read the attention paper and summarise the encoder/decoder stack' }] },
];

const handlers = {
  status: () => ({ ok: true, message: 'Connected · Obsidian Local REST API 5.4.0' }),
  bookmarks: () => parseBookmarks(doc),
  search: () => SEARCH,
  readNote: () => NOTE,
  save: (m) => ({ category: m.item.category }),
};

const page = {
  title: params.get('title') || 'Obsidian Web Clipper alternatives — a practical guide',
  url: params.get('url') || 'https://medium.com/@notes/obsidian-web-clipping-guide',
  description: 'Compare ways to capture the web into your vault.',
  image: '',
  selection: params.get('sel') ?? 'Capture first, organize later: a single inbox note with sections beats a hundred scattered files.',
};

const noop = () => {};
const ev = { addListener: noop };
window.chrome = {
  extension: { getViews: () => (params.get('panel') ? [] : [window]) },
  runtime: {
    getURL: (p) => {
      if (p.startsWith('/_favicon/')) return 'https://www.google.com/s2/favicons';
      return p;
    },
    sendMessage: async (m) => ({ ok: true, data: handlers[m.type]?.(m) }),
    openOptionsPage: noop,
  },
  storage: { local: { get: async () => ({ settings }), set: async () => {} }, onChanged: ev },
  tabs: { query: async () => [{ id: 1, title: page.title, url: page.url }], create: noop, onActivated: ev, onUpdated: ev },
  scripting: { executeScript: async () => [{ result: page }] },
  windows: { getCurrent: async () => ({ id: 1 }) },
  sidePanel: { open: async () => {} },
  permissions: { request: async () => true },
};

// Point favicon <img>s at Google's favicon service (the real extension uses chrome's _favicon API).
new MutationObserver(() => {
  for (const img of document.querySelectorAll('img[src^="https://www.google.com/s2/favicons?"]')) {
    const u = new URL(img.src);
    const page = u.searchParams.get('pageUrl');
    if (page) img.src = `https://www.google.com/s2/favicons?sz=32&domain_url=${encodeURIComponent(page)}`;
  }
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });

// Scripted interactions for each screenshot scene.
window.addEventListener('load', () =>
  setTimeout(() => {
    const scene = params.get('scene');
    const $ = (id) => document.getElementById(id);
    const fire = (el) => el.dispatchEvent(new Event('input', { bubbles: true }));
    // Headless Chrome's viewport is a little narrower than --window-size; pin the panel width.
    if (params.get('panel')) document.body.style.width = '440px';
    if (params.get('tall')) document.body.style.maxHeight = 'none';
    document.activeElement?.blur();
    window.getSelection().removeAllRanges();
    if (scene === 'save') {
      $('tags').value = 'pkm obsidian';
      fire($('tags'));
      $('note').value = 'Good overview of clipping workflows';
      fire($('note'));
      $('readlater').checked = true;
      $('readlater').dispatchEvent(new Event('change'));
      document.querySelector('details.preview').open = true;
    }
    if (scene === 'dupe') {
      /* page URL already in the sample doc → duplicate banner shows automatically */
    }
    if (scene === 'browse') document.querySelector('[data-tab="browse"]').click();
    if (scene === 'unread') {
      document.querySelector('[data-tab="browse"]').click();
      $('show').value = 'unread';
      $('show').dispatchEvent(new Event('change'));
    }
    if (scene === 'search' || scene === 'note') {
      document.querySelector('[data-tab="search"]').click();
      $('q').value = 'attention';
      $('search-form').requestSubmit();
      if (scene === 'note') setTimeout(() => document.querySelector('.result').click(), 200);
    }
  }, 400)
);
