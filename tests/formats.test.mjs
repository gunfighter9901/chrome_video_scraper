import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyUrl, KINDS, mediaKey, sortVariants, parseQuality,
  buildFilename, sanitizeFilename, decideOutputPolicy, codecCompat,
  formatBytes, deviceProfile, isFmp4Segments, isSegmentUrl,
} from '../core/formats.mjs';

test('classifyUrl', () => {
  assert.equal(classifyUrl('https://x/a.m3u8'), KINDS.HLS);
  assert.equal(classifyUrl('https://x/a.m3u8?t=1'), KINDS.HLS);
  assert.equal(classifyUrl('https://x/a.mpd'), KINDS.DASH);
  assert.equal(classifyUrl('https://x/a.mp4'), KINDS.PROGRESSIVE);
  assert.equal(classifyUrl('https://x/seg.ts'), null);
  assert.equal(classifyUrl('https://x/v', 'video/mp4'), KINDS.PROGRESSIVE);
  assert.equal(classifyUrl('https://x/v', 'video/mp2t'), null);
  assert.equal(classifyUrl('https://x/v', 'application/vnd.apple.mpegurl'), KINDS.HLS);
});

test('mediaKey ignores volatile query length but distinguishes hosts', () => {
  const a = mediaKey('https://cdn.example/v/index.m3u8?token=aaaa');
  const b = mediaKey('https://cdn.example/v/index.m3u8?token=bbbb');
  assert.notEqual(a, b);
  assert.ok(mediaKey('https://other.example/v/index.m3u8?tok=1').startsWith('other.example'));
});

test('sortVariants orders by height then bandwidth', () => {
  const sorted = sortVariants([
    { url: 'a', height: 480, bandwidth: 800 },
    { url: 'b', height: 1080, bandwidth: 4000 },
    { url: 'c', height: 1080, bandwidth: 6000 },
  ]);
  assert.deepEqual(sorted.map((v) => v.url), ['c', 'b', 'a']);
});

test('parseQuality', () => {
  assert.equal(parseQuality('1080p'), 1080);
  assert.equal(parseQuality('1280x720'), 720);
  assert.equal(parseQuality(720), 720);
  assert.equal(parseQuality('unknown'), 0);
});

test('filename sanitization', () => {
  assert.equal(sanitizeFilename('a/b:c*d?"e<f>g|h'), 'abcdefgh');
  assert.equal(buildFilename('My Video', { ext: 'mp4', quality: '720p' }), 'My Video [720p].mp4');
});

test('output policy: size threshold and codec compatibility', () => {
  // Already compatible -> remux regardless of size.
  assert.equal(decideOutputPolicy({ sizeBytes: 100 * 1024 * 1024, videoCodec: 'avc1', audioCodec: 'mp4a', thresholdMB: 800 }).mode, 'remux');
  // Small + incompatible + capable device -> transcode.
  assert.equal(decideOutputPolicy({ sizeBytes: 100 * 1024 * 1024, videoCodec: 'hvc1', audioCodec: 'mp4a', thresholdMB: 800, deviceCanTranscode: true }).mode, 'transcode');
  // Large + incompatible -> remux only (CPU safety).
  assert.equal(decideOutputPolicy({ sizeBytes: 900 * 1024 * 1024, videoCodec: 'hvc1', audioCodec: 'mp4a', thresholdMB: 800, deviceCanTranscode: true }).mode, 'remux');
  // Unknown size + incompatible -> remux only.
  assert.equal(decideOutputPolicy({ sizeBytes: 0, videoCodec: 'hvc1', audioCodec: 'mp4a', thresholdMB: 800 }).mode, 'remux');
});

test('codecCompat', () => {
  assert.equal(codecCompat('avc1.4d401f'), true);
  assert.equal(codecCompat('mp4a.40.2'), true);
  assert.equal(codecCompat('hvc1.1.6.L93'), false);
  assert.equal(codecCompat('vp09.00.10.08'), true);
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1048576), '1 MB');
});

test('deviceProfile does not throw outside a browser', () => {
  const p = deviceProfile();
  assert.equal(typeof p.canTranscode, 'boolean');
});

test('fMP4 vs TS segment detection', () => {
  assert.equal(isFmp4Segments([{ url: 'https://x/a.m4s' }]), true);
  assert.equal(isFmp4Segments([{ url: 'https://x/a.ts' }]), false);
  assert.equal(isFmp4Segments([{ url: 'https://x/seg', map: { url: 'https://x/init.mp4' } }]), true);
  assert.equal(isFmp4Segments([]), false);
  assert.equal(isSegmentUrl('https://x/a.m4s'), true);
  assert.equal(isSegmentUrl('https://x/a.mp4'), false);
});
