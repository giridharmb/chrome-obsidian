import { getSettings } from './lib/settings.js';
import { getPageInfo, getLinkText } from './lib/page.js';
import * as core from './lib/core.js';

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
  await buildMenus();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(buildMenus);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) buildMenus();
});

/* ---------------- Feedback ---------------- */

async function flash(tabId, ok) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: ok ? '#16a34a' : '#dc2626', tabId });
    await chrome.action.setBadgeText({ text: ok ? '✓' : '!', tabId });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}), 2500);
  } catch {}
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message });
}

async function run(tab, item) {
  const s = await getSettings();
  try {
    const r = await core.saveItem(s, item);
    await flash(tab?.id, true);
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
  save: (s, m) => core.saveItem(s, m.item),
  status: (s) => core.status(s),
  bookmarks: (s) => core.getBookmarks(s),
  toggleRead: (s, m) => core.toggleRead(s, m.url),
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
