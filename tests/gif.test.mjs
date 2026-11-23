import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeGif, gifKindFor, gifExtensionFor, gifKey,
  interpretGifPageData, interpretGifGlobals, mergeGifCandidates,
  GIF_PLUGIN_ID,
} from '../core/gifPlugin.mjs';
import { KINDS, classifyUrl, extensionForVariant, variantLabel } from '../core/formats.mjs';

test('gif plugin id is stable', () => {
  assert.equal(GIF_PLUGIN_ID, 'global-gif-scrape');
});

test('looksLikeGif detects gif/webp by url and content-type', () => {
  assert.equal(looksLikeGif('https://x/a.gif'), true);
  assert.equal(looksLikeGif('https://x/a.gif?token=abc'), true);
  assert.equal(looksLikeGif('https://x/a.webp'), true);
  assert.equal(looksLikeGif('https://x/a.mp4'), false);
  assert.equal(looksLikeGif('https://x/v', 'image/gif'), true);
  assert.equal(looksLikeGif('https://x/v', 'image/webp'), true);
  assert.equal(looksLikeGif('https://x/v', 'video/mp4'), false);
  assert.equal(looksLikeGif('blob:https://x/123'), false);
  assert.equal(looksLikeGif('data:image/gif;base64,AAA'), false);
  assert.equal(looksLikeGif('https://x/a.ts'), false);
});

test('classifyUrl routes gifs to GIF kind', () => {
  assert.equal(classifyUrl('https://x/a.gif'), KINDS.GIF);
  assert.equal(classifyUrl('https://x/a.webp'), KINDS.GIF);
  assert.equal(classifyUrl('https://x/v', 'image/gif'), KINDS.GIF);
  assert.equal(gifKindFor('https://x/a.gif'), KINDS.GIF);
  assert.equal(gifKindFor('https://x/a.mp4'), null);
});

test('gif extension follows url/mime', () => {
  assert.equal(extensionForVariant({ kind: KINDS.GIF, url: 'https://x/a.gif' }), 'gif');
  assert.equal(extensionForVariant({ kind: KINDS.GIF, url: 'https://x/a.webp' }), 'webp');
  assert.equal(extensionForVariant({ kind: KINDS.GIF, url: 'https://x/a', mimeType: 'image/gif' }), 'gif');
  assert.equal(gifExtensionFor('https://x/a.gif'), 'gif');
});

test('variantLabel for gif', () => {
  assert.match(variantLabel({ kind: KINDS.GIF, label: 'GIF' }), /GIF/);
});

test('gifKey dedupes by host+path (query-insensitive)', () => {
  assert.equal(gifKey('https://c/x/a.gif?t=1'), gifKey('https://c/x/a.gif?t=2'));
  assert.notEqual(gifKey('https://a/x/a.gif'), gifKey('https://b/x/a.gif'));
});

test('interpretGifPageData picks urls + og:image gif', () => {
  const out = interpretGifPageData({
    urls: [{ url: 'https://x/a.gif', initiator: 'inline-script' }, { url: 'https://x/b.mp4' }],
    meta: { title: 't', ogImage: 'https://x/og.gif' },
  });
  const urls = out.map((c) => c.url);
  assert.ok(urls.includes('https://x/a.gif'));
  assert.ok(urls.includes('https://x/og.gif'));
  assert.ok(!urls.includes('https://x/b.mp4'));
});

test('interpretGifPageData ignores segments and blobs', () => {
  const out = interpretGifPageData({
    urls: ['https://x/a.ts', 'blob:https://x/1', 'https://x/a.gif'],
  });
  assert.deepEqual(out.map((c) => c.url), ['https://x/a.gif']);
});

test('interpretGifGlobals hunts nested gif strings (bounded)', () => {
  const out = interpretGifGlobals([
    { key: '__NEXT_DATA__', value: { gallery: [{ src: 'https://x/1.gif' }, { src: 'https://x/v.mp4' }] } },
  ]);
  assert.ok(out.some((c) => c.url === 'https://x/1.gif'));
  assert.ok(!out.some((c) => c.url === 'https://x/v.mp4'));
});

test('mergeGifCandidates dedupes across sources', () => {
  const out = mergeGifCandidates({
    pageUrls: ['https://x/a.gif'],
    domUrls: [{ url: 'https://x/a.gif?sig=1' }],
    perfUrls: [],
    pageData: { urls: [], meta: {} },
    globals: [],
  });
  // Same host+path collapses to one entry.
  assert.equal(out.length, 1);
});
