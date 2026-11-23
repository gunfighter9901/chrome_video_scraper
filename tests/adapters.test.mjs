import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretPageData, getAdapter, refererFor } from '../core/adapters.mjs';

test('the generic adapter is selected for all URLs', () => {
  assert.equal(getAdapter('https://example.com/video.mp4').id, 'generic');
  assert.equal(getAdapter('https://cdn.example.com/stream/master.m3u8').id, 'generic');
});

test('refererFor falls back to the page URL', () => {
  assert.equal(refererFor('https://cdn.example/x.mp4', 'https://example.com/watch'), 'https://example.com/watch');
  assert.equal(refererFor('https://cdn.example/x.mp4', ''), null);
});

test('interpretPageData extracts flashvars mediaDefinitions', () => {
  const pageData = {
    flashvars: [{
      mediaDefinitions: [
        { format: 'mp4', quality: '720', videoUrl: 'https://cdn.example/videos/123_720p.mp4' },
        { format: 'hls', quality: 'auto', videoUrl: 'https://cdn.example/hls/123/master.m3u8' },
      ],
    }],
    urls: [],
    globals: [],
    meta: { title: 'Example' },
  };
  const out = interpretPageData(pageData, 'https://example.com/watch/123');
  const kinds = out.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['hls', 'progressive']);
  assert.equal(out.length, 2);
});

test('interpretPageData scans nested globals for media urls', () => {
  const pageData = {
    flashvars: [],
    urls: [],
    globals: [{ key: '__NEXT_DATA__', value: { props: { pageProps: { video: { hlsUrl: 'https://cdn.example/stream/master.m3u8' } } } } }],
    meta: {},
  };
  const out = interpretPageData(pageData, 'https://example.com/watch');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'hls');
});

test('interpretPageData ignores raw segments and blobs', () => {
  const pageData = {
    flashvars: [],
    globals: [],
    meta: {},
    urls: [
      { url: 'https://cdn.example/seg-1.ts' },
      { url: 'blob:https://example.com/1234' },
      { url: 'https://cdn.example/movie.mp4' },
    ],
  };
  const out = interpretPageData(pageData, 'https://example.com/');
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://cdn.example/movie.mp4');
});
