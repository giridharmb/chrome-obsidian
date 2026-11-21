// Transport layer: Local REST API client + obsidian:// URI builders.

const encPath = (p) =>
  p
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');

export class ObsidianError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class RestClient {
  constructor({ apiUrl, apiKey }) {
    this.base = (apiUrl || '').replace(/\/+$/, '');
    this.key = apiKey;
  }

  async req(path, { method = 'GET', headers = {}, body, allow404 = false } = {}) {
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, ...headers },
        body,
      });
    } catch {
      const err = new ObsidianError(
        `Can't reach Obsidian at ${this.base}. Is Obsidian open with the Local REST API plugin enabled?`,
        0
      );
      err.offline = true; // lets callers queue the save instead of losing it
      throw err;
    }
    if (res.status === 404 && allow404) return null;
    if (res.status === 401 || res.status === 403) throw new ObsidianError('Obsidian rejected the API key. Check it in the extension options.', res.status);
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).message || msg;
      } catch {}
      throw new ObsidianError(`Obsidian error ${res.status}: ${msg}`, res.status);
    }
    return res;
  }

  async status() {
    const res = await this.req('/');
    return res.json(); // { authenticated, ok, service, versions }
  }

  async read(path) {
    const res = await this.req(`/vault/${encPath(path)}`, { headers: { Accept: 'text/markdown' }, allow404: true });
    return res ? res.text() : null;
  }

  async write(path, content) {
    await this.req(`/vault/${encPath(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: content,
    });
  }

  async writeBinary(path, buffer, contentType) {
    await this.req(`/vault/${encPath(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType || 'application/octet-stream' },
      body: buffer,
    });
  }

  async exists(path) {
    return (await this.read(path)) !== null;
  }

  /** Markdown files directly inside a folder (not recursive). */
  async list(dir) {
    return (await this.listAll(dir)).filter((f) => f.endsWith('.md')).map((f) => `${dir}/${f}`);
  }

  /** Every name directly inside a folder (sub-folders end with "/"). */
  async listAll(dir) {
    const res = await this.req(`/vault/${encPath(dir)}/`, { allow404: true });
    return res ? (await res.json()).files || [] : [];
  }

  async remove(path) {
    await this.req(`/vault/${encPath(path)}`, { method: 'DELETE', allow404: true });
  }

  /** Append to today's daily note (uses Obsidian's own daily-note settings). */
  async appendDaily(content) {
    await this.req('/periodic/daily/', { method: 'POST', headers: { 'Content-Type': 'text/markdown' }, body: content });
  }

  /** Every tag in the vault as [{ name: '#tag', count }]. Only newer plugin versions have this endpoint. */
  async tags() {
    const j = await (await this.req('/tags/')).json();
    return (Array.isArray(j) ? j : j.tags || [])
      .map((t) => (typeof t === 'string' ? { name: t, count: 1 } : { name: t.name ?? t.tag, count: t.count ?? 1 }))
      .filter((t) => t.name)
      .map((t) => ({ name: `#${String(t.name).replace(/^#/, '')}`, count: t.count }));
  }

  async open(path) {
    await this.req(`/open/${encPath(path)}`, { method: 'POST' });
  }

  async search(query, contextLength = 80) {
    const res = await this.req(`/search/simple/?query=${encodeURIComponent(query)}&contextLength=${contextLength}`, {
      method: 'POST',
    });
    return res.json(); // [{ filename, score, matches: [{ match: {start,end}, context }] }]
  }
}

const q = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

/** Built-in URI: appends to the end of the file (creates it if missing). */
export const uriAppend = ({ vaultName, file, content }) =>
  `obsidian://new?${q({ vault: vaultName, file: file.replace(/\.md$/, ''), content: `\n${content}`, append: 'true', silent: 'true' })}`;

/** Advanced URI plugin: appends under a heading. */
export const advancedUriAppend = ({ vaultName, file, heading, content }) =>
  `obsidian://advanced-uri?${q({ vault: vaultName, filepath: file, heading, mode: 'append', data: content })}`;

export const uriOpen = ({ vaultName, file }) => `obsidian://open?${q({ vault: vaultName, file })}`;

export const uriSearch = ({ vaultName, query }) => `obsidian://search?${q({ vault: vaultName, query })}`;
