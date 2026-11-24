// core/messaging.mjs
// Canonical message type constants shared by background / offscreen / popup (ES modules).
// NOTE: classic content scripts cannot import this file; keep string values in sync with
//       content/*.js and page/sniffer-page.js.

export const MSG = Object.freeze({
  // content/page -> background
  CANDIDATES: 'UV_CANDIDATES',                 // sniffer found media candidates
  PAGE_DATA: 'UV_PAGE_DATA',                   // page-context globals/scripts extracted
  SNIFFER_READY: 'UV_SNIFFER_READY',

  // background -> content
  RESCAN: 'UV_RESCAN',                         // ask content script to re-scan + report

  // popup -> content
  COLLECT: 'UV_COLLECT',                       // return raw candidates (perf/dom/page)
  PROBE: 'UV_PROBE',                           // fetch manifest/metadata for a candidate

  // popup/background
  ANALYZE: 'UV_ANALYZE',                       // raw candidates -> normalized media items
  GET_TAB_MEDIA: 'UV_GET_TAB_MEDIA',
  DOWNLOAD: 'UV_DOWNLOAD',
  CANCEL: 'UV_CANCEL',
  STATE: 'UV_STATE',

  // background -> offscreen
  OFF_START: 'UV_OFF_START',
  OFF_CANCEL: 'UV_OFF_CANCEL',
  OFF_PROGRESS: 'UV_OFF_PROGRESS',
  OFF_DONE: 'UV_OFF_DONE',
  OFF_ERROR: 'UV_OFF_ERROR',

  // offscreen -> background (offscreen documents only get chrome.runtime)
  SAVE_FILE: 'UV_SAVE_FILE',       // start a chrome.downloads.download
  SAVE_STATUS: 'UV_SAVE_STATUS',   // poll a chrome download's state

  // background -> content (panel updates)
  PANEL_PROGRESS: 'uvProgress',
  PANEL_DONE: 'uvComplete',
  PANEL_ERROR: 'uvError',
  PANEL_ADD: 'uvAddDownload',
});

export const DEFAULT_SETTINGS = Object.freeze({
  folder: 'UniversalVideoDownloader',
  // size threshold in MB: <= threshold may be transcoded for compatibility, > threshold is remux-only
  transcodeThresholdMB: 800,
  // never transcode on devices below this tier
  transcodeOnLowEnd: false,
  concurrency: 3,
  maxQuality: 0, // 0 = best available
  preferMp4: true,
  logLevel: 'error',
  streamingMux: true, // use incremental TS transmux + OPFS
});

export async function getSettings() {
  try {
    const stored = await chrome.storage.local.get('uvSettings');
    return { ...DEFAULT_SETTINGS, ...(stored?.uvSettings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  try { await chrome.storage.local.set({ uvSettings: next }); } catch {}
  return next;
}
