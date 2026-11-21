// Move/edit logic against an in-memory vault (fetch is stubbed; no Obsidian needed).
import assert from 'node:assert';
import { DEFAULTS } from '../src/lib/settings.js';
import * as core from '../src/lib/core.js';

const vault = new Map();
globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
  const path = decodeURIComponent(new URL(url).pathname.replace('/vault/', ''));
  if (method === 'PUT') return vault.set(path, body), new Response('', { status: 200 });
  if (method === 'DELETE') return new Response('', { status: vault.delete(path) ? 200 : 404 });
  if (path.endsWith('/')) {
    const files = [...vault.keys()].filter((k) => k.startsWith(path) && !k.slice(path.length).includes('/')).map((k) => k.slice(path.length));
    return files.length ? new Response(JSON.stringify({ files })) : new Response('{}', { status: 404 });
  }
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

// Chrome import: folders become sections, saved links and non-web links are skipped, one write per section.
vault.clear();
vault.set(F, start);
const r = await core.importBookmarks(s, [
  { title: 'New', url: 'https://new.com/?utm_source=x', section: 'Dev', date: '2025-05-05' },
  { title: 'Dup', url: 'https://a.com/', section: 'Dev' },
  { title: 'Js', url: 'javascript:void(0)', section: 'Dev' },
  { title: 'Rec', url: 'https://rec.com', section: 'Recipes' },
  { title: 'Same twice', url: 'https://rec.com', section: 'Recipes' },
]);
assert.deepEqual(r, { added: 2, skipped: 3, sections: 2 });
assert.ok(vault.get(F).includes('- [New](https://new.com/) #bookmark/dev · new.com · 2025-05-05'));
assert.ok(vault.get(F).includes('### Recipes\n\n- [Rec](https://rec.com) #bookmark/recipes'));
assert.equal(vault.get(F).split('a.com').length, start.split('a.com').length);
console.log('import OK');
assert.ok([...vault.keys()].some((k) => /^Bookmarks\/Backups\/Bookmarks \d{4}-\d{2}-\d{2} \d{4}\.md\.bak$/.test(k)), 'import keeps a backup');

// Undo: snapshot, delete two, restore.
vault.clear();
vault.set(F, start);
await core.snapshot(s);
await core.removeBookmark(s, 'https://a.com');
await core.removeBookmark(s, 'https://c.com');
assert.ok(!vault.get(F).includes('a.com'));
await core.restore(s);
assert.equal(vault.get(F), start);
await assert.rejects(async () => core.restore(s)); // one undo per snapshot
await core.pin(s, 'https://b.com');
assert.ok(vault.get(F).includes('- [B](https://b.com) #pinned #bookmark/inbox'));
console.log('undo / pin OK');

// Reminder mark in the note: written, kept through an edit and a move, cleared.
vault.clear();
vault.set(F, start);
const mark = '⏰ 2026-12-01 09:00 (weekly)';
assert.equal(await core.markReminder(s, 'https://a.com', mark), true);
assert.ok(vault.get(F).includes(`2026-01-01 ${mark}\n\t> quote`), 'mark goes at the end of the entry line');
await core.updateBookmark(s, { url: 'https://a.com', section: 'Inbox', item: { title: 'A3', url: 'https://a.com', category: 'Dev', tags: [], readLater: true, date: '2026-01-01' } });
assert.ok(vault.get(F).includes(`- [ ] [A3](https://a.com) #bookmark/dev · a.com · 2026-01-01 ${mark}\n\t> quote`), 'edit + move keeps the mark');
const parsed = (await core.getBookmarks(s)).entries.find((e) => e.title === 'A3');
assert.deepEqual([parsed.date, parsed.note, parsed.remind.repeat, new Date(parsed.remind.at).getHours()], ['2026-01-01', '', 'weekly', 9]);
await core.markReminder(s, 'https://a.com', null);
assert.ok(!vault.get(F).includes('⏰'));
assert.equal(await core.markReminder(s, 'https://nope.com', mark), false);

// Backups: only the 10 newest copies of a note are kept; other files in the folder are left alone.
vault.clear();
vault.set(F, start);
for (let d = 1; d <= 14; d++) vault.set(`Bookmarks/Backups/Bookmarks 2025-01-${String(d).padStart(2, '0')} 0900.md.bak`, 'old');
vault.set('Bookmarks/Backups/my own file.md', 'keep me');
await core.snapshot(s, { backup: true });
const baks = [...vault.keys()].filter((k) => k.endsWith('.md.bak')).sort();
assert.equal(baks.length, 10);
assert.ok(!baks.some((k) => /2025-01-0[1-5] /.test(k)) && baks.some((k) => k.includes('2025-01-14')), 'the oldest copies are the ones removed');
assert.equal(vault.get('Bookmarks/Backups/my own file.md'), 'keep me');
console.log('reminder mark / backup cleanup OK');
