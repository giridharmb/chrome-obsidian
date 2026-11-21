// Drives the real service worker with a fake chrome.* and an in-memory vault, to cover the paths a
// browser test cannot click: right-click menu items, the quick-save shortcut and address-bar search.
import assert from 'node:assert';

const vault = new Map();
globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
  const u = new URL(url);
  if (u.pathname === '/') return new Response(JSON.stringify({ authenticated: true }));
  const path = decodeURIComponent(u.pathname.replace('/vault/', ''));
  if (method === 'PUT') return vault.set(path, body), new Response('', { status: 200 });
  return vault.has(path) ? new Response(vault.get(path)) : new Response('{}', { status: 404 });
};

const listeners = {};
const store = { settings: { apiKey: 'k' } };
const calls = [];
const menus = [];
let pageInfo = {};
const ev = (name) => ({ addListener: (fn) => ((listeners[name] ||= []).push(fn)) });
const leaf = (path) =>
  new Proxy(function () {}, {
    get: (_, k) => (k === 'addListener' ? ev(path).addListener : leaf(`${path}.${String(k)}`)),
    apply: (_, __, args) => (calls.push([path, ...args]), Promise.resolve(path.endsWith('query') ? [] : undefined)),
  });
const overrides = {
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (v) => void Object.assign(store, structuredClone(v)),
    },
    onChanged: ev('storage.onChanged'),
  },
  runtime: { onInstalled: ev('onInstalled'), onStartup: ev('onStartup'), onMessage: ev('onMessage'), getURL: (p) => p, lastError: null, openOptionsPage() {} },
  contextMenus: { removeAll: async () => void (menus.length = 0), create: (m) => menus.push(m), onClicked: ev('menu.onClicked') },
  scripting: { executeScript: async ({ func }) => [{ result: /alt|images/.test(String(func)) ? 'alt text' : /querySelectorAll\('a\[href\]'\)/.test(String(func)) ? 'Link text' : pageInfo }] },
  omnibox: { onInputChanged: ev('omni.changed'), onInputEntered: ev('omni.entered') },
};
globalThis.chrome = new Proxy({}, { get: (_, k) => overrides[k] ?? leaf(String(k)) });

await import('../src/background.js');
const F = 'Bookmarks/Bookmarks.md';
const tab = { id: 7, windowId: 1, title: 'Tab title', url: 'https://github.com/a/b' };
const click = (info) => listeners['menu.onClicked'][0](info, tab);
const sectionOf = (text) => {
  let section = null;
  for (const l of (vault.get(F) || '').split('\n')) {
    if (l.startsWith('### ')) section = l.slice(4);
    if (l.includes(text)) return section;
  }
  return undefined;
};

// Menus are built on install: the six actions, one sub-item per section for pages and links, two icon items.
await listeners.onInstalled[0]({ reason: 'update' });
assert.ok(menus.some((m) => m.id === 'save-page') && menus.some((m) => m.id === 'page-to:1' && m.title === 'Dev') && menus.some((m) => m.id === 'save-image'));

pageInfo = { title: 'Repo', url: 'https://github.com/a/b?utm_source=x', selection: '' };
await click({ menuItemId: 'save-page' });
assert.equal(sectionOf('[Repo](https://github.com/a/b)'), 'Dev', 'page saved by rule, tracking parameter stripped');

await click({ menuItemId: 'page-to:2' }); // "Save page to section ▸ Reading"
assert.equal(vault.get(F).split('[Repo]').length - 1, 2);
assert.ok(vault.get(F).split('### Reading')[1].includes('[Repo]'), 'page sent to the chosen section');

await click({ menuItemId: 'save-link', linkUrl: 'https://example.com/x', frameId: 0 });
assert.equal(sectionOf('[Link text](https://example.com/x)'), 'Inbox', 'link saved with its text as the title');

pageInfo = { title: 'Article', url: 'https://medium.com/p', selection: 'line one\nline two' };
await click({ menuItemId: 'save-selection', selectionText: 'line one line two' });
assert.ok(vault.get(F).includes('[Article](https://medium.com/p)') && vault.get(F).includes('\t> line one\n\t> line two'), 'highlight keeps its line breaks');

await click({ menuItemId: 'save-image', srcUrl: 'https://img.example/p.png', pageUrl: 'https://medium.com/p', frameId: 0 });
assert.equal(sectionOf('![alt text|300](https://img.example/p.png)'), 'Images');

// Quick-save shortcut.
pageInfo = { title: 'Video', url: 'https://www.youtube.com/watch?v=1', selection: '' };
await listeners['commands.onCommand'][0]('quick-save', { ...tab, url: pageInfo.url });
await new Promise((r) => setTimeout(r, 50));
assert.equal(sectionOf('[Video](https://www.youtube.com/watch?v=1)'), 'Videos');
assert.ok(calls.some((c) => c[0] === 'action.setBadgeText' && c[1].text === '✓'), 'quick-save shows a ✓ on the icon');

// Address bar: "ob <words>" suggests saved bookmarks; Enter opens the best match.
const suggestions = await new Promise((res) => listeners['omni.changed'][0]('medium article', res));
assert.deepEqual(suggestions.map((s) => s.content), ['https://medium.com/p']);
assert.ok(!/[<>&](?!dim|\/dim|url|\/url|amp;)/.test(suggestions[0].description.replace(/<\/?(dim|url)>/g, '')), 'suggestion text is escaped');
await listeners['omni.entered'][0]('youtube');
assert.ok(calls.some((c) => c[0] === 'tabs.update' && c[1].url === 'https://www.youtube.com/watch?v=1'));

// A failed background save tells the user instead of failing silently.
globalThis.fetch = async () => new Response('{}', { status: 401 });
await listeners['commands.onCommand'][0]('quick-save', { ...tab, url: pageInfo.url });
await new Promise((r) => setTimeout(r, 50));
assert.ok(calls.some((c) => c[0] === 'notifications.create' && /Could not save/.test(c[1].title)), 'error notification shown');
assert.ok(calls.some((c) => c[0] === 'action.setBadgeText' && c[1].text === '!'));

console.log('background (menus, shortcut, address bar) OK');
process.exit(0);
