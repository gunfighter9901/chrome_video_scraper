// background.js
// Universal Video Downloader — MV3 service worker (module).
// Responsibilities: inject the sniffer, aggregate detected media into per-tab "items",
// route downloads to the offscreen document, and forward progress to UI surfaces.

import { MSG, getSettings, setSettings } from './core/messaging.mjs';
import { parseM3U8 } from './core/hls.mjs';
import { parseMpd } from './core/dash.mjs';
import {
  KINDS, classifyUrl, mediaKey, sortVariants, normalizeVariant, variantHeight,
  buildFilename, extensionForVariant, decideOutputPolicy, deviceProfile,
} from './core/formats.mjs';
import { interpretPageData, refererFor, getAdapter } from './core/adapters.mjs';

const CONTENT_FILES = ['content/sniffer.js', 'content/panel.js', 'content/button.js'];
const CONTENT_CSS = ['content/panel.css', 'content/button.css'];
const PAGE_FILES = ['page/sniffer-page.js'];
const OFFSCREEN_URL = 'offscreen.html';

const log = (...a) => { try { console.debug('[UV]', ...a); } catch {} };

/* ------------------------------------------------------------------ registry */

/** tabId -> { items: Map<id, item>, page, updatedAt } */
const tabRegistry = new Map();
/** downloadId -> { tabId, itemId, filename, variant } */
const downloads = new Map();
const injectedTabs = new Set();

let profile = null;
function device() {
  if (!profile) profile = deviceProfile();
  return profile;
}

/* ------------------------------------------------------------------ messaging */

function tabSend(tabId, message, { timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'timeout' }); } }, timeout);
    try {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: false, error: 'no-response' });
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: String(e) });
    }
  });
}

function broadcast(message) {
  try { chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; }); } catch {}
}

async function ensureInjected(tabId) {
  if (injectedTabs.has(tabId)) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_CSS }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: PAGE_FILES }).catch(() => {});
    injectedTabs.add(tabId);
    return true;
  } catch (e) {
    log('inject failed', e?.message);
    return false;
  }
}

/* ------------------------------------------------------------------ analysis */

async function collectSnapshot(tabId) {
  const resp = await tabSend(tabId, { type: 'UV_COLLECT' }, { timeout: 8000 });
  if (!resp || !resp.ok) return { candidates: [], pageData: {}, page: {} };
  return { candidates: resp.candidates || [], pageData: resp.pageData || {}, page: resp.page || {} };
}

function mergeCandidates(snapshot) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const url = typeof raw === 'string' ? raw : raw && raw.url;
    if (!url || !/^https?:/i.test(url)) return;
    const kind = (raw && raw.kind) || classifyUrl(url, (raw && raw.contentType) || '');
    if (!kind) return;
    const key = mediaKey(url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, kind, contentType: (raw && raw.contentType) || null, source: (raw && raw.source) || 'sniff' });
  };
  for (const c of snapshot.candidates || []) push(c);
  for (const c of interpretPageData(snapshot.pageData, snapshot.page?.url)) push(c);
  return out;
}

function buildItems(snapshot, probes) {
  const items = [];
  const page = snapshot.page || {};
  const pageUrl = page.url || '';
  const probeByUrl = new Map();
  for (const p of probes || []) {
    if (p && p.url) {
      probeByUrl.set(p.url, p);
      if (p.finalUrl) probeByUrl.set(p.finalUrl, p);
    }
  }

  const candidates = mergeCandidates(snapshot);
  for (const cand of candidates) {
    const probe = probeByUrl.get(cand.url) || {};
    const contentType = probe.contentType || cand.contentType || '';
    let kind = cand.kind || classifyUrl(cand.url, contentType);

    try {
      if (kind === KINDS.HLS) {
        const item = buildHlsItem(cand, probe, page, pageUrl);
        if (item) items.push(item);
      } else if (kind === KINDS.DASH) {
        const item = buildDashItem(cand, probe, page, pageUrl);
        if (item) items.push(item);
      } else {
        const item = buildProgressiveItem(cand, probe, page, pageUrl);
        if (item) items.push(item);
      }
    } catch (e) {
      log('build item failed', e?.message);
    }
  }
  // De-duplicate items by their primary URL.
  const seen = new Set();
  return items.filter((it) => {
    const k = mediaKey(it.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function baseItem(cand, page, pageUrl) {
  const adapter = getAdapter(cand.url);
  return {
    id: `m-${Math.abs(hashString(cand.url)).toString(36)}`,
    url: cand.url,
    kind: cand.kind,
    source: cand.source,
    pageUrl,
    referer: refererFor(cand.url, pageUrl) || pageUrl || null,
    adapter: adapter.id,
    title: page.title || null,
    thumbnail: page.thumbnail || null,
    duration: page.duration || null,
    drm: false,
    drmSystems: [],
    variants: [],
    error: null,
  };
}

function buildHlsItem(cand, probe, page, pageUrl) {
  if (!probe || probe.ok === false || !probe.text) {
    // Manifest couldn't be read directly; still expose the raw URL as a downloadable item.
    const item = baseItem(cand, page, pageUrl);
    item.variants = [normalizeVariant({ url: cand.url, kind: KINDS.HLS, label: 'auto' })];
    if (probe && probe.error) item.error = probe.error;
    return item;
  }
  const parsed = parseM3U8(probe.text, probe.finalUrl || cand.url);
  if (parsed.error && parsed.error !== 'empty-playlist') {
    // Not actually a playlist.
    return buildProgressiveItem(cand, probe, page, pageUrl);
  }
  const item = baseItem(cand, page, pageUrl);
  item.drm = parsed.drm;
  item.drmSystems = parsed.drmMethods;
  item.duration = item.duration || parsed.totalDuration || null;

  if (parsed.isMaster && parsed.variants.length) {
    item.variants = parsed.variants.map((v) => normalizeVariant({
      url: v.url,
      kind: KINDS.HLS,
      width: v.width,
      height: v.height,
      bandwidth: v.bandwidth,
      videoCodec: v.videoCodec,
      audioCodec: v.audioCodec,
      codecs: (v.codecs || []).join(','),
      isDefault: !!v.name,
    }));
  } else {
    item.variants = [normalizeVariant({
      url: probe.finalUrl || cand.url,
      kind: KINDS.HLS,
      label: parsed.totalDuration ? 'playlist' : 'auto',
      duration: parsed.totalDuration || null,
    })];
  }
  item.variants = sortVariants(item.variants);
  return item;
}

function buildDashItem(cand, probe, page, pageUrl) {
  const item = baseItem(cand, page, pageUrl);
  if (!probe || !probe.text) {
    item.variants = [normalizeVariant({ url: cand.url, kind: KINDS.DASH, label: 'auto' })];
    return item;
  }
  const mpd = parseMpd(probe.text, probe.finalUrl || cand.url);
  item.drm = mpd.drm;
  item.drmSystems = mpd.drmSystems;
  item.duration = item.duration || mpd.duration || null;
  if (!mpd.representations.length) {
    item.variants = [normalizeVariant({ url: cand.url, kind: KINDS.DASH, label: 'auto' })];
    return item;
  }
  const videos = mpd.representations.filter((r) => r.type === 'video');
  const audios = mpd.representations.filter((r) => r.type === 'audio');
  const bestAudio = [...audios].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0] || null;
  item.variants = videos.map((v) => normalizeVariant({
    url: v.segments[0]?.url || v.baseUrl,
    kind: KINDS.DASH,
    width: v.width,
    height: v.height,
    bandwidth: v.bandwidth,
    videoCodec: v.codecs,
    codecs: v.codecs,
    initUrl: v.initUrl,
    segments: v.segments,
    extras: bestAudio ? {
      audio: {
        url: bestAudio.segments[0]?.url,
        initUrl: bestAudio.initUrl,
        segments: bestAudio.segments,
        codecs: bestAudio.codecs,
        bandwidth: bestAudio.bandwidth,
      },
    } : undefined,
  }));
  item.variants = sortVariants(item.variants);
  return item;
}

function buildProgressiveItem(cand, probe, page, pageUrl) {
  const item = baseItem(cand, page, pageUrl);
  const size = probe && probe.contentLength ? probe.contentLength : 0;
  item.variants = [normalizeVariant({
    url: probe?.finalUrl || cand.url,
    kind: KINDS.PROGRESSIVE,
    label: size ? undefined : 'auto',
    sizeBytes: size || null,
    mimeType: probe?.contentType || null,
  })];
  return item;
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return h;
}

async function getMediaForTab(tabId, { force = false } = {}) {
  const existing = tabRegistry.get(tabId);
  if (!force && existing && Date.now() - existing.updatedAt < 4000) return existing;

  const injected = await ensureInjected(tabId);
  if (!injected) throw new Error('Cannot access this page. Click the extension icon on the tab, then retry.');

  const snapshot = await collectSnapshot(tabId);
  const candidates = mergeCandidates(snapshot);
  const probeResp = await tabSend(tabId, { type: 'UV_PROBE', candidates }, { timeout: 20000 });
  const probes = (probeResp && probeResp.results) || [];
  const items = buildItems(snapshot, probes);
  const entry = { items, page: snapshot.page || {}, updatedAt: Date.now() };
  tabRegistry.set(tabId, entry);
  return entry;
}

/* ------------------------------------------------------------------ offscreen */

let offscreenReady = null;
async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    try {
      if (chrome.offscreen && chrome.offscreen.hasDocument) {
        if (await chrome.offscreen.hasDocument()) return true;
      } else {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (contexts && contexts.length) return true;
      }
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS', 'DOM_SCRAPING'],
        justification: 'Stream and remux detected video into a downloadable file using OPFS.',
      });
      return true;
    } catch (e) {
      log('offscreen create failed', e?.message);
      offscreenReady = null;
      return false;
    }
  })();
  return offscreenReady;
}

function offscreenSend(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask the browser's download manager to save a URL (blob: or http:). This MUST run in the
 * service worker: offscreen documents only expose chrome.runtime, not chrome.downloads.
 */
async function startChromeDownload({ url, filename, folder }) {
  if (!url || !filename) throw new Error('Missing download URL or filename');
  const path = `${folder || 'UniversalVideoDownloader'}/${filename}`;
  const chromeId = await chrome.downloads.download({ url, filename: path, saveAs: false });
  return { chromeId, path };
}

function chromeDownloadStatus(chromeId) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.search({ id: chromeId }, (items) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        const item = items && items[0];
        if (!item) { resolve({ ok: false, error: 'not-found' }); return; }
        resolve({ ok: true, state: item.state, filename: item.filename || null, error: item.error || null });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

function usableItems(items) {
  return (items || []).filter((it) => it && !it.drm && it.variants && it.variants.length);
}

/** Pick the highest-resolution item/variant pair. Variants are already sorted best-first. */
function pickBestItem(items) {
  let best = null;
  let bestHeight = -1;
  for (const item of items) {
    const variant = item.variants[0];
    const height = variantHeight(variant);
    if (height > bestHeight) { bestHeight = height; best = { item, variant }; }
  }
  return best;
}

/**
 * Send a job to the offscreen document, retrying if the document was just created and its
 * module listener has not registered yet (a real race on the first download).
 */
async function startOffscreenJob(job) {
  let lastError = 'Worker did not acknowledge the job';
  for (let attempt = 0; attempt < 6; attempt++) {
    if (!(await ensureOffscreen())) {
      lastError = 'Could not create the download worker';
    } else {
      const ack = await offscreenSend({ type: MSG.OFF_START, job });
      if (ack && ack.ok !== false) return { ok: true };
      lastError = ack?.error || lastError;
    }
    offscreenReady = null; // force a re-check on the next attempt
    await sleep(200 + attempt * 250);
  }
  return { ok: false, error: lastError };
}

/* ------------------------------------------------------------------ downloads */

function resolveVariant(item, index) {
  if (!item || !Array.isArray(item.variants) || !item.variants.length) return null;
  const i = Number.isInteger(index) && index >= 0 && index < item.variants.length ? index : 0;
  return item.variants[i];
}

async function startDownload({ tabId, item, variant, pageUrl }) {
  if (!item) throw new Error('No media selected');
  if (item.drm) throw new Error('This stream is DRM-protected and cannot be downloaded.');
  if (!variant || !variant.url) throw new Error('No downloadable variant');

  const settings = await getSettings();
  const referer = item.referer || refererFor(variant.url, pageUrl) || pageUrl || null;
  const quality = variantHeight(variant) ? `${variantHeight(variant)}p` : '';
  const folder = settings.folder;
  const filename = buildFilename(item.title || 'video', { ext: extensionForVariant(variant), quality });
  const policy = decideOutputPolicy({
    sizeBytes: variant.sizeBytes || 0,
    videoCodec: variant.videoCodec || '',
    audioCodec: variant.audioCodec || '',
    thresholdMB: settings.transcodeThresholdMB,
    preferCompatible: true,
    deviceCanTranscode: device().canTranscode,
  });

  const jobId = `uv-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const job = {
    id: jobId,
    kind: variant.kind || item.kind,
    url: variant.url,
    initUrl: variant.initUrl || null,
    segments: variant.segments || null,
    audio: (variant.extras && variant.extras.audio) || null,
    referer,
    filename,
    folder,
    policy,
    concurrency: Math.max(1, Math.min(6, settings.concurrency || 3)),
    pageUrl: pageUrl || item.pageUrl || null,
    title: item.title || null,
    tabId: tabId || null,
  };

  const ready = await ensureOffscreen();
  if (!ready) throw new Error('Could not start the download worker');

  const ack = await startOffscreenJob(job);
  if (!ack.ok) throw new Error(ack.error || 'Worker rejected the job');

  downloads.set(jobId, { tabId, itemId: item.id, filename, variant, title: item.title });
  if (tabId) {
    try {
      chrome.tabs.sendMessage(tabId, { action: 'uvAddDownload', downloadId: jobId, filename }, () => void chrome.runtime.lastError);
    } catch {}
  }
  broadcast({ type: 'UV_DOWNLOAD_STARTED', downloadId: jobId, filename, title: item.title, folder });
  return jobId;
}

/* ------------------------------------------------------------------ router */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  if (!type) return false;

  switch (type) {
    case MSG.CANDIDATES: {
      const tabId = sender?.tab?.id;
      if (tabId && message.snapshot) {
        const prev = tabRegistry.get(tabId);
        tabRegistry.set(tabId, {
          items: prev ? prev.items : [],
          page: message.snapshot.page || {},
          raw: message.snapshot,
          updatedAt: prev ? prev.updatedAt : 0,
        });
      }
      sendResponse?.({ ok: true });
      return false;
    }

    case MSG.GET_TAB_MEDIA: {
      (async () => {
        try {
          const tabId = message.tabId || (await activeTabId());
          if (!tabId) throw new Error('No active tab');
          const entry = await getMediaForTab(tabId, { force: !!message.force });
          sendResponse({ ok: true, items: entry.items, page: entry.page, device: device() });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    case MSG.DOWNLOAD: {
      (async () => {
        try {
          const tabId = message.tabId || (await activeTabId());
          const entry = message.item ? null : tabRegistry.get(tabId);
          const item = message.item || (entry && entry.items.find((it) => it.id === message.itemId));
          const variant = resolveVariant(item, message.variantIndex);
          const downloadId = await startDownload({ tabId, item, variant, pageUrl: message.pageUrl || item?.pageUrl });
          sendResponse({ ok: true, downloadId });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    case 'UV_QUICK_DOWNLOAD': {
      (async () => {
        try {
          const tabId = sender?.tab?.id;
          if (!tabId) throw new Error('No tab context');
          const entry = await getMediaForTab(tabId, { force: true });
          const usable = usableItems(entry.items);
          if (!usable.length) {
            // Fall back to any drm item to give a precise error.
            if (entry.items.some((it) => it.drm)) throw new Error('Only DRM-protected streams were found');
            throw new Error('No downloadable media found. Press play, then try again.');
          }
          const chosen = pickBestItem(usable);
          const downloadId = await startDownload({ tabId, item: chosen.item, variant: chosen.variant, pageUrl: entry.page?.url });
          sendResponse({ ok: true, downloadId });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    case MSG.CANCEL: {
      const id = message.downloadId;
      downloads.delete(id);
      offscreenSend({ type: MSG.OFF_CANCEL, id }).then(() => sendResponse?.({ ok: true }));
      return true;
    }

    // The offscreen document creates the blob URL; only this service worker may use
    // chrome.downloads (offscreen documents only expose chrome.runtime).
    case MSG.SAVE_FILE: {
      (async () => {
        try {
          const saved = await startChromeDownload({
            url: message.url,
            filename: message.filename,
            folder: message.folder,
          });
          sendResponse({ ok: true, chromeId: saved.chromeId, path: saved.path });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    case MSG.SAVE_STATUS: {
      chromeDownloadStatus(message.chromeId).then(sendResponse);
      return true;
    }

    case MSG.OFF_PROGRESS:
    case MSG.OFF_DONE:
    case MSG.OFF_ERROR: {
      forwardDownloadEvent(message);
      sendResponse?.({ ok: true });
      return false;
    }

    case 'UV_RELAY_FETCH': {
      (async () => {
        try {
          const tabId = message.tabId || (await activeTabId());
          if (!tabId) throw new Error('No tab for relay');
          const resp = await tabSend(tabId, {
            type: 'UV_RELAY_FETCH',
            url: message.url,
            range: message.range || null,
            wantText: !!message.wantText,
            referer: message.referer || null,
          }, { timeout: 45000 });
          sendResponse(resp);
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    case 'UV_GET_SETTINGS': {
      getSettings().then((s) => sendResponse({ ok: true, settings: s }));
      return true;
    }
    case 'UV_SET_SETTINGS': {
      setSettings(message.patch || {}).then((s) => sendResponse({ ok: true, settings: s }));
      return true;
    }

    default:
      return false;
  }
});

function forwardDownloadEvent(message) {
  const id = message.id;
  const info = downloads.get(id) || {};
  const tabId = info.tabId;
  if (message.type === MSG.OFF_PROGRESS) {
    broadcast({ type: 'UV_DOWNLOAD_PROGRESS', downloadId: id, ...message });
    if (tabId) {
      try {
        chrome.tabs.sendMessage(tabId, {
          action: 'uvProgress',
          downloadId: id,
          data: { progress: message.progress || 0, status: message.status || '', downloaded: message.downloaded, total: message.total },
        }, () => void chrome.runtime.lastError);
      } catch {}
    }
  } else if (message.type === MSG.OFF_DONE) {
    downloads.delete(id);
    broadcast({ type: 'UV_DOWNLOAD_DONE', downloadId: id, filename: message.filename || info.filename, path: message.path || null });
    if (tabId) {
      try { chrome.tabs.sendMessage(tabId, { action: 'uvComplete', downloadId: id, filename: info.filename }, () => void chrome.runtime.lastError); } catch {}
    }
  } else if (message.type === MSG.OFF_ERROR) {
    downloads.delete(id);
    broadcast({ type: 'UV_DOWNLOAD_ERROR', downloadId: id, error: message.error });
    if (tabId) {
      try { chrome.tabs.sendMessage(tabId, { action: 'uvError', downloadId: id, error: message.error }, () => void chrome.runtime.lastError); } catch {}
    }
  }
}

async function activeTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id || null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ misc */

chrome.tabs?.onRemoved?.addListener((tabId) => {
  tabRegistry.delete(tabId);
  injectedTabs.delete(tabId);
});

// A navigation replaces the page context, so the injected scripts and cached items are gone.
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo && (changeInfo.status === 'loading' || changeInfo.url)) {
    injectedTabs.delete(tabId);
    tabRegistry.delete(tabId);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: 'uv-download-media',
      title: 'Download media with Universal Video Downloader',
      contexts: ['page', 'video', 'audio'],
    });
  } catch {}
  try { chrome.storage.local.set({ uvInstalled: Date.now() }); } catch {}
});

chrome.contextMenus?.onClicked?.addListener((info, tab) => {
  if (info.menuItemId !== 'uv-download-media' || !tab?.id) return;
  (async () => {
    try {
      const entry = await getMediaForTab(tab.id, { force: true });
      const usable = usableItems(entry.items);
      const chosen = pickBestItem(usable);
      if (!chosen) return;
      await startDownload({ tabId: tab.id, item: chosen.item, variant: chosen.variant, pageUrl: entry.page?.url });
    } catch (e) { log('context menu download failed', e?.message); }
  })();
});

log('background ready');
