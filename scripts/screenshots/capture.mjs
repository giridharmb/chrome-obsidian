#!/usr/bin/env node
// Renders the real popup/options pages with a mocked chrome.* API and saves PNGs to docs/images/.
// Usage: npm run screenshots   (needs Google Chrome; CHROME=/path/to/chrome to override, ONLY=popup-save,options for a subset)

import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'docs/images');
const PORT = 8765;
const CHROME =
  process.env.CHROME ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : 'google-chrome');

const SCENES = [
  { name: 'popup-save', page: 'popup', q: 'scene=save&tall=1', size: [400, 830] },
  { name: 'popup-save-dark', page: 'popup', q: 'scene=save&tall=1', size: [400, 830], dark: true },
  { name: 'popup-duplicate', page: 'popup', q: `scene=dupe&sel=&title=coddingtonbear/obsidian-local-rest-api&url=${encodeURIComponent('https://github.com/coddingtonbear/obsidian-local-rest-api')}`, size: [400, 420] },
  { name: 'popup-bookmarks', page: 'popup', q: 'scene=browse', size: [400, 600] },
  { name: 'popup-unread', page: 'popup', q: 'scene=unread', size: [400, 480] },
  { name: 'popup-search', page: 'popup', q: 'scene=search', size: [400, 380] },
  { name: 'popup-note', page: 'popup', q: 'scene=note', size: [400, 600] },
  { name: 'side-panel', page: 'popup', q: 'scene=browse&panel=1', size: [460, 700] },
  { name: 'options', page: 'options', q: '', size: [900, 1660] },
];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

async function harness(page) {
  let html = await readFile(path.join(ROOT, page, `${page}.html`), 'utf8');
  html = html.replace('<head>', `<head>\n  <base href="/${page}/">`);
  html = html.replace(/<script type="module" src="(\w+)\.js"><\/script>/, (m) => `<script type="module" src="/scripts/screenshots/mock-chrome.js"></script>\n  ${m}`);
  return html;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    const m = /^\/__shot\/(popup|options)\.html$/.exec(url.pathname);
    if (m) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(await harness(m[1]));
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) throw new Error('outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
// Headless Chrome lingers after each shot, so capture all scenes in parallel (one profile each).
const shoot = async (s) => {
  const profile = await mkdtemp(path.join(tmpdir(), 'obm-shots-'));
  const out = path.join(OUT, `${s.name}.png`);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--user-data-dir=${profile}`,
    '--force-device-scale-factor=2',
    `--window-size=${s.size[0]},${s.size[1]}`,
    '--virtual-time-budget=5000',
    `--screenshot=${out}`,
    ...(s.dark ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'] : ['--blink-settings=preferredColorScheme=1']),
    `http://127.0.0.1:${PORT}/__shot/${s.page}.html?${s.q}`,
  ];
  try {
    await run(CHROME, args, { timeout: 120000 });
    console.log('✓', path.relative(ROOT, out));
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
};
try {
  const only = process.env.ONLY?.split(',');
  await Promise.all(SCENES.filter((s) => !only || only.includes(s.name)).map(shoot));
} finally {
  server.close();
}
