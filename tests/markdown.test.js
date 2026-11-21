import { DEFAULTS } from '../src/lib/settings.js';
import * as m from '../src/lib/markdown.js';
import assert from 'node:assert';
const s = { ...DEFAULTS };
let doc = m.newBookmarksFile(s);
const e1 = m.renderEntry(s, { title: 'Repo [one]', url: 'https://github.com/a/b', category: m.categorize('https://github.com/a/b', s), tags: ['tools', '#ai'], note: 'cool', readLater: true });
console.log(e1);
doc = m.insertUnderHeading(doc, m.categorize('https://github.com/a/b', s), e1);
const e2 = m.renderEntry(s, { title: 'Second', url: 'https://gitlab.com/x', category: '💻 Dev', tags: [], readLater: false, selection: 'line one\nline two' });
doc = m.insertUnderHeading(doc, 'Dev', e2);
const e3 = m.renderEntry(s, { title: 'Clip', url: 'https://x.com/p(1)', category: 'Brand New', clipPath: 'Bookmarks/Clippings/Clip.md', readLater: true });
doc = m.insertUnderHeading(doc, 'Brand New', e3);
doc = m.insertUnderHeading(doc, 'Brand New', m.renderEntry(s, { title: 'Later', url: 'https://z.org', category: 'Brand New' }), { newestFirst: false });
const img = m.renderImageEntry(s, { embed: '![[Bookmarks/Attachments/a.png|300]]', pageTitle: 'Pic page', pageUrl: 'https://img.site/p' });
doc = m.insertUnderHeading(doc, '🖼 Images', img);
console.log('-----\n' + doc + '\n-----');
const { entries, sections } = m.parseBookmarks(doc);
console.log(entries.map(e => [e.section, e.title, e.url, e.done, e.tags.join(','), e.note, e.notePath, e.image].join(' | ')).join('\n'));
assert.equal(entries.length, 5);
assert.equal(entries.find(e => e.url === 'https://github.com/a/b').title, 'Repo [one]');
assert.equal(entries.find(e => e.title === 'Clip').notePath, 'Bookmarks/Clippings/Clip');
const t = m.toggleEntry(doc, 'https://github.com/a/b/');
assert.ok(t.includes('- [x] [Repo'));
assert.equal(m.categorize('https://www.youtube.com/watch?v=1', s), 'Videos');
assert.equal(m.categorize('https://example.com', s), 'Inbox');
console.log(m.renderClipping(s, { title: 'T "q"', url: 'https://a.b/c', category: '💻 Dev', tags: ['x'], description: 'desc', selection: 'hi', note: 'n', readLater: true }));
console.log(m.renderMarkdown('# H\n- [ ] [a](javascript:alert(1)) #tag <b>x</b>\n> [!info] hello **b**'));
console.log('ALL OK');
{
  const d = m.insertUnderHeading(m.newBookmarksFile(s), 'Images', m.renderImageEntry(s, { embed: '![a|300](https://i/x.png)', pageTitle: 'P', pageUrl: 'https://p.io' }));
  const [img] = m.parseBookmarks(d).entries;
  assert.equal(img.url, 'https://p.io');
  assert.equal(img.note, '');
  assert.equal(img.image, true);
  console.log('image entry OK');
}
{
  assert.equal(m.cleanUrl('https://a.com/p?utm_source=x&id=7&fbclid=abc'), 'https://a.com/p?id=7');
  assert.equal(m.cleanUrl('https://a.com/p?q=a b'), 'https://a.com/p?q=a b'); // untouched when nothing to strip
  assert.equal(m.cleanUrl('not a url'), 'not a url');
  assert.equal(m.canonUrl('https://a.com/p/?utm_medium=x'), m.canonUrl('https://a.com/p'));
  const d = '## Dev\n\n- [A](https://a.com)\n\t> quote\n- [ ] [B](https://b.com/?utm_source=z)\n';
  assert.equal(m.removeEntry(d, 'https://a.com/'), '## Dev\n\n- [ ] [B](https://b.com/?utm_source=z)\n');
  assert.equal(m.removeEntry(d, 'https://b.com/'), '## Dev\n\n- [A](https://a.com)\n\t> quote\n');
  assert.equal(m.removeEntry(d, 'https://nope.com'), null);
  console.log('cleanUrl / removeEntry OK');
}
{
  const old = '# T\n\n## 💻 Dev\n\n- a\n\n## My own heading\n\n## 🗂 Session 2026-11-11 10:00\n';
  assert.equal(m.shrinkSections(old, ['Dev']), '# T\n\n### Dev\n\n- a\n\n## My own heading\n\n### Session 2026-11-11 10:00\n');
  assert.equal(m.shrinkSections('### 💻 Dev\n### 🎯 Mine\n', ['Dev', '🎯 Mine']), '### Dev\n### 🎯 Mine\n');
  assert.ok(m.insertUnderHeading(m.newBookmarksFile(s), 'Brand new', '- x').includes('\n### Brand new\n'));
  console.log('shrinkSections OK');
}
{
  const d = '### Dev\n\n- [A](https://a.com)\n\t> quote\n- [B](https://b.com)\n';
  const t = m.takeEntry(d, 'https://a.com');
  assert.deepEqual(t, { content: '### Dev\n\n- [B](https://b.com)\n', block: '- [A](https://a.com)\n\t> quote', index: 2 });
  assert.equal(m.takeEntry(d, 'https://x.com'), null);
  console.log('takeEntry OK');
}
{
  const p = m.parseBookmarks('### Dev\n- [T](https://t.com) #x · t.com · 2026-01-01 — see [[Other note]] too\n- [[Clips/C|C]] [↗](https://c.com) — n\n').entries;
  assert.equal(p[0].title, 'T');
  assert.equal(p[0].notePath, null);
  assert.equal(p[0].note, 'see [[Other note]] too');
  assert.equal(p[1].title, 'C');
  assert.equal(p[1].notePath, 'Clips/C');
  console.log('wikilink-in-note OK');
}
{
  const d = '### Dev\n- [A](https://a.com) #bookmark/dev · a.com\n';
  const pinned = m.togglePin(d, 'https://a.com');
  assert.equal(pinned, '### Dev\n- [A](https://a.com) #pinned #bookmark/dev · a.com\n');
  assert.equal(m.parseBookmarks(pinned).entries[0].pinned, true);
  assert.equal(m.togglePin(pinned, 'https://a.com'), d);
  const es = m.parseBookmarks('### Dev\n- [ ] [=SUM("x")](https://a.com/?q=1&r=2) #t · a.com · 2026-01-02 — n, "q"\n').entries;
  assert.equal(m.toCsv(es).split('\r\n')[1], `"'=SUM(""x"")","https://a.com/?q=1&r=2","Dev","#t","2026-01-02","unread","n, ""q"""`);
  const html = m.toNetscape(es);
  assert.ok(html.includes('<DT><H3>Dev</H3>') && html.includes('HREF="https://a.com/?q=1&amp;r=2"') && html.includes('TAGS="t"'));
  console.log('pin / export OK');
}
