# Universal Video Downloader — Project Information (AI Agent Handoff)

> **Purpose of this file:** Persistent, self-contained context for any AI agent (or human) working on this
> repository. Read this **before** touching code. It records the mission, decisions, architecture,
> tech stack, trade-offs, limitations and known pitfalls so work does not have to be re-derived.
>
> Keep it updated whenever a significant decision, file or limitation changes.

- **Last updated:** 2026-11-23
- **Repo root:** `/Users/ranjith/Developer/hub-downloader`
- **Current product name:** **Universal Video Downloader** v5.2.0 (generalized build)
- **Status:** ✅ **Generalized build implemented + v5.1.0 bug fixes + legacy code removed** (Milestones
  M1, M2, M2.1 and M2.2 in `PLAN.md`). M3 (extra adapters, WebCodecs transcode, resume, separate-audio
  HLS) is pending. See §2.6 for the working/non-working matrix.

> **IMPORTANT — files that are ACTIVE vs UNUSED**
> The active runtime is: `manifest.json`, `background.js`, `offscreen.js`, `offscreen.html`, `popup.html`,
> `popup.js`, `content/*`, `page/sniffer-page.js`, `core/*`, `modules/hls2mp4/*`, `modules/hls/*`,
> `modules/FSBlob.mjs`, `modules/network/IndexedDBManager.mjs`, `modules/utils/EnvUtils.mjs`, and
> `modules/mediabunny/*` (DASH muxing). Some bundled modules are dead legacy (see the §2.1 module inventory);
> no legacy root-level runtime files remain.

---

## 1. Mission

Build a **universal, reliable and lightweight Chrome MV3 video downloader** that:

1. **Detects** streamable media (`.m3u8` / HLS, `.mpd` / DASH, progressive `.mp4` / `.webm`, and other
   manifest-based streams) on **any** site — social media, movie/TV streaming, adult, education, news, etc.
2. **Downloads** the detected stream at user-selected quality.
3. **Saves a playable file** (MP4 preferred), remuxing (not re-encoding) whenever possible.
4. Runs **reliably and lightly on low-end machines** (reference target: **4 GB RAM**, weak CPU, slow/erratic
   network, low provider bandwidth).

### Success criteria
- Peak memory during a large (1 GB+) download stays **well under ~200–300 MB** and **must not** scale with
  the full file size.
- Works without depending on a specific site's DOM/payload shape.
- Recovers from flaky CDNs (retry/backoff/resume) instead of failing the whole download.
- CPU stays low: prefer **remux/transmux** (`-c copy` equivalent) over transcode.
- Extension is not bloated: ship only modules actually reachable at runtime.

### Explicit non-goals / red lines
- **No DRM circumvention.** Widevine/PlayReady/FairPlay protected streams (Netflix, Disney+, etc.) are out of
  scope and must not be attacked. Detect DRM and show a clear "protected, not supported" message.
- No credential/cookie theft; the extension only uses the user's existing session for the current tab.
- No server-side/proxy service in v1 (fully client-side / local-only).

---

## 2. Current State (as-is)

### 2.0 AS-BUILT (v5.2.0 — generalized)

The extension has been rewritten around a site-agnostic sniffing + streaming-download core.
Legacy single-site files have been **removed** (see §2.1); only the active runtime remains.

**v5.1.0 fixes (focused, no architecture rewrite):**
- **Critical save-path fix:** `chrome.downloads` is not available in offscreen documents (only
  `chrome.runtime` is). The offscreen worker now creates the blob URL and asks `background.js` to call
  `chrome.downloads.download()` and poll its state. Without this, every download failed at the save step.
- **Correct output extension:** progressive WebM/MKV/MOV/FLV are no longer misnamed `.mp4`
  (`core/formats.mjs::extensionForVariant`).
- **Implicit HLS byte ranges** (`#EXT-X-BYTERANGE:length` without `@offset`) now continue from the previous
  range of the same URL instead of restarting at 0.
- **Live HLS is rejected** with a clear error instead of saving a truncated snapshot.
- **Context-menu download picks the best quality**, not the first item in the list.
- **Retry backoff no longer sleeps twice** (removed a duplicated `sleep`).
- Added regression tests for the save bridge and the parser/naming fixes.

**Runtime flow (any site):**
1. User opens the popup (or clicks the in-page button / context menu). `activeTab` is granted.
2. `background.js` injects `content/sniffer.js`, `content/panel.js`, `content/button.js` (isolated world)
   plus `page/sniffer-page.js` (MAIN world), and inserts `content/panel.css` + `content/button.css`.
3. `page/sniffer-page.js` hooks `fetch`/XHR (metadata only, never bodies), harvests player globals
   (`flashvars_*`, `__NEXT_DATA__`, …) and inline-script media URLs, and `postMessage`s them.
4. `content/sniffer.js` also reads `performance.getEntriesByType('resource')` (catches media loaded
   *before* the click), scans the DOM, and returns a merged snapshot to the background on `UV_COLLECT`.
5. `background.js` merges + de-dupes candidates, asks the content script to **probe** each one
   (`UV_PROBE`: fetch manifest text / HEAD or range-GET for size — done in page context so CORS,
   cookies and `Referer` are correct), then parses with `core/hls.mjs` / `core/dash.mjs`.
6. The popup lists each media item with its variants/qualities. DRM items are shown but disabled.
7. On download, `background.js` builds a job and sends it to the **offscreen document**.
8. `offscreen.js` downloads with bounded concurrency and writes to **OPFS** (disk), then remuxes. It creates
   a `blob:` URL for the finished file and sends `MSG.SAVE_FILE` to `background.js`, which calls
   `chrome.downloads.download()` and is polled via `MSG.SAVE_STATUS`. Progress flows back to the popup and
   the in-page panel. This split is required because offscreen documents only expose `chrome.runtime`.

**Download strategies (offscreen):**
- **Progressive MP4/WebM** → streamed straight to an OPFS file → disk-backed `File` → save (near-zero heap).
- **HLS with fMP4 segments** (`.m4s`/`EXT-X-MAP`) → `init` + segments concatenated into one OPFS file
  (no re-processing) → save. Lowest CPU.
- **HLS with MPEG-TS segments** → **incremental transmux** (`modules/hls2mp4`, new `start/pushSegment/finish`
  API) with fragment payloads stored in **OPFS via `modules/FSBlob.mjs`**; then saved. Memory ≈ a few segments.
- **DASH** → `mediabunny` reads encoded packets from the init/segments and writes a **fragmented MP4** to an
  OPFS `StreamTarget`; falls back to direct concatenation if muxing fails.
- **Referer/cookie failures** (401/403/404/412) → automatic retry through a **content-script relay** that
  fetches in page context and returns base64.
- **Saving** → offscreen creates the final blob URL; the service worker owns `chrome.downloads` and polls
  the download state (offscreen docs have no `chrome.downloads`).

**Output policy (owner decision):** documents the size at download time and passes
`core/formats.mjs::decideOutputPolicy` the variant size + codecs. `> 800 MB` is always **remux-only**;
`≤ 800 MB` may **transcode** only when the codecs are not already compatible *and* the device is capable.
Transcode execution (WebCodecs) is **not implemented yet** (M3) — the policy is recorded but the
downloader currently always remuxes. See §7.

**As-built file map (active):**

| File | Role |
|---|---|
| `manifest.json` | MV3, `activeTab`+`scripting`+`storage`+`downloads`+`offscreen`+`contextMenus`; optional host perms |
| `background.js` | Injection, candidate registry, probing, download jobs, progress relay, **save bridge (`chrome.downloads`)** |
| `content/sniffer.js` | Detection: perf entries + DOM + page messages; `UV_COLLECT`, `UV_PROBE`, `UV_RELAY_FETCH` |
| `content/panel.js` + `content/panel.css` | In-page progress panel |
| `content/button.js` + `content/button.css` | In-player "Download" button (`UV_QUICK_DOWNLOAD`) |
| `page/sniffer-page.js` | MAIN-world fetch/XHR hooks + player-global harvesting |
| `offscreen.js` | OPFS streaming downloader + transmux/mux + blob URL creation; delegates saving to background |
| `popup.html` / `popup.js` | Media list, quality picker, download + progress |
| `core/messaging.mjs` | Message constants (including `SAVE_FILE`/`SAVE_STATUS`) + settings defaults |
| `core/hls.mjs` | Pure M3U8 parser (master/media, attrs, byte ranges, keys/DRM, `EXT-X-MAP` signed-query inheritance) |
| `core/dash.mjs` | Pure MPD parser (SegmentTemplate/List/Base, DRM detection, self-closing reps) |
| `core/formats.mjs` | Classification, variant model/sorting, naming/extension, output policy, device profile |
| `core/adapters.mjs` | Generic adapter registry + `interpretPageData` |
| `core/opfs.mjs` | OPFS temp-file helpers |
| `core/pipeline.mjs` | Ordered, bounded-concurrency pipeline (`orderedPipeline`, `mapLimit`) |
| `modules/hls2mp4/*` | **Modified**: incremental `start/pushSegment/finish` transmux API |
| `modules/FSBlob.mjs` | **Modified**: OPFS-backed blob store on Chromium (was pure in-memory) |
| `tests/*.test.mjs` | 41 Node tests (hls, dash, formats, adapters, pipeline, manifest/build integrity, save bridge) |
| `package.json` | Developer metadata only; `npm test` runs the Node suite. Not used by Chrome. |

**How to build & test (no build step):**
```bash
# Unit tests
node --test tests/*.test.mjs

# Syntax-check every runtime file
for f in core/*.mjs modules/hls2mp4/*.mjs content/*.js page/*.js; do node --check "$f"; done

# Load: chrome://extensions → Developer mode → Load unpacked → this folder
```
Current result: **41/41 tests pass; all runtime files parse.** Project size: **~6 MB** (under the 100 MB
sharing target).

### 2.1 Legacy single-site code — removed (v5.2.0)

The original single-site implementation, its research notes, and its editor/workspace files were removed.
No site-specific adapter, folder, referer, DOM, or manifest coupling remains; the active runtime is fully
generic. Removed files: `background-enhanced.js`, `content.js`, `inject.js`, `download-manager.js`,
`player-button.js`, `logger.js`, `rough_research.md`, `download-manager.sublime-workspace`,
`styles/` (all legacy CSS), `site-config.js`, `.serp-canonical-build-*.js`, and `.DS_Store`.

**Module inventory (status as-built):**

| Module | Status |
|---|---|
| `modules/hls2mp4/*` | **USED** — incremental TS→MP4 transmux (modified for streaming) |
| `modules/hls/hls.mjs`, `Mp4Sample.mjs` | **USED** — hls.js demuxers/remuxers behind transmuxer |
| `modules/FSBlob.mjs` | **USED** — OPFS-backed blob store on Chromium |
| `modules/network/IndexedDBManager.mjs` | **USED** only on non-OPFS browsers |
| `modules/utils/EnvUtils.mjs` | **USED** (by FSBlob) |
| `modules/mediabunny/**` | **USED** for DASH/fMP4 streaming mux (4.3 MB — pruning candidate) |
| `modules/reencoder/**`, `modules/dash2mp4/**`, `modules/mp4box.mjs`, most `modules/utils/*` | **UNUSED** (dead legacy; safe to prune) |

### 2.6 Working vs non-working (v5.2.0)

#### Working end-to-end

| Capability | Status / notes |
|---|---|
| Standard HLS VOD (muxed TS or fMP4) | ✅ Detect, parse, download, save (parser/pipeline unit-tested; browser E2E pending) |
| Standard DASH VOD (`SegmentTemplate` `$Number$`, `SegmentList`, `SegmentBase`) | ✅ Detect, parse, mux, save (parser/pipeline unit-tested; browser E2E pending) |
| Progressive MP4/WebM/MKV/MOV/FLV | ✅ Stream to OPFS, save with correct extension; verified in Chrome 157 E2E |
| Detection via Performance Timing, DOM, fetch/XHR metadata, globals, inline URLs | ✅ Works on cooperative pages |
| DRM detection and refusal | ✅ HLS keys, DASH `ContentProtection`; download disabled |
| Bounded concurrency, retry/backoff, cancel | ✅ Ordered writes, 3 retries, abort support |
| CORS/Referer/cookie relay fallback | ✅ Page-context base64 relay when direct fetch fails |
| OPFS disk-backed streaming | ✅ Progressive and fMP4; TS fragment payloads via `FSBlob` |
| Save bridge | ✅ Offscreen blob URL → service worker `chrome.downloads` → polled state; verified in Chrome 157 E2E |
| Popup, in-page panel, player button, context menu | ✅ All wired; context menu picks best quality |
| Live HLS rejection | ✅ Clear error instead of a truncated file |
| Unit tests + syntax checks | ✅ 41/41 pass; all runtime files parse |
| Chrome smoke/E2E | ✅ Extension loads (v5.2.0), save bridge completes, progressive download saves byte-for-byte |

#### Not working / intentionally unsupported

| Gap | Impact / workaround |
|---|---|
| HLS separate audio (`EXT-X-MEDIA`) | Video-only variants download **silent**; needs audio muxing (M3) |
| AES-128 HLS | Refused as protected; no decryption path |
| DASH `SegmentTimeline`, `$Time$`, dynamic/live, complex multi-period | Unsupported or wrong segment lists |
| Live HLS/DASH | HLS is explicitly rejected; DASH live is unsupported |
| MSE/blob-only players, Worker/Service Worker requests | Often invisible to page hooks; no capture |
| Media URLs inside JSON API responses | XHR hook does not read bodies; may be missed |
| YouTube/TikTok/Instagram/X/Netflix/Disney+/Prime | Signature/DRM/MSE; out of scope |
| Subtitles, audio-track selection | Not implemented |
| Resume after restart/network drop | Not implemented; failed downloads restart |
| WebCodecs transcode execution | Policy is computed; downloader always remuxes |
| Unparsed DASH manifest | Download fails with a clear "press Rescan" error |
| HLS fMP4 mid-stream discontinuities | Plain concatenation may need remuxing |
| Lost TS segment | Skipped to tolerate CDN errors; output may have a gap |
| Service-worker restart during a job | In-memory `downloads`/tab maps are lost; panel updates may stop |
| First save on a new host | May prompt for optional host permission; relay is slower |

---

## 3. Problem Statement (why it's slow/heavy today)

> **As-built status:** items **1, 2, 3, 5, 6, 8** below are addressed by v5.2.0 (OPFS streaming, incremental
> transmux, ordered bounded concurrency, gated logging, generic detection, save bridge). Item **4 (resume)**
> and the transcode part of the output policy are **deferred to M3**.

Performance is reported to depend on laptop RAM, internet speed, provider CDN speed and transcoding cost.
Root causes found in code:

1. **Whole-file buffering.** Both MP4 and HLS paths accumulate the **entire** media in JS memory:
   - HLS: `segmentPayloads` (array of `ArrayBuffer`) + `datas[]` blobs + final combined `Blob`.
   - MP4: `chunks[]` array + final `Blob`.
   On a 4 GB machine a 1–2 GB video can push several GB of heap → GC thrash / tab crash.
2. **Duplicate copies.** The final `Blob` is a *copy* of already-buffered bytes (combinedData / Blob array),
   doubling peak memory.
3. **Chrome never offloads to disk.** `FSBlob` explicitly uses an in-memory `Map` on Chrome
   (`BrowserCanAutoOffloadBlobs = isChrome()`), so the "disk-backed" design is defeated.
4. **No HTTP range/resume.** Interrupted downloads restart from scratch.
5. **Sequential segment fetch.** One segment at a time underuses bandwidth and increases total time.
6. **Heavy logging.** Many unconditional `console.log` calls (including dumping full playlists and JSON).
7. **Bloat.** 4.3 MB `mediabunny` + 224 KB `reencoder` + dead utils are shipped but unused.
8. **Fragile detection.** Relies on site-specific `flashvars`/DOM, not on generic network observation.

---

## 4. Target Architecture (proposed)

### 4.1 Layered design
```
┌────────────────────────────────────────────────────────────────┐
│ MV3 Service Worker (background)                                │
│  - orchestrator, state machine, download registry              │
│  - DNR header rules (per-origin, learned)                      │
│  - routes work to offscreen; owns chrome.downloads             │
└───────────────▲───────────────────────────┬────────────────────┘
                │ messages                  │ messages
┌───────────────┴───────────┐   ┌───────────▼────────────────────┐
│ Content script (all sites)│   │ Offscreen document             │
│  - generic DOM media scan │   │  - network fetch + retry/resume│
│  - <video>/<source>/src   │   │  - HLS/DASH probe + parse      │
│  - page-context sniffer   │   │  - streaming write to OPFS     │
│    (fetch/XHR hook)       │   │  - remux to MP4 (stream)       │
│  - injected in-page UI    │   │  - blob URL → service worker   │
└───────────────────────────┘   └────────────────────────────────┘
```

### 4.2 Detection strategy (universal, layered)
1. **Network sniffing (primary).** A page-context sniffer wrapped around `fetch`/`XMLHttpRequest`
   (`PerformanceObserver` as backup) observes responses whose URL/`Content-Type` look like media:
   - manifests: `.m3u8` (`application/vnd.apple.mpegurl`), `.mpd` (`application/dash+xml`)
   - segments: `.ts`, `.m4s`, `.mp4` fragments (`video/mp2t`, `video/iso.segment`)
   - progressive: `.mp4`, `.webm`, `.mov` (`video/*`)
   Requests are correlated into a "media candidate" with URL, type, headers, tab and timing.
   **Content-Type + URL sniffing only — never parse response bodies at sniff time** (keeps it light).
2. **DOM scan (secondary).** `<video>`, `<video><source>`, `currentSrc`, `src`, `data-src`, `poster`,
   JSON-LD, `og:video`, `twitter:player:stream`, common player config globals.
3. **Manifest probe (tertiary).** Fetch the manifest (small) to enumerate variants/qualities. Master
   playlists give real resolutions/bandwidth; media playlists give segments/duration.
4. **Site adapters (optional, additive only).** A small registry of per-host hints (extra referer rules,
   player containers, known API endpoints). The generic pipeline works without any adapter.

### 4.3 Download strategy (memory-first)
- **Streaming writes to OPFS** (Origin Private File System) from the offscreen document:
  fetch segment/fragment → write to an OPFS `FileSystemWritableFileStream` → release the buffer.
  Peak memory becomes ~one/few segments, **not the whole file**.
- At completion, `fileHandle.getFile()` returns a **disk-backed `File`**. The offscreen document creates
  `URL.createObjectURL(file)`; the **service worker** calls `chrome.downloads.download()` (offscreen documents
  only expose `chrome.runtime`) and polls `chrome.downloads.search()` until the save completes.
- **HLS → MP4:** use a **fragmented-MP4 (fMP4) muxer that supports incremental output** so fragments are
  written as they arrive. Candidates: `mediabunny` (already bundled, has `StreamTarget`) or a slim custom
  fMP4 writer built on the existing `MP4Generator`/`transmuxer`. Avoid the current "accumulate-then-finalize"
  `moov`-at-end design for large files.
- **DASH → MP4:** same fMP4 approach; segments are already fMP4, so typically a concatenation/merge.
- **Progressive MP4:** stream to OPFS directly, or forward the original URL to the service worker's
  `chrome.downloads.download` when no auth headers are required (zero-copy path).
- **Concurrency:** small bounded pool (default 2–4 in-flight segments) with a **bandwidth-aware scheduler**
  (adaptive: raise concurrency on fast links, lower on slow/erroring ones). Always globally rate-limited to
  be polite and avoid CDN bans.
- **Cross-origin fetching (critical):** with `activeTab`-only permissions the offscreen document has no host
  access to media CDNs, so direct cross-origin `fetch` is blocked (CORS) or rejected. The downloader
  therefore: (1) asks the popup to request the media origin via `optional_host_permissions` on download
  (host access bypasses CORS), and (2) **always falls back to a page-context relay** (`offscreen` →
  background → content script → base64) on any direct-fetch failure, which inherits the page's cookies,
  `Referer` and CORS allowances. Progressive files relay in 4 MiB ranged chunks; HLS/DASH segments relay
  per segment. A final browser-download fallback covers progressive files if both fail.
- **Resume/retry:** exponential backoff + jitter per segment (already present), plus a persisted index of
  completed segments so a restart resumes instead of re-downloading. *(Resume is M3; retry is built.)*

### 4.4 Output & naming
- Default container **MP4** (H.264/AAC passthrough). Only transcode if the source codec is incompatible
  **and** the user opts in (WebCodecs, CPU-heavy, warns on low-end devices).
- Folder/file naming from `sanitizeFilename`, generalized (configurable folder, e.g. `VideoDownloader/`).
- Subtitles (`#EXT-X-MEDIA` / WebVTT) optional; capture if present but keep off by default.

### 4.5 Lightness budget
- Ship **only** reachable modules; drop `mediabunny`/`reencoder`/dead utils **unless** one is chosen as the
  muxer (then keep exactly one muxer, minified).
- Level-gate all logging (default `error` in packaged builds).
- Avoid polling loops; prefer event-driven progress with throttled UI updates (e.g. ≤4 Hz).
- Respect `EnvUtils.hasComputationalResources()` / `navigator.deviceMemory` to auto-reduce concurrency and
  disable re-encode on low-end devices.

---

## 5. Tech Stack

| Concern | Choice | Rationale |
|---|---|---|
| Platform | Chrome MV3 (Chromium browsers) | Existing baseline; offscreen + OPFS available |
| Language | Vanilla ES2020+ JS / ES modules | No build step; minimal tooling; easy to audit |
| Background | Service worker, `"type": "module"` | Already in use |
| Heavy work | Offscreen document + (optionally) Web Workers | MV3 SW has no DOM/`URL.createObjectURL` |
| Storage (temp) | **OPFS** (`navigator.storage.getDirectory()`) | Disk-backed, avoids heap blow-up |
| Storage (state) | `chrome.storage.session`/`local` | Download registry, learned header rules, settings |
| Network | `fetch` + `AbortController` + streaming `ReadableStream` | Progress, cancellation, retry |
| Header control | `declarativeNetRequest` dynamic rules | Set `Referer`/`Origin` per learned origin |
| Transmux | HLS: TS/fMP4 → MP4; DASH: fMP4 merge | CPU-cheap (`copy` semantics) |
| Save | Service-worker `chrome.downloads.download` + offscreen blob URL | Native download UI; offscreen docs lack `chrome.downloads` |
| UI | Popup + in-page panel + player button | Existing; generalize copy/branding |
| Tests | Node-based unit tests for pure parsers + manual load-unpacked checklist | No build system today |

---

## 6. Key Decisions (Decision Log)

| # | Decision | Choice | Status | Rationale / Notes |
|---|---|---|---|---|
| D1 | Product scope | Generic sniffing **+ optional site adapters** | ✅ **Locked** (owner) | Universal coverage; adapters are additive only |
| D2 | Detection primary source | Network sniffing (fetch/XHR hook) + Performance Resource Timing + DOM | ✅ **Built** | Site-agnostic; perf entries recover pre-click media |
| D3 | Memory strategy | OPFS streaming writes + disk-backed `File`/`Blob` → blob URL → service-worker `chrome.downloads` | ✅ **Built** | Core fix for 4 GB machines; FSBlob + offscreen use OPFS |
| D4 | Transcode policy | `> 800 MB` remux-only; `≤ 800 MB` may transcode when codecs incompatible | ✅ **Policy built**, ⏳ transcode exec pending | Avoids CPU drain on large files |
| D5 | Muxer | `mediabunny` `StreamTarget` for DASH/fMP4; custom incremental transmux for TS | ✅ **Built** | mediabunny has **no MPEG-TS input**, so TS keeps the hls.js transmuxer |
| D6 | Host permissions | **`activeTab` only** (+ `optional_host_permissions` declared for future opt-in) | ✅ **Locked** (owner) | Detection is click-initiated on arbitrary sites |
| D7 | Site adapters | Optional additive hints only | ✅ **Built** | Generic pipeline works without any adapter |
| D8 | DRM | Detect and refuse; no circumvention | ✅ **Built** | Legal/safety; DRM items shown disabled |
| D9 | Branding / name | **Universal Video Downloader** | ✅ **Locked** (owner) | manifest/copy/colors updated |
| D10 | Build tooling | No build step; plain ES modules | ✅ **Built** | Node used only for tests |
| D11 | Concurrency default | 3 in-flight segments, configurable 1–6 | ✅ **Built** | Order-preserving pipeline |
| D12 | Settings surface | `chrome.storage.local.uvSettings` + defaults; options page deferred | 🟡 **Partial** | Background exposes `UV_GET_SETTINGS`/`UV_SET_SETTINGS` |
| D13 | Save bridge | Offscreen creates the blob URL; **service worker owns `chrome.downloads`** and polls state | ✅ **Built (v5.1.0)** | Offscreen documents only expose `chrome.runtime`; direct `chrome.downloads` calls were fatal |
| D14 | Output naming | Extension derived from container (HLS/DASH → mp4; WebM/MKV/MOV/FLV preserved) | ✅ **Built (v5.1.0)** | Prevents mislabeled progressive files |


> Update this table when a decision is finalized.

---

## 7. Pros / Cons of the Chosen Approach

### Pros
- **Site-agnostic:** one sniffer covers HLS/DASH/MP4 across most sites; adapters are optional.
- **Memory-safe:** OPFS streaming means peak RAM ≈ a few segments, independent of file size.
- **CPU-cheap:** remux-only default, no re-encode for the common case.
- **Retry-resilient:** segment-level retry/backoff and a page-context relay fallback. (Resume after a full
  restart is **not** implemented yet.)
- **Auditable:** vanilla JS, no hidden dependencies, single bundled muxer.
- **Reuses assets:** working transmux pipeline, offscreen architecture, progress UI.

### Cons / Risks
- **Manifests needing custom logic:** some services use obfuscated/encrypted manifests, signed one-time
  URLs, or DRM — sniffing alone won't work there (acceptable limitation).
- **`activeTab`-only trade-off:** no silent background detection; users must invoke the extension. This keeps
  permissions minimal but changes UX versus classic downloaders.
- **OPFS availability/quotas** vary; must handle quota errors and fall back gracefully.
- **Streaming fMP4 muxing is non-trivial**; risk of producing subtly broken files → needs a validator.
- **Sniffing hooks can clash** with site code (must be defensive, low-overhead, easy to disable).
- **Some sites use service workers/Media Source Extensions** where bytes never appear as simple
  fetchable URLs → may need `MediaSource`/`SourceBuffer` interception (harder, later).
- **Adaptive quality:** server may pick a variant; we expose variants from the manifest, but some sites
  use opaque single-quality segment URLs.

---

## 8. Limitations (known at time of writing)

### As-built limitations (v5.2.0)

**Fixed in v5.1.0:** offscreen `chrome.downloads` save failure, wrong extension for progressive WebM/MKV/MOV/FLV,
implicit HLS byte-range offsets, live HLS silently producing a partial file, context-menu low-quality pick,
and doubled retry backoff.
- **`activeTab` only ⇒ no silent auto-detection.** Sniffing starts when the user opens the popup/clicks
  the button/uses the context menu. Media loaded before that is recovered from the Performance Resource
  Timing buffer (bounded, typically 250 entries), but not guaranteed for very long sessions.
- **No transcode execution yet.** The ≤800 MB "transcode for compatibility" policy is computed and stored
  but the downloader currently always remuxes (the bundled `reencoder` is broken/legacy). Add real WebCodecs
  transcode in M3.
- **TS-based HLS** uses the custom incremental transmuxer, not mediabunny (mediabunny cannot demux MPEG-TS).
  Output memory ≈ segment buffers + sample tables (good, but not perfectly flat for multi-hour videos).
- **fMP4 HLS is concatenated** (init + segments) rather than re-muxed. This is fast/light; some unusual
  playlists with mid-stream discontinuities could need re-muxing.
- **HLS with a separate audio rendition** (master `EXT-X-MEDIA` + video-only variants) is not yet muxed with
  its audio; muxed TS/fMP4 streams are fine.
- **DASH** supports common static VOD (`SegmentTemplate`/`SegmentList`/`SegmentBase`); dynamic/live and
  exotic `SegmentTimeline` cases are not covered.
- **Relay fallback** (for referer/cookie/CORS-protected CDNs) transfers segment bytes as base64 through the
  content script; functional but with ~33% overhead. It is the safety net when direct fetch is blocked —
  which is common with `activeTab`-only permissions. Granting the per-origin permission from the popup
  enables the faster direct path.
- **First download may prompt for the media origin.** The popup requests `optional_host_permissions` for the
  media origin(s) so the offscreen worker can fetch without CORS. Denying is fine (relay is used) but slower.

- DRM (Widevine/PlayReady/FairPlay) streams are **unsupported by design**.
- Live streams: **not in v1** (VOD only). Live requires continuous muxing and unbounded output sizing.
- Encrypted HLS (`#EXT-X-KEY` with AES-128 or SAMPLE-AES): AES-128 may be supported later (key URI is
  fetchable); SAMPLE-AES/DRM is not.
- Sites that deliver media exclusively through MSE with custom segmenters may not be detectable in v1.
- Chrome-only; Firefox/Safari differ (no `chrome.offscreen`, OPFS nuances).
- No playlist/batch/channel downloading in v1.
- No subtitles/audio-track selection in v1 (captured opportunistically at most).
- No built-in network proxy/VPN/geo-bypass; only the user's own session/headers are used.

---

## 9. Performance Targets (acceptance criteria)

| Metric | Target |
|---|---|
| Peak JS heap for a 1 GB HLS download | < 250 MB |
| Peak JS heap for a 1 GB progressive download | < 100 MB (ideally ~few MB) |
| CPU during remux | Low; no sustained > 1 core on low-end HW |
| Segment concurrency | Adaptive 2–4, configurable |
| Time-to-first-byte after "Download" | < 1 s (manifest fetch + first segment) |
| Shipped extension size | < ~1.5 MB (excluding icons) after pruning |
| Resume after network drop | Resumes, does not restart |
| Detection latency | Media appears in UI within ~2 s of playback start |

**Current status:** memory/CPU targets are design goals (browser profiling still pending). Project size is
**~6 MB unpacked**, comfortably under the 100 MB sharing target but above the 1.5 MB post-prune target
because the mediabunny source + dist are bundled. Resume is **not implemented** (M3).

---

## 10. Testing Plan

### Automated (implemented — `tests/*.test.mjs`, run with `npm test` or `node --test tests/*.test.mjs`)
- `hls.test.mjs` — attributes, signed-query inheritance, master/media playlists, explicit/implicit byte
  ranges, live flag, DRM, `EXT-X-MAP`, variant picking.
- `dash.test.mjs` — ISO durations, SegmentTemplate expansion, SegmentList, DRM, self-closing reps.
- `formats.test.mjs` — URL classification, de-dup keys, variant sorting, naming/extension, output policy,
  codecs, fMP4-vs-TS detection, device profile.
- `adapters.test.mjs` — adapter selection, referer resolution, `flashvars` interpretation, nested globals,
  segment/blob rejection.
- `pipeline.test.mjs` — in-order delivery, concurrency cap, empty/single inputs, error propagation.
- `manifest.test.mjs` — MV3 validity, no blanket host permissions, referenced files exist, no legacy
  content-script references, mediabunny exports present.
- `architecture.test.mjs` — offscreen never calls `chrome.downloads`; the service worker owns the save
  bridge; offscreen creates blob URLs and uses `SAVE_FILE`/`SAVE_STATUS`.

**Current result: 41/41 pass; all runtime files pass `node --check`.**

### Browser smoke test (Chrome 157, 2026-11-23)

Loaded the unpacked extension through the DevTools protocol and exercised the real runtime:

- ✅ `background.js` service worker starts, reports manifest **5.2.0**, and raises no exceptions.
- ✅ **Save bridge:** `UV_SAVE_FILE` → service-worker `chrome.downloads.download` → `UV_SAVE_STATUS`
  returns `complete`; saved file content was verified.
- ✅ **Progressive E2E:** local page → detection → popup list → Download → offscreen OPFS stream → save.
  A 256 KB source was saved byte-for-byte (262,144 bytes) with no runtime exceptions.
  The E2E used a test-only copy with a localhost host permission so injection did not need a manual
  action click; product code was unchanged.

Still manual: HLS/DASH download E2E, memory profiling, DRM/live rejection, cancel and network-drop checks.

### Manual load-unpacked checklist
1. `chrome://extensions` → Developer mode → **Load unpacked** → select this folder. Expect **no** install-time
   host-permission prompt (only `activeTab`/`contextMenus`/etc.).
2. Open a known HLS test page, press play, open the popup. Expect media to appear within ~2 s.
3. Download the top quality; confirm the file **saves** (this exercises the new service-worker save bridge)
   and plays (`ffprobe -v error -show_streams out.mp4`).
4. Repeat for a progressive MP4 page and (if available) a DASH page. Confirm a WebM source saves as `.webm`.
5. While downloading, open DevTools → Memory and confirm the extension heap does **not** grow with file size
   (peak should stay in the tens of MB for large files).
6. Cancel a download mid-way; confirm no partial file is saved and the panel updates.
7. Simulate a network drop (DevTools offline for a few seconds); confirm retry/backoff and eventual success.
8. Verify a site whose player exposes `flashvars`/`mediaDefinitions` (generic page-data regression).
9. Verify DRM content (e.g. a Widevine stream) shows "DRM protected" and cannot be downloaded.
10. Open a live HLS playlist; expect a clear "Live streams are not supported" error.


---

## 11. Glossary

- **HLS** — HTTP Live Streaming; `.m3u8` manifest + `.ts`/`.m4s` segments.
- **DASH** — MPEG-DASH; `.mpd` manifest + fMP4 segments.
- **Manifest/playlist** — text file listing variants and/or segments.
- **Master playlist** — lists variant streams (qualities). **Media playlist** — lists actual segments.
- **fMP4** — fragmented MP4 (`moof`/`mdat` boxes), streamable.
- **Transmux/remux** — change container without re-encoding. **Transcode** — re-encode (expensive).
- **OPFS** — Origin Private File System; sandboxed disk storage available to extensions.
- **Offscreen document** — MV3 hidden document allowed to use DOM APIs the service worker cannot.
- **DNR** — `declarativeNetRequest`; declarative header/URL rules.
- **MSE** — Media Source Extensions; JS feeds segments to `<video>`; can hide real URLs.

---

## 12. Working Notes / Handy Commands

```bash
# Repo has no package.json; it's a plain unpacked extension. Load via:
#   chrome://extensions → Developer mode → Load unpacked → this folder

# Inspect module sizes (to keep the extension light):
du -sh modules/* | sort -h

# Find runtime-reachable modules (from offscreen.js / background / content):
grep -RhoE "from ['\"][^'\"]+['\"]" modules/hls2mp4 modules/hls modules/FSBlob.mjs

# Validate a produced file (if ffprobe is installed):
ffprobe -v error -show_streams -show_format output.mp4
```

---

## 13. Open Questions

All previously-open questions were answered by the owner (2026-09-20) and are locked in the Decision Log.
Remaining **future** questions:
1. **Muxer pruning:** keep the 4.3 MB mediabunny for DASH, or replace with a slim fMP4 writer / direct merge
   to shrink the package?
2. **Transcode:** implement WebCodecs transcode for the ≤800 MB compatibility path, or drop transcode entirely?
3. **Adapters:** which concrete platforms are worth hand-written adapters (given many major
   ones use DRM/MSE)?
4. **Optional host permissions:** add a per-site "Enable auto-detect" toggle that requests
   `optional_host_permissions` and registers a persistent content script?
5. **Settings UI:** add an options page for folder/naming/quality cap/concurrency/policy?

