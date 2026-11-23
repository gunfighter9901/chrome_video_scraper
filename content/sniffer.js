// content/sniffer.js
// Isolated-world content script. Aggregates media candidates from:
//   - the page-context sniffer (page/sniffer-page.js) via window.postMessage
//   - the Performance Resource Timing API (catches media loaded before injection)
//   - the DOM (<video>, <source>, og:video, links)
// Responds to UV_COLLECT / UV_RESCAN from the popup/background.
(function () {
  if (window.__uvSnifferLoaded) return;
  window.__uvSnifferLoaded = true;

  const MEDIA_RE = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv)(\?|#|$)/i;
  const SEGMENT_RE = /\.(ts|m4s|m2ts)(\?|#|$)/i;

  const state = {
    pageCandidates: [],   // {url, contentType, initiator}
    pageData: { globals: [], flashvars: [], urls: [], meta: {} },
    lastReport: 0,
  };

  function classify(url, contentType) {
    const u = String(url || '');
    const ct = String(contentType || '').toLowerCase();
    if (/\.m3u8(\?|#|$)/i.test(u) || ct.includes('mpegurl')) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(u) || ct.includes('dash+xml')) return 'dash';
    if (!/^(blob|data):/i.test(u) && (/\.(mp4|m4v|webm|mkv|mov|flv)(\?|#|$)/i.test(u) || (ct.startsWith('video/') && !ct.includes('mp2t')))) return 'progressive';
    return null;
  }

  function add(list, seen, url, meta) {
    if (!url || typeof url !== 'string') return;
    if (!/^https?:/i.test(url)) return;
    if (SEGMENT_RE.test(url)) return;
    const kind = classify(url, meta && meta.contentType);
    if (!kind) return;
    const key = `${kind}:${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ url, kind, contentType: (meta && meta.contentType) || null, source: (meta && meta.source) || 'dom' });
  }

  function perfCandidates() {
    const out = [];
    const seen = new Set();
    try {
      const entries = performance.getEntriesByType('resource') || [];
      for (const e of entries) {
        if (!e || !e.name) continue;
        if (!MEDIA_RE.test(e.name) && !/mpegurl|dash/i.test(e.initiatorType || '')) continue;
        add(out, seen, e.name, { source: 'perf', contentType: e.contentType });
      }
    } catch {}
    return out;
  }

  function domCandidates() {
    const out = [];
    const seen = new Set();
    try {
      document.querySelectorAll('video, video source, audio, audio source').forEach((el) => {
        const src = el.currentSrc || el.src || el.getAttribute('src') || el.getAttribute('data-src');
        add(out, seen, src, { source: 'dom' });
      });
      const metaEls = [
        ['meta[property="og:video"]', 'content'],
        ['meta[property="og:video:url"]', 'content'],
        ['meta[property="og:video:secure_url"]', 'content'],
        ['meta[name="twitter:player:stream"]', 'content'],
      ];
      for (const [sel, attrName] of metaEls) {
        const el = document.querySelector(sel);
        if (el && el[attrName]) add(out, seen, el[attrName], { source: 'dom-meta' });
      }
      document.querySelectorAll('a[href]').forEach((a) => {
        if (a.href && MEDIA_RE.test(a.href)) add(out, seen, a.href, { source: 'dom-link' });
      });
    } catch {}
    return out;
  }

  function mergedCandidates() {
    const out = [];
    const seen = new Set();
    for (const c of perfCandidates()) add(out, seen, c.url, c);
    for (const c of domCandidates()) add(out, seen, c.url, c);
    for (const c of state.pageCandidates) add(out, seen, c.url, c);
    // page-data urls (handled more thoroughly by background's interpretPageData)
    for (const u of (state.pageData.urls || [])) {
      const url = typeof u === 'string' ? u : u && u.url;
      add(out, seen, url, { source: (u && u.initiator) || 'page' });
    }
    return out;
  }

  function pageInfo() {
    const meta = state.pageData.meta || {};
    let title = meta.title || document.title || null;
    let thumbnail = meta.thumbnail || null;
    let duration = meta.duration || null;
    try {
      const video = document.querySelector('video');
      if (video && Number.isFinite(video.duration) && video.duration > 0) duration = video.duration;
    } catch {}
    return { url: location.href, title, thumbnail, duration };
  }

  function snapshot() {
    return { candidates: mergedCandidates(), pageData: state.pageData, page: pageInfo() };
  }

  function reportToBackground() {
    const now = Date.now();
    if (now - state.lastReport < 1200) return;
    state.lastReport = now;
    try {
      chrome.runtime.sendMessage({ type: 'UV_CANDIDATES', snapshot: snapshot() }, () => { void chrome.runtime.lastError; });
    } catch {}
  }

  // Receive page-context data.
  window.addEventListener('message', (event) => {
    const d = event && event.data;
    if (!d || d.__uv !== true || d.source !== 'uv-page') return;
    if (d.type === 'candidates' && d.payload && Array.isArray(d.payload.urls)) {
      for (const u of d.payload.urls) {
        if (u && u.url) state.pageCandidates.push(u);
      }
      reportToBackground();
    } else if (d.type === 'pagedata' && d.payload) {
      state.pageData = {
        globals: d.payload.globals || [],
        flashvars: d.payload.flashvars || [],
        urls: d.payload.urls || [],
        meta: d.payload.meta || {},
      };
      reportToBackground();
    }
  });

  // Make sure the page-context sniffer is present (works for auto-enabled sites too).
  function ensurePageScript() {
    try {
      if (document.documentElement.getAttribute('data-uv-page-sniffer') === '1') return;
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('page/sniffer-page.js');
      s.onload = () => { try { s.remove(); } catch {} };
      (document.head || document.documentElement).appendChild(s);
    } catch {}
  }

  function requestPageScan() {
    try { window.postMessage({ __uv: true, source: 'uv-content', type: 'scan' }, '*'); } catch {}
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'UV_COLLECT') {
      ensurePageScript();
      requestPageScan();
      // Give the page script a moment to respond, then snapshot.
      setTimeout(() => {
        try { sendResponse({ ok: true, ...snapshot() }); } catch {}
      }, msg.wait === false ? 0 : 180);
      return true;
    }
    if (msg.type === 'UV_RESCAN') {
      requestPageScan();
      setTimeout(reportToBackground, 200);
      try { sendResponse({ ok: true }); } catch {}
      return true;
    }
    if (msg.type === 'UV_PROBE') {
      probeCandidates(msg.candidates || []).then((results) => {
        try { sendResponse({ ok: true, results }); } catch {}
      }).catch((e) => {
        try { sendResponse({ ok: false, error: String(e) }); } catch {}
      });
      return true;
    }
    if (msg.type === 'UV_RELAY_FETCH') {
      relayFetch(msg).then((resp) => {
        try { sendResponse(resp); } catch {}
      }).catch((e) => {
        try { sendResponse({ ok: false, error: String(e) }); } catch {}
      });
      return true;
    }
    return false;
  });

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // Fetch on behalf of the offscreen document, in page context (correct Referer + cookies).
  async function relayFetch(req) {
    const headers = {};
    if (req.range) headers.Range = req.range;
    try {
      const r = await fetch(req.url, {
        method: 'GET',
        headers,
        credentials: 'include',
        referrer: req.referer || undefined,
        referrerPolicy: 'no-referrer-when-downgrade',
      });
      const contentType = r.headers.get('content-type') || '';
      if (req.wantText) {
        return { ok: r.ok, status: r.status, contentType, text: await r.text(), finalUrl: r.url };
      }
      const buf = await r.arrayBuffer();
      return { ok: r.ok, status: r.status, contentType, contentLength: buf.byteLength, base64: arrayBufferToBase64(buf), finalUrl: r.url };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function probeOne(c) {
    const url = c && c.url;
    if (!url) return { url, ok: false, error: 'no-url' };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 12000);
    try {
      const isManifest = c.kind === 'hls' || c.kind === 'dash' || /\.(m3u8|mpd)(\?|#|$)/i.test(url);
      if (isManifest) {
        const r = await fetch(url, { credentials: 'include', signal: timeout.signal, headers: { Accept: '*/*' } });
        const contentType = r.headers.get('content-type') || '';
        let text = null;
        if (r.ok) {
          const t = await r.text();
          if (t.length <= 3000000) text = t;
        }
        return { url, ok: r.ok, status: r.status, contentType, text, finalUrl: r.url };
      }
      // Progressive: try HEAD, fall back to a 1-byte range GET.
      let r = await fetch(url, { method: 'HEAD', credentials: 'include', signal: timeout.signal });
      if (!r.ok) {
        r = await fetch(url, { method: 'GET', credentials: 'include', signal: timeout.signal, headers: { Range: 'bytes=0-1' } });
      }
      const contentType = r.headers.get('content-type') || '';
      let contentLength = parseInt(r.headers.get('content-length') || '0', 10) || 0;
      const range = r.headers.get('content-range') || '';
      const totalMatch = range.match(/\/(\d+)\s*$/);
      if (totalMatch) contentLength = parseInt(totalMatch[1], 10) || contentLength;
      try { if (r.body && r.body.cancel) await r.body.cancel(); } catch {}
      return { url, ok: r.ok, status: r.status, contentType, contentLength, finalUrl: r.url };
    } catch (e) {
      return { url, ok: false, error: String((e && e.message) || e), kind: c && c.kind };
    } finally {
      clearTimeout(timer);
    }
  }

  async function probeCandidates(list) {
    const capped = list.slice(0, 20);
    return Promise.all(capped.map((c) => probeOne(c)));
  }

  ensurePageScript();
  setTimeout(() => { try { requestPageScan(); reportToBackground(); } catch {} }, 300);
  setTimeout(() => { try { reportToBackground(); } catch {} }, 2000);
})();
