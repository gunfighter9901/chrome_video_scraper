// core/dash.mjs
// Lightweight, dependency-free MPEG-DASH MPD parser (regex based) that runs in a service worker
// (no DOMParser). Covers the common static VOD cases: SegmentTemplate, SegmentList, SegmentBase,
// multiple periods are flattened, BaseURL inherited. DRM is detected and refused by callers.

export function looksLikeDash(url) {
  return /\.mpd(\?|#|$)/i.test(String(url || ''));
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function attr(tag, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = String(tag).match(re);
  if (!m) return null;
  return decodeEntities(m[2] !== undefined ? m[2] : m[3]);
}

function numAttr(tag, name) {
  const v = attr(tag, name);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function resolve(baseUrl, rel) {
  const raw = String(rel || '').trim();
  if (!raw) return raw;
  try { return new URL(raw, baseUrl).toString(); } catch { return raw; }
}

/** ISO-8601 duration (e.g. PT1H2M3.5S) -> seconds */
export function parseIsoDuration(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const days = (Number(y) || 0) * 365 + (Number(mo) || 0) * 30 + (Number(d) || 0);
  return days * 86400 + (Number(h) || 0) * 3600 + (Number(mi) || 0) * 60 + (Number(s) || 0);
}

function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (_, key, pad) => {
    if (!(key in vars)) return '';
    let v = vars[key];
    if (pad && typeof v === 'number') v = String(v).padStart(parseInt(pad, 10), '0');
    if (key === 'Time' && typeof v === 'number') v = String(v);
    return String(v);
  });
}

function topLevelBaseUrls(xml) {
  // Grab BaseURL values that appear before the first Period (roughly).
  const firstPeriod = xml.search(/<Period[\s>]/i);
  const head = firstPeriod >= 0 ? xml.slice(0, firstPeriod) : xml;
  const urls = [];
  const re = /<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/gi;
  let m;
  while ((m = re.exec(head)) !== null) urls.push(decodeEntities(m[1].trim()));
  return urls;
}

function parseRepresentation(repTag, repInner, ctx) {
  const id = attr(repTag, 'id') || ctx.repId;
  const mimeType = attr(repTag, 'mimeType') || ctx.mimeType || '';
  const codecs = attr(repTag, 'codecs') || ctx.codecs || '';
  const width = numAttr(repTag, 'width');
  const height = numAttr(repTag, 'height');
  const bandwidth = numAttr(repTag, 'bandwidth');
  const frameRate = attr(repTag, 'frameRate');
  const lang = attr(repTag, 'lang') || ctx.lang || null;

  // Dedicated BaseURLs inside the representation.
  const repBases = [];
  {
    const re = /<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/gi;
    let m;
    while ((m = re.exec(repInner)) !== null) repBases.push(decodeEntities(m[1].trim()));
  }
  let base = ctx.base;
  if (repBases.length) base = resolve(base, repBases[repBases.length - 1]);

  const rep = {
    id,
    type: /video/i.test(mimeType) ? 'video' : /audio/i.test(mimeType) ? 'audio' : 'unknown',
    mimeType,
    codecs,
    width,
    height,
    bandwidth,
    frameRate: frameRate ? parseFloat(frameRate) : null,
    language: lang,
    baseUrl: base,
    initUrl: null,
    segments: [],
    isSegmentTemplate: false,
  };

  // SegmentTemplate (own, or inherited from the AdaptationSet/Period level)
  const ownTmplTag = (repInner.match(/<SegmentTemplate[^>]*>/i) || [])[0] || '';
  const parentTmplTag = ctx.templateTag || '';
  if (ownTmplTag || parentTmplTag) {
    const pickVal = (n) => {
      if (ownTmplTag) { const v = attr(ownTmplTag, n); if (v != null) return v; }
      return parentTmplTag ? attr(parentTmplTag, n) : null;
    };
    const pickNum = (n) => {
      const v = pickVal(n);
      if (v == null) return null;
      const num = Number(v);
      return Number.isFinite(num) ? num : null;
    };
    const media = pickVal('media');
    const initialization = pickVal('initialization');
    const timescale = pickNum('timescale') || 1;
    const segDuration = pickNum('duration');
    const startNumber = pickNum('startNumber');
    const endNumber = pickNum('endNumber');
    const vars = {
      RepresentationID: id,
      Bandwidth: bandwidth || 0,
      Number: startNumber != null ? startNumber : 1,
    };
    if (initialization) rep.initUrl = resolve(base, fillTemplate(initialization, vars));
    if (media) {
      rep.isSegmentTemplate = true;
      const start = startNumber != null ? startNumber : 1;
      let count = 0;
      if (segDuration && ctx.periodDuration) {
        count = Math.ceil(ctx.periodDuration / (segDuration / timescale));
      } else if (endNumber != null) {
        count = Math.max(0, endNumber - start + 1);
      }
      for (let n = 0; n < count; n++) {
        rep.segments.push({
          url: resolve(base, fillTemplate(media, { ...vars, Number: start + n })),
          duration: segDuration ? segDuration / timescale : null,
        });
      }
    }
  }

  // SegmentList
  if (!rep.segments.length) {
    const initTag = (repInner.match(/<Initialization[^>]*>/i) || [])[0];
    if (!rep.initUrl && initTag) {
      const src = attr(initTag, 'sourceURL') || attr(initTag, 'sourceUrl');
      if (src) rep.initUrl = resolve(base, fillTemplate(src, { RepresentationID: id, Bandwidth: bandwidth || 0 }));
    }
    const re = /<SegmentURL[^>]*>/gi;
    let m;
    while ((m = re.exec(repInner)) !== null) {
      const media = attr(m[0], 'media') || attr(m[0], 'mediaRange');
      if (media) rep.segments.push({ url: resolve(base, media), duration: null });
    }
  }

  // SegmentBase (single file with index) — treat as one progressive-ish segment.
  if (!rep.segments.length && !rep.initUrl && /<SegmentBase[\s>]/i.test(repInner)) {
    rep.segments.push({ url: base, duration: null });
  }
  if (!rep.segments.length) {
    rep.segments.push({ url: base, duration: null });
  }

  return rep;
}

/**
 * @param {string} xml MPD document text
 * @param {string} baseUrl URL the MPD was fetched from
 */
export function parseMpd(xml, baseUrl = '') {
  const text = String(xml || '');
  const out = {
    isDynamic: false,
    duration: null,
    representations: [],
    drm: false,
    drmSystems: [],
    error: null,
  };
  const mpdTag = (text.match(/<MPD\b[^>]*>/i) || [])[0];
  if (!mpdTag) { out.error = 'not-mpd'; return out; }
  out.isDynamic = (attr(mpdTag, 'type') || 'static').toLowerCase() === 'dynamic';
  out.duration = parseIsoDuration(attr(mpdTag, 'mediaPresentationDuration'));

  const bases = topLevelBaseUrls(text);
  let rootBase = baseUrl;
  for (const b of bases) rootBase = resolve(rootBase, b);

  // DRM
  const cpRe = /<ContentProtection\b[^>]*>/gi;
  let cp;
  while ((cp = cpRe.exec(text)) !== null) {
    const scheme = attr(cp[0], 'schemeIdUri') || '';
    out.drmSystems.push(scheme);
  }
  out.drm = out.drmSystems.length > 0;

  // Period-level duration + SegmentTemplate defaults.
  const periods = text.split(/<Period\b/i).slice(1);
  const periodChunks = periods.length ? periods : [text.slice(text.indexOf(mpdTag))];

  for (const chunk of periodChunks) {
    const periodTag = (chunk.match(/^[^>]*>/) || [''])[0];
    const periodStart = numAttr(periodTag, 'start') || 0;
    const periodDur = numAttr(periodTag, 'duration');
    const periodDuration = periodDur || out.duration || null;
    const templateTag = (chunk.match(/<SegmentTemplate[^>]*>/i) || [])[0] || '';
    const chunkBaseMatch = chunk.match(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/i);
    const chunkBase = chunkBaseMatch ? resolve(rootBase, decodeEntities(chunkBaseMatch[1].trim())) : rootBase;

    const ctx = { base: chunkBase, periodDuration, templateTag, repId: '0', mimeType: '', codecs: '', lang: null };

    // Adaptations
    const adaptRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    let adapt;
    let foundAdapt = false;
    while ((adapt = adaptRe.exec(chunk)) !== null) {
      foundAdapt = true;
      const aTag = `<AdaptationSet ${adapt[1]}>`;
      const aInner = adapt[2];
      const aCtx = {
        ...ctx,
        mimeType: attr(aTag, 'mimeType') || '',
        codecs: attr(aTag, 'codecs') || '',
        lang: attr(aTag, 'lang') || null,
      };
      const repRe = /<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/gi;
      let rep;
      let foundRep = false;
      while ((rep = repRe.exec(aInner)) !== null) {
        foundRep = true;
        const attrs = rep[1] || '';
        const inner = rep[2] || '';
        out.representations.push(parseRepresentation(`<Representation ${attrs}>`, inner, aCtx));
      }
      if (!foundRep) {
        // AdaptationSet-level representation (SegmentTemplate at adaptation level).
        out.representations.push(parseRepresentation(aTag, aInner, aCtx));
      }
    }
    if (!foundAdapt) {
      // Very small MPDs may put Representation directly under Period.
      const repRe = /<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/gi;
      let rep;
      while ((rep = repRe.exec(chunk)) !== null) {
        out.representations.push(parseRepresentation(`<Representation ${rep[1] || ''}>`, rep[2] || '', ctx));
      }
    }
    void periodStart;
  }

  if (!out.representations.length) out.error = 'no-representations';
  return out;
}
