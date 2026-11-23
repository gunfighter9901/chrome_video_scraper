// core/adapters.mjs
// Adapter registry + generic page-data interpretation.
//
// Adapters are optional, additive hints on top of generic network/DOM sniffing. The generic
// adapter always works; an adapter may add a referer/UA hint or interpret a known API shape.

import { KINDS, classifyUrl, isMediaUrl, isSegmentUrl } from './formats.mjs';

const SITE_ADAPTERS = [
  {
    id: 'generic',
    label: 'Generic',
    test: () => true,
    referer: null,
  },
];

export function getAdapter(url) {
  const u = String(url || '');
  for (const a of SITE_ADAPTERS) {
    try { if (a.test === true || (a.test instanceof RegExp ? a.test.test(u) : a.test(u))) return a; } catch {}
  }
  return SITE_ADAPTERS[SITE_ADAPTERS.length - 1];
}

/** Referer to use for a media URL given the page URL. */
export function refererFor(mediaUrl, pageUrl) {
  const adapter = getAdapter(mediaUrl);
  if (adapter.referer) return adapter.referer;
  if (pageUrl && /^https?:/i.test(pageUrl)) return pageUrl;
  return null;
}

function pushCandidate(list, seen, raw, meta = {}) {
  const url = typeof raw === 'string' ? raw : raw && raw.url;
  if (!url || typeof url !== 'string' || url.length < 8) return;
  if (!/^https?:/i.test(url) && !url.startsWith('blob:')) return;
  if (url.startsWith('blob:') || url.startsWith('data:')) return;
  if (isSegmentUrl(url)) return; // never surface raw segments as top-level media
  const kind = classifyUrl(url, meta.contentType || '') || KINDS.HLS; // heuristics: unknown but media-ish
  if (!kind) return;
  const key = `${kind}:${url}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push({
    url,
    kind,
    source: meta.source || 'page',
    contentType: meta.contentType || null,
    title: meta.title || null,
    thumbnail: meta.thumbnail || null,
    duration: meta.duration || null,
    initiator: meta.initiator || null,
  });
}

/**
 * Interpret page-context data collected by page/sniffer-page.js.
 * @param {object} pageData
 * @param {string} pageUrl
 * @returns {Array<object>} raw candidates
 */
export function interpretPageData(pageData, pageUrl) {
  const out = [];
  const seen = new Set();
  const meta = {
    title: pageData?.meta?.title || null,
    thumbnail: pageData?.meta?.thumbnail || null,
    duration: pageData?.meta?.duration || null,
    source: 'page',
  };

  // 1. Player flashvars mediaDefinitions
  const flashvarsList = Array.isArray(pageData?.flashvars) ? pageData.flashvars : (pageData?.flashvars ? [pageData.flashvars] : []);
  for (const fv of flashvarsList) {
    const defs = fv?.mediaDefinitions;
    if (Array.isArray(defs)) {
      for (const d of defs) {
        if (!d || typeof d !== 'object') continue;
        pushCandidate(out, seen, d.videoUrl || d.url, {
          ...meta,
          contentType: d.format === 'hls' ? 'application/vnd.apple.mpegurl' : undefined,
          initiator: 'flashvars',
        });
      }
    }
    if (fv?.videoUrl) pushCandidate(out, seen, fv.videoUrl, { ...meta, initiator: 'flashvars' });
  }

  // 2. Explicit URL lists gathered from globals/scripts
  const urls = Array.isArray(pageData?.urls) ? pageData.urls : [];
  for (const item of urls) {
    if (!item) continue;
    if (typeof item === 'string') pushCandidate(out, seen, item, meta);
    else pushCandidate(out, seen, item.url, { ...meta, contentType: item.contentType, initiator: item.initiator });
  }

  // 3. Nested structures: recursively hunt for media-looking strings (bounded depth)
  const hunt = (obj, depth, path) => {
    if (depth > 5 || obj == null) return;
    if (typeof obj === 'string') {
      if (isMediaUrl(obj) && !isSegmentUrl(obj)) pushCandidate(out, seen, obj, { ...meta, initiator: path });
      return;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 200); i++) hunt(obj[i], depth + 1, path);
      return;
    }
    if (typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (/^(videoUrl|src|file|url|playlist|manifest|hls|dash|mp4|source)$/i.test(k)) {
          const v = obj[k];
          if (typeof v === 'string') pushCandidate(out, seen, v, { ...meta, initiator: `${path}.${k}` });
        }
        hunt(obj[k], depth + 1, path ? `${path}.${k}` : k);
      }
    }
  };
  for (const g of (pageData?.globals || [])) hunt(g?.value, 0, g?.key || 'global');

  return out;
}

export const KNOWN_ADAPTERS = SITE_ADAPTERS;
