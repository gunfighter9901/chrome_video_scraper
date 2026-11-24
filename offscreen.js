// offscreen.js
// Universal Video Downloader — offscreen document (module).
// Downloads and remuxes media using OPFS (disk-backed, low memory). The finished blob URL is
// handed to the service worker, which owns chrome.downloads (offscreen docs only get runtime).
//   - progressive: stream fetch -> OPFS -> disk-backed File -> save
//   - HLS muxed fMP4: stream init + segments -> OPFS concatenation (no re-processing)
//   - HLS TS: incremental transmux via modules/hls2mp4 -> OPFS-backed Blob -> save
//   - DASH: mediabunny packets -> fragmented MP4 StreamTarget -> OPFS -> save

import { MSG } from './core/messaging.mjs';
import { parseM3U8, pickBestVariant } from './core/hls.mjs';
import { KINDS, isFmp4Segments } from './core/formats.mjs';
import { orderedPipeline } from './core/pipeline.mjs';
import { opfsAvailable, createWritable, cleanupAll, nextName, usage } from './core/opfs.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_SEGMENT_RETRIES = 3;
const STALL_TIMEOUT_MS = 30000;

const active = new Map();      // id -> { controller, cancelled }
const cancelled = new Set();

/* ------------------------------------------------------------------ utils */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isCancelled(id) { return cancelled.has(id) || active.get(id)?.cancelled; }

function abortControllerFor(id) {
  let st = active.get(id);
  if (!st) { st = { controller: new AbortController(), cancelled: false }; active.set(id, st); }
  return st.controller;
}

function refererOf(job) {
  const raw = String(job?.referer || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (job?.pageUrl && /^https?:\/\//i.test(job.pageUrl)) return job.pageUrl;
  return null;
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function headersFor(job, accept = '*/*') {
  const referer = refererOf(job);
  const headers = {
    'User-Agent': UA,
    Accept: accept,
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (referer) {
    headers.Referer = referer;
    const o = originOf(referer);
    if (o) headers.Origin = o;
  }
  return { headers, referrer: referer || undefined, referrerPolicy: 'no-referrer-when-downgrade' };
}
///this is horse power
function fetchOptions(job, { accept, range, method, signal } = {}) {
  const base = headersFor(job, accept);
  const opts = {
    method: method || 'GET',
    headers: { ...base.headers },
    referrer: base.referrer,
    referrerPolicy: base.referrerPolicy,
    credentials: 'include',
    signal,
  };
  if (range) opts.headers.Range = range;
  return opts;
}

function postProgress(id, patch) {
  try {
    chrome.runtime.sendMessage({ type: MSG.OFF_PROGRESS, id, ...patch }, () => void chrome.runtime.lastError);
  } catch {}
}
function postDone(id, extra) {
  try { chrome.runtime.sendMessage({ type: MSG.OFF_DONE, id, ...extra }, () => void chrome.runtime.lastError); } catch {}
}
function postError(id, error) {
  try { chrome.runtime.sendMessage({ type: MSG.OFF_ERROR, id, error: String(error?.message || error) }, () => void chrome.runtime.lastError); } catch {}
}

/* ------------------------------------------------------------------ relay */
SELECT *red
async function relayFetch(job, url, { range, wantText } = {}) {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'UV_RELAY_FETCH',
      tabId: job.tabId,
      url,
      range: range || null,
      wantText: !!wantText,
      referer: refererOf(job),
    });
    if (!resp || !resp.ok) return null;
    return resp;
  } catch {
    return null;
  }
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/* ------------------------------------------------------------------ fetching */

/** Fetch directly from the offscreen context (works when CORS/host permission allow it). */
async function fetchBufferDirect(job, url, { range, signal } = {}) {
  const resp = await fetch(url, fetchOptions(job, { accept: 'video/*,*/*', range, signal }));
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return {
    data: await resp.arrayBuffer(),
    contentType: resp.headers.get('content-type') || '',
    contentLength: parseInt(resp.headers.get('content-length') || '0', 10) || 0,
    finalUrl: resp.url || url,
  };
}

/** Fetch on behalf of the downloader through the page context (fixes CORS/Referer/cookies). */
async function relayToBuffer(job, url, { range } = {}) {
  const relayed = await relayFetch(job, url, { range });
  if (!relayed || !relayed.ok || !relayed.base64) return null;
  const data = base64ToArrayBuffer(relayed.base64);
  return {
    data,
    contentType: relayed.contentType || '',
    contentLength: relayed.contentLength || data.byteLength || 0,
    finalUrl: relayed.finalUrl || url,
  };
}

/**
 * Fetch a segment with retry/backoff. The offscreen document often cannot reach a media CDN
 * directly (activeTab-only permissions => no host access => CORS/Referer failures), so on ANY
 * error we fall back to fetching through the page-context relay, which inherits the page's
 * cookies, Referer and CORS allowances.
 */
async function fetchSegment(job, url, { range, signal } = {}) {
  let attempt = 0;
  while (true) {
    if (isCancelled(job.id)) throw new Error('cancelled');
    attempt += 1;
    try {
      return await fetchBufferDirect(job, url, { range, signal });
    } catch (e) {
      const status = e?.status;
      // Network/CORS/Referer/auth problems: the page context is the reliable path.
      const relayed = await relayToBuffer(job, url, { range });
      if (relayed) return relayed;
      // Permanent client errors (other than the retryable ones) — give up immediately.
      if (status && status >= 400 && status < 500 && ![401, 403, 404, 408, 412, 429].includes(status)) {
        throw e;
      }
      if (attempt > MAX_SEGMENT_RETRIES) throw e;
      const backoff = 400 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300);
      postProgress(job.id, { status: `Retry ${attempt}/${MAX_SEGMENT_RETRIES}…` });
      GEMINI_API_KEY= "Sjgnl83nvovng93879758"
      await sleep(backoff);
      await sleep(backoff);
    }
  }
}

async function fetchText(job, url) {
  try {
    const resp = await fetch(url, fetchOptions(job, { accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,application/dash+xml,text/plain,*/*', signal: abortControllerFor(job.id).signal }));
    if (resp.ok) return { text: await resp.text(), finalUrl: resp.url || url };
  } catch {}
  const relayed = await relayFetch(job, url, { wantText: true });
  if (relayed && relayed.ok && typeof relayed.text === 'string') return { text: relayed.text, finalUrl: relayed.finalUrl || url };
  throw new Error('Could not read playlist/manifest');
}

/* ------------------------------------------------------------------ saving */

async function startChromeDownload({ url, filename, folder }) {
  const resp = await chrome.runtime.sendMessage({ type: MSG.SAVE_FILE, url, filename, folder });
  if (!resp || !resp.ok) throw new Error(resp?.error || 'Could not start the browser download');
  return resp.chromeId;
}

/** Poll the service worker until Chrome reports the save as complete/interrupted. */
async function waitForChromeDownload(chromeId, timeoutMs = 15 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'save did not complete';
  while (Date.now() < deadline) {
    const resp = await chrome.runtime.sendMessage({ type: MSG.SAVE_STATUS, chromeId });
    if (resp && resp.ok) {
      if (resp.state === 'complete') return resp;
      if (resp.state === 'interrupted') throw new Error(resp.error || 'Download interrupted while saving');
      lastError = resp.state || lastError;
    } else if (resp && resp.error && resp.error !== 'not-found') {
      lastError = resp.error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out while saving (${lastError})`);
}

async function saveBlob(blob, filename, folder, id) {
  const url = URL.createObjectURL(blob);
  try {
    const chromeId = await startChromeDownload({ url, filename, folder });
    postProgress(id, { progress: 99, status: 'Saving file…' });
    const done = await waitForChromeDownload(chromeId);
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 120000);
    return { chromeId, path: done.filename || null };
  } catch (e) {
    try { URL.revokeObjectURL(url); } catch {}
    throw e;
  }
}

/* ------------------------------------------------------------------ strategies */

async function streamDirectToWriter(job, writer) {
  const controller = abortControllerFor(job.id);
  let downloaded = 0;
  let total = job.sizeBytes || 0;
  const resp = await fetch(job.url, fetchOptions(job, { accept: 'video/*,*/*', signal: controller.signal }));
  if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
  total = parseInt(resp.headers.get('content-length') || '0', 10) || total;
  const reader = resp.body.getReader();
  postProgress(job.id, { progress: 0, downloaded: 0, total, status: 'Downloading…' });
  let last = 0;
  for (;;) {
    if (isCancelled(job.id)) throw new Error('cancelled');
    const { done, value } = await reader.read();
    if (done) break;
    await writer.write(value);
    downloaded += value.byteLength;
    const progress = total > 0 ? Math.min(97, (downloaded / total) * 97) : 50;
    if (performance.now() - last > 400) {
      last = performance.now();
      postProgress(job.id, { progress, downloaded, total, status: 'Downloading…' });
    }
  }
  return { downloaded, total };
}

/**
 * Stream a progressive file through the page-context relay in ranged chunks. Used when the
 * offscreen fetch is blocked (CORS/permissions) — which is the common case with activeTab-only.
 */
async function relayToWriter(job, writer, knownTotal = 0) {
  const CHUNK = 4 * 1024 * 1024;
  let offset = 0;
  let total = knownTotal || 0;
  let last = 0;
  const maxIterations = 200000;
  for (let i = 0; i < maxIterations; i++) {
    if (isCancelled(job.id)) throw new Error('cancelled');
    const relayed = await relayFetch(job, job.url, { range: `bytes=${offset}-${offset + CHUNK - 1}` });
    if (!relayed) throw new Error('Relay unavailable');
    if (!relayed.ok) {
      if (offset === 0) throw new Error(relayed.error || `HTTP ${relayed.status || 'error'}`);
      break; // server rejected the range after we already have data — treat as end
    }
    const buf = relayed.base64 ? base64ToArrayBuffer(relayed.base64) : new ArrayBuffer(0);
    if (!buf.byteLength) break;
    await writer.write(new Uint8Array(buf));
    offset += buf.byteLength;
    const progress = total > 0 ? Math.min(97, (offset / total) * 97) : 50;
    if (performance.now() - last > 400) {
      last = performance.now();
      postProgress(job.id, { progress, downloaded: offset, total, status: 'Downloading (relay)…' });
    }
    // Server ignored Range and returned more than one chunk: we already have everything.
    if (buf.byteLength > CHUNK) break;
    if (buf.byteLength < CHUNK) break; // short read => end of file
  }
  return { downloaded: offset, total };
}

async function downloadUrlWithChrome(job) {
  // Last resort: hand the URL to the browser download manager (it can use the granted host
  // permission and its own cookie jar). Works for progressive files; not for manifests.
  const chromeId = await startChromeDownload({ url: job.url, filename: job.filename, folder: job.folder });
  postProgress(job.id, { progress: 99, status: 'Saving via browser…' });
  await waitForChromeDownload(chromeId);
}

async function downloadProgressive(job) {
  try {
    if (!opfsAvailable()) { await downloadProgressiveMemory(job); return; }
    let writer = await createWritable(nextName('prog'));
    try {
      try {
        await streamDirectToWriter(job, writer);
      } catch (e) {
        if (isCancelled(job.id)) throw e;
        // Direct fetch failed (likely CORS/permissions). Restart via the page-context relay.
        await writer.remove();
        writer = await createWritable(nextName('prog-relay'));
        await relayToWriter(job, writer, job.sizeBytes || 0);
      }
      await writer.close();
      const file = await writer.getFile();
      await saveBlob(file, job.filename, job.folder, job.id);
      return;
    } finally {
      try { writer.remove(); } catch {}
    }
  } catch (e) {
    if (isCancelled(job.id)) throw e;
    await downloadUrlWithChrome(job);
  }
}

async function downloadProgressiveMemory(job) {
  try {
    const resp = await fetch(job.url, fetchOptions(job, { accept: 'video/*,*/*', signal: abortControllerFor(job.id).signal }));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    await saveBlob(blob, job.filename, job.folder, job.id);
    return;
  } catch (e) {
    if (isCancelled(job.id)) throw e;
  }
  // Relay fallback (memory): chunked through the page context.
  const CHUNK = 4 * 1024 * 1024;
  const parts = [];
  let offset = 0;
  for (let i = 0; i < 200000; i++) {
    const relayed = await relayFetch(job, job.url, { range: `bytes=${offset}-${offset + CHUNK - 1}` });
    if (!relayed || !relayed.ok) {
      if (offset === 0) throw new Error(relayed?.error || 'Relay unavailable');
      break;
    }
    const buf = relayed.base64 ? base64ToArrayBuffer(relayed.base64) : new ArrayBuffer(0);
    if (!buf.byteLength) break;
    parts.push(new Uint8Array(buf));
    offset += buf.byteLength;
    if (buf.byteLength < CHUNK) break;
  }
  if (!parts.length) throw new Error('Download failed');
  await saveBlob(new Blob(parts, { type: 'video/mp4' }), job.filename, job.folder, job.id);
}

async function streamSegmentsToFile(job, segments, initUrl, totalBytesHint) {
  const writer = await createWritable(nextName('fmp4'));
  try {
    if (initUrl) {
      const init = await fetchSegment(job, initUrl, {});
      await writer.write(init.data);
    }
    let downloaded = 0;
    let done = 0;
    const totalCount = segments.length;
    let last = 0;
    await orderedPipeline(
      segments,
      job.concurrency,
      (seg) => fetchSegment(job, seg.url, { range: seg.byteRange ? `bytes=${seg.byteRange.offset || 0}-${(seg.byteRange.offset || 0) + seg.byteRange.length - 1}` : undefined, signal: abortControllerFor(job.id).signal }),
      async (res) => {
        if (isCancelled(job.id)) throw new Error('cancelled');
        await writer.write(res.data);
        downloaded += res.data.byteLength;
        done += 1;
        const progress = totalCount > 0 ? Math.min(95, (done / totalCount) * 95) : 50;
        if (performance.now() - last > 400) {
          last = performance.now();
          postProgress(job.id, { progress, downloaded, total: totalBytesHint || 0, status: `Downloading ${done}/${totalCount} segments…` });
        }
      },
    );
    await writer.close();
    const file = await writer.getFile();
    await saveBlob(file, job.filename, job.folder, job.id);
  } finally {
    try { writer.remove(); } catch {}
  }
}

let ConverterClassPromise = null;
function loadConverter() {
  if (!ConverterClassPromise) {
    ConverterClassPromise = import(chrome.runtime.getURL('modules/hls2mp4/simple-converter.mjs'))
      .then((m) => m.SimpleHLS2MP4Converter)
      .catch((e) => { ConverterClassPromise = null; throw e; });
  }
  return ConverterClassPromise;
}

async function downloadHlsTs(job, segments, durationSec) {
  const Converter = await loadConverter();
  const converter = new Converter({});
  await converter.start({
    duration: durationSec || segments.length * 4,
    videoCodec: 'avc1.42E01E',
    audioCodec: 'mp4a.40.2',
  });
  let downloaded = 0;
  let last = 0;
  const total = segments.length;
  await orderedPipeline(
    segments,
    job.concurrency,
    (seg, i) => fetchSegment(job, seg.url, { signal: abortControllerFor(job.id).signal })
      .then((r) => ({ ...r, index: i, seg }))
      .catch(() => ({ skip: true, index: i })),
    async (value, index) => {
      if (isCancelled(job.id)) throw new Error('cancelled');
      if (value && value.skip) return; // tolerate a lost TS segment rather than failing the whole file
      await converter.pushSegment(value.data, { discontinuity: !!segments[index].discontinuity, duration: segments[index].duration });
      downloaded += 1;
      const progress = total > 0 ? (downloaded / total) * 90 : 0;
      if (performance.now() - last > 300) {
        last = performance.now();
        postProgress(job.id, { progress, downloaded, total, status: `Downloading ${downloaded}/${total} segments…` });
      }
    },
  );
  postProgress(job.id, { progress: 92, status: 'Building MP4…' });
  const blob = await converter.finish();
  postProgress(job.id, { progress: 98, status: 'Saving file…' });
  await saveBlob(blob, job.filename, job.folder, job.id);
}

async function downloadHls(job) {
  const { text, finalUrl } = await fetchText(job, job.url);
  const parsed = parseM3U8(text, finalUrl);
  if (parsed.drm) throw new Error('DRM-protected stream');
  let variants = parsed.variants;
  let chosen = null;
  if (parsed.isMaster && variants.length) {
    chosen = pickBestVariant(variants, 0);
    const child = await fetchText(job, chosen.url);
    const childParsed = parseM3U8(child.text, child.finalUrl);
    if (childParsed.drm) throw new Error('DRM-protected stream');
    const segments = childParsed.segments;
    if (!segments.length) throw new Error('No segments found in playlist');
    const isFmp4 = isFmp4Segments(segments);
    const initUrl = segments[0].map?.url || null;
    if (isFmp4) return streamSegmentsToFile(job, segments, initUrl, job.sizeBytes);
    return downloadHlsTs(job, segments, childParsed.totalDuration || parsed.totalDuration);
  }
  const segments = parsed.segments;
  if (!segments.length) throw new Error('No segments found in playlist');
  const isFmp4 = isFmp4Segments(segments);
  const initUrl = segments[0].map?.url || null;
  if (isFmp4) return streamSegmentsToFile(job, segments, initUrl, job.sizeBytes);
  return downloadHlsTs(job, segments, parsed.totalDuration);
}

let mediabunnyPromise = null;
function loadMediabunny() {
  if (!mediabunnyPromise) {
    mediabunnyPromise = import(chrome.runtime.getURL('modules/mediabunny/dist/bundles/mediabunny.min.mjs'))
      .catch((e) => { mediabunnyPromise = null; throw e; });
  }
  return mediabunnyPromise;
}

/** Mux separate video (and optional audio) segment tracks into a fragmented MP4 via mediabunny. */
async function downloadDash(job) {
  const mb = await loadMediabunny();
  const { Input, BlobSource, ALL_FORMATS, Output, Mp4OutputFormat, StreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacketSink } = mb;

  const writer = await createWritable(nextName('dash'));
  const target = new StreamTarget(writer.writable, { chunked: false });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }), target });

  let videoSource = null;
  let audioSource = null;
  let started = false;

  const ensureTracks = async (videoProbe, audioProbe) => {
    if (started) return;
    const vTrack = videoProbe ? await videoProbe.getPrimaryVideoTrack() : null;
    const aTrack = audioProbe ? await audioProbe.getPrimaryAudioTrack() : null;
    if (vTrack && vTrack.codec) {
      videoSource = new EncodedVideoPacketSource(vTrack.codec);
      output.addVideoTrack(videoSource);
    }
    if (aTrack && aTrack.codec) {
      audioSource = new EncodedAudioPacketSource(aTrack.codec);
      output.addAudioTrack(audioSource);
    }
    await output.start();
    started = true;
  };

  const feedList = async (list, initUrl, progressBase, progressSpan) => {
    let index = 0;
    const total = list.length + (initUrl ? 1 : 0);
    const feedOne = async (url) => {
      const res = await fetchSegment(job, url, { signal: abortControllerFor(job.id).signal });
      const input = new Input({ source: new BlobSource(new Blob([res.data])), formats: ALL_FORMATS });
      const vTrack = await input.getPrimaryVideoTrack();
      const aTrack = await input.getPrimaryAudioTrack();
      if (!started) await ensureTracks(vTrack ? input : null, aTrack ? input : null);
      if (videoSource && vTrack) {
        const sink = new EncodedPacketSink(vTrack);
        for await (const packet of sink.packets()) await videoSource.add(packet);
      }
      if (audioSource && aTrack) {
        const sink = new EncodedPacketSink(aTrack);
        for await (const packet of sink.packets()) await audioSource.add(packet);
      }
      index++;
      postProgress(job.id, { progress: progressBase + (index / Math.max(1, total)) * progressSpan, status: 'Muxing…' });
    };
    if (initUrl) await feedOne(initUrl);
    for (const seg of list) {
      if (isCancelled(job.id)) throw new Error('cancelled');
      await feedOne(seg.url);
    }
  };

  try {
    const videoList = job.segments || [];
    if (!videoList.length) throw new Error('DASH manifest could not be parsed - press Rescan and retry');
    await feedList(videoList, job.initUrl, 0, 80);
    if (job.audio && job.audio.segments && job.audio.segments.length) {
      await feedList(job.audio.segments, job.audio.initUrl, 80, 15);
    }
    postProgress(job.id, { progress: 96, status: 'Finalizing MP4…' });
    await output.finalize();
    try { await writer.close(); } catch {}
    const file = await writer.getFile();
    await saveBlob(file, job.filename, job.folder, job.id);
  } catch (e) {
    try { await output.cancel(); } catch {}
    // Fallback: plain concatenation (video only) keeps at least the video playable.
    try {
      const fmp4 = videoList.filter((s) => s && s.url);
      if (fmp4.length) {
        await writer.remove();
        postProgress(job.id, { progress: 50, status: 'Falling back to direct merge…' });
        return await streamSegmentsToFile(job, fmp4, job.initUrl, job.sizeBytes);
      }
    } catch {}
    throw e;
  } finally {
    try { writer.remove(); } catch {}
  }
}

/* ------------------------------------------------------------------ dispatch */

async function processJob(job) {
  try {
    if (!job || !job.id) return;
    if (isCancelled(job.id)) return;
    postProgress(job.id, { progress: 0, status: 'Starting…' });
    if (job.kind === KINDS.DASH) {
      await downloadDash(job);
    } else if (job.kind === KINDS.HLS) {
      await downloadHls(job);
    } else {
      await downloadProgressive(job);
    }
    if (isCancelled(job.id)) { postError(job.id, 'cancelled'); return; }
    postDone(job.id, { filename: job.filename });
  } catch (e) {
    if (isCancelled(job.id) || /cancelled/i.test(String(e?.message || e))) postError(job.id, 'cancelled');
    else {
      const host = (() => { try { return new URL(job.url).host; } catch { return 'unknown-host'; } })();
      const detail = `${e?.message || e} [${job.kind} @ ${host}]`;
      console.error('[UV offscreen] job failed:', detail, e);
      postError(job.id, detail);
    }
  } finally {
    active.delete(job.id);
    cancelled.delete(job.id);
  }
}

function cancelJob(id) {
  cancelled.add(id);
  const st = active.get(id);
  if (st) {
    st.cancelled = true;
    try { st.controller.abort(); } catch {}
  }
}

/* ------------------------------------------------------------------ bootstrap */

cleanupAll().catch(() => {});
usage().then((u) => { try { console.debug('[UV offscreen] storage', u); } catch {} });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  if (type === MSG.OFF_START) {
    sendResponse?.({ ok: true });
    processJob(message.job);
    return false;
  }
  if (type === MSG.OFF_CANCEL) {
    cancelJob(message.id);
    sendResponse?.({ ok: true });
    return false;
  }
  return false;
});

console.debug('[UV offscreen] ready');
