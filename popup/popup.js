import { getSettings } from '../src/lib/settings.js';
import { getPageInfo, getActiveTab } from '../src/lib/page.js';
import { uriSearch } from '../src/lib/obsidian.js';
import {
  categorize,
  cleanUrl,
  renderEntry,
  parseTagInput,
  safeFileName,
  domainOf,
  canonUrl,
  norm,
  renderMarkdown,
} from '../src/lib/markdown.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
};

const isPopup = chrome.extension.getViews({ type: 'popup' }).includes(window);
document.body.classList.toggle('panel', !isPopup);
if (!isPopup) $('btn-panel').hidden = true;
$('kbd').textContent = navigator.platform.includes('Mac') ? '⌘↵' : 'Ctrl↵';

let S; // settings
let page = {}; // current page info
let category = '';
let data = { entries: [], sections: [] };
let currentNote = null;

async function send(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || 'Unknown error');
  return r.data;
}

function toast(msg, err = false, action) {
  const t = $('toast');
  t.textContent = msg;
  if (action) t.append(' · ', el('a', { textContent: action.label, onclick: action.fn }));
  t.style.pointerEvents = action ? 'auto' : '';
  t.className = `show${err ? ' err' : ''}`;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.className = ''), err ? 4000 : 1800);
}

const favicon = (url) => {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '32');
  return u.toString();
};

const openTab = (url) => chrome.tabs.create({ url });

/* ---------------- Tabs ---------------- */

document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    for (const t of ['save', 'browse', 'search']) $(`tab-${t}`).hidden = t !== b.dataset.tab;
    if (b.dataset.tab === 'browse') $('filter').focus();
    if (b.dataset.tab === 'search') $('q').focus();
  })
);

$('btn-options').onclick = () => chrome.runtime.openOptionsPage();
$('btn-open').onclick = () => send('open').catch((e) => toast(e.message, true));
// sidePanel.open() must run synchronously inside the click gesture, so resolve the window id up front.
let windowId;
chrome.windows.getCurrent().then((w) => (windowId = w.id));
$('btn-panel').onclick = () => {
  chrome.sidePanel.open({ windowId }).then(() => window.close());
};

/* ---------------- Save tab ---------------- */

function renderCats() {
  const cats = [...S.categories];
  for (const s of data.sections) if (!cats.some((c) => norm(c) === norm(s))) cats.push(s);
  const box = $('cats');
  box.replaceChildren(
    ...cats.map((c) =>
      el('button', {
        className: `chip${norm(c) === norm(category) ? ' selected' : ''}`,
        textContent: c,
        onclick: () => {
          category = c;
          renderCats();
          updatePreview();
        },
      })
    ),
    el('button', {
      className: 'chip new',
      textContent: '+ New',
      onclick: (e) => {
        const input = el('input', { className: 'chip-input', placeholder: 'Section name' });
        const commit = () => {
          const v = input.value.trim();
          if (v) category = v;
          if (v && !S.categories.some((c) => norm(c) === norm(v))) data.sections.push(v);
          renderCats();
          updatePreview();
        };
        input.onkeydown = (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            commit();
          }
          if (ev.key === 'Escape') renderCats();
        };
        input.onblur = commit;
        e.currentTarget.replaceWith(input);
        input.focus();
      },
    })
  );
}

let vaultTags = []; // [{ name: '#tag', count }] from the whole vault, when the plugin supports it

/** Tag → use count across bookmarks, minus the automatic #bookmark/<section> tags. */
function bookmarkTagCounts() {
  const counts = new Map();
  const prefix = `#${(S.tagPrefix || '').toLowerCase()}/`;
  for (const e of data.entries)
    for (const t of e.tags) if (!(S.tagPrefix && t.toLowerCase().startsWith(prefix))) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

// The chips double as autocomplete: they narrow to the word being typed, and Tab accepts the first one.
function renderTagSuggestions() {
  const input = $('tags');
  const partial = /\S$/.test(input.value) ? input.value.split(/[\s,]+/).pop().replace(/^#/, '').toLowerCase() : '';
  const done = partial ? input.value.replace(/\S+$/, '') : input.value;
  const have = new Set(parseTagInput(done));
  const counts = bookmarkTagCounts();
  for (const t of vaultTags) counts.set(t.name, Math.max(counts.get(t.name) || 0, t.count));
  const starts = (t) => t.toLowerCase().startsWith(`#${partial}`);
  const top = [...counts.entries()]
    .filter(([t]) => !have.has(t) && t.toLowerCase().includes(partial))
    .sort((a, b) => starts(b[0]) - starts(a[0]) || b[1] - a[1])
    .map(([t]) => t)
    .slice(0, 12);
  $('tag-suggest').replaceChildren(
    ...top.map((t) =>
      el('button', {
        className: 'chip',
        textContent: t,
        onclick: () => {
          input.value = `${done.trim()} ${t.slice(1)}`.trim() + ' ';
          input.focus();
          renderTagSuggestions();
          updatePreview();
        },
      })
    )
  );
  input.dataset.partial = partial;
}

$('tags').addEventListener('keydown', (e) => {
  const first = $('tag-suggest').firstElementChild;
  const partial = e.target.dataset.partial;
  if (e.key !== 'Tab' || e.shiftKey || !partial || !first || first.textContent.slice(1).toLowerCase() === partial) return;
  e.preventDefault();
  first.click();
});

function currentItem(open = false) {
  const useSel = !$('sel-wrap').hidden && $('use-sel').checked;
  return {
    kind: 'page',
    title: $('title').value.trim() || page.url,
    url: page.url,
    category,
    tags: parseTagInput($('tags').value).map((t) => t.slice(1)),
    note: $('note').value.trim(),
    selection: useSel ? page.selection : '',
    readLater: $('readlater').checked,
    dedicatedNote: $('dedicated').checked,
    description: page.description,
    image: page.image,
    open,
  };
}

function updatePreview() {
  if (!S || !page.url) return;
  const it = currentItem();
  const clipPath = it.dedicatedNote && S.mode === 'rest' ? `${S.clippingsFolder}/${safeFileName(it.title)}.md` : null;
  $('preview').textContent = renderEntry(S, { ...it, clipPath });
  $('target').textContent = `${S.bookmarksFile} › ${category}`;
}

async function doSave(open) {
  if (!page.url) return;
  const btns = [$('save'), $('save-open')];
  btns.forEach((b) => (b.disabled = true));
  try {
    const r = await send('save', { item: currentItem(open) });
    if (r.queued) toast("Obsidian isn't running — queued, will save when it's back");
    else {
      toast(`Saved to ${r.category}`, false, {
        label: 'Undo',
        fn: async () => {
          clearTimeout(doSave.closing);
          await send('remove', { url: r.url, file: r.file }).then(() => toast('Removed'), (e) => toast(e.message, true));
          loadBookmarks();
        },
      });
    }
    // Leave time to hit Undo before the popup closes.
    if (isPopup && S.closeAfterSave) doSave.closing = setTimeout(() => window.close(), 1800);
    else loadBookmarks();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

$('save').onclick = () => doSave(false);
$('save-open').onclick = () => doSave(true);
$('save-tabs').onclick = () =>
  send('saveTabs').then((r) => toast(`Saved ${r.count} tabs to ${r.category}`), (e) => toast(e.message, true));
for (const id of ['title', 'tags', 'note']) $(id).addEventListener('input', updatePreview);
for (const id of ['readlater', 'dedicated', 'use-sel']) $(id).addEventListener('change', updatePreview);
$('tags').addEventListener('input', renderTagSuggestions);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !$('tab-save').hidden) {
    e.preventDefault();
    doSave(e.shiftKey);
  }
});

function showDuplicate() {
  const box = $('dupe');
  const hit = page.url && data.entries.find((e) => canonUrl(e.url) === canonUrl(page.url));
  box.hidden = !hit;
  if (!hit) return;
  const state = hit.done === false ? ' · unread' : hit.done ? ' · read' : '';
  box.replaceChildren(
    `Already saved in `,
    el('b', { textContent: hit.section || 'bookmarks' }),
    `${hit.date ? ` on ${hit.date}` : ''}${state}. `,
    el('a', { textContent: 'Open in Obsidian', onclick: () => send('open', { path: hit.notePath ? `${hit.notePath}.md` : undefined }) })
  );
}

async function loadPage() {
  const tab = await getActiveTab();
  if (!tab) return;
  page = await getPageInfo(tab);
  page.url = cleanUrl(page.url);
  $('title').value = page.title;
  $('url').textContent = page.url;
  $('url').title = page.url;
  $('fav').src = favicon(page.url);
  $('sel-wrap').hidden = !page.selection;
  $('sel').textContent = page.selection;
  $('note').value = '';
  $('tags').value = '';
  category = categorize(page.url, S);
  const savable = /^(https?|file|ftp):/.test(page.url);
  $('save').disabled = $('save-open').disabled = !savable;
  if (!savable) toast("This page can't be bookmarked", true);
  renderCats();
  showDuplicate();
  updatePreview();
}

/* ---------------- Browse tab ---------------- */

/** Add or remove a word (usually a #tag) in the bookmarks filter. */
function toggleFilter(word) {
  const words = $('filter').value.trim().split(/\s+/).filter(Boolean);
  const i = words.findIndex((w) => w.toLowerCase() === word.toLowerCase());
  i === -1 ? words.push(word) : words.splice(i, 1);
  $('filter').value = words.join(' ');
  renderList();
}

function renderTagCloud(words) {
  const top = [...bookmarkTagCounts().entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  $('tag-cloud').replaceChildren(
    ...top.map(([t, n]) =>
      el('button', { className: `chip${words.includes(t.toLowerCase()) ? ' selected' : ''}`, onclick: () => toggleFilter(t) }, t, el('i', { textContent: n }))
    )
  );
}

function renderList() {
  const words = $('filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  const f = words.length;
  renderTagCloud(words);
  const show = $('show').value;
  const list = $('list');
  const items = data.entries.filter((e) => {
    if (show === 'unread' && e.done !== false) return false;
    if (show === 'done' && e.done !== true) return false;
    if (!f) return true;
    const hay = [e.title, e.url, e.section, e.note, ...e.tags].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  if (!items.length) {
    list.replaceChildren(el('div', { className: 'empty', textContent: data.entries.length ? 'No matches.' : 'No bookmarks yet — save your first page!' }));
    return;
  }
  const groups = new Map();
  for (const e of items) {
    const k = e.section || 'Unsorted';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const out = [];
  for (const [section, entries] of groups) {
    const h = el('div', { className: 'group-h' }, el('span', { textContent: section }), el('span', { textContent: entries.length }));
    h.onclick = () => h.classList.toggle('collapsed');
    out.push(h, el('div', { className: 'group' }, ...entries.map(renderItem)));
  }
  list.replaceChildren(...out);
}

function renderItem(e) {
  const box =
    e.done === null
      ? null
      : el('input', {
          type: 'checkbox',
          checked: e.done,
          title: e.done ? 'Mark as unread' : 'Mark as read',
          onchange: async (ev) => {
            try {
              await send('toggleRead', { url: e.url, file: e.file });
              e.done = ev.target.checked;
              renderList();
            } catch (err) {
              ev.target.checked = !ev.target.checked;
              toast(err.message, true);
            }
          },
        });
  const meta = el('div', { className: 'm' }, `${domainOf(e.url)}${e.date ? ` · ${e.date}` : ''} `);
  for (const t of e.tags) meta.append(el('span', { className: 'tag', textContent: `${t} `, onclick: () => toggleFilter(t) }));
  if (e.note) meta.append(`— ${e.note}`);
  meta.title = meta.textContent;
  const tools = el(
    'div',
    { className: 'tools' },
    e.notePath ? el('button', { textContent: 'Note', title: 'Open its note in Obsidian', onclick: () => send('open', { path: `${e.notePath}.md` }) }) : null,
    e.notePath ? el('button', { textContent: 'View', title: 'Preview note here', onclick: () => viewNote(`${e.notePath}.md`) }) : null,
    el('button', {
      textContent: '✕',
      title: 'Delete this bookmark',
      onclick: () => confirm(`Delete "${e.title}" from your bookmarks?`) && send('remove', { url: e.url, file: e.file }).then(loadBookmarks, (err) => toast(err.message, true)),
    })
  );
  return el(
    'div',
    { className: `item${e.done ? ' done' : ''}` },
    box || el('img', { className: 'fav', src: favicon(e.url), alt: '' }),
    el('div', { className: 'body' }, el('a', { className: 't', textContent: e.title || e.url, title: e.url, onclick: () => openTab(e.url) }), meta),
    tools
  );
}

$('filter').addEventListener('input', renderList);
$('show').addEventListener('change', renderList);

async function loadBookmarks() {
  if (S.mode !== 'rest' || !S.apiKey) {
    $('list').replaceChildren(el('div', { className: 'empty', textContent: 'Browsing bookmarks needs the Local REST API mode. Use “Open bookmarks note” (↗) instead.' }));
    return;
  }
  try {
    data = await send('bookmarks');
    $('count').textContent = data.entries.length || '';
  } catch (e) {
    $('list').replaceChildren(el('div', { className: 'empty', textContent: e.message }));
    return;
  }
  renderList();
  renderCats();
  renderTagSuggestions();
  showDuplicate();
}

/* ---------------- Search tab ---------------- */

// Search as you type; searchSeq drops answers that arrive after a newer query.
let searchSeq = 0;
let searchTimer;
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => S.mode === 'rest' && $('q').value.trim().length > 1 && $('search-form').requestSubmit(), 300);
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

$('search-form').onsubmit = async (ev) => {
  ev.preventDefault();
  const query = $('q').value.trim();
  if (!query) return;
  if (S.mode !== 'rest') return send('openUrl', { url: uriSearch({ vaultName: S.vaultName, query }) });
  const box = $('results');
  $('note-view').hidden = true;
  box.hidden = false;
  box.replaceChildren(el('div', { className: 'empty', textContent: 'Searching…' }));
  try {
    const mine = ++searchSeq;
    const results = await send('search', { query });
    if (mine !== searchSeq) return;
    if (!results.length) return box.replaceChildren(el('div', { className: 'empty', textContent: 'No notes found.' }));
    const re = new RegExp(`(${query.split(/\s+/).filter(Boolean).map(escapeRe).join('|')})`, 'gi');
    box.replaceChildren(
      ...results.map((r) => {
        const parts = r.filename.split('/');
        const name = parts.pop().replace(/\.md$/, '');
        const ctx = el('div', { className: 'ctx' });
        const text = (r.matches?.[0]?.context || '').replace(/\s+/g, ' ').trim();
        text.split(re).forEach((p, i) => ctx.append(i % 2 ? el('mark', { textContent: p }) : p));
        return el(
          'div',
          { className: 'result', onclick: () => viewNote(r.filename) },
          el('div', { className: 'fn', textContent: name }),
          parts.length ? el('div', { className: 'fd', textContent: parts.join(' / ') }) : null,
          text ? ctx : null
        );
      })
    );
  } catch (e) {
    box.replaceChildren(el('div', { className: 'empty', textContent: e.message }));
  }
};

async function viewNote(path) {
  document.querySelector('.tabs [data-tab="search"]').click();
  $('results').hidden = true;
  $('note-view').hidden = false;
  $('note-title').textContent = path.split('/').pop().replace(/\.md$/, '');
  $('note-body').textContent = 'Loading…';
  currentNote = path;
  try {
    const md = await send('readNote', { path });
    if (md === null) throw new Error(`Note not found: ${path}`);
    $('note-body').innerHTML = renderMarkdown(md); // renderer escapes all HTML
    $('note-body').querySelectorAll('a.md-wiki').forEach((a) => (a.onclick = () => viewNote(a.dataset.path)));
    // Clicking a tag searches the vault for it.
    $('note-body').querySelectorAll('.md-tag').forEach((t) => (t.onclick = () => (($('q').value = t.textContent), $('search-form').requestSubmit())));
  } catch (e) {
    $('note-body').textContent = e.message;
  }
}

$('back').onclick = () => {
  $('note-view').hidden = true;
  $('results').hidden = false;
};
$('note-open').onclick = () => currentNote && send('open', { path: currentNote }).catch((e) => toast(e.message, true));

/* ---------------- Init ---------------- */

async function checkStatus() {
  const st = await send('status').catch((e) => ({ ok: false, message: e.message }));
  $('status').className = `dot ${st.ok ? 'ok' : 'bad'}`;
  $('status').title = st.message;
  const b = $('banner');
  b.hidden = st.ok;
  if (!st.ok) {
    b.replaceChildren(`${st.message}. `, el('a', { textContent: 'Open settings', onclick: () => chrome.runtime.openOptionsPage() }));
  }
}

async function init() {
  S = await getSettings();
  $('readlater').checked = S.readLater;
  $('dedicated').disabled = S.mode !== 'rest';
  if (S.mode !== 'rest') $('dedicated').parentElement.title = 'Requires Local REST API mode';
  await loadPage();
  $('title').focus();
  $('title').select();
  checkStatus();
  loadBookmarks();
  send('tags').then((t) => ((vaultTags = t || []), renderTagSuggestions()), () => {});
}

init();

// Side panel: follow the active tab.
if (!isPopup) {
  chrome.tabs.onActivated.addListener(() => loadPage().then(showDuplicate));
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (tab.active && info.status === 'complete') loadPage().then(showDuplicate);
  });
  chrome.storage.onChanged.addListener((c) => c.settings && init());
}
