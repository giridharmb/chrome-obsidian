import { getSettings, saveSettings, resetSettings, DEFAULTS } from '../src/lib/settings.js';
import { renderEntry } from '../src/lib/markdown.js';

const $ = (id) => document.getElementById(id);
const TEXT = ['apiUrl', 'apiKey', 'vaultName', 'bookmarksFile', 'clippingsFolder', 'attachmentsFolder', 'tagPrefix', 'entryTemplate', 'domainRules'];
const BOOL = ['addCategoryTag', 'readLater', 'newestFirst', 'linkDate', 'downloadImages', 'closeAfterSave'];

const lines = (v) => v.split('\n').map((l) => l.trim()).filter(Boolean);

function fillSelect(id, cats, value) {
  $(id).replaceChildren(...cats.map((c) => new Option(c, c, false, c === value)));
  if (!cats.includes(value) && cats.length) $(id).value = cats[0];
}

function readForm() {
  const s = {};
  for (const k of TEXT) s[k] = $(k).value.trim();
  for (const k of BOOL) s[k] = $(k).checked;
  s.mode = document.querySelector('input[name=mode]:checked')?.value || 'rest';
  s.categories = lines($('categories').value);
  s.defaultCategory = $('defaultCategory').value || s.categories[0];
  s.imageCategory = $('imageCategory').value || s.categories[0];
  if (!/\.md$/.test(s.bookmarksFile)) s.bookmarksFile += '.md';
  return s;
}

function preview() {
  const s = { ...DEFAULTS, ...readForm() };
  const sample = {
    title: 'Attention Is All You Need',
    url: 'https://arxiv.org/abs/1706.03762',
    category: s.categories.find((c) => /research/i.test(c)) || s.defaultCategory,
    tags: ['ml', 'transformers'],
    note: 'the original transformer paper',
    readLater: s.readLater,
  };
  $('tpl-preview').textContent = renderEntry(s, sample);
}

function syncCategorySelects() {
  const cats = lines($('categories').value);
  fillSelect('defaultCategory', cats, $('defaultCategory').value);
  fillSelect('imageCategory', cats, $('imageCategory').value);
}

function updateModeUI() {
  const mode = document.querySelector('input[name=mode]:checked')?.value;
  $('rest-fields').hidden = mode !== 'rest';
}

async function load() {
  const s = await getSettings();
  for (const k of TEXT) $(k).value = s[k];
  for (const k of BOOL) $(k).checked = !!s[k];
  document.querySelector(`input[name=mode][value="${s.mode}"]`).checked = true;
  $('categories').value = s.categories.join('\n');
  fillSelect('defaultCategory', s.categories, s.defaultCategory);
  fillSelect('imageCategory', s.categories, s.imageCategory);
  updateModeUI();
  preview();
}

function flash(id, msg, ok) {
  $(id).textContent = msg;
  $(id).className = `result-msg ${ok ? 'ok' : 'bad'}`;
}

$('categories').addEventListener('input', syncCategorySelects);
document.querySelectorAll('input, textarea, select').forEach((n) => n.addEventListener('input', preview));
document.querySelectorAll('input[name=mode]').forEach((n) => n.addEventListener('change', updateModeUI));

$('downloadImages').addEventListener('change', async (e) => {
  if (!e.target.checked) return;
  // Fetching images from arbitrary sites needs host access; ask only when the user opts in.
  const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
  if (!granted) {
    e.target.checked = false;
    flash('saved', 'Site access is needed to download images. Remote image links will be embedded instead.', false);
  }
});

$('save-settings').onclick = async () => {
  const s = readForm();
  if (!s.categories.length) return flash('saved', 'Add at least one section.', false);
  await saveSettings(s);
  flash('saved', 'Saved ✓', true);
};

$('reset').onclick = async () => {
  if (!confirm('Reset all settings except API key and vault name?')) return;
  await resetSettings();
  await load();
  flash('saved', 'Defaults restored', true);
};

$('test').onclick = async () => {
  await saveSettings(readForm());
  flash('test-result', 'Testing…', true);
  const r = await chrome.runtime.sendMessage({ type: 'status' });
  const st = r?.data || { ok: false, message: r?.error };
  flash('test-result', st.message, st.ok);
};

$('shortcuts').onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
};

load();
