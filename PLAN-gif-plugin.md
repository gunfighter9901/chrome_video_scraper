# GIF Scrape Global Plugin — Plan + Implementation Notes

## Goal
Detect downloadable GIFs / animated WebP on any site (Giphy, Tenor, boards,
meme pages, avatars, stickers) and download them as-is via the existing
progressive OPFS path. Zero site-specific code; additive only.

## Design (global plugin, not adapter fork)
- New `KINDS.GIF` in `core/formats.mjs`. `classifyUrl()` routes `.gif`/`.webp`
  + `image/gif`/`image/webp` to GIF. `extensionForVariant()` preserves
  `gif/webp/apng`, `variantLabel()` shows `GIF`.
- New pure module `core/gifPlugin.mjs` (`gifPlugin.id = global-gif-scrape`):
  - `looksLikeGif(url, ct)`, `gifKindFor()`, `gifExtensionFor()`, `gifKey()`
    (host+path dedupe, query-insensitive for signed URLs).
  - `interpretGifPageData()` — explicit `pageData.urls` + `og:image` /
    `twitter:image` + flashvars strings.
  - `interpretGifGlobals()` — bounded recursive hunt (`depth<=5`,
    `<=150 keys`, `<=50 globals`, `<=200 urls`) for `https://...gif|webp`.
  - `mergeGifCandidates()` — merges page/dom/perf + pagedata + globals.
- Wired into `core/adapters.mjs::interpretPageData()` (GIF-first branch,
  `og:image`/`twitter:image`, hunt keys `gif|image|poster|srcset`).
- `content/sniffer.js`: `GIF_RE`, `classify()` gif branch, `<img>` + `srcset`
  + `video[poster]` + bounded CSS `background-image` (300 nodes) + `og:image`
  meta + `a[href*.gif]`.
- `page/sniffer-page.js`: `GIF_RE`, `looksMedia()` gif branch, inline-script
  regex `+gif|webp|apng`, `collectMeta()` `ogImage`/`twitterImage`, `fullScan()`
  `<img>` sweep (150), `scanDom()` img + `a[href*.gif]`.
- `background.js`: `mergeCandidates()` += `mergeGifCandidates()` (dedupe by
  `gifKey` for GIF, `mediaKey` otherwise), `buildItems()` += `buildGifItem()`
  (single-variant, no manifest probe, probe failure non-fatal),
  `baseItem()` adapter=`global-gif-scrape` for GIF, job += `sizeBytes/mimeType`.
- `offscreen.js`: `processJob()` GIF → `downloadProgressive()` (no remux),
  `streamDirectToWriter()` GIF Accept `image/gif,image/webp,image/*`.
- `popup.js`: badge `GIF`.

## Why this shape
- GIFs are single files: reuse progressive OPFS streaming (near-zero heap),
  relay fallback, and `chrome.downloads` save bridge unchanged.
- Pure plugin module → testable in Node, runnable in SW.
- Query-insensitive `gifKey` prevents 20 duplicates of the same meme with
  different `?token=`.

## Limits (intentional)
- No GIF→MP4 transcode, no resize, no multi-GIF batch zip (M3 candidates).
- Static `.webp` currently surfaces as GIF (downloadable, correctly labeled
  WEBP) — acceptable over missing animated stickers.
- `data:`/`blob:` GIFs (canvas-generated) not downloadable (no URL to fetch).

## Verification
- `npm test` — 52/52 (41 existing + 10 gif + 1 pipeline-race regression).
- `node --check` all `core/*.mjs`, `content/*.js`, `page/*.js`,
  `background/popup/offscreen`.
- Manual: Giphy/Tenor search → popup lists GIF → Download saves `.gif`
  byte-identical; Rescan after scroll picks lazy `<img data-src>`.

## Two fixed issues (from code review)
1. **`orderedPipeline` async `onResult` race (high)** — `core/pipeline.mjs`.
   Concurrent runners both entered `drain()` and ran `writer.write()` /
   `converter.pushSegment()` concurrently out of order → corrupt fMP4/TS.
   Fix: chain drains through `drainChain` promise so delivery is strictly
   serial + in order. Regression test
   `tests/pipeline-async-order.test.mjs` asserts `peak==1` and order with
   async writer latency.
2. **Progressive/GIF progress stuck at 50%** — `background.js` built
   `variant.sizeBytes` from HEAD probe but never copied it to `job`.
   `offscreen.js::streamDirectToWriter` read `job.sizeBytes||0` → always 0
   when server omits `content-length`. Fix: `job.sizeBytes/mimeType` set in
   `startDownload()`; offscreen uses it as `total` fallback + gradual
   progress when total unknown.
