// page/sniffer-page.js
// Runs in the PAGE (MAIN) world. Hooks fetch/XHR to observe media requests and harvests
// player globals (flashvars_*, __NEXT_DATA__, etc.) plus inline-script media URLs.
// It never reads response bodies — only URL + content-type metadata — to stay light.
// Posts results to the isolated content script via window.postMessage.
(function () {
  if (window.__uvPageSniffer) return;
  window.__uvPageSniffer = true;
  try { document.documentElement.setAttribute('data-uv-page-sniffer', '1'); } catch {}

  const MEDIA_RE = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|m4s|ts|m2ts|gif|webp|apng)(\?|#|$)/i;
  const GIF_RE = /\.(gif|webp|apng)(\?|#|$)/i;
  const SEGMENT_RE = /\.(ts|m4s|m2ts)(\?|#|$)/i;
  const MANIFEST_RE = /\.(m3u8|mpd)(\?|#|$)/i;
  const seen = new Set();
  let flushTimer = null;
  const pendingUrls = [];

  function looksMedia(u, contentType) {
    const s = String(u || '');
    const ct = String(contentType || '').toLowerCase();
    if (!s || /^(blob|data|about):/i.test(s)) return false;
    if (MANIFEST_RE.test(s)) return true;
    if (ct.includes('mpegurl') || ct.includes('dash+xml')) return true;
    if (ct.startsWith('video/') && !ct.includes('mp2t')) return true;
    // Global GIF scrape: image/gif + .gif/.webp URLs are first-class media.
    if (GIF_RE.test(s)) return true;
    if (ct.includes('image/gif') || ct.includes('image/webp')) return true;
    if (MEDIA_RE.test(s) && !SEGMENT_RE.test(s)) return true;
    return false;
  }

  function addUrl(url, contentType, initiator) {
    const u = String(url || '');
    if (!looksMedia(u, contentType)) return;
    const key = `${u}|${contentType || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    pendingUrls.push({ url: u, contentType: contentType || null, initiator: initiator || null });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushUrls();
    }, 250);
  }

  function flushUrls() {
    if (!pendingUrls.length) return;
    const urls = pendingUrls.splice(0, pendingUrls.length);
    post('candidates', { urls });
  }

  function post(type, payload) {
    try { window.postMessage({ __uv: true, source: 'uv-page', type, payload }, '*'); } catch {}
  }

  // ---- fetch hook ----
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function' && !origFetch.__uvPatched) {
      const patched = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url);
          addUrl(url, (init && init.headers && init.headers.get && init.headers.get('accept')) || '', 'fetch');
        } catch {}
        return origFetch.apply(this, arguments);
      };
      patched.__uvPatched = true;
      window.fetch = patched;
    }
  } catch {}

  // ---- XHR hook ----
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    if (!origOpen.__uvPatched) {
      const patchedOpen = function (method, url) {
        try { this.__uvUrl = url; } catch {}
        return origOpen.apply(this, arguments);
      };
      patchedOpen.__uvPatched = true;
      XMLHttpRequest.prototype.open = patchedOpen;
      XMLHttpRequest.prototype.send = function () {
        try {
          const self = this;
          self.addEventListener('load', function () {
            try {
              const ct = self.getResponseHeader && self.getResponseHeader('content-type');
              addUrl(self.__uvUrl, ct || '', 'xhr');
            } catch {}
          });
        } catch {}
        return origSend.apply(this, arguments);
      };
    }
  } catch {}

  // ---- inline script / global harvesting ----
  const GLOBAL_KEYS = [
    'flashvars_', '__NEXT_DATA__', '__INITIAL_STATE__', '__NUXT__', '__APOLLO_STATE__',
    'videoData', 'playerObjList', 'playerConfig', 'videojs', 'jwplayer', 'bitmovin',
  ];

  function safeClone(value, depth, budget) {
    if (budget.remaining <= 0) return undefined;
    if (value == null) return value;
    const t = typeof value;
    if (t === 'string') {
      budget.remaining -= value.length;
      return value.length > 4000 ? value.slice(0, 4000) : value;
    }
    if (t === 'number' || t === 'boolean') return value;
    if (t === 'function' || t === 'symbol') return undefined;
    if (depth <= 0) return undefined;
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < Math.min(value.length, 100) && budget.remaining > 0; i++) {
        const v = safeClone(value[i], depth - 1, budget);
        if (v !== undefined) out.push(v);
      }
      return out;
    }
    if (t === 'object') {
      const out = {};
      let keys = 0;
      for (const k of Object.keys(value)) {
        if (keys++ > 120 || budget.remaining <= 0) break;
        const v = safeClone(value[k], depth - 1, budget);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    return undefined;
  }

  function harvestGlobals() {
    const globals = [];
    const flashvars = [];
    try {
      for (const key of Object.keys(window)) {
        if (key.startsWith('flashvars_') || GLOBAL_KEYS.includes(key)) {
          try {
            const value = window[key];
            if (value && (typeof value === 'object')) {
              const cloned = safeClone(value, 5, { remaining: 120000 });
              globals.push({ key, value: cloned });
              if (key.startsWith('flashvars_')) flashvars.push(cloned);
            }
          } catch {}
        }
      }
    } catch {}
    return { globals, flashvars };
  }

  function harvestInlineScripts() {
    const urls = [];
    const found = new Set();
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent;
        if (!text || text.length < 12 || text.length > 2000000) continue;
        const re = /https?:\/\/[^\s"'`\\<>]+?\.(?:m3u8|mpd|mp4|webm|mkv|mov|m4v|gif|webp|apng)(?:\?[^\s"'`\\<>]*)?/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          const u = m[0].replace(/&amp;/g, '&');
          if (!found.has(u)) { found.add(u); urls.push({ url: u, initiator: 'inline-script' }); }
          if (urls.length > 60) break;
        }
        if (urls.length > 60) break;
      }
    } catch {}
    return urls;
  }

  function collectMeta() {
    const meta = { title: document.title || null, thumbnail: null, duration: null };
    try {
      const ogt = document.querySelector('meta[property="og:title"]');
      const ogi = document.querySelector('meta[property="og:image"]');
      const ogv = document.querySelector('meta[property="og:video"]') || document.querySelector('meta[property="og:video:url"]');
      const ogvd = document.querySelector('meta[property="og:video:duration"]') || document.querySelector('meta[property="video:duration"]');
      if (ogt && ogt.content) meta.title = ogt.content;
      if (ogi && ogi.content) {
        meta.thumbnail = ogi.content;
        // GIF-first: og:image is the canonical GIF on many meme/board pages.
        if (GIF_RE.test(ogi.content)) meta.ogImage = ogi.content;
      }
      if (ogv && ogv.content) meta.ogVideo = ogv.content;
      if (ogvd && ogvd.content) meta.duration = parseFloat(ogvd.content) || null;
      const tw = document.querySelector('meta[name="twitter:player:stream"]');
      if (tw && tw.content) meta.twitterStream = tw.content;
      const twi = document.querySelector('meta[name="twitter:image"]');
      if (twi && twi.content) {
        if (GIF_RE.test(twi.content)) meta.twitterImage = twi.content;
        if (!meta.thumbnail) meta.thumbnail = twi.content;
      }
      const video = document.querySelector('video');
      if (video && Number.isFinite(video.duration) && video.duration > 0) meta.duration = video.duration;
    } catch {}
    return meta;
  }

  function fullScan() {
    const { globals, flashvars } = harvestGlobals();
    const urls = harvestInlineScripts();
    const meta = collectMeta();
    if (meta.ogVideo) urls.push({ url: meta.ogVideo, initiator: 'og:video' });
    if (meta.twitterStream) urls.push({ url: meta.twitterStream, initiator: 'twitter:stream' });
    if (meta.ogImage) urls.push({ url: meta.ogImage, initiator: 'og:image:gif' });
    if (meta.twitterImage) urls.push({ url: meta.twitterImage, initiator: 'twitter:image:gif' });
    // <img> GIFs: the most common GIF carrier — scan directly in page world too
    // (content-world DOM scan may miss lazy/shadow images).
    try {
      const imgs = document.querySelectorAll('img[src], img[data-src]');
      for (let i = 0; i < Math.min(imgs.length, 150); i++) {
        const src = imgs[i].currentSrc || imgs[i].src || imgs[i].getAttribute('data-src');
        if (src && GIF_RE.test(src)) urls.push({ url: src, initiator: 'img:gif' });
      }
    } catch {}
    for (const u of urls) addUrl(u.url, '', u.initiator);
    flushUrls();
    post('pagedata', { globals, flashvars, urls, meta });
  }

  function scanDom() {
    try {
      const urls = [];
      document.querySelectorAll('video, video source, audio, audio source').forEach((el) => {
        const src = el.currentSrc || el.src || el.getAttribute('src') || el.getAttribute('data-src');
        if (src) urls.push({ url: src, initiator: 'dom' });
      });
      document.querySelectorAll('img[src], img[data-src]').forEach((el) => {
        const src = el.currentSrc || el.src || el.getAttribute('data-src');
        if (src && GIF_RE.test(src)) urls.push({ url: src, initiator: 'dom-img-gif' });
      });
      document.querySelectorAll('a[href$=".mp4"], a[href*=".m3u8"], a[href*=".mpd"], a[href$=".gif"], a[href*=".gif"]').forEach((a) => {
        urls.push({ url: a.href, initiator: 'dom-link' });
      });
      if (urls.length) post('candidates', { urls });
    } catch {}
  }

  // Listen for scan requests from the content script.
  window.addEventListener('message', (event) => {
    if (!event || !event.data || event.data.__uv !== true || event.data.source !== 'uv-content') return;
    if (event.data.type === 'scan') {
      try { fullScan(); scanDom(); } catch {}
    }
  });

  // Initial full scan, then a couple of delayed rescans for async players.
  try { fullScan(); scanDom(); } catch {}
  setTimeout(() => { try { fullScan(); scanDom(); } catch {} }, 1500);
  setTimeout(() => { try { fullScan(); scanDom(); } catch {} }, 5000);
})();
