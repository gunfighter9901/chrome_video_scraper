// core/formats.mjs
// Pure helpers: URL/kind classification, variant normalization/sorting, naming, and the
// size-based output policy (<= threshold may transcode, > threshold is remux-only).

export const KINDS = Object.freeze({ HLS: 'hls', DASH: 'dash', PROGRESSIVE: 'progressive', UNKNOWN: 'unknown' });

const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|flv|avi|wmv|m4s|ts|m2ts|mpd|m3u8)(\?|#|$)/i;
const SEGMENT_EXT = /\.(ts|m4s|m2ts|aac|cmfv|cmfa)(\?|#|$)/i;

/** Classify a URL by extension and/or content type. Returns one of KINDS or null. */
export function classifyUrl(url, contentType = '') {
  const u = String(url || '');
  const ct = String(contentType || '').toLowerCase();
  if (/\.m3u8(\?|#|$)/i.test(u) || ct.includes('mpegurl')) return KINDS.HLS;
  if (/\.mpd(\?|#|$)/i.test(u) || ct.includes('dash+xml')) return KINDS.DASH;
  if (ct.startsWith('video/')) {
    if (ct.includes('mp2t')) return null; // a TS segment, not a standalone asset
    return KINDS.PROGRESSIVE;
  }
  if (ct.includes('application/octet-stream') && /\.(mp4|webm|mkv|mov)(\?|#|$)/i.test(u)) return KINDS.PROGRESSIVE;
  if (/\.(mp4|m4v|webm|mkv|mov|flv)(\?|#|$)/i.test(u)) return KINDS.PROGRESSIVE;
  return null;
}

export function isSegmentUrl(url) {
  return SEGMENT_EXT.test(String(url || ''));
}

/** Heuristic: are these HLS/DASH segments fragmented MP4 (vs MPEG-TS)? */
export function isFmp4Segments(segments) {
  const first = segments && segments[0];
  if (!first) return false;
  if (first.map && first.map.url) return true;
  return /\.(m4s|mp4|cmfv|cmfa)(\?|#|$)/i.test(first.url || '');
}

export function isMediaUrl(url) {
  return MEDIA_EXT.test(String(url || ''));
}

/** Stable de-duplication key for a URL (host+path+hash-ish, ignoring volatile query tokens). */
export function mediaKey(url) {
  try {
    const u = new URL(String(url));
    const seg = u.pathname;
    // Keep a short query signature so distinct signed streams don't collapse to one.
    const q = u.search ? u.search.slice(0, 48) : '';
    return `${u.host}${seg}${q}`;
  } catch {
    return String(url || '').slice(0, 200);
  }
}

export function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return ''; }
}

export function originOf(url) {
  try { return new URL(String(url)).origin; } catch { return ''; }
}

/** Parse a quality label ("1080p", "1280x720", "720") into a height number (0 if unknown). */
export function parseQuality(value) {
  if (value == null) return 0;
  const s = String(value);
  const wxh = s.match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/i);
  if (wxh) return parseInt(wxh[2], 10);
  const p = s.match(/(\d{3,5})\s*p/i);
  if (p) return parseInt(p[1], 10);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

export function variantHeight(v) {
  return (v && (v.height || parseQuality(v.quality) || parseQuality(v.label))) || 0;
}

export function variantBandwidth(v) {
  return (v && (v.bandwidth || v.tbr || 0)) || 0;
}

/** Normalize a raw variant into the canonical shape used by the UI and downloader. */
export function normalizeVariant(raw = {}) {
  const height = variantHeight(raw);
  return {
    url: raw.url,
    kind: raw.kind || null,
    height,
    width: raw.width || (height ? Math.round((height * 16) / 9 / 2) * 2 : null),
    bandwidth: variantBandwidth(raw) || null,
    codecs: raw.codecs || (raw.videoCodec ? [raw.videoCodec, raw.audioCodec].filter(Boolean).join(',') : ''),
    videoCodec: raw.videoCodec || null,
    audioCodec: raw.audioCodec || null,
    mimeType: raw.mimeType || null,
    label: raw.label || (height ? `${height}p` : (raw.name || 'default')),
    audioUrl: raw.audioUrl || null,
    initUrl: raw.initUrl || null,
    segments: raw.segments || null,
    duration: raw.duration || null,
    sizeBytes: raw.sizeBytes || null,
    isDefault: !!raw.isDefault,
    extras: raw.extras || undefined,
  };
}

/** Sort variants best-first: higher resolution, then higher bitrate, then progressive preferred. */
export function sortVariants(variants) {
  return [...(variants || [])].filter((v) => v && v.url).sort((a, b) => {
    const ah = variantHeight(a); const bh = variantHeight(b);
    if (ah !== bh) return bh - ah;
    const ab = variantBandwidth(a); const bb = variantBandwidth(b);
    if (ab !== bb) return bb - ab;
    const aProg = a.kind === KINDS.PROGRESSIVE ? 1 : 0;
    const bProg = b.kind === KINDS.PROGRESSIVE ? 1 : 0;
    return bProg - aProg;
  });
}

const CODEC_COMPAT = {
  h264: true, avc: true, avc1: true,
  aac: true, mp4a: true,
  hevc: false, hvc1: false, hev1: false,
  vp9: true, vp09: true, av1: true, av01: true,
  opus: 'maybe', vorbis: 'maybe', mp3: true,
};

export function codecCompat(codec) {
  const c = String(codec || '').toLowerCase().split('.')[0];
  if (!c) return 'maybe';
  for (const key of Object.keys(CODEC_COMPAT)) {
    if (c.startsWith(key)) return CODEC_COMPAT[key];
  }
  return 'maybe';
}

/**
 * Decide whether to remux or transcode.
 * Policy (owner decision): <= thresholdMB -> prefer transcode for compatibility when needed;
 *                            >  thresholdMB -> remux only (avoid CPU drain).
 * Transcode is only recommended when the source codecs are NOT already broadly compatible,
 * or when the user explicitly asked for maximum compatibility.
 */
export function decideOutputPolicy({ sizeBytes = 0, videoCodec = '', audioCodec = '', thresholdMB = 800, preferCompatible = true, deviceCanTranscode = true } = {}) {
  const thresholdBytes = thresholdMB * 1024 * 1024;
  const sizeKnown = sizeBytes > 0;
  const tooBig = sizeKnown && sizeBytes > thresholdBytes;
  const vOk = codecCompat(videoCodec) === true;
  const aOk = codecCompat(audioCodec) === true;
  const compatible = vOk && aOk;

  if (!preferCompatible || compatible) {
    return { mode: 'remux', reason: compatible ? 'already-compatible' : 'no-transcode-requested' };
  }
  if (tooBig) {
    return { mode: 'remux', reason: 'over-threshold-remux-only' };
  }
  if (!sizeKnown) {
    // Unknown size: be conservative on low-end/remux to avoid runaway CPU.
    return { mode: 'remux', reason: 'unknown-size-remux-only' };
  }
  if (!deviceCanTranscode) {
    return { mode: 'remux', reason: 'device-cannot-transcode' };
  }
  return { mode: 'transcode', reason: 'small-incompatible-compat' };
}

/** Best-effort device capability check (Chromium exposes these; may be undefined elsewhere). */
export function deviceProfile() {
  const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || null;
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || null;
  const webCodecs = typeof globalThis !== 'undefined' && !!globalThis.VideoEncoder;
  const lowEnd = (mem != null && mem < 4) || (cores != null && cores < 4);
  return { memoryGB: mem, cores, webCodecs, lowEnd, canTranscode: webCodecs && !lowEnd };
}

export function sanitizeFilename(name, maxLen = 180) {
  const cleaned = String(name || 'video')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || 'video').substring(0, maxLen);
}

export function buildFilename(title, { ext = 'mp4', quality = '', id = '' } = {}) {
  const base = sanitizeFilename(title || id || 'video');
  const suffix = quality ? ` [${quality}]` : '';
  return `${base}${suffix}.${ext}`;
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Human label for a variant. */
export function variantLabel(v) {
  if (!v) return 'Unknown';
  const h = variantHeight(v);
  const kindLabel = v.kind === KINDS.HLS ? 'HLS' : v.kind === KINDS.DASH ? 'DASH' : 'MP4';
  const size = v.sizeBytes ? ` · ${formatBytes(v.sizeBytes)}` : '';
  return `${h ? `${h}p` : (v.label || 'default')} · ${kindLabel}${size}`;
}
