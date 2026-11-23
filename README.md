# Universal Video Downloader

A lightweight Chrome (MV3) extension that detects and downloads **HLS (`.m3u8`)**, **DASH (`.mpd`)** and
**progressive (`.mp4`/`.webm`)** video from cooperative sites. It streams to disk via the Origin Private
File System (OPFS), so peak memory stays low — designed for low-end machines (4 GB RAM).

- Plain JavaScript, **no build step**.
- `activeTab`-only permissions: detection runs when you invoke the extension.
- Remux-first: `> 800 MB` downloads are never re-encoded (CPU safety). The transcode policy is computed;
  WebCodecs transcode execution is not implemented yet.
- DRM-protected streams are detected and refused.
- Current version: **5.2.0** (save path fixed, legacy code removed; see “Status” below).

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Usage

1. Open a page with a video and press play.
2. Click the toolbar icon (grants access for that tab).
3. The popup lists detected media and available qualities. Pick one and click **Download**.
   - The first time you download from a new media host, Chrome may ask to grant access to that host.
     Allowing it makes downloads faster; denying still works via the page-context relay, just slower.
   - A **Download** button also appears on the page's video; it downloads the best quality directly.
   - Or right-click the page/video → **Download media with Universal Video Downloader**.
4. Progress appears in the popup and in the in-page panel (top-right). Files are saved under
   `UniversalVideoDownloader/` in your Downloads folder.

If nothing is detected: press play, wait a couple of seconds, then hit **Rescan**. Some sites use DRM,
Media Source Extensions, workers, or JSON APIs that hide the real media URL — those are not supported yet.

## Status: what works and what does not

### Works

- Standard **HLS VOD** with muxed MPEG-TS or fMP4 segments.
- Standard **DASH VOD** using `SegmentTemplate` (`$Number$`), `SegmentList`, or `SegmentBase`.
- Direct **progressive MP4/WebM/MKV/MOV/FLV** URLs.
- Detection from Performance Resource Timing, DOM, `fetch`/XHR metadata, player globals, inline-script URLs.
- DRM detection and refusal (Widevine/PlayReady/FairPlay, HLS `EXT-X-KEY`, DASH `ContentProtection`).
- Bounded-concurrency segment downloads, retry/backoff, cancel, and a page-context relay fallback for
  CORS/Referer/cookie-protected CDNs.
- Disk-backed OPFS streaming for progressive and fMP4 HLS; incremental TS→MP4 transmux; DASH muxing via
  the bundled mediabunny.
- Popup quality picker, in-page progress panel, in-player button, context-menu download.
- Save path now correctly delegates `chrome.downloads` to the service worker (offscreen documents only
  expose `chrome.runtime`).

### Does not work / not supported

- **Separate-audio HLS** (`EXT-X-MEDIA` audio renditions): video-only variants download without audio.
- **AES-128 HLS**: refused as protected; only unencrypted or DRM-free streams are supported.
- **DASH** `SegmentTimeline`, `$Time$` templates, dynamic/live, and exotic multi-period MPDs.
- **Live streams**: explicitly rejected (VOD only).
- **MSE/blob-only players**, Service Worker/Worker requests, and media URLs hidden inside JSON API
  responses are often missed.
- **DRM sites** (Netflix, Disney+, Prime Video, etc.) and mainstream sites that require signature
  deciphering (YouTube, TikTok, Instagram, X) are out of scope.
- **Subtitles/audio-track selection**, resume-after-restart, batch/playlist downloads.
- **WebCodecs transcode execution** (the policy is recorded; the downloader always remuxes).
- Unparsed DASH manifests: the popup may list the URL, but the downloader cannot build segments; press
  **Rescan** so the manifest can be probed and parsed.

## How it works

```
popup / button / context menu  ->  background.js (service worker)
     |                                  |
     | injects (activeTab)              | asks content script to probe candidates
     v                                  v
content/sniffer.js  +  page/sniffer-page.js  -->  core/hls.mjs, core/dash.mjs (parse)
     |                                                                    |
     |                                                                    v
     +----------------------- offscreen.js (streaming downloader) <-------+
                                    |
                    OPFS (disk) -> blob URL -> background.js -> chrome.downloads
```

- **Progressive** media is streamed straight to an OPFS file (near-zero heap).
- **HLS fMP4** is concatenated (init + segments) into one OPFS file.
- **HLS MPEG-TS** is transmuxed incrementally; fragment data lives in OPFS via `modules/FSBlob.mjs`.
- **DASH** is muxed with [mediabunny](https://github.com/Vanilagy/mediabunny) into a fragmented MP4
  written to an OPFS `StreamTarget`.
- Segments download with bounded concurrency (default 3) but are written in order.
- **Saving:** the offscreen document creates the final blob URL, then the service worker calls
  `chrome.downloads.download()` and polls its state. This is required because offscreen documents only
  have access to `chrome.runtime`.

## Development

```bash
# Unit tests (41)
npm test                 # or: node --test tests/*.test.mjs

# Syntax check runtime files
for f in core/*.mjs modules/hls2mp4/*.mjs content/*.js page/*.js; do node --check "$f"; done
for f in background.js popup.js offscreen.js; do cp "$f" /tmp/x.mjs && node --check /tmp/x.mjs; done
```

Verified in Chrome 157: the service worker loads (v5.2.0), the save bridge completes, and a progressive
download E2E saved a 256 KB file byte-for-byte with no runtime exceptions. HLS/DASH browser E2E and memory
profiling remain manual.

See `information.md` for architecture, decisions, limitations and handoff notes, and `PLAN.md` for the
roadmap/milestones.

## Project size

The unpacked project is approximately **6 MB**, including the bundled mediabunny source and dist files —
well under the 100 MB sharing target.

## Legal

Only download content you have the right to download, and respect each site's terms of service and
applicable copyright law. DRM circumvention is explicitly out of scope.
