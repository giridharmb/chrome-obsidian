import assert from 'node:assert';
import { nextTime, advance, upsert } from '../src/lib/reminders.js';

const at = new Date(2026, 0, 31, 9, 0).getTime(); // 31 Jan 09:00 local
const day = 86400000;
assert.equal(nextTime(at, 'daily', at), at + day);
assert.equal(nextTime(at, 'weekly', at + 10 * day), at + 14 * day); // skips occurrences missed while Chrome was closed
assert.ok(nextTime(at, 'monthly', at) > at + 27 * day);

const list = [
  { url: 'a', at: at - 1, repeat: '' },
  { url: 'b', at: at - 1, repeat: 'daily' },
  { url: 'c', at: at + day, repeat: '' },
];
const { due, keep } = advance(list, at);
assert.deepEqual(due.map((r) => r.url), ['a', 'b']);
assert.deepEqual(keep.map((r) => r.url), ['b', 'c']);
assert.equal(keep[0].at, at - 1 + day);

let rs = upsert([], { url: 'a', at: 1, repeat: 'daily' });
rs = upsert(rs, { url: 'a', at: 2, snooze: true }); // snoozing must not cancel the repeat
rs = upsert(rs, { url: 'a', at: 3, repeat: 'weekly' });
assert.deepEqual(rs, [{ url: 'a', at: 2, snooze: true }, { url: 'a', at: 3, repeat: 'weekly' }]);
console.log('reminders OK');
