// Collects page metadata from a tab. Falls back to tab title/URL on pages we can't script (chrome://, Web Store…).

function collectPageInfo() {
  const meta = (n) => document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content?.trim() || '';
  const abs = (u) => {
    try {
      return u ? new URL(u, location.href).href : '';
    } catch {
      return '';
    }
  };
  return {
    title: meta('og:title') || document.title || '',
    url: location.href,
    description: meta('og:description') || meta('description') || meta('twitter:description'),
    image: abs(meta('og:image') || meta('twitter:image')),
    siteName: meta('og:site_name'),
    selection: String(window.getSelection() || '').trim(),
  };
}

export async function getPageInfo(tab) {
  const base = { title: tab.title || tab.url || '', url: tab.url || '', description: '', image: '', siteName: '', selection: '' };
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectPageInfo });
    const info = res?.result || {};
    return { ...base, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v)) };
  } catch {
    return base;
  }
}

export async function getLinkText(tabId, frameId, href) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId || 0] },
      args: [href],
      func: (h) => {
        for (const a of document.querySelectorAll('a[href]')) {
          if (a.href === h) return (a.innerText || a.title || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
        }
        return '';
      },
    });
    return res?.result || '';
  } catch {
    return '';
  }
}

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}
