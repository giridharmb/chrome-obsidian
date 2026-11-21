// Move/edit logic against an in-memory vault (fetch is stubbed; no Obsidian needed).
import assert from 'node:assert';
import { DEFAULTS } from '../src/lib/settings.js';
import * as core from '../src/lib/core.js';

const vault = new Map();
globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
  const path = decodeURIComponent(new URL(url).pathname.replace('/vault/', ''));
  if (method === 'PUT') return vault.set(path, body), new Response('', { status: 200 });
  return vault.has(path) ? new Response(vault.get(path)) : new Response('{}', { status: 404 });
};

const s = { ...DEFAULTS, apiKey: 'k' };
const F = s.bookmarksFile;
const start = '### Inbox\n\n- [ ] [A](https://a.com) #bookmark/inbox #x · a.com · 2026-01-01\n\t> quote\n- [B](https://b.com) #bookmark/inbox\n\n### Dev\n\n- [C](https://c.com) #bookmark/dev\n';

// Drag A from Inbox to Dev: quote travels, section tag changes, B and C untouched.
vault.set(F, start);
await core.moveBookmark(s, { url: 'https://a.com', section: 'Inbox', to: 'Dev' });
assert.equal(vault.get(F), '### Inbox\n\n- [B](https://b.com) #bookmark/inbox\n\n### Dev\n\n- [ ] [A](https://a.com) #bookmark/dev #x · a.com · 2026-01-01\n\t> quote\n- [C](https://c.com) #bookmark/dev\n');

// Edit A in place (same section): position, quote, date and done-state kept.
vault.set(F, start.replace('- [ ] [A]', '- [x] [A]'));
await core.updateBookmark(s, { url: 'https://a.com', section: 'Inbox', item: { title: 'A2', url: 'https://a.com', category: 'Inbox', tags: ['y'], note: 'n', readLater: true, done: true, date: '2026-01-01' } });
assert.equal(vault.get(F), start.replace('- [ ] [A](https://a.com) #bookmark/inbox #x · a.com · 2026-01-01', '- [x] [A2](https://a.com) #bookmark/inbox #y · a.com · 2026-01-01 — n'));

// Unknown URL: error, note unchanged.
vault.set(F, start);
await assert.rejects(core.moveBookmark(s, { url: 'https://nope.com', section: 'Inbox', to: 'Dev' }));
assert.equal(vault.get(F), start);

// One note per section: entry leaves the hub note and lands in Bookmarks/Dev.md.
const split = { ...s, splitBySection: true };
vault.set(F, start);
await core.moveBookmark(split, { url: 'https://b.com', file: F, section: 'Inbox', to: 'Dev' });
assert.equal(vault.get('Bookmarks/Dev.md'), '### Dev\n\n- [B](https://b.com) #bookmark/dev\n');
assert.ok(!vault.get(F).includes('b.com') && vault.get(F).includes('c.com'));
console.log('move / edit OK');
