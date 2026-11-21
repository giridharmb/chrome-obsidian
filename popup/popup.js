import { getSettings, saveSettings } from '../src/lib/settings.js';
import { getPageInfo, getActiveTab } from '../src/lib/page.js';
import { uriSearch } from '../src/lib/obsidian.js';
import {
  categorize,
  cleanUrl,
  normTag,
  toCsv,
  toNetscape,
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
  toast.h = setTimeout(() => (t.className = ''), action ? 7000 : err ? 4000 : 1800);
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

$('theme').onchange = (e) => {
  document.documentElement.dataset.theme = S.theme = e.target.value;
  saveSettings({ theme: S.theme });
};
$('btn-options').onclick = () => chrome.runtime.openOptionsPage();
$('btn-open').onclick = () => send('open').catch((e) => toast(e.message, true));
// sidePanel.open() must run synchronously inside the click gesture, so resolve the window id up front.
let windowId;
chrome.windows.getCurrent().then((w) => (windowId = w.id));
$('btn-panel').onclick = () => {
  chrome.sidePanel.open({ windowId }).then(() => window.close());
};

/* ---------------- Save tab ---------------- */

/** Matcher for entries that are the page currently open. */
const isCurrent = () => {
  const u = page.url ? canonUrl(page.url) : null;
  return (e) => u !== null && canonUrl(e.url) === u;
};

function renderCats() {
  const cats = [...S.categories];
  for (const s of data.sections) if (!cats.some((c) => norm(c) === norm(s))) cats.push(s);
  const box = $('cats');
  // Sections that already hold this page get a ✓ so you can see where it lives.
  const here = isCurrent();
  const savedIn = new Set(editing ? [] : data.entries.filter(here).map((e) => norm(e.section)));
  box.replaceChildren(
    ...cats.map((c) =>
      el('button', {
        className: `chip${norm(c) === norm(category) ? ' selected' : ''}${savedIn.has(norm(c)) ? ' saved' : ''}`,
        textContent: savedIn.has(norm(c)) ? `✓ ${c}` : c,
        title: savedIn.has(norm(c)) ? 'This page is already saved here' : '',
        onclick: () => {
          catTouched = true;
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
          if (v) catTouched = true;
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

/** An entry's own tags, without "#" and without the automatic section tag. */
function userTags(e) {
  const prefix = `#${(S.tagPrefix || '').toLowerCase()}/`;
  return e.tags.filter((t) => !(S.tagPrefix && t.toLowerCase().startsWith(prefix))).map((t) => t.slice(1));
}

let catTouched = false; // true once the user picks a section by hand

/** Rules first; otherwise the section you most often used for this site. */
function suggestCategory() {
  const byRule = categorize(page.url, S);
  if (byRule !== S.defaultCategory) return byRule;
  const site = domainOf(page.url || '');
  const counts = new Map();
  for (const e of data.entries) {
    if (site && !e.image && domainOf(e.url) === site && !/^Session \d/.test(e.section)) counts.set(e.section, (counts.get(e.section) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || byRule;
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
// "Always save <site> here": adds a rule at the top of the auto-sort list, so it wins.
function renderSiteRule() {
  const site = domainOf(page.url || '');
  const b = $('site-rule');
  b.hidden = !site || editing || !category || norm(categorize(page.url, S)) === norm(category);
  b.textContent = `Always save ${site} to ${category}`;
  b.onclick = async () => {
    S = await saveSettings({ domainRules: `${site} = ${category}\n${S.domainRules}` });
    toast(`Rule added: ${site} → ${category}`);
    renderSiteRule();
  };
}

function renderTagSuggestions() {
  const input = $('tags');
  const partial = /\S$/.test(input.value) ? input.value.split(/[\s,]+/).pop().replace(/^#/, '').toLowerCase() : '';
  const done = partial ? input.value.replace(/\S+$/, '') : input.value;
  const have = new Set(parseTagInput(done));
  const counts = bookmarkTagCounts();
  for (const t of vaultTags) counts.set(t.name, Math.max(counts.get(t.name) || 0, t.count));
  // Likely tags for this page come first: ones you used on the same site, then the page's own keywords.
  const site = domainOf(page.url || '');
  const likely = new Set(data.entries.filter((e) => site && domainOf(e.url) === site).flatMap(userTags).map((t) => `#${t}`));
  for (const k of (page.keywords || '').split(',').map(normTag).filter(Boolean).slice(0, 5)) {
    likely.add(k);
    if (!counts.has(k)) counts.set(k, 0);
  }
  const starts = (t) => t.toLowerCase().startsWith(`#${partial}`);
  const top = [...counts.entries()]
    .filter(([t]) => !have.has(t) && t.toLowerCase().includes(partial))
    .sort((a, b) => starts(b[0]) - starts(a[0]) || likely.has(b[0]) - likely.has(a[0]) || b[1] - a[1])
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
  renderSiteRule();
  const it = currentItem();
  const clipPath = it.dedicatedNote && S.mode === 'rest' ? `${S.clippingsFolder}/${safeFileName(it.title)}.md` : null;
  $('preview').textContent = renderEntry(S, { ...it, clipPath });
  $('target').textContent = `${S.bookmarksFile} › ${category}`;
}

/* ----- Reminders: fixed offsets or a chosen date & time, optionally repeating ----- */

let reminders = new Map(); // canonical url → { at, repeat }
const localInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const whenText = (r) =>
  `⏰ ${new Date(r.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${r.repeat ? ` · ${r.repeat}` : ''}`;
const tomorrow9 = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
};

async function loadReminders() {
  const { reminders: list = [] } = await chrome.storage.local.get('reminders');
  reminders = new Map(list.filter((r) => !r.snooze).map((r) => [canonUrl(r.url), r]));
}

$('remind').onchange = () => {
  const v = $('remind').value;
  $('remind-at').hidden = v !== 'pick';
  $('remind-repeat').hidden = !v;
  if (v === 'pick' && !$('remind-at').value) $('remind-at').value = localInput(tomorrow9());
};

function setReminder(item) {
  const v = $('remind').value;
  if (!v) return;
  const at = v === 'pick' ? new Date($('remind-at').value).getTime() : Date.now() + +v * 86400000;
  if (!(at > Date.now())) return toast('Reminder not set: pick a time in the future', true);
  send('remind', { url: item.url, title: item.title, at, repeat: $('remind-repeat').value }).catch((e) => toast(e.message, true));
  $('remind').value = $('remind-repeat').value = '';
  $('remind').onchange();
}

// The bell on a bookmark row opens this bar to set, change or remove its reminder.
let reminding = null;
function openRemindBar(e) {
  reminding = e;
  const r = reminders.get(canonUrl(e.url));
  $('rb-title').textContent = e.title;
  $('rb-at').value = localInput(r?.at || tomorrow9());
  $('rb-repeat').value = r?.repeat || '';
  $('rb-del').hidden = !r;
  $('remind-bar').hidden = false;
}
const closeRemindBar = () => (($('remind-bar').hidden = true), (reminding = null));
const afterReminderChange = async (msg) => {
  closeRemindBar();
  await loadReminders();
  renderList();
  toast(msg);
};
$('rb-close').onclick = closeRemindBar;
$('rb-set').onclick = () => {
  const at = new Date($('rb-at').value).getTime();
  if (!(at > Date.now())) return toast('Pick a time in the future', true);
  send('remind', { url: reminding.url, title: reminding.title, at, repeat: $('rb-repeat').value }).then(() => afterReminderChange('Reminder set'), (e) => toast(e.message, true));
};
$('rb-del').onclick = () => send('unremind', { url: reminding.url }).then(() => afterReminderChange('Reminder removed'), (e) => toast(e.message, true));

async function doSave(open) {
  if (!page.url) return;
  const btns = [$('save'), $('save-open')];
  btns.forEach((b) => (b.disabled = true));
  try {
    if (editing) {
      const e = editing;
      const item = { ...currentItem(), date: e.date, done: e.done, notePath: e.notePath };
      await send('update', { url: e.url, file: e.file, section: e.section, item });
      setReminder(item);
      toast('Updated');
      await stopEdit();
      loadBookmarks();
      document.querySelector('.tabs [data-tab="browse"]').click();
      return;
    }
    const saved = currentItem(open);
    const r = await send('save', { item: saved });
    setReminder(saved);
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
$('save-open').onclick = () => (editing ? stopEdit() : doSave(true));

// Typing [[ in the Note box suggests notes from the vault; Tab or a click completes the link.
let noteTimer;
$('note').addEventListener('input', () => {
  clearTimeout(noteTimer);
  const note = $('note');
  const m = /\[\[([^[\]]*)$/.exec(note.value.slice(0, note.selectionStart));
  if (!m || S.mode !== 'rest' || m[1].trim().length < 2) return $('note-suggest').replaceChildren();
  noteTimer = setTimeout(async () => {
    const q = m[1].trim().toLowerCase();
    const found = await send('search', { query: q }).catch(() => []);
    const names = [...new Set(found.map((r) => r.filename.split('/').pop().replace(/\.md$/, '')))];
    names.sort((a, b) => b.toLowerCase().includes(q) - a.toLowerCase().includes(q));
    $('note-suggest').replaceChildren(
      ...names.slice(0, 6).map((n) =>
        el('button', {
          className: 'chip',
          textContent: `[[${n}]]`,
          onclick: () => {
            const at = note.selectionStart;
            note.value = `${note.value.slice(0, at - m[0].length)}[[${n}]] ${note.value.slice(at)}`;
            $('note-suggest').replaceChildren();
            note.focus();
            updatePreview();
          },
        })
      )
    );
  }, 250);
});
$('note').addEventListener('keydown', (e) => {
  const first = $('note-suggest').firstElementChild;
  if (e.key !== 'Tab' || e.shiftKey || !first) return;
  e.preventDefault();
  first.click();
});
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
  const hits = editing || !page.url ? [] : data.entries.filter((e) => canonUrl(e.url) === canonUrl(page.url));
  box.hidden = !hits.length;
  if (!hits.length) return;
  // The same link can sit in several sections; name every one.
  const parts = hits.flatMap((h, i) => [
    i ? (i === hits.length - 1 ? ' and ' : ', ') : '',
    el('b', { textContent: h.section || 'bookmarks' }),
    `${h.date ? ` on ${h.date}` : ''}${h.done === false ? ' · unread' : h.done ? ' · read' : ''}`,
  ]);
  const hit = hits[0];
  box.replaceChildren(
    'Already saved in ',
    ...parts,
    '. ',
    el('a', { textContent: 'Open in Obsidian', onclick: () => send('open', { path: hit.notePath ? `${hit.notePath}.md` : hit.file }) })
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
  catTouched = false;
  category = suggestCategory();
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

const limits = new Map(); // section → how many entries are shown
const opened = new Set(); // sections unfolded by hand in a large collection

function renderStats() {
  const all = data.entries;
  if (!all.length) return $('stats').replaceChildren();
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const top = (pairs) => [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join(', ');
  const sections = new Map();
  for (const e of all) sections.set(e.section, (sections.get(e.section) || 0) + 1);
  const b = (n) => el('b', { textContent: n });
  $('stats').replaceChildren(
    b(all.length), ' bookmarks · ',
    b(all.filter((e) => e.done === false).length), ' to read · ',
    b(all.filter((e) => e.date >= weekAgo).length), ' saved this week · top sections: ', top(sections),
    bookmarkTagCounts().size ? ` · top tags: ${top(bookmarkTagCounts())}` : ''
  );
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
  renderStats();
  const show = $('show').value;
  const list = $('list');
  const site = domainOf(page.url || '');
  let items = data.entries.filter((e) => {
    if (show === 'unread' && e.done !== false) return false;
    if (show === 'done' && e.done !== true) return false;
    if (show === 'site' && domainOf(e.url) !== site) return false;
    if (show === 'broken' && !broken.has(e.url)) return false;
    if (show === 'pinned' && !e.pinned) return false;
    if (show === 'reminders' && !reminders.has(canonUrl(e.url))) return false;
    if (!f) return true;
    const hay = [e.title, e.url, e.section, e.note, ...e.tags].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  if (show === 'recent') items = [...items].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  shown = items;
  if (!items.length && (f || show !== 'all')) {
    list.replaceChildren(el('div', { className: 'empty', textContent: 'No matches.' }));
    return;
  }
  const groups = new Map(); // keyed without emoji/case so "Dev" and "💻 Dev" are one group
  const group = (name) => groups.get(norm(name)) || groups.set(norm(name), [name, []]).get(norm(name));
  // Unfiltered view lists every section, including empty ones.
  if (!f && show === 'all') [...S.categories, ...data.sections].forEach(group);
  const flat = { recent: 'Recent', reminders: 'Reminders' }[show]; // views shown as one list instead of by section
  if (flat === 'Reminders') items.sort((a, b) => reminders.get(canonUrl(a.url)).at - reminders.get(canonUrl(b.url)).at);
  for (const e of items) group(flat || e.section || 'Unsorted')[1].push(e);
  const order = SORTS[$('sort').value];
  for (const g of groups.values()) {
    if (order) g[1].sort(order);
    g[1].sort((a, b) => b.pinned - a.pinned); // pinned first; the sort is stable, so the rest keep their order
  }
  const out = [];
  // Large collections: sections start folded, and each shows 50 entries at a time, so the popup stays fast.
  const big = data.entries.length > 200 && !f && show === 'all';
  for (const [section, entries] of groups.values()) {
    const key = norm(section);
    const limit = limits.get(key) || 50;
    const h = el('div', { className: 'group-h' }, el('span', { textContent: section }), el('span', { textContent: entries.length }));
    if (big && !opened.has(key)) h.classList.add('collapsed');
    h.onclick = () => (h.classList.toggle('collapsed') ? opened.delete(key) : opened.add(key));
    const rest = entries.length - limit;
    const more =
      rest > 0
        ? el('button', {
            className: 'small more',
            textContent: `Show ${Math.min(100, rest)} more (${rest} hidden)`,
            onclick: () => (limits.set(key, limit + 100), renderList()),
          })
        : null;
    const g = el('div', { className: 'group' }, ...entries.slice(0, limit).map(renderItem), more);
    // Drop a dragged bookmark on a section (its header or its list) to move it there.
    for (const zone of [h, g]) {
      zone.ondragover = (ev) => {
        if (!dragged || flat || norm(dragged.section) === norm(section)) return;
        ev.preventDefault();
        h.classList.add('drop');
      };
      zone.ondragleave = () => h.classList.remove('drop');
      zone.ondrop = (ev) => {
        ev.preventDefault();
        h.classList.remove('drop');
        const e = dragged;
        send('move', { url: e.url, file: e.file, section: e.section, to: section }).then(
          () => (toast(`Moved to ${section}`), loadBookmarks()),
          (err) => toast(err.message, true)
        );
      };
    }
    out.push(h, g);
  }
  list.replaceChildren(...out);
  if (focusIdx >= 0) setFocus(focusIdx);
  renderBulk();
}

const SORTS = {
  new: (a, b) => b.date.localeCompare(a.date),
  old: (a, b) => a.date.localeCompare(b.date),
  title: (a, b) => a.title.localeCompare(b.title),
  domain: (a, b) => domainOf(a.url).localeCompare(domainOf(b.url)) || a.title.localeCompare(b.title),
};

let shown = []; // entries matching the current view (used by "Select all shown" and "Check links")
let broken = new Map(); // url → why it failed the last link check

/* ----- Selecting several bookmarks and acting on them together ----- */

const selected = new Set();
let selectMode = false;

function toggleSel(e) {
  selected.has(e) ? selected.delete(e) : selected.add(e);
  renderList();
}

function renderBulk() {
  $('bulk').hidden = !selectMode && !selected.size;
  $('select-mode').classList.toggle('on', selectMode);
  $('bulk-n').textContent = `${selected.size} selected`;
  const cats = [...S.categories];
  for (const s of data.sections) if (!cats.some((c) => norm(c) === norm(s))) cats.push(s);
  $('bulk-move').replaceChildren(new Option('Move to…', ''), ...cats.map((c) => new Option(c, c)));
}

async function bulk(label, fn) {
  const items = [...selected];
  if (!items.length) return toast('Select some bookmarks first', true);
  let failed = 0;
  try {
    await send('snapshot', { backup: true }); // for Undo, plus a dated copy in Bookmarks/Backups
  } catch (e) {
    return toast(e.message, true);
  }
  toast(`${label}: working on ${items.length}…`);
  for (const e of items) await Promise.resolve(fn(e)).catch(() => failed++); // one at a time: each rewrites the note
  selected.clear();
  await loadBookmarks();
  toast(failed ? `${label}: ${failed} of ${items.length} failed` : `${label}: ${items.length} done`, !!failed, UNDO);
}

const UNDO = {
  label: 'Undo',
  fn: () => send('restore').then(() => (toast('Restored'), loadBookmarks()), (e) => toast(e.message, true)),
};

async function removeOne(e) {
  if (!confirm(`Delete "${e.title}" from your bookmarks?`)) return;
  try {
    await send('snapshot');
    await send('remove', { url: e.url, file: e.file });
    await loadBookmarks();
    toast('Deleted', false, UNDO);
  } catch (err) {
    toast(err.message, true);
  }
}

$('export').onchange = (ev) => {
  const kind = ev.target.value;
  ev.target.value = '';
  if (!kind || !shown.length) return;
  const text = kind === 'csv' ? toCsv(shown) : toNetscape(shown);
  const a = el('a', {
    href: URL.createObjectURL(new Blob([text], { type: kind === 'csv' ? 'text/csv' : 'text/html' })),
    download: `obsidian-bookmarks.${kind}`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${shown.length} bookmarks`);
};

/** The edit-form shape of an existing entry, optionally with one more tag. */
const asItem = (e, tag) => ({
  title: e.title,
  url: e.url,
  category: e.section,
  tags: [...new Set([...userTags(e), ...(tag ? [tag] : [])])],
  note: e.note,
  readLater: e.done !== null,
  done: e.done,
  date: e.date,
  notePath: e.notePath,
});

$('select-mode').onclick = () => {
  selectMode = !selectMode;
  if (!selectMode) selected.clear();
  renderList();
};
$('bulk-clear').onclick = () => {
  selectMode = false;
  selected.clear();
  renderList();
};
$('bulk-all').onclick = () => {
  shown.forEach((e) => selected.add(e));
  renderList();
};
$('bulk-move').onchange = (ev) => {
  const to = ev.target.value;
  if (to) bulk(`Move to ${to}`, (e) => norm(e.section) !== norm(to) && send('move', { url: e.url, file: e.file, section: e.section, to }));
};
$('bulk-tag').onkeydown = (ev) => {
  const tag = normTag(ev.target.value).slice(1);
  if (ev.key !== 'Enter' || !tag) return;
  ev.target.value = '';
  // Image entries are skipped: rewriting their line would drop the embedded picture.
  bulk(`Tag #${tag}`, (e) => (e.image ? Promise.reject() : send('update', { url: e.url, file: e.file, section: e.section, item: asItem(e, tag) })));
};
$('bulk-read').onclick = () => bulk('Mark read', (e) => e.done === false && send('toggleRead', { url: e.url, file: e.file }));
$('bulk-del').onclick = () =>
  confirm(`Delete ${selected.size} bookmarks from your notes?`) && bulk('Delete', (e) => send('remove', { url: e.url, file: e.file }));

$('check').onclick = async () => {
  // Asked for only when you use this button: checking a link means requesting it.
  if (!(await chrome.permissions.request({ origins: ['<all_urls>'] }))) return toast('Site access is needed to check links', true);
  const urls = [...new Set(shown.map((e) => e.url))].slice(0, 200);
  toast(`Checking ${urls.length} links…`);
  try {
    const dead = await send('checkLinks', { urls });
    broken = new Map(dead.map((d) => [d.url, d.reason]));
    if (dead.length) $('show').value = 'broken';
    renderList();
    toast(dead.length ? `${dead.length} of ${urls.length} links are broken` : `All ${urls.length} links load`, !!dead.length);
  } catch (e) {
    toast(e.message, true);
  }
};

/* ----- Keyboard: / filter · ↑↓ move · Enter open · e edit · x select · Delete remove ----- */

let focusIdx = -1;
const visibleItems = () => [...document.querySelectorAll('#list .item')].filter((n) => n.offsetParent);

function setFocus(i) {
  const items = visibleItems();
  items.forEach((n) => n.classList.remove('focused'));
  focusIdx = Math.max(-1, Math.min(i, items.length - 1));
  const n = items[focusIdx];
  if (n) {
    n.classList.add('focused');
    n.scrollIntoView({ block: 'nearest' });
  }
}

document.addEventListener('keydown', (ev) => {
  if ($('tab-browse').hidden || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    if (typing && ev.target.id !== 'filter') return;
    ev.preventDefault();
    if (typing) ev.target.blur();
    setFocus(focusIdx + (ev.key === 'ArrowDown' ? 1 : -1));
    if (focusIdx === -1) $('filter').focus();
    return;
  }
  if (typing) return void (ev.key === 'Escape' && ev.target.blur());
  if (ev.key === '/') return void (ev.preventDefault(), $('filter').focus());
  const e = visibleItems()[focusIdx]?.entry;
  if (!e) return;
  if (ev.key === 'Enter') openTab(e.url);
  else if (ev.key === 'e') e.image || startEdit(e);
  else if (ev.key === 'x' || ev.key === ' ') ev.preventDefault(), toggleSel(e);
  else if (ev.key === 'p') send('pin', { url: e.url, file: e.file }).then(() => loadBookmarks(), (err) => toast(err.message, true));
  else if (ev.key === 'Delete' || ev.key === 'Backspace') removeOne(e);
});

let dragged = null; // bookmark being dragged between sections
let editing = null; // bookmark loaded into the Save tab for editing

function startEdit(e) {
  editing = e;
  page = { url: e.url, title: e.title, selection: '', description: '', image: '' };
  $('title').value = e.title;
  $('url').textContent = e.url;
  $('fav').src = favicon(e.url);
  $('tags').value = userTags(e).join(' ');
  $('note').value = e.note;
  $('readlater').checked = e.done !== null;
  $('dedicated').checked = false;
  $('sel-wrap').hidden = true;
  category = e.section;
  $('save').firstChild.textContent = 'Update ';
  $('save-open').textContent = 'Cancel';
  $('save').disabled = $('save-open').disabled = false;
  for (const id of ['dedicated', 'save-tabs']) $(id).closest('label, button').hidden = true;
  document.querySelector('.tabs [data-tab="save"]').click();
  renderCats();
  renderTagSuggestions();
  showDuplicate();
  updatePreview();
}

function stopEdit() {
  editing = null;
  $('save').firstChild.textContent = 'Save ';
  $('save-open').textContent = 'Save & open in Obsidian';
  for (const id of ['dedicated', 'save-tabs']) $(id).closest('label, button').hidden = false;
  return loadPage();
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
  const rem = reminders.get(canonUrl(e.url));
  if (rem) meta.prepend(el('span', { className: 'rem', textContent: `${whenText(rem)} · ` }));
  if (broken.has(e.url)) meta.prepend(el('span', { className: 'bad', textContent: `⚠ ${broken.get(e.url)} · ` }));
  meta.title = meta.textContent;
  const tools = el(
    'div',
    { className: 'tools' },
    e.notePath ? el('button', { textContent: 'Note', title: 'Open its note in Obsidian', onclick: () => send('open', { path: `${e.notePath}.md` }) }) : null,
    e.notePath ? el('button', { textContent: 'View', title: 'Preview note here', onclick: () => viewNote(`${e.notePath}.md`) }) : null,
    // Not for image entries: rewriting their line would drop the embedded picture.
    e.image ? null : el('button', { textContent: 'Edit', title: 'Edit title, section, tags and note', onclick: () => startEdit(e) }),
    el('button', { textContent: '⏰', className: rem ? 'on' : '', title: rem ? 'Change or remove the reminder' : 'Remind me about this', onclick: () => openRemindBar(e) }),
    el('button', {
      textContent: e.pinned ? '★' : '☆',
      className: e.pinned ? 'on' : '',
      title: e.pinned ? 'Unpin' : 'Pin to the top of its section',
      onclick: () => send('pin', { url: e.url, file: e.file }).then(() => loadBookmarks(), (err) => toast(err.message, true)),
    }),
    el('button', { textContent: '✕', title: 'Delete this bookmark', onclick: () => removeOne(e) })
  );
  const row = el(
    'div',
    {
      className: `item${e.done ? ' done' : ''}${!editing && isCurrent()(e) ? ' current' : ''}${selected.has(e) ? ' sel' : ''}`,
      entry: e,
      draggable: true,
      ondragstart: (ev) => {
        dragged = e;
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', e.url);
      },
      ondragend: () => (dragged = null),
    },
    box || el('img', { className: 'fav', src: favicon(e.url), alt: '', loading: 'lazy' }),
    el('div', { className: 'body' }, el('a', { className: 't', title: e.url, onclick: () => openTab(e.url) }, e.pinned ? el('span', { className: 'pin', textContent: '★' }) : null, e.title || e.url), meta),
    tools
  );
  // While selecting, a click anywhere on the row selects it instead of opening, ticking or editing.
  row.addEventListener(
    'click',
    (ev) => {
      if (!selectMode && !ev.metaKey && !ev.ctrlKey) return;
      ev.preventDefault();
      ev.stopPropagation();
      toggleSel(e);
    },
    true
  );
  return row;
}

$('filter').addEventListener('input', () => (limits.clear(), renderList()));
$('show').addEventListener('change', renderList);
$('sort').addEventListener('change', renderList);

async function loadBookmarks(quiet = false) {
  if (S.mode !== 'rest' || !S.apiKey) {
    $('list').replaceChildren(el('div', { className: 'empty', textContent: 'Browsing bookmarks needs the Local REST API mode. Use “Open bookmarks note” (↗) instead.' }));
    return;
  }
  try {
    const next = await send('bookmarks');
    if (quiet && JSON.stringify(next) === JSON.stringify(data)) return; // nothing changed in Obsidian
    data = next;
    $('count').textContent = data.entries.length || '';
  } catch (e) {
    if (!quiet) $('list').replaceChildren(el('div', { className: 'empty', textContent: e.message }));
    return;
  }
  selected.clear(); // they point at the old list
  await loadReminders();
  if (!editing && !catTouched && page.url) category = suggestCategory();
  renderList();
  renderCats();
  renderTagSuggestions();
  showDuplicate();
}

// Pick up edits made in Obsidian while the popup or side panel stays open.
setInterval(() => {
  if (S && !editing && !selected.size && !dragged && document.visibilityState === 'visible') loadBookmarks(true);
}, 15000);

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
  document.documentElement.dataset.theme = $('theme').value = S.theme;
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
