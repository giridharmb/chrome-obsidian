// Save/browse orchestration. Runs in the service worker so writes are serialized
// (two quick saves never clobber each other's read-modify-write).

import { RestClient, ObsidianError, uriAppend, advancedUriAppend, uriOpen } from './obsidian.js';
import {
  categorize,
  resolveCategory,
  renderEntry,
  renderImageEntry,
  renderClipping,
  newBookmarksFile,
  insertUnderHeading,
  parseBookmarks,
  toggleEntry,
  removeEntry,
  takeEntry,
  categoryTag,
  norm,
  shrinkSections,
  cleanUrl,
  fmtTime,
  safeFileName,
  fmtDate,
  slug,
  domainOf,
  canonUrl,
} from './markdown.js';

let chain = Promise.resolve();
const serialize = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

export const client = (s) => new RestClient(s);

function requireRest(s) {
  if (s.mode !== 'rest') throw new ObsidianError('This feature needs the Local REST API mode (see options).', 0);
  if (!s.apiKey) throw new ObsidianError('Set your Local REST API key in the extension options first.', 0);
}

/** Opens obsidian:// URIs without leaving a stray tab behind. */
export async function launchUri(uri) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id && /^https?:/.test(tab.url || '')) {
    await chrome.tabs.update(tab.id, { url: uri });
  } else {
    const t = await chrome.tabs.create({ url: uri, active: false });
    setTimeout(() => chrome.tabs.remove(t.id).catch(() => {}), 1500);
  }
}

export async function openInObsidian(s, path) {
  const file = path || s.bookmarksFile;
  // The URI brings the Obsidian window to the front; REST /open only switches the active note.
  if (s.mode !== 'rest' || s.vaultName) return launchUri(uriOpen({ vaultName: s.vaultName, file }));
  try {
    await client(s).open(file);
  } catch {
    await launchUri(uriOpen({ vaultName: s.vaultName, file }));
  }
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : 'Bookmarks');

/** Which note a section's entries live in. */
export const fileFor = (s, category) =>
  s.splitBySection && s.mode === 'rest'
    ? `${dirOf(s.bookmarksFile)}/${category.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'Bookmarks'}.md`
    : s.bookmarksFile;

let cache = { at: 0, data: null };

/** Serialized read → fn → write. fn gets null for a missing note and returns null to abort. */
function editNote(s, path, fn) {
  requireRest(s);
  const c = client(s);
  return serialize(async () => {
    const next = fn(await c.read(path));
    if (next == null) return false;
    await c.write(path, next);
    cache.at = 0;
    return true;
  });
}

async function appendToBookmarks(s, heading, block) {
  if (s.mode === 'rest') {
    return editNote(s, fileFor(s, heading), (cur) =>
      insertUnderHeading(shrinkSections(cur ?? (s.splitBySection ? '' : newBookmarksFile(s)), s.categories), heading, block, { newestFirst: s.newestFirst }).replace(/^\n+/, '')
    );
  }
  const uri =
    s.mode === 'advanced-uri'
      ? advancedUriAppend({ vaultName: s.vaultName, file: s.bookmarksFile, heading, content: block })
      : uriAppend({ vaultName: s.vaultName, file: s.bookmarksFile, content: block });
  await launchUri(uri);
}

async function createClipping(s, item, category) {
  const c = client(s);
  const folder = s.clippingsFolder.replace(/\/+$/, '');
  let path = `${folder}/${safeFileName(item.title)}.md`;
  if (await c.exists(path)) path = `${folder}/${safeFileName(item.title, 60)} ${fmtDate()} ${Date.now() % 100000}.md`;
  await c.write(path, renderClipping(s, { ...item, category }));
  return path;
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };

async function downloadImage(s, srcUrl) {
  const res = await fetch(srcUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0];
  if (!type.startsWith('image/')) throw new Error('Not an image');
  const base = slug(decodeURIComponent(new URL(srcUrl).pathname.split('/').pop() || '').replace(/\.\w+$/, '')).slice(0, 40) || 'image';
  const path = `${s.attachmentsFolder.replace(/\/+$/, '')}/${fmtDate()}-${base}-${Date.now() % 100000}.${EXT[type] || 'png'}`;
  await client(s).writeBinary(path, await res.arrayBuffer(), type);
  return path;
}

/**
 * item: { kind: 'page'|'link'|'selection'|'image', title, url, category?, tags?, note?, selection?,
 *         readLater?, dedicatedNote?, description?, image?, srcUrl?, pageUrl?, pageTitle?, open? }
 */
export async function saveItem(s, item) {
  let category;
  let block;
  let notePath = null;
  item = { ...item, url: cleanUrl(item.url), pageUrl: cleanUrl(item.pageUrl) };

  if (item.kind === 'image') {
    category = s.imageCategory;
    let embed = `![${(item.title || 'image').replace(/[[\]|]/g, '')}|300](${item.srcUrl})`;
    if (s.mode === 'rest' && s.downloadImages && /^https?:/.test(item.srcUrl)) {
      try {
        embed = `![[${await downloadImage(s, item.srcUrl)}|300]]`;
      } catch (e) {
        console.warn('Image download failed, embedding remote URL instead:', e);
      }
    }
    block = renderImageEntry(s, { embed, pageTitle: item.pageTitle, pageUrl: item.pageUrl, tags: item.tags });
  } else {
    category = item.category ? resolveCategory(item.category, s.categories) : categorize(item.url, s);
    if (item.dedicatedNote && s.mode === 'rest') {
      requireRest(s);
      notePath = await createClipping(s, item, category);
    }
    block = renderEntry(s, {
      title: item.title,
      url: item.url,
      category,
      tags: item.tags || [],
      note: item.note,
      selection: item.selection,
      readLater: item.readLater ?? s.readLater,
      clipPath: notePath,
      date: item.date,
    });
  }

  const file = fileFor(s, category);
  await appendToBookmarks(s, category, block);
  if (s.dailyNote && s.mode === 'rest') {
    // Best effort: needs Obsidian's Daily notes plugin; the bookmark itself is already saved.
    await client(s).appendDaily(block).catch((e) => console.warn('Daily note logging failed:', e));
  }
  if (item.open) await openInObsidian(s, notePath || file);
  return { category, notePath, file, url: item.url };
}

/** Like saveItem, but if Obsidian is unreachable the item is kept and saved later by flushQueue. */
export async function saveOrQueue(s, item) {
  try {
    return await saveItem(s, item);
  } catch (e) {
    if (!e.offline) throw e;
    const { queue = [] } = await chrome.storage.local.get('queue');
    await chrome.storage.local.set({ queue: [...queue, { ...item, date: fmtDate(), open: false }] });
    return { queued: true };
  }
}

let flushing = false;
export async function flushQueue(s) {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const { queue = [] } = await chrome.storage.local.get('queue');
      if (!queue.length) return;
      try {
        await saveItem(s, queue[0]);
      } catch (e) {
        if (e.offline) return; // still down; try again on the next alarm
        console.warn('Dropping queued bookmark that cannot be saved:', queue[0].url, e);
      }
      // Re-read so items queued while we were saving are not lost.
      const now = (await chrome.storage.local.get('queue')).queue || [];
      await chrome.storage.local.set({ queue: now.slice(1) });
    }
  } finally {
    flushing = false;
  }
}

/** Save every tab as one dated "Session" section. */
export async function saveTabs(s, tabs) {
  const pages = tabs.filter((t) => /^https?:/.test(t.url || ''));
  if (!pages.length) throw new ObsidianError('No web pages open in this window.', 0);
  const section = `Session ${fmtDate()} ${fmtTime()}`;
  const block = pages
    .map((t) => renderEntry(s, { title: t.title, url: cleanUrl(t.url), category: 'Session', tags: [], readLater: s.readLater }))
    .join('\n');
  await appendToBookmarks(s, section, block);
  return { count: pages.length, category: section };
}

export async function getBookmarks(s) {
  requireRest(s);
  const c = client(s);
  const files = s.splitBySection ? [...new Set([s.bookmarksFile, ...(await c.list(dirOf(s.bookmarksFile)))])] : [s.bookmarksFile];
  const out = { entries: [], sections: [] };
  for (const file of files) {
    const content = await c.read(file);
    if (!content) continue;
    const p = parseBookmarks(content);
    out.entries.push(...p.entries.map((e) => ({ ...e, file })));
    out.sections.push(...p.sections);
  }
  return out;
}

/** getBookmarks with a 60s cache, for the icon badge and address-bar search. */
export async function cachedBookmarks(s) {
  if (!cache.data || Date.now() - cache.at > 60000) cache = { at: Date.now(), data: await getBookmarks(s) };
  return cache.data;
}

export async function findExisting(s, url) {
  const { entries } = await getBookmarks(s);
  const u = canonUrl(url);
  return entries.find((e) => canonUrl(e.url) === u) || null;
}

export async function toggleRead(s, url, file) {
  if (!(await editNote(s, file || s.bookmarksFile, (cur) => cur && toggleEntry(cur, url)))) throw new ObsidianError('Entry has no read-later checkbox.', 0);
}

/** Removes the list entry only; a dedicated note or downloaded image stays in the vault. */
export async function removeBookmark(s, url, file) {
  if (!(await editNote(s, file || s.bookmarksFile, (cur) => cur && removeEntry(cur, url)))) throw new ObsidianError('Bookmark not found in the note.', 0);
}

/**
 * Moves an entry to section `to` (drag and drop). With `line`, also replaces its first line (edit);
 * indented children such as the highlight quote always travel with it.
 */
export async function moveBookmark(s, { url, file, section, to, line }) {
  requireRest(s);
  const from = file || s.bookmarksFile;
  const target = fileFor(s, to);
  const [oldTag, newTag] = [categoryTag(s, section || ''), categoryTag(s, to)];
  const redo = (block) => {
    const [first, ...rest] = block.split('\n');
    const retagged = first.split(' ').map((w) => (oldTag && w === oldTag ? newTag : w)).join(' ');
    return [line ?? retagged, ...rest].join('\n');
  };
  const place = (cur, block) =>
    insertUnderHeading(shrinkSections(cur ?? '', s.categories), to, block, { newestFirst: s.newestFirst }).replace(/^\n+/, '');
  const missing = new ObsidianError('Bookmark not found in the note.', 0);

  if (target === from) {
    const ok = await editNote(s, from, (cur) => {
      const t = cur && takeEntry(cur, url);
      if (!t) return null;
      if (norm(section) !== norm(to)) return place(t.content, redo(t.block));
      const lines = t.content.split('\n'); // same section: keep its position
      lines.splice(t.index, 0, redo(t.block));
      return lines.join('\n');
    });
    if (!ok) throw missing;
    return;
  }
  const t = takeEntry((await client(s).read(from)) || '', url);
  if (!t) throw missing;
  // Add before removing: if the second write fails you get a duplicate, never a lost bookmark.
  await editNote(s, target, (cur) => place(cur, redo(t.block)));
  await editNote(s, from, (cur) => cur && removeEntry(cur, url));
}

/** Rewrites an entry from the popup's edit form. */
export function updateBookmark(s, { url, file, section, item }) {
  const to = resolveCategory(item.category, s.categories);
  let line = renderEntry(s, {
    title: item.title,
    url: cleanUrl(item.url),
    category: to,
    tags: item.tags || [],
    note: item.note,
    readLater: item.readLater,
    clipPath: item.notePath ? `${item.notePath}.md` : null,
    date: item.date || undefined,
  });
  if (item.done) line = line.replace('- [ ] ', '- [x] ');
  return moveBookmark(s, { url, file, section, to, line });
}

/** Adds many bookmarks at once (Chrome import): one write per section; links already saved are skipped. */
export async function importBookmarks(s, items) {
  const have = new Set((await getBookmarks(s)).entries.map((e) => canonUrl(e.url)));
  const bySection = new Map();
  let added = 0;
  for (const it of items) {
    if (!/^https?:/.test(it.url || '') || have.has(canonUrl(it.url))) continue;
    have.add(canonUrl(it.url));
    const section = resolveCategory(it.section || s.defaultCategory, s.categories);
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(renderEntry(s, { title: it.title || it.url, url: cleanUrl(it.url), category: section, tags: [], readLater: false, date: it.date }));
    added++;
  }
  for (const [section, blocks] of bySection) await appendToBookmarks(s, section, blocks.join('\n'));
  return { added, skipped: items.length - added, sections: bySection.size };
}

/**
 * Which of these links no longer load: [{ url, reason }]. Only a 404/410 or no answer at all counts;
 * sites that merely refuse automated requests (401/403/429/5xx) are left alone.
 * shortcut: runs inside one message, so the caller caps the list; move to a background job if you need thousands.
 */
export async function checkLinks(urls) {
  const dead = [];
  const queue = [...urls];
  const probe = async (url) => {
    for (const method of ['HEAD', 'GET']) {
      try {
        const r = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(6000) });
        r.body?.cancel();
        if (r.ok) return;
        if (method === 'GET' && (r.status === 404 || r.status === 410)) return dead.push({ url, reason: String(r.status) });
      } catch {
        if (method === 'GET') dead.push({ url, reason: 'no answer' });
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (queue.length) await probe(queue.shift());
  }));
  return dead;
}

export async function searchVault(s, query) {
  requireRest(s);
  const results = await client(s).search(query);
  return results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 40);
}

export async function readNote(s, path) {
  requireRest(s);
  let p = path.endsWith('.md') ? path : `${path}.md`;
  return client(s).read(p);
}

export async function status(s) {
  if (s.mode !== 'rest') return { ok: true, mode: s.mode, message: `Using ${s.mode === 'uri' ? 'obsidian:// URI' : 'Advanced URI'} mode` };
  if (!s.apiKey) return { ok: false, mode: s.mode, message: 'API key not set' };
  try {
    const st = await client(s).status();
    return st.authenticated
      ? { ok: true, mode: s.mode, message: `Connected · ${st.service || 'Local REST API'} ${st.versions?.self || ''}`.trim() }
      : { ok: false, mode: s.mode, message: 'API key rejected' };
  } catch (e) {
    return { ok: false, mode: s.mode, message: e.message };
  }
}

export { domainOf };
