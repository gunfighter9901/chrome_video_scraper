// popup.js — Universal Video Downloader (module)
import { MSG } from './core/messaging.mjs';
import { variantLabel, formatBytes } from './core/formats.mjs';

const els = {
  page: document.getElementById('page'),
  state: document.getElementById('state'),
  list: document.getElementById('list'),
  rescan: document.getElementById('rescan'),
  note: document.getElementById('note'),
};

let currentTabId = null;
let items = [];
const progressById = new Map();

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: false, error: 'no response' });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

function showState(html) {
  els.state.innerHTML = html;
  els.state.style.display = '';
  els.list.innerHTML = '';
}

function hideState() {
  els.state.style.display = 'none';
}

function render() {
  hideState();
  els.list.innerHTML = '';
  if (!items.length) {
    showState('No media found on this page.<br><small>Press play, then hit Rescan.</small>');
    els.note.classList.remove('hidden');
    return;
  }
  els.note.classList.add('hidden');
  for (const item of items) {
    els.list.appendChild(renderItem(item));
  }
}

function sourceBadge(item) {
  const map = { hls: 'HLS', dash: 'DASH', progressive: 'MP4', network: 'net', perf: 'perf', dom: 'dom' };
  return map[item.kind] || (item.kind || 'media').toUpperCase();
}

function renderItem(item) {
  const wrap = document.createElement('div');
  wrap.className = 'item';

  const head = document.createElement('div');
  head.className = 'item-head';
  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.alt = '';
  if (item.thumbnail) thumb.src = item.thumbnail;
  else thumb.style.visibility = 'hidden';
  thumb.onerror = () => { thumb.style.visibility = 'hidden'; };

  const titleWrap = document.createElement('div');
  titleWrap.style.minWidth = '0';
  titleWrap.style.flex = '1';
  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = item.title || item.pageUrl || 'Video';
  const sub = document.createElement('div');
  sub.className = 'item-sub';
  const b1 = document.createElement('span'); b1.className = 'badge'; b1.textContent = sourceBadge(item);
  sub.appendChild(b1);
  if (item.duration) { const d = document.createElement('span'); d.textContent = `${Math.round(item.duration)}s`; sub.appendChild(d); }
  if (item.variants && item.variants.length) { const v = document.createElement('span'); v.textContent = `${item.variants.length} quality`; sub.appendChild(v); }
  if (item.drm) {
    const drm = document.createElement('span'); drm.className = 'badge drm'; drm.textContent = 'DRM protected'; sub.appendChild(drm);
  }
  titleWrap.appendChild(title); titleWrap.appendChild(sub);
  head.appendChild(thumb); head.appendChild(titleWrap);
  wrap.appendChild(head);

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  const select = document.createElement('select');
  const variants = item.variants && item.variants.length ? item.variants : [{ label: 'auto', url: item.url, kind: item.kind }];
  variants.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    const extra = v.sizeBytes ? ` (${formatBytes(v.sizeBytes)})` : '';
    opt.textContent = variantLabel(v) + extra;
    select.appendChild(opt);
  });
  const btn = document.createElement('button');
  btn.className = 'dl';
  btn.type = 'button';
  btn.textContent = 'Download';
  btn.disabled = !!item.drm || !variants.length;
  if (item.drm) btn.title = 'DRM-protected streams cannot be downloaded';

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Starting…';
    const variantIndex = parseInt(select.value, 10) || 0;
    const selected = variants[variantIndex] || variants[0];
    // First await keeps the user-gesture context so Chrome can show the permission prompt.
    // Host access to the media origin lets the offscreen worker fetch without CORS blocking.
    let granted = false;
    try { granted = await requestMediaPermissions([item.url, selected && selected.url]); } catch {}
    const status = ensureStatus(wrap);
    const txt = status.querySelector('.txt');
    const bar = status.querySelector('.bar > i');
    txt.textContent = granted ? 'Starting…' : 'Starting (will relay if blocked)…';
    const resp = await send({ type: MSG.DOWNLOAD, tabId: currentTabId, item, variantIndex, pageUrl: item.pageUrl });
    if (resp && resp.ok) {
      btn.textContent = 'Started';
      progressById.set(resp.downloadId, { wrap, select, btn });
      ensureStatus(wrap);
    } else {
      btn.textContent = 'Failed';
      btn.title = (resp && resp.error) || 'Download failed';
      txt.textContent = `Failed: ${(resp && resp.error) || 'unknown error'}`;
      bar.style.width = '0%';
      setTimeout(() => { btn.disabled = false; if (btn.textContent === 'Failed') btn.textContent = 'Retry'; }, 1500);
    }
  });

  actions.appendChild(select);
  actions.appendChild(btn);
  wrap.appendChild(actions);
  return wrap;
}

async function requestMediaPermissions(urls) {
  const origins = [];
  for (const u of urls || []) {
    try {
      if (u && /^https?:/i.test(u)) {
        const origin = new URL(u).origin + '/*';
        if (!origins.includes(origin)) origins.push(origin);
      }
    } catch {}
  }
  if (!origins.length) return false;
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

function ensureStatus(wrap) {
  let status = wrap.querySelector('.status');
  if (!status) {
    status = document.createElement('div');
    status.className = 'status';
    status.innerHTML = '<span class="txt">Starting…</span><div class="bar"><i></i></div>';
    wrap.appendChild(status);
  }
  return status;
}

chrome.runtime.onMessage?.addListener((msg) => {
  if (!msg) return;
  const id = msg.downloadId;
  const entry = progressById.get(id);
  if (!entry) {
    if (msg.type === 'UV_DOWNLOAD_STARTED' && msg.filename) {
      // no active row; ignore
    }
    return;
  }
  const status = ensureStatus(entry.wrap);
  const txt = status.querySelector('.txt');
  const bar = status.querySelector('.bar > i');
  if (msg.type === 'UV_DOWNLOAD_PROGRESS') {
    bar.style.width = `${Math.min(100, msg.progress || 0)}%`;
    txt.textContent = msg.status || 'Downloading…';
  } else if (msg.type === 'UV_DOWNLOAD_DONE') {
    bar.style.width = '100%';
    txt.textContent = 'Complete';
    entry.btn.textContent = 'Done';
  } else if (msg.type === 'UV_DOWNLOAD_ERROR') {
    txt.textContent = `Failed: ${msg.error || 'error'}`;
    entry.btn.disabled = false;
    entry.btn.textContent = 'Retry';
  }
  return false;
});

async function load(force) {
  showState('<div class="spinner"></div>Detecting media…');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;
  els.page.textContent = tab?.title ? tab.title : (tab?.url || '');
  if (!currentTabId) { showState('No active tab.'); return; }
  const resp = await send({ type: MSG.GET_TAB_MEDIA, tabId: currentTabId, force: !!force });
  if (!resp || !resp.ok) {
    showState(`Could not scan this page.<br><small>${escapeHtml((resp && resp.error) || '')}</small>`);
    els.note.classList.remove('hidden');
    return;
  }
  items = resp.items || [];
  render();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

els.rescan.addEventListener('click', () => load(true));
document.addEventListener('DOMContentLoaded', () => load(true));
if (document.readyState !== 'loading') load(true);
