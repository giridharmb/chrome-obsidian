import { getSettings } from './lib/settings.js';
import { getPageInfo, getLinkText } from './lib/page.js';
import * as core from './lib/core.js';
import { canonUrl, stripIcon } from './lib/markdown.js';
import { advance, upsert } from './lib/reminders.js';

/* ---------------- Context menus ---------------- */

async function buildMenus() {
  const s = await getSettings();
  await chrome.contextMenus.removeAll();
  const add = (props) => chrome.contextMenus.create(props, () => void chrome.runtime.lastError);

  add({ id: 'save-page', title: 'Save page to Obsidian', contexts: ['page'] });
  add({ id: 'page-to', title: 'Save page to Obsidian section…', contexts: ['page'] });
  add({ id: 'save-link', title: 'Save link to Obsidian', contexts: ['link'] });
  add({ id: 'link-to', title: 'Save link to Obsidian section…', contexts: ['link'] });
  add({ id: 'save-selection', title: 'Save highlight to Obsidian', contexts: ['selection'] });
  add({ id: 'save-image', title: 'Save image to Obsidian', contexts: ['image'] });
  s.categories.forEach((c, i) => {
    add({ id: `page-to:${i}`, parentId: 'page-to', title: c, contexts: ['page'] });
    add({ id: `link-to:${i}`, parentId: 'link-to', title: c, contexts: ['link'] });
  });
  add({ id: 'open-bookmarks', title: 'Open bookmarks note in Obsidian', contexts: ['action'] });
  add({ id: 'open-panel', title: 'Open Obsidian side panel', contexts: ['action'] });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Sections no longer carry icons; update settings saved by an older version.
  const { settings } = await chrome.storage.local.get('settings');
  if (settings?.categories) {
    settings.categories = settings.categories.map(stripIcon);
    for (const k of ['defaultCategory', 'imageCategory']) if (settings[k]) settings[k] = stripIcon(settings[k]);
    await chrome.storage.local.set({ settings });
  }
  await buildMenus();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(buildMenus);

// Retry bookmarks that were saved while Obsidian was closed.
chrome.alarms.create('flush', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async () => {
  core.flushQueue(await getSettings()).catch(() => {});
  // Reminders ride on the same once-a-minute alarm.
  const { reminders = [], fired = {} } = await chrome.storage.local.get(['reminders', 'fired']);
  const { due, keep } = advance(reminders);
  if (!due.length) return;
  // `fired` keeps the titles so a snooze button can re-create the reminder.
  await chrome.storage.local.set({ reminders: keep, fired: { ...fired, ...Object.fromEntries(due.map((r) => [r.url, r.title])) } });
  for (const r of due) {
    chrome.notifications.create(`remind:${r.url}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: r.repeat ? `Time to read this (${r.repeat})` : 'Time to read this',
      message: r.title || r.url,
      buttons: [{ title: 'Later today' }, { title: 'Tomorrow 9:00' }],
      requireInteraction: true,
    });
  }
});

async function setReminder(r) {
  const { reminders = [] } = await chrome.storage.local.get('reminders');
  await chrome.storage.local.set({ reminders: upsert(reminders, r) });
}

async function clearReminders(url) {
  const { reminders = [] } = await chrome.storage.local.get('reminders');
  await chrome.storage.local.set({ reminders: reminders.filter((r) => r.url !== url) });
}

chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith('remind:')) return;
  chrome.tabs.create({ url: id.slice(7) });
  chrome.notifications.clear(id);
});
chrome.notifications.onButtonClicked.addListener(async (id, button) => {
  if (!id.startsWith('remind:')) return;
  const url = id.slice(7);
  const at = new Date();
  if (button === 0) at.setHours(at.getHours() + 3);
  else at.setDate(at.getDate() + 1), at.setHours(9, 0, 0, 0);
  const { fired = {} } = await chrome.storage.local.get('fired');
  await setReminder({ url, title: fired[url] || url, at: at.getTime(), repeat: '', snooze: true });
  chrome.notifications.clear(id);
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) buildMenus();
});

/* ---------------- Feedback ---------------- */

async function flash(tabId, ok, text = ok ? '✓' : '!') {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: ok ? '#16a34a' : '#dc2626', tabId });
    await chrome.action.setBadgeText({ text, tabId });
    if (tabId) setTimeout(() => chrome.tabs.get(tabId).then(markSaved, () => {}), 2500);
  } catch {}
}

/** ★ on the icon when the tab's page is already bookmarked. */
async function markSaved(tab) {
  if (!tab?.id) return;
  const s = await getSettings();
  let saved = false;
  if (s.mode === 'rest' && s.apiKey && /^https?:/.test(tab.url || '')) {
    const u = canonUrl(tab.url);
    saved = await core.cachedBookmarks(s).then((d) => d.entries.some((e) => canonUrl(e.url) === u), () => false);
  }
  try {
    if (saved) await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed', tabId: tab.id });
    await chrome.action.setBadgeText({ text: saved ? '★' : '', tabId: tab.id });
  } catch {}
}

const markActive = () => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => markSaved(t));
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId).then(markSaved, () => {}));
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === 'complete') markSaved(tab);
});

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message });
}

async function run(tab, item) {
  const s = await getSettings();
  try {
    const r = await core.saveOrQueue(s, item);
    await flash(tab?.id, true, r.queued ? '…' : '✓');
    return r;
  } catch (e) {
    await flash(tab?.id, false);
    notify('Could not save to Obsidian', e.message);
    throw e;
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  const s = await getSettings();
  const catFrom = (prefix) => (id.startsWith(prefix) ? s.categories[+id.split(':')[1]] : undefined);

  try {
    if (id === 'open-bookmarks') return core.openInObsidian(s);
    if (id === 'open-panel') return chrome.sidePanel.open({ windowId: tab.windowId });

    if (id === 'save-page' || id.startsWith('page-to:')) {
      const p = await getPageInfo(tab);
      return run(tab, { kind: 'page', ...p, selection: '', category: catFrom('page-to:') });
    }
    if (id === 'save-link' || id.startsWith('link-to:')) {
      const text = info.selectionText || (await getLinkText(tab.id, info.frameId, info.linkUrl)) || info.linkUrl;
      return run(tab, { kind: 'link', title: text, url: info.linkUrl, category: catFrom('link-to:') });
    }
    if (id === 'save-selection') {
      const p = await getPageInfo(tab);
      // Prefer the live selection (keeps line breaks); fall back to the menu's flattened text.
      return run(tab, { kind: 'selection', ...p, selection: p.selection || info.selectionText });
    }
    if (id === 'save-image') {
      const alt = await chrome.scripting
        .executeScript({
          target: { tabId: tab.id, frameIds: [info.frameId || 0] },
          args: [info.srcUrl],
          func: (src) => [...document.images].find((i) => i.currentSrc === src || i.src === src)?.alt || '',
        })
        .then(([r]) => r?.result || '')
        .catch(() => '');
      return run(tab, { kind: 'image', title: alt, srcUrl: info.srcUrl, pageUrl: info.pageUrl, pageTitle: tab.title });
    }
  } catch (e) {
    console.error(e);
  }
});

/* ---------------- Keyboard shortcut ---------------- */

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'quick-save' || !tab) return;
  const p = await getPageInfo(tab);
  run(tab, { kind: 'page', ...p }).catch(() => {});
});

/* ---------------- Messages from popup / side panel / options ---------------- */

const handlers = {
  save: (s, m) => core.saveOrQueue(s, m.item).finally(markActive),
  saveTabs: async (s) => core.saveTabs(s, await chrome.tabs.query({ lastFocusedWindow: true })),
  remove: (s, m) => core.removeBookmark(s, m.url, m.file).then(() => clearReminders(m.url)).finally(markActive),
  status: (s) => core.status(s),
  bookmarks: (s) => core.getBookmarks(s),
  tags: (s) => core.client(s).tags().catch(() => []), // older plugins: fall back to bookmark tags only
  move: (s, m) => core.moveBookmark(s, m),
  update: (s, m) => core.updateBookmark(s, m).finally(markActive),
  snapshot: (s, m) => core.snapshot(s, m),
  restore: (s) => core.restore(s).finally(markActive),
  pin: (s, m) => core.pin(s, m.url, m.file),
  remind: (s, m) => setReminder({ url: m.url, title: m.title, at: m.at, repeat: m.repeat || '' }),
  unremind: (s, m) => clearReminders(m.url),
  importBookmarks: (s, m) => core.importBookmarks(s, m.items),
  checkLinks: (s, m) => core.checkLinks(m.urls),
  toggleRead: (s, m) => core.toggleRead(s, m.url, m.file),
  search: (s, m) => core.searchVault(s, m.query),
  readNote: (s, m) => core.readNote(s, m.path),
  open: (s, m) => core.openInObsidian(s, m.path),
  openUrl: (s, m) => core.launchUri(m.url),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  getSettings()
    .then((s) => h(s, msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});

/* ---------------- Address bar: "ob <words>" searches saved bookmarks ---------------- */

const xml = (t) => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

async function matchBookmarks(text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const { entries } = await core.cachedBookmarks(await getSettings());
  return entries
    .filter((e) => {
      const hay = [e.title, e.url, e.section, e.note, ...e.tags].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .slice(0, 8);
}

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  matchBookmarks(text)
    .then((m) => suggest(m.map((e) => ({ content: e.url, description: `${xml(e.title)} <dim>${xml(e.section)}</dim> <url>${xml(e.url)}</url>` }))))
    .catch(() => {});
});

chrome.omnibox.onInputEntered.addListener(async (text) => {
  const url = /^https?:/.test(text) ? text : (await matchBookmarks(text).catch(() => []))[0]?.url;
  if (url) chrome.tabs.update({ url });
});
