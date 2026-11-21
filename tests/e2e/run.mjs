#!/usr/bin/env node
// End-to-end tests: the real extension in a real Chrome, saving into a fake Obsidian (in-memory vault).
// Usage: npm run test:e2e        (needs `npm install` once; takes about 4 minutes because it waits on real timers)

import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeObsidian } from './fake-obsidian.mjs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HUB = 'Bookmarks/Bookmarks.md';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

const results = [];
const problems = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push([false, name, e.message]);
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function until(fn, msg, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${msg}`);
    await sleep(150);
  }
}

const obs = await startFakeObsidian();
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXT], args: ['--window-size=1400,1000'] });
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('src/background.js'), { timeout: 20000 });
const ORIGIN = swTarget.url().split('/src/')[0];

const watch = (page, label) => {
  page.on('pageerror', (e) => problems.push(`${label}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && problems.push(`${label} console: ${m.text()}`));
};

// An extension page we keep open to call chrome.* APIs from the tests.
const ext = await browser.newPage();
watch(ext, 'options');
await ext.goto(`${ORIGIN}/options/options.html`);
const storage = (key) => ext.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
const setSettings = (patch) =>
  ext.evaluate(async (p) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...p } });
  }, patch);

const web = await browser.newPage(); // the "site being browsed"
const visit = async (name, query = '') => {
  await web.bringToFront();
  await web.goto(`${obs.base}/pages/${name}${query}`);
};
const pageUrl = (name, query = '') => `${obs.base}/pages/${name}${query}`;

let popup = null;
async function openPopup() {
  await guard();
  if (popup && !popup.isClosed()) await popup.close().catch(() => {});
  await web.bringToFront();
  await ext.evaluate(() => chrome.action.openPopup());
  const target = await browser.waitForTarget((t) => t.url().endsWith('popup/popup.html') && t.type() !== 'service_worker', { timeout: 10000 });
  popup = await target.asPage();
  watch(popup, 'popup');
  await popup.evaluate(() => (window.confirm = () => true));
  await popup.waitForFunction(() => document.getElementById('url').textContent.length > 0, { timeout: 10000 });
  await popup.waitForFunction(() => document.getElementById('status').className.includes('ok') || document.getElementById('status').className.includes('bad'));
  await sleep(400); // bookmarks, tags and reminders load after the page info
  return popup;
}
const toast = () => popup.$eval('#toast', (n) => (n.className.includes('show') ? n.textContent : ''));
let lastToast = '';
const waitToast = (text, ms) => until(async () => (lastToast = (await toast()) || lastToast).includes(text), `toast containing "${text}"`, ms).catch((e) => Promise.reject(new Error(`${e.message} (last toast: "${lastToast}")`)));
const tab = async (name) => {
  await popup.click(`.tabs [data-tab="${name}"]`);
  await sleep(250);
};
const note = (file = HUB) => obs.vault.get(file) || '';
const lineOf = (title, file = HUB) => note(file).split('\n').find((l) => l.includes(`[${title}]`) || l.includes(`|${title}]]`)) || '';
const sectionOf = (title, file = HUB) => {
  let section = '';
  for (const l of note(file).split('\n')) {
    if (/^#{2,6} /.test(l)) section = l.replace(/^#+ /, '');
    if (l.includes(`[${title}]`) || l.includes(`|${title}]]`)) return section;
  }
  return null;
};
// Click a tool button ("Edit", "✕", "☆", "⏰"…) on the bookmark row with this title.
const rowButton = (title, label) =>
  popup.evaluate(
    (t, l) => {
      const row = [...document.querySelectorAll('#list .item')].find((n) => n.querySelector('.t').textContent.includes(t));
      if (!row) throw new Error(`no row "${t}"`);
      const b = [...row.querySelectorAll('.tools button')].find((x) => x.textContent === l);
      if (!b) throw new Error(`no "${l}" button on "${t}"`);
      b.click();
    },
    title,
    label
  );
const rows = () => popup.$$eval('#list .item .t', (ns) => ns.map((n) => n.textContent.replace('★', '')));

// SAFETY: point the extension at the fake server before anything else, and refuse to run otherwise.
// The extension's default address is the real Obsidian; these tests must never talk to it.
await setSettings({ apiUrl: obs.base, apiKey: obs.key, closeAfterSave: false, domainRules: '/pages/article = Reading\n/pages/video = Videos\n/pages/split = Dev' });
const guard = async () => {
  const s = await storage('settings');
  if (s?.apiUrl !== obs.base) {
    console.error(`ABORT: extension is pointed at ${s?.apiUrl}, not the fake server ${obs.base}`);
    await browser.close();
    await obs.stop();
    process.exit(2);
  }
};
await guard();

console.log(`Extension ${ORIGIN} · ${await browser.version()} · fake Obsidian on ${obs.base}\n`);

try {
  await step('Settings page: shows saved settings, Test connection reports Connected', async () => {
    await ext.reload(); // the form must show the fake server, because "Test connection" saves the form first
    ok((await ext.$eval('#apiUrl', (n) => n.value)) === obs.base, 'settings form does not show the saved API URL');
    await ext.$eval('#test', (n) => n.click());
    await until(() => ext.$eval('#test-result', (n) => n.textContent.includes('Connected')), 'Connected message');
    await guard();
  });

  await step('Wrong API key shows a warning in the popup', async () => {
    await setSettings({ apiKey: 'wrong' });
    await visit('article');
    await openPopup();
    ok(await popup.$eval('#banner', (n) => !n.hidden && /rejected/i.test(n.textContent)), 'no "rejected" banner');
    await setSettings({ apiKey: obs.key });
  });

  await step('Popup save: clean URL, auto section, tag autocomplete, highlight → note', async () => {
    await visit('article', '?utm_source=news&id=7');
    await web.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.getElementById('sel'));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await openPopup();
    ok((await popup.$eval('#title', (n) => n.value)) === 'E2E Article', 'title not read from the page');
    const url = await popup.$eval('#url', (n) => n.textContent);
    ok(!url.includes('utm_source') && url.includes('id=7'), `tracking parameter not stripped: ${url}`);
    ok((await popup.$eval('#cats .selected', (n) => n.textContent)) === 'Reading', 'rule did not pick Reading');
    const chips = await popup.$$eval('#tag-suggest .chip', (ns) => ns.map((n) => n.textContent));
    ok(chips.includes('#alpha') && chips.includes('#vaulttag'), `page keyword / vault tags not suggested: ${chips}`);
    await popup.type('#tags', 'e2e alp');
    await popup.keyboard.press('Tab');
    ok((await popup.$eval('#tags', (n) => n.value)) === 'e2e alpha ', 'Tab did not complete the tag');
    await popup.type('#note', 'hello');
    ok(await popup.$eval('#sel', (n) => n.textContent.includes('Selected sentence')), 'selection not captured');
    await popup.click('#save');
    await waitToast('Saved to Reading');
    const n = note();
    ok(n.includes('### Reading') && !/^## /m.test(n), 'sections should be H3');
    ok(lineOf('E2E Article') === `- [ ] [E2E Article](${pageUrl('article', '?id=7')}) #bookmark/reading #e2e #alpha · 127.0.0.1 · ${today} — hello`, `unexpected line: ${lineOf('E2E Article')}`);
    ok(n.includes('\t> Selected sentence for the highlight.'), 'highlight quote missing');
    ok(sectionOf('E2E Article') === 'Reading', 'entry not under Reading');
  });

  await step('Already-saved page: notice, ✓ on the section chip, ★ on the toolbar icon', async () => {
    await openPopup();
    ok(await popup.$eval('#dupe', (n) => !n.hidden && n.textContent.includes('Reading')), 'no already-saved notice');
    ok((await popup.$$eval('#cats .chip.saved', (ns) => ns.map((n) => n.textContent))).join() === '✓ Reading', 'no ✓ on Reading');
    const badge = await until(
      () => ext.evaluate(async (u) => chrome.action.getBadgeText({ tabId: (await chrome.tabs.query({})).find((t) => t.url === u).id }), pageUrl('article', '?utm_source=news&id=7')),
      'star badge'
    );
    ok(badge === '★', `badge is "${badge}"`);
  });

  await step('Undo right after saving removes the entry', async () => {
    await visit('video');
    await openPopup();
    ok((await popup.$eval('#cats .selected', (n) => n.textContent)) === 'Videos', 'rule did not pick Videos');
    await popup.click('#readlater'); // off: plain entry without a checkbox
    await popup.click('#save');
    await waitToast('Saved to Videos');
    ok(lineOf('E2E Video').startsWith('- [E2E Video]'), 'entry not saved without a checkbox');
    await popup.click('#toast a');
    await until(() => !note().includes('E2E Video'), 'entry removed by Undo');
    await popup.click('#save');
    await until(() => note().includes('E2E Video'), 'entry saved again');
  });

  await step('Bookmarks tab: list, stats, filter, tag chip, views, sort', async () => {
    await openPopup();
    await tab('browse');
    ok((await rows()).length === 2, `expected 2 rows, got ${await rows()}`);
    ok(await popup.$eval('#stats', (n) => n.textContent.includes('2 bookmarks') && n.textContent.includes('1 to read')), 'stats line wrong');
    await popup.type('#filter', 'video');
    ok((await rows()).join() === 'E2E Video', 'filter did not narrow the list');
    await popup.$eval('#filter', (n) => ((n.value = ''), n.dispatchEvent(new Event('input'))));
    await popup.evaluate(() => [...document.querySelectorAll('#tag-cloud .chip')].find((c) => c.textContent.startsWith('#alpha')).click());
    ok((await rows()).join() === 'E2E Article', 'tag chip did not filter');
    await popup.$eval('#filter', (n) => ((n.value = ''), n.dispatchEvent(new Event('input'))));
    await popup.select('#show', 'unread');
    ok((await rows()).join() === 'E2E Article', 'Read later view wrong');
    await popup.select('#show', 'site');
    ok((await rows()).length === 2, 'On this site view wrong');
    await popup.select('#show', 'recent');
    ok((await popup.$$eval('.group-h', (ns) => ns.map((n) => n.firstChild.textContent))).join() === 'Recent', 'Recent view not flat');
    await popup.select('#show', 'all');
    ok((await popup.$$eval('.group-h', (ns) => ns.length)) >= 8, 'empty sections not listed');
  });

  await step('Tick read, pin, and edit write back to the note', async () => {
    await popup.evaluate(() => [...document.querySelectorAll('#list .item')].find((n) => n.textContent.includes('E2E Article')).querySelector('input[type=checkbox]').click());
    await until(() => lineOf('E2E Article').startsWith('- [x] '), 'checkbox ticked in the note');
    await rowButton('E2E Video', '☆');
    await until(() => lineOf('E2E Video').includes(`](${pageUrl('video')}) #pinned`), '#pinned added');
    await until(async () => (await popup.$$eval('#list .item .pin', (ns) => ns.length)) === 1, 'pin star shown');
    await rowButton('E2E Article', 'Edit');
    await until(() => popup.$eval('#save', (n) => n.textContent.includes('Update')), 'edit form');
    ok((await popup.$eval('#tags', (n) => n.value)) === 'e2e alpha', 'edit form did not load the tags');
    await popup.$eval('#title', (n) => ((n.value = 'E2E Article v2'), n.dispatchEvent(new Event('input', { bubbles: true }))));
    await popup.click('#save');
    await waitToast('Updated');
    ok(lineOf('E2E Article v2') === `- [x] [E2E Article v2](${pageUrl('article', '?id=7')}) #bookmark/reading #e2e #alpha · 127.0.0.1 · ${today} — hello`, `edit result: ${lineOf('E2E Article v2')}`);
    ok(note().includes('\t> Selected sentence for the highlight.'), 'edit lost the highlight quote');
  });

  await step('Drag a bookmark to another section', async () => {
    await tab('browse');
    await popup.evaluate(() => {
      const dt = new DataTransfer();
      const row = [...document.querySelectorAll('#list .item')].find((n) => n.textContent.includes('E2E Video'));
      const head = [...document.querySelectorAll('.group-h')].find((h) => h.firstChild.textContent === 'Dev');
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      head.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      head.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await until(() => sectionOf('E2E Video') === 'Dev', 'entry moved under Dev');
    ok(lineOf('E2E Video').includes('#bookmark/dev') && !lineOf('E2E Video').includes('#bookmark/videos'), 'section tag not updated');
  });

  await step('Delete with Undo; bulk tag with backup and Undo', async () => {
    await until(async () => (await rows()).length === 2, 'list reloaded');
    const before = note();
    await rowButton('E2E Video', '✕');
    await waitToast('Deleted');
    ok(!note().includes('E2E Video'), 'entry not deleted');
    await popup.click('#toast a');
    await until(() => note() === before, 'note restored by Undo');
    await until(async () => (await rows()).length === 2, 'list reloaded after undo');

    await popup.click('#select-mode');
    await popup.evaluate(() => document.querySelectorAll('#list .item').forEach((n) => n.click()));
    ok(await popup.$eval('#bulk-n', (n) => n.textContent === '2 selected'), 'rows not selected');
    await popup.type('#bulk-tag', 'bulk');
    await popup.keyboard.press('Enter');
    await waitToast('2 done');
    ok(lineOf('E2E Article v2').includes('#bulk') && lineOf('E2E Video').includes('#bulk'), 'bulk tag not applied');
    ok(lineOf('E2E Video').includes('#pinned'), 'bulk tag dropped the pin');
    ok([...obs.vault.keys()].some((k) => /^Bookmarks\/Backups\/Bookmarks .*\.md\.bak$/.test(k)), 'no backup written');
    await popup.click('#toast a');
    await until(() => note() === before, 'bulk action undone');
    await popup.click('#bulk-clear');
  });

  await step('Keyboard: / focuses the filter, arrows move, Enter-free checks', async () => {
    await popup.evaluate(() => document.activeElement.blur());
    await popup.keyboard.press('/');
    ok((await popup.evaluate(() => document.activeElement.id)) === 'filter', '/ did not focus the filter');
    await popup.keyboard.press('ArrowDown');
    ok((await popup.$$eval('#list .item.focused', (ns) => ns.length)) === 1, 'ArrowDown did not focus a row');
    await popup.keyboard.press('ArrowUp');
    ok((await popup.evaluate(() => document.activeElement.id)) === 'filter', 'ArrowUp did not return to the filter');
    await popup.evaluate(() => document.activeElement.blur());
  });

  await step('Export and link check', async () => {
    await popup.select('#export', 'csv');
    await waitToast('Exported 2 bookmarks');
    const dead = await popup.evaluate((urls) => chrome.runtime.sendMessage({ type: 'checkLinks', urls }), [pageUrl('article'), pageUrl('gone')]);
    ok(dead.ok && dead.data.length === 1 && dead.data[0].url === pageUrl('gone') && dead.data[0].reason === '404', `link check result: ${JSON.stringify(dead)}`);
  });

  await step('Search vault: live results, note preview, [[ note autocomplete', async () => {
    await tab('search');
    await popup.type('#q', 'Article');
    await until(async () => (await popup.$$eval('#results .result', (ns) => ns.length)) >= 1, 'live search results');
    await popup.click('#results .result');
    await until(() => popup.$eval('#note-body', (n) => n.textContent.includes('E2E Article v2')), 'note preview');
    await tab('save');
    await popup.type('#note', 'see [[Bookm');
    await until(async () => (await popup.$$eval('#note-suggest .chip', (ns) => ns.map((n) => n.textContent))).includes('[[Bookmarks]]'), 'note suggestion');
    await popup.keyboard.press('Tab');
    ok((await popup.$eval('#note', (n) => n.value)) === 'see [[Bookmarks]] ', 'Tab did not complete the note link');
  });

  await step('Dedicated note, daily-note logging, per-site rule button', async () => {
    await setSettings({ dailyNote: true });
    await visit('tool');
    await openPopup();
    await popup.evaluate(() => [...document.querySelectorAll('#cats .chip')].find((c) => c.textContent === 'Tools').click());
    ok(await popup.$eval('#site-rule', (n) => !n.hidden && n.textContent === 'Always save 127.0.0.1 to Tools'), 'rule button missing');
    await popup.click('#dedicated');
    await popup.click('#save');
    await waitToast('Saved to Tools');
    const clip = note('Bookmarks/Clippings/E2E Tool.md');
    ok(clip.includes(`source: "${pageUrl('tool')}"`) && clip.includes('description: "A handy tool"'), 'dedicated note missing or incomplete');
    ok(lineOf('E2E Tool').includes('[[Bookmarks/Clippings/E2E Tool|E2E Tool]]'), 'hub entry does not link the dedicated note');
    ok(obs.daily.length === 1 && obs.daily[0].includes('E2E Tool'), 'daily note not written');
    await setSettings({ dailyNote: false });
  });

  await step('Save all tabs, image entry, link entry', async () => {
    await popup.click('#save-tabs');
    await waitToast('tabs to Session');
    ok(/### Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(note()), 'no Session section');
    const img = await popup.evaluate((src, page) => chrome.runtime.sendMessage({ type: 'save', item: { kind: 'image', title: 'pic', srcUrl: src, pageUrl: page, pageTitle: 'Img page' } }), pageUrl('img'), pageUrl('tool'));
    ok(img.ok && note().includes(`- ![pic|300](${pageUrl('img')}) from [Img page]`), `image entry: ${JSON.stringify(img)}`);
    const link = await popup.evaluate((u) => chrome.runtime.sendMessage({ type: 'save', item: { kind: 'link', title: 'A link', url: u, category: 'Shopping' } }), pageUrl('linked'));
    ok(link.ok && sectionOf('A link') === 'Shopping', 'link entry not under Shopping');
  });

  await step('One note per section', async () => {
    await setSettings({ splitBySection: true });
    await visit('split');
    await openPopup();
    await popup.click('#save');
    await waitToast('Saved to Dev');
    ok(note('Bookmarks/Dev.md').includes('### Dev') && note('Bookmarks/Dev.md').includes('E2E Split'), 'section note not written');
    ok(!note().includes('E2E Split'), 'entry also written to the hub note');
    await openPopup();
    ok(await popup.$eval('#dupe', (n) => !n.hidden), 'entry in a section note not recognised as saved');
    await tab('browse');
    ok((await rows()).includes('E2E Split') && (await rows()).includes('E2E Video'), 'list should merge hub and section notes');
    await setSettings({ splitBySection: false });
  });

  await step('Theme switcher applies and persists', async () => {
    await popup.select('#theme', 'nord');
    ok((await popup.evaluate(() => document.documentElement.dataset.theme)) === 'nord', 'theme not applied');
    await until(async () => (await storage('settings')).theme === 'nord', 'theme saved');
    await openPopup();
    ok((await popup.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(46, 52, 64)', 'theme not restored on reopen');
    await popup.select('#theme', 'system');
  });

  await step('Offline: save is queued, then written when Obsidian returns (waits for the 1-minute timer)', async () => {
    await visit('offline');
    await openPopup();
    await obs.stop();
    await popup.click('#save');
    await waitToast('queued');
    ok(((await storage('queue')) || []).length === 1, 'save not queued');
    await obs.start();
    await until(() => note().includes('E2E Offline'), 'queued save written', 80000);
    ok(((await storage('queue')) || []).length === 0, 'queue not emptied');
  });

  await step('Reminder: set from a row, fires, notification + badge + due list, repeats (waits for the timer)', async () => {
    await openPopup();
    await tab('browse');
    await rowButton('E2E Video', '⏰');
    ok(await popup.$eval('#remind-bar', (n) => !n.hidden), 'reminder bar did not open');
    const at = new Date(Date.now() + 20000);
    at.setSeconds(0, 0);
    at.setMinutes(at.getMinutes() + 1); // datetime-local works in whole minutes
    const local = new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await popup.$eval('#rb-at', (n, v) => (n.value = v), local);
    await popup.select('#rb-repeat', 'daily');
    await popup.click('#rb-set');
    await waitToast('Reminder set');
    const set = await storage('reminders');
    ok(set.length === 1 && set[0].at === at.getTime() && set[0].repeat === 'daily', `stored reminder: ${JSON.stringify(set)}`);
    ok(await popup.$eval('#list .item .rem', (n) => n.textContent.includes('daily')), 'row does not show the reminder');
    await popup.select('#show', 'reminders');
    ok((await rows()).join() === 'E2E Video', 'Reminders view wrong');

    const url = pageUrl('video');
    await until(async () => ((await storage('fired')) || {})[url], 'reminder fired', at.getTime() - Date.now() + 75000);
    ok(Object.keys(await ext.evaluate(() => chrome.notifications.getAll())).includes(`remind:${url}`), 'no Chrome notification was created');
    ok((await ext.evaluate(() => chrome.action.getBadgeText({}))) === '1', 'toolbar count not shown');
    const next = await storage('reminders');
    ok(next.length === 1 && next[0].at === at.getTime() + 86400000, 'daily reminder not rescheduled for tomorrow');

    await openPopup();
    ok(await popup.$eval('#due', (n) => !n.hidden && n.textContent.includes('E2E Video')), 'due reminder not listed in the popup');
    await popup.evaluate(() => [...document.querySelectorAll('#due button')].find((b) => b.textContent === 'Dismiss').click());
    await until(() => popup.$eval('#due', (n) => n.hidden), 'due list cleared');
    ok((await ext.evaluate(() => chrome.action.getBadgeText({}))) === '', 'toolbar count not cleared');

    await tab('browse');
    await rowButton('E2E Video', '⏰');
    await popup.click('#rb-del');
    await waitToast('Reminder removed');
    ok((await storage('reminders')).length === 0, 'reminder not removed');
  });

  await step('No JavaScript errors in the popup, settings page or background', async () => {
    ok(problems.length === 0, problems.join('\n'));
  });
} finally {
  await browser.close();
  await obs.stop();
}

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
