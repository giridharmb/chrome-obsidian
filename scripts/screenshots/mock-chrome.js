// Fake chrome.* APIs + sample vault data so the real popup/options pages can be rendered
// in a normal browser tab for README screenshots. Loaded as a module before the page script.
import { parseBookmarks, newBookmarksFile, insertUnderHeading, renderEntry } from '/src/lib/markdown.js';
import { DEFAULTS } from '/src/lib/settings.js';

const params = new URLSearchParams(location.search);
const settings = { ...DEFAULTS, apiKey: 'demo-key', vaultName: 'My Vault', apiUrl: 'https://127.0.0.1:27124', theme: params.get('theme') || 'system' };

const samples = [
  ['Dev', 'coddingtonbear/obsidian-local-rest-api', 'https://github.com/coddingtonbear/obsidian-local-rest-api', ['obsidian', 'api'], 'powers this extension', true],
  ['Dev', 'Vite — Getting Started', 'https://vitejs.dev/guide/', ['frontend'], '', false],
  ['Dev', 'Chrome Extensions: Manifest V3', 'https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3', ['chrome'], '', true],
  ['Reading', 'How to take smart notes', 'https://fortelabs.com/blog/how-to-take-smart-notes/', ['pkm', 'zettelkasten'], 'great intro to Zettelkasten', true],
  ['Reading', 'The Pragmatic Engineer — On writing', 'https://blog.pragmaticengineer.com/writing/', ['writing'], '', false],
  ['Videos', 'Building a Second Brain in Obsidian', 'https://www.youtube.com/watch?v=OUN8uyQ3dXw', ['pkm'], '', true],
  ['Research', 'Attention Is All You Need', 'https://arxiv.org/abs/1706.03762', ['ml', 'transformers'], 'the original transformer paper', true],
  ['Tools', 'Excalidraw', 'https://excalidraw.com/', ['diagrams'], '', false],
];
let doc = newBookmarksFile(settings);
for (const [cat, title, url, tags, note, readLater] of samples.reverse()) {
  const clipPath = title.startsWith('Attention') ? 'Bookmarks/Clippings/Attention Is All You Need.md' : null;
  doc = insertUnderHeading(doc, cat, renderEntry(settings, { title, url, category: cat, tags, note, readLater, clipPath, date: '2026-10-09' }));
}

// The duplicate scene shows a link that lives in two sections.
if (params.get('scene') === 'dupe') {
  doc = insertUnderHeading(doc, 'Reading', renderEntry(settings, { title: 'coddingtonbear/obsidian-local-rest-api', url: 'https://github.com/coddingtonbear/obsidian-local-rest-api', category: 'Reading', tags: [], readLater: false, date: '2026-11-20' }));
}

// ?big=3000 fills the note with that many generated bookmarks, to check the popup stays fast.
if (params.get('big')) {
  const lines = { Dev: [], Reading: [], Videos: [], Research: [], Tools: [] };
  const names = Object.keys(lines);
  for (let i = 0; i < +params.get('big'); i++) {
    const cat = names[i % names.length];
    lines[cat].push(renderEntry(settings, { title: `Generated bookmark ${i}`, url: `https://site${i % 97}.example.com/page/${i}`, category: cat, tags: [`topic${i % 23}`], readLater: i % 3 === 0, date: '2026-11-01' }));
  }
  for (const cat of names) doc = insertUnderHeading(doc, cat, lines[cat].join('\n'));
}

const NOTE = `---
title: "Attention Is All You Need"
source: "https://arxiv.org/abs/1706.03762"
domain: "arxiv.org"
category: "Research"
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
  checkLinks: (m) => [{ url: m.urls[1], reason: '404' }],
  tags: () => [],
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

// The reminders scene shows two pending reminders and one that has come due.
const day = 86400000;
const extraStore =
  params.get('scene') === 'reminders'
    ? {
        reminders: [
          { url: 'https://arxiv.org/abs/1706.03762', title: 'Attention Is All You Need', at: Date.now() + 2 * day, repeat: 'weekly' },
          { url: 'https://fortelabs.com/blog/how-to-take-smart-notes/', title: 'How to take smart notes', at: Date.now() + day, repeat: '' },
        ],
        fired: { 'https://www.youtube.com/watch?v=OUN8uyQ3dXw': 'Building a Second Brain in Obsidian' },
      }
    : {};

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
  storage: { local: { get: async () => ({ settings, ...extraStore }), set: async () => {} }, onChanged: ev },
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
    const tool = (title, label) =>
      [...[...document.querySelectorAll('#list .item')].find((n) => n.textContent.includes(title)).querySelectorAll('.tools button')].find((b) => b.textContent === label).click();
    if (scene === 'reminders') {
      document.querySelector('[data-tab="browse"]').click();
      setTimeout(() => {
        $('show').value = 'reminders';
        $('show').dispatchEvent(new Event('change'));
        tool('Attention', '⏰');
        document.activeElement?.blur();
      }, 300);
    }
    if (scene === 'bulk') {
      document.querySelector('[data-tab="browse"]').click();
      setTimeout(() => {
        $('select-mode').click();
        [...document.querySelectorAll('#list .item')].slice(0, 3).forEach((n) => n.click());
      }, 300);
    }
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
