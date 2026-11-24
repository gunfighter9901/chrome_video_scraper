// core/hls.mjs
// Pure HLS (M3U8) playlist parser. No DOM/network access; safe in service worker and Node.
// Handles master + media playlists, attributes, byte ranges, keys (DRM detection),
// EXT-X-MAP init segments, and signed-query inheritance for relative URLs.

const RE = {
  STREAM_INF: /^#EXT-X-STREAM-INF:(.*)$/i,
  MEDIA: /^#EXT-X-MEDIA:(.*)$/i,
  I_FRAME_STREAM_INF: /^#EXT-X-I-FRAME-STREAM-INF:(.*)$/i,
  KEY: /^#EXT-X-KEY:(.*)$/i,
  SESSION_KEY: /^#EXT-X-SESSION-KEY:(.*)$/i,
  MAP: /^#EXT-X-MAP:(.*)$/i,
  EXTINF: /^#EXTINF:\s*([\d.]+)\s*(?:,\s*(.*))?$/i,
  BYTERANGE: /^#EXT-X-BYTERANGE:(.*)$/i,
  TARGETDURATION: /^#EXT-X-TARGETDURATION:\s*(\d+(?:\.\d+)?)/i,
  MEDIA_SEQUENCE: /^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/i,
  DISCONTINUITY_SEQ: /^#EXT-X-DISCONTINUITY-SEQUENCE:\s*(\d+)/i,
  PLAYLIST_TYPE: /^#EXT-X-PLAYLIST-TYPE:\s*(\S+)/i,
  VERSION: /^#EXT-X-VERSION:\s*(\d+)/i,
  START: /^#EXT-X-START:(.*)$/i,
  ENDLIST: /^#EXT-X-ENDLIST/i,
  DISCONTINUITY: /^#EXT-X-DISCONTINUITY\s*$/i,
  GAP: /^#EXT-X-GAP/i,
};

/** Parse an HLS attribute list: KEY=VALUE,KEY="quoted,value",KEY=0x1F */
export function parseAttributes(input) {
  const out = {};
  const str = String(input || '');
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    let value = m[2];
    if (value && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[m[1].toUpperCase()] = value;
  }
  return out;
}

/** Resolve a possibly-relative playlist URL. Inherits the base query (signed tokens) when the
 *  relative resource has no query of its own. */
export function resolveUrl(baseUrl, resource) {
  const raw = String(resource || '').trim();
  if (!raw) return raw;
  try {
    const base = new URL(baseUrl);
    const resolved = new URL(raw, base);
    if (!resolved.search && !raw.includes('?') && base.search) {
      resolved.search = base.search;
    }
    return resolved.toString();
  } catch {
    return raw;
  }
}

function parseByteRange(attr) {
  if (!attr) return null;
  const [lenStr, offStr] = String(attr).split('@');
  const length = parseInt(lenStr, 10);
  if (!Number.isFinite(length)) return null;
  const offset = offStr !== undefined ? parseInt(offStr, 10) : null;
  return { length, offset: Number.isFinite(offset) ? offset : null };
}

function isDrmMethod(method) {
  const m = String(method || '').toUpperCase();
  return m && m !== 'NONE';
}

/**
 * @param {string} content raw playlist text
 * @param {string} baseUrl URL the playlist was fetched from (after redirects)
 * @returns {{
 *   isMaster: boolean, isMedia: boolean, live: boolean, version: number|null,
 *   targetDuration: number|null, totalDuration: number,
 *   variants: Array<object>, audioRenditions: Array<object>,
 *   segments: Array<object>, initSegment: string|null,
 *   drm: boolean, drmMethods: string[], keys: Array<object>, error: string|null
 * }}
 */
export function parseM3U8(content, baseUrl = '') {
  const text = String(content || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const result = {
    isMaster: false,
    isMedia: false,
    live: true,
    version: null,
    targetDuration: null,
    mediaSequence: 0,
    totalDuration: 0,
    variants: [],
    audioRenditions: [],
    segments: [],
    initSegment: null,
    drm: false,
    drmMethods: [],
    keys: [],
    error: null,
  };

  if (!text || !/#EXTM3U/i.test(lines[0] || text.slice(0, 64))) {
    result.error = 'not-a-playlist';
    return result;
  }

  let pendingStreamInf = null;
  let pendingIFrameInf = null;
  let pendingDuration = null;
  let pendingByteRange = null;
  let pendingKey = null;
  let pendingMap = null;
  let discontinuity = false;
  let seq = null;
  const allKeys = [];
  const allMaps = [];
  /** URL -> next byte offset, for implicit `#EXT-X-BYTERANGE:length` entries. */
  const byteRangeCursor = new Map();

  const pushKey = (attrs) => {
    const method = (attrs.METHOD || 'NONE').toUpperCase();
    const key = {
      method,
      uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null,
      iv: attrs.IV || null,
      keyFormat: attrs.KEYFORMAT || null,
      keyFormatVersions: attrs.KEYFORMATVERSIONS || null,
    };
    allKeys.push(key);
    if (isDrmMethod(method)) {
      result.drm = true;
      result.drmMethods.push(method);
    }
    return key;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#')) {
      let m;
      if ((m = line.match(RE.STREAM_INF))) {
        result.isMaster = true;
        pendingStreamInf = parseAttributes(m[1]);
        continue;
      }
      if ((m = line.match(RE.I_FRAME_STREAM_INF))) {
        pendingIFrameInf = parseAttributes(m[1]);
        result.isMaster = true;
        continue;
      }
      if ((m = line.match(RE.MEDIA))) {
        result.isMaster = true;
        const a = parseAttributes(m[1]);
        result.audioRenditions.push({
          type: (a.TYPE || '').toUpperCase(),
          groupId: a['GROUP-ID'] || null,
          name: a.NAME || null,
          language: a.LANGUAGE || null,
          isDefault: a.DEFAULT === 'YES',
          autoselect: a.AUTOSELECT === 'YES',
          uri: a.URI ? resolveUrl(baseUrl, a.URI) : null,
          channels: a.CHANNELS || null,
        });
        continue;
      }
      if ((m = line.match(RE.SESSION_KEY))) {
        pushKey(parseAttributes(m[1]));
        continue;
      }
      if ((m = line.match(RE.KEY))) {
        const attrs = parseAttributes(m[1]);
        pendingKey = (attrs.METHOD || '').toUpperCase() === 'NONE' ? null : pushKey(attrs);
        continue;
      }
      if ((m = line.match(RE.MAP))) {
        const attrs = parseAttributes(m[1]);
        const map = {
          url: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : null,
          byteRange: parseByteRange(attrs.BYTERANGE),
        };
        pendingMap = map;
        allMaps.push(map);
        if (!result.initSegment && map.url) result.initSegment = map.url;
        continue;
      }
      if ((m = line.match(RE.BYTERANGE))) {
        pendingByteRange = parseByteRange(m[1]);
        continue;
      }
      if ((m = line.match(RE.EXTINF))) {
        result.isMedia = true;
        pendingDuration = parseFloat(m[1]) || 0;
        continue;
      }
      if ((m = line.match(RE.TARGETDURATION))) { result.targetDuration = parseFloat(m[1]); continue; }
      if ((m = line.match(RE.MEDIA_SEQUENCE))) { result.mediaSequence = parseInt(m[1], 10) || 0; continue; }
      if ((m = line.match(RE.DISCONTINUITY_SEQ))) { continue; }
      if ((m = line.match(RE.PLAYLIST_TYPE))) { continue; }
      if ((m = line.match(RE.VERSION))) { result.version = parseInt(m[1], 10); continue; }
      if (RE.ENDLIST.test(line)) { result.live = false; continue; }
      if (RE.DISCONTINUITY.test(line)) { discontinuity = true; continue; }
      if (RE.GAP.test(line)) { continue; }
      continue; // other tags ignored
    }

    // Non-comment line: a URI.
    if (pendingStreamInf) {
      const a = pendingStreamInf;
      const [w, h] = (a.RESOLUTION || '').split('x').map((n) => parseInt(n, 10));
      const codecs = (a.CODECS || '').split(',').map((s) => s.trim()).filter(Boolean);
      result.variants.push({
        url: resolveUrl(baseUrl, line),
        width: Number.isFinite(w) ? w : null,
        height: Number.isFinite(h) ? h : null,
        bandwidth: a.BANDWIDTH ? parseInt(a.BANDWIDTH, 10) : null,
        averageBandwidth: a['AVERAGE-BANDWIDTH'] ? parseInt(a['AVERAGE-BANDWIDTH'], 10) : null,
        frameRate: a['FRAME-RATE'] ? parseFloat(a['FRAME-RATE']) : null,
        codecs,
        videoCodec: codecs.find((c) => !/^mp4a/i.test(c)) || null,
        audioCodec: codecs.find((c) => /^mp4a/i.test(c)) || null,
        audioGroupId: a.AUDIO || null,
        videoGroupId: a.VIDEO || null,
        name: a.NAME || null,
      });
      pendingStreamInf = null;
      continue;
    }
    if (pendingIFrameInf) {
      pendingIFrameInf = null;
      continue;
    }

    // Media segment.
    result.isMedia = true;
    if (seq === null) seq = result.mediaSequence;
    const url = resolveUrl(baseUrl, line);
    // A BYTERANGE without "@offset" continues after the previous range of the same URL.
    const byteRange = pendingByteRange && pendingByteRange.offset == null
      ? { ...pendingByteRange, offset: byteRangeCursor.get(url) || 0 }
      : pendingByteRange;
    const segment = {
      url,
      duration: pendingDuration || 0,
      byteRange,
      key: pendingKey,
      map: pendingMap,
      discontinuity,
      sequence: seq++,
    };
    if (byteRange) byteRangeCursor.set(url, byteRange.offset + byteRange.length);
    result.segments.push(segment);
    result.totalDuration += segment.duration;
    pendingDuration = null;
    pendingByteRange = null;
    discontinuity = false;
  }

  // Keep only one representative key/map entry list, deduplicated by URI+method.
  const seenKeys = new Set();
  result.keys = allKeys.filter((k) => {
    const id = `${k.method}|${k.uri}|${k.keyFormat || ''}`;
    if (seenKeys.has(id)) return false;
    seenKeys.add(id);
    return true;
  });
  result.drmMethods = [...new Set(result.drmMethods)];

  // If a master lists I-frame variants only, still allow fall back.
  if (!result.isMaster && result.segments.length === 0) {
    result.error = result.error || 'empty-playlist';
  }
  return result;
}

/** True if a URL plausibly points at an HLS playlist. */
export function looksLikeHls(url) {
  return /\.m3u8(\?|#|$)/i.test(String(url || ''));
}

/** Pick the best variant not exceeding maxHeight (0 = no cap). */
export function pickBestVariant(variants, maxHeight = 0) {
  const list = (variants || []).filter((v) => v && v.url);
  if (!list.length) return null;
  const capped = maxHeight > 0 ? list.filter((v) => !v.height || v.height <= maxHeight) : list;
  const pool = capped.length ? capped : list;
  return [...pool].sort((a, b) => {
    const ah = a.height || 0; const bh = b.height || 0;
    if (ah !== bh) return bh - ah;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  })[0];
}
