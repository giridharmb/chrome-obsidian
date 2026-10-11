// Settings live in chrome.storage.local (the API key never leaves this machine).

export const DEFAULTS = {
  // 'rest'         → Obsidian "Local REST API" plugin. Silent, section-aware, enables Browse/Search.
  // 'advanced-uri' → "Advanced URI" plugin. Section-aware, but brings Obsidian to the front.
  // 'uri'          → Built-in obsidian:// URI. No plugin needed; appends to end of the note.
  mode: 'rest',
  apiUrl: 'http://127.0.0.1:27123',
  apiKey: '',
  vaultName: '',

  bookmarksFile: 'Bookmarks/Bookmarks.md',
  clippingsFolder: 'Bookmarks/Clippings',
  attachmentsFolder: 'Bookmarks/Attachments',

  categories: [
    '📥 Inbox',
    '💻 Dev',
    '📚 Reading',
    '🎥 Videos',
    '🧪 Research',
    '🛠 Tools',
    '🛒 Shopping',
    '🖼 Images',
  ],
  defaultCategory: '📥 Inbox',
  imageCategory: '🖼 Images',

  // "pattern = Category". Pattern matches the hostname (substring) or, if it has a "/", the full URL.
  domainRules: [
    'github.com = Dev',
    'gitlab.com = Dev',
    'stackoverflow.com = Dev',
    'developer.mozilla.org = Dev',
    'npmjs.com = Dev',
    'youtube.com = Videos',
    'youtu.be = Videos',
    'vimeo.com = Videos',
    'medium.com = Reading',
    'substack.com = Reading',
    'news.ycombinator.com = Reading',
    'arxiv.org = Research',
    'scholar.google = Research',
    'amazon. = Shopping',
    'ebay. = Shopping',
  ].join('\n'),

  tagPrefix: 'bookmark',
  addCategoryTag: true,
  newestFirst: true,
  readLater: true,
  linkDate: false,
  downloadImages: false,
  closeAfterSave: true,
  entryTemplate: '- {{checkbox}}{{link}} {{tags}} · {{domain}} · {{date}}{{note}}',
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function resetSettings() {
  const { apiKey, vaultName } = await getSettings();
  await chrome.storage.local.set({ settings: { ...DEFAULTS, apiKey, vaultName } });
}
