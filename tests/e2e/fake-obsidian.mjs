// A stand-in for Obsidian's Local REST API with an in-memory vault, plus a few test web pages.
// Lets the end-to-end tests run the real extension without touching a real vault.

import http from 'node:http';

const PAGES = {
  article: { title: 'E2E Article', keywords: 'alpha, beta gamma', body: '<p id="sel">Selected sentence for the highlight.</p>' },
  video: { title: 'E2E Video', body: '<p>video</p>' },
  tool: { title: 'E2E Tool', description: 'A handy tool', body: '<p>tool</p>' },
  split: { title: 'E2E Split', body: '<p>split</p>' },
  offline: { title: 'E2E Offline', body: '<p>offline</p>' },
};

export function startFakeObsidian({ key = 'test-key', port = 27999 } = {}) {
  const vault = new Map(); // path → content (string)
  const daily = [];
  const opened = [];
  let server;

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');

    const page = /^\/pages\/(\w+)/.exec(url.pathname);
    if (page) {
      if (page[1] === 'gone') return send(404, 'gone', 'text/plain');
      if (page[1] === 'img') return send(200, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), 'image/png');
      const p = PAGES[page[1]] || { title: page[1], body: '' };
      return send(
        200,
        `<!doctype html><title>${p.title}</title>${p.keywords ? `<meta name="keywords" content="${p.keywords}">` : ''}${p.description ? `<meta name="description" content="${p.description}">` : ''}<h1>${p.title}</h1>${p.body}`,
        'text/html'
      );
    }

    const authed = req.headers.authorization === `Bearer ${key}`;
    if (url.pathname === '/') return send(200, { status: 'OK', authenticated: authed, service: 'Fake Obsidian', versions: { self: 'e2e' } });
    if (!authed) return send(401, { errorCode: 40101, message: 'Authorization required' });

    if (url.pathname.startsWith('/vault/')) {
      const path = decodeURIComponent(url.pathname.slice('/vault/'.length));
      if (req.method === 'PUT') return vault.set(path, body), send(204, '');
      if (path === '' || path.endsWith('/')) {
        const names = new Set();
        for (const k of vault.keys()) {
          if (!k.startsWith(path)) continue;
          const rest = k.slice(path.length);
          names.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest);
        }
        return names.size ? send(200, { files: [...names] }) : send(404, { message: 'Not found' });
      }
      return vault.has(path) ? send(200, vault.get(path), 'text/markdown') : send(404, { message: 'Not found' });
    }
    if (url.pathname === '/search/simple/' && req.method === 'POST') {
      const q = (url.searchParams.get('query') || '').toLowerCase();
      const hits = [...vault.entries()]
        .filter(([k, v]) => k.endsWith('.md') && (k.toLowerCase().includes(q) || v.toLowerCase().includes(q)))
        .map(([k, v]) => {
          const i = Math.max(0, v.toLowerCase().indexOf(q));
          return { filename: k, score: -1, matches: [{ match: { start: i, end: i + q.length, source: 'content' }, context: v.slice(Math.max(0, i - 30), i + 60) }] };
        });
      return send(200, hits);
    }
    if (url.pathname === '/tags/') return send(200, { tags: [{ name: 'vaulttag', count: 3 }] });
    if (url.pathname === '/periodic/daily/' && req.method === 'POST') return daily.push(body), send(204, '');
    if (url.pathname.startsWith('/open/')) return opened.push(decodeURIComponent(url.pathname.slice(6))), send(200, '');
    return send(404, { message: 'Unknown route' });
  };

  const api = {
    port,
    key,
    vault,
    daily,
    opened,
    base: `http://127.0.0.1:${port}`,
    start: () =>
      new Promise((resolve) => {
        server = http.createServer(handler);
        server.listen(port, '127.0.0.1', resolve);
      }),
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
  return api.start().then(() => api);
}
