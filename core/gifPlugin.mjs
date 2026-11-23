// core/gifPlugin.mjs
// Global GIF scrape plugin — site-agnostic, additive only.
//
// Why a separate plugin: GIFs don't need manifest parsing (unlike HLS/DASH).
// They hide in <img>, og:image, CSS backgrounds, inline scripts and player
// globals, and the generic video sniffer ignores them. This module centralises
// all GIF heuristics so content/page/background share one definition.
//
// Flow: page/sniffer-page.js + content/sniffer.js collect raw URLs ->
// background.js merges via interpretGifPageData() + interpretGifGlobals() ->
// background builds a single-variant GIF item (treated as progressive download).
//
// Pure functions only (no DOM/chrome) so it runs in SW and Node tests.

import { KINDS, classifyUrl } from './formats.mjs';

export const GIF_PLUGIN_ID = 'global-gif-scrape';

export const GIF_RE = /\.gif(\?|#|$)/i;
export const WEBP_RE = /\.webp(\?|#|$)/i;
const GIF_CT_RE = /image\/gif/i;
const WEBP_CT_RE = /image\/webp/i;

const MAX_URLS = 200;
const MAX_SCAN_KEYS = 150;
const MAX_SCAN_DEPTH = 5;

/** True if a URL and/or content-type looks like a downloadable GIF/WebP. */
export function looksLikeGif(url, contentType = '') {
  const u = String(url || '');
  const ct = String(contentType || '');
  if (!u || /^(blob|data|about):/i.test(u)) return false;
  if (!/^https?:/i.test(u)) return false;
  if (GIF_RE.test(u)) return true;
  if (WEBP_RE.test(u)) return true;
  if (GIF_CT_RE.test(ct) || WEBP_CT_RE.test(ct)) return true;
  return false;
}

/** Classify wrapper — returns KINDS.GIF or null. */
export function gifKindFor(url, contentType = '') {
  return looksLikeGif(url, contentType) ? KINDS.GIF : null;
}

/** Extension for a gif URL: gif | webp | apng fallback gif. */
export function gifExtensionFor(url, mimeType = '') {
  const m = String(url || '').match(/\.(gif|webp|apng)(?:[?#]|$)/i);
  if (m) return m[1].toLowerCase();
  const mt = String(mimeType || '').toLowerCase();
  if (mt.includes('webp')) return 'webp';
  if (mt.includes('png')) return 'apng';
  return 'gif';
}

/** Stable dedupe key: host + path (query stripped except short signature). */
export function gifKey(url) {
  try {
    const u = new URL(String(url));
    return `gif:${u.host}${u.pathname}`.toLowerCase();
  } catch {
    return `gif:${String(url || '').slice(0, 200).toLowerCase()}`;
  }
}

function pushGif(list, seen, raw, meta = {}) {
  const url = typeof raw === 'string' ? raw : raw && raw.url;
  if (!url || typeof url !== 'string') return;
  if (!looksLikeGif(url, meta.contentType || (typeof raw === 'object' && raw.contentType) || '')) return;
  // Never surface segments / video chunks as GIFs.
  if (/\.(ts|m4s|m2ts|mpd|m3u8)(\?|#|$)/i.test(url)) return;
  const key = gifKey(url);
  if (seen.has(key)) return;
  seen.add(key);
  list.push({
    url,
    kind: KINDS.GIF,
    source: meta.source || 'gif',
    contentType: meta.contentType || (typeof raw === 'object' && raw.contentType) || null,
    title: meta.title || null,
    thumbnail: meta.thumbnail || null,
    initiator: meta.initiator || 'gif-scrape',
  });
  void classifyUrl;
}

/**
 * Interpret explicit URL lists from pageData (inline scripts, og:image,
 * twitter:image, harvested globals). Pure — used by background + tests.
 */
export function interpretGifPageData(pageData = {}, pageUrl = '') {
  void pageUrl;
  const out = [];
  const seen = new Set();
  const meta = {
    title: pageData?.meta?.title || null,
    thumbnail: pageData?.meta?.thumbnail || null,
    source: 'gif',
  };

  const urls = Array.isArray(pageData?.urls) ? pageData.urls : [];
  for (const item of urls.slice(0, MAX_URLS)) {
    if (!item) continue;
    if (typeof item === 'string') pushGif(out, seen, item, meta);
    else pushGif(out, seen, item.url, { ...meta, contentType: item.contentType, initiator: item.initiator || 'page' });
  }

  // og:image / twitter:image often hold the canonical GIF on meme/boards sites.
  for (const k of ['ogVideo', 'ogImage', 'twitterStream', 'twitterImage']) {
    const v = pageData?.meta?.[k];
    if (typeof v === 'string') pushGif(out, seen, v, { ...meta, initiator: `meta:${k}` });
  }

  // flashvars-style payloads occasionally embed gif preview URLs.
  const flashvars = Array.isArray(pageData?.flashvars)
    ? pageData.flashvars
    : pageData?.flashvars
      ? [pageData.flashvars]
      : [];
  for (const fv of flashvars) {
    if (!fv || typeof fv !== 'object') continue;
    for (const k of Object.keys(fv)) {
      const v = fv[k];
      if (typeof v === 'string') pushGif(out, seen, v, { ...meta, initiator: 'flashvars' });
    }
  }

  return out;
}

/**
 * Recursively hunt nested globals for GIF-looking strings.
 * Bounded (depth + key count) so hostile __NEXT_DATA__ can't hang the SW.
 */
export function interpretGifGlobals(globals = []) {
  const out = [];
  const seen = new Set();
  const hunt = (obj, depth, path) => {
    if (depth > MAX_SCAN_DEPTH || obj == null || out.length >= MAX_URLS) return;
    if (typeof obj === 'string') {
      // Fast path: only test strings that mention gif/webp at all.
      if (/gif|webp/i.test(obj)) {
        // May contain multiple URLs in one blob — extract all.
        const re = /https?:\/\/[^\s"'`\\<>]+?\.(?:gif|webp)(?:\?[^\s"'`\\<>]*)?/gi;
        let m;
        let guard = 0;
        while ((m = re.exec(obj)) !== null && guard++ < 20) {
          pushGif(out, seen, m[0].replace(/&amp;/g, '&'), { initiator: path });
        }
        // Single bare URL without scheme-relative noise.
        if (guard === 0) pushGif(out, seen, obj, { initiator: path });
      }
      return;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 100); i++) hunt(obj[i], depth + 1, path);
      return;
    }
    if (typeof obj === 'object') {
      const keys = Object.keys(obj);
      for (let i = 0; i < Math.min(keys.length, MAX_SCAN_KEYS); i++) {
        const k = keys[i];
        const v = obj[k];
        if (typeof v === 'string' && /gif|image|poster|src|url|file|media/i.test(k)) {
          if (/gif|webp/i.test(v)) pushGif(out, seen, v, { initiator: `${path}.${k}` });
        }
        hunt(v, depth + 1, path ? `${path}.${k}` : k);
      }
    }
  };
  for (const g of (globals || []).slice(0, 50)) {
    if (!g) continue;
    hunt(g?.value ?? g, 0, g?.key || 'global');
  }
  return out;
}

/** Merge + dedupe GIF candidates from every source. */
export function mergeGifCandidates({ pageUrls = [], globals = [], domUrls = [], perfUrls = [], pageData = {} } = {}) {
  const out = [];
  const seen = new Set();
  const pushAll = (items, source) => {
    for (const it of (items || []).slice(0, MAX_URLS)) {
      const url = typeof it === 'string' ? it : it?.url;
      pushGif(out, seen, url, {
        source: source || (typeof it === 'object' && it.source) || 'gif',
        contentType: (typeof it === 'object' && it.contentType) || null,
        initiator: (typeof it === 'object' && it.initiator) || source,
      });
    }
  };
  pushAll(pageUrls, 'gif-page');
  pushAll(domUrls, 'gif-dom');
  pushAll(perfUrls, 'gif-perf');
  for (const c of interpretGifPageData(pageData)) pushGif(out, seen, c.url, c);
  for (const c of interpretGifGlobals(globals.length ? globals : pageData?.globals || [])) {
    pushGif(out, seen, c.url, c);
  }
  return out.slice(0, MAX_URLS);
}

export const gifPlugin = {
  id: GIF_PLUGIN_ID,
  label: 'Global GIF scrape',
  kinds: [KINDS.GIF],
  test: () => true,
  looksLikeGif,
  interpretGifPageData,
  interpretGifGlobals,
  mergeGifCandidates,
};
