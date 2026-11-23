# Build Plan — Universal Video Downloader

Derived from `information.md` and the owner's decisions (2026-09-20).

## Owner Decisions (locked)
- **D1 Scope:** Generic network sniffing **+ optional site adapters** (adapters are additive only).
- **D2 Memory:** **OPFS streaming** + use the **bundled `mediabunny`** where it applies.
- **D3 Permissions:** **`activeTab`** only for broad access; no `<all_urls>` host permission by default.
  → Optional per-site "Enable auto-detect" via `optional_host_permissions` (opt-in, user gesture).
- **D4 Output policy:**
  - size ≤ **800 MB** → prefer **transcode/re-encode** for maximum compatibility,
  - size > **800 MB** → **remux only** (no re-encode) to avoid CPU drain/wait.
  (Only transcode when actually needed; most streams are already H.264/AAC.)
- **D5 Site adapters:** optional additive hints only; the generic pipeline works without them.
- **D6 Name:** **Universal Video Downloader**.

## Reality checks / constraints (must be honored in design)
- **mediabunny cannot demux MPEG-TS.** Use it for fMP4/DASH/progressive MP4. TS-based HLS uses the
  existing hls.js-based transmuxer, refactored to stream incrementally.
- **`activeTab`** grants access only after the user invokes the extension. Auto-detection therefore only
  happens when (a) the user clicks the extension/opens the popup, or (b) they enabled auto-detect for that
  site (optional host permission). This is a deliberate trade-off.
- **No DRM circumvention.** Detect and refuse.
- MV3 service worker cannot create object URLs or use OPFS for writes across restarts without care; the
  **offscreen document** owns heavy IO and OPFS.

---

## Architecture

```
manifest.json (activeTab + scripting + storage + downloads + notifications + offscreen;
               optional_host_permissions: <all_urls>)

background.js  (service worker, module)
  - message router + per-tab candidate registry (in-memory + chrome.storage.session)
  - injects content/sniffer.js + content/panel.js on activeTab
  - optional: registers persistent content script when host permission granted
  - adapter registry: generic (+ optional adapters incrementally)
  - on download: resolve variant -> send job to offscreen
  - DNR: learned Referer/Origin header rules (only where permitted)

content/sniffer.js  (isolated world, injected)
  - reads performance resource entries (catches media loaded before click)
  - DOM scan: <video>, <source>, og:video, JSON-LD
  - injects page/sniffer-page.js (page context) to hook fetch/XHR -> postMessage
  - maps candidates -> chrome.runtime.sendMessage({type:'UV_CANDIDATES'})

page/sniffer-page.js (page context)
  - wraps fetch + XMLHttpRequest, detects media by URL/content-type
  - never reads bodies; posts only metadata

content/panel.js     (in-page progress panel; generalized download-manager)
content/button.js    (generalized in-player button, attaches to <video>)

offscreen.js (module) — the downloader
  - OPFS file writer (core/opfs.mjs)
  - progressive MP4/WebM: stream fetch -> OPFS -> disk-backed File -> chrome.downloads
  - fMP4 HLS / DASH: mediabunny Input -> Output(Mp4OutputFormat, StreamTarget -> OPFS)
  - TS HLS: incremental transmux (modules/hls2mp4) -> OPFS-backed Blob -> chrome.downloads
  - bounded segment concurrency + retry/backoff + cancel
  - policy: transcode only if codec-incompatible AND size <= threshold AND device capable

core/            (shared ES modules)
  hls.mjs        pure M3U8 parser (master+media, attrs, signed-query inheritance)
  dash.mjs       pure MPD parser (representations + segment templates/list)
  formats.mjs    candidate/variant model, sorting, naming, size/policy helpers
  adapters.mjs   adapter registry + generic adapter
  opfs.mjs       OPFS read/write helpers
  messaging.mjs  message type constants + helpers

popup.html/js    generalized UI: detected media list, variant/quality picker, download button
```

---

## Milestones

### M1 — Generalized skeleton + detection ✅ DONE (v5.0.0)
- ✅ Rewrote `manifest.json` (activeTab; optional host permission declared).
- ✅ `core/{hls,dash,formats,adapters,messaging,opfs,pipeline}.mjs`.
- ✅ `content/sniffer.js`, `page/sniffer-page.js`.
- ✅ `background.js` orchestrator with candidate registry + adapter interpretation + injection + probing.
- ✅ `popup.html/js` listing detected media + quality selection.
- ✅ Generalized `content/panel.js` and `content/button.js` (+ injected CSS).
- ✅ Generic `flashvars`/`mediaDefinitions` interpretation retained; no site-specific coupling.

### M2 — Streaming downloader ✅ DONE (v5.0.0)
- ✅ `offscreen.js` rewrite.
- ✅ OPFS streaming for progressive media.
- ✅ mediabunny streaming mux for DASH (fragmented MP4 → OPFS `StreamTarget`), with concat fallback.
- ✅ Incremental TS transmux (`modules/hls2mp4` `start/pushSegment/finish`) + OPFS-backed `modules/FSBlob.mjs`.
- ✅ Bounded-concurrency ordered pipeline + retry/backoff + cancel + content-script relay fallback.
- ✅ Size-based output policy computed (≤800 MB may transcode, >800 MB remux-only). ⏳ Transcode execution
  itself is deferred (see M3); the downloader currently remuxes and records the policy.
- ✅ Progress + completion + error plumbing to popup and in-page panel.

### M2.1 — Focused correctness fixes ✅ DONE (v5.1.0)
- ✅ **Save bridge:** offscreen creates the blob URL; `background.js` owns `chrome.downloads` and polls it.
  (Offscreen documents only expose `chrome.runtime` — direct `chrome.downloads` calls were fatal.)
- ✅ Correct output extension for progressive WebM/MKV/MOV/FLV.
- ✅ Implicit HLS `#EXT-X-BYTERANGE` offsets continue after the previous range.
- ✅ Live HLS is explicitly rejected instead of saving a truncated snapshot.
- ✅ Context-menu download picks the best quality.
- ✅ Removed duplicated retry sleep.
- ✅ Added `tests/architecture.test.mjs` + parser/naming regressions (41 tests total).
- ✅ Updated `README.md`, `information.md`, `PLAN.md`; added `package.json` (`npm test`).

### M2.2 — Legacy removal + repo cleanup ✅ DONE (v5.2.0)
- ✅ Removed the single-site adapter and its folder/referer special-casing; registry is generic-only.
- ✅ Deleted legacy runtime/research files (`background-enhanced.js`, `content.js`, `inject.js`,
  `download-manager.js`, `player-button.js`, `logger.js`, `rough_research.md`, legacy `styles/`,
  `site-config.js`, `.serp-canonical-build-*.js`, and the editor file).
- ✅ Removed all site-specific references from code, tests, and documentation.
- ✅ Version bumped to **5.2.0** across `manifest.json`, `package.json`, `README.md`, `information.md`.
- ✅ Repo-wide grep for legacy terms returns no matches; project size **~5.6 MB** (< 100 MB target).

### M3 — Hardening (NEXT)
- Resume index (persist completed segments).
- WebCodecs transcode implementation for the ≤800 MB path (the bundled `reencoder` is currently broken).
- More adapters (e.g. X/Twitter, TikTok) where feasible without DRM.
- HLS separate-audio-rendition muxing; DASH dynamic/`SegmentTimeline`/`$Time$`.
- Detection for JSON API responses, Worker/Service Worker requests, and MSE/blob players.
- DASH fallback when the manifest could not be probed/parsed.
- Settings/options page (folder, quality cap, concurrency, policy override) + per-site auto-detect opt-in.
- Prune dead modules (`reencoder`, `dash2mp4`, `mp4box`, unused utils).

### M4 — Verification
- ✅ Node unit tests: **41/41 passing** (`npm test` or `node --test tests/*.test.mjs`).
- ✅ Syntax: all runtime files pass `node --check`.
- ✅ Build integrity: `manifest.json` validated; referenced files exist; mediabunny exports verified.
- ✅ Chrome 157 smoke: extension loads, service worker reports **5.2.0**, no runtime exceptions.
- ✅ Save bridge E2E: blob URL → service-worker `chrome.downloads` → status `complete`; content verified.
- ✅ Progressive E2E: local page → detection → popup → download; 256 KB saved byte-for-byte.
- ⏳ HLS/DASH browser E2E and manual memory/DRM/cancel checklist (see `information.md` §10).


---

## Acceptance targets (from information.md §9)
- Peak heap for a 1 GB HLS download < 250 MB.
- Peak heap for a 1 GB progressive download < 100 MB.
- Remux-only path for > 800 MB; no sustained CPU spike.
- Detection surfaces media within ~2 s of user click.
- Output file plays (`ffprobe` when available).

---

## Risks
- TS incremental transmux correctness (fMP4/moov offsets). Mitigation: keep proven finalize path as
  fallback; validate output with `ffprobe`; gate streaming behind a feature flag in settings.
- `activeTab` UX (no auto-detect until click). Mitigation: clear popup guidance + optional per-site enable.
- mediabunny API misuse. Mitigation: small isolated adapter with try/catch fallback to direct streaming.
- OPFS quota errors. Mitigation: catch, surface message, fall back to memory for small files.
