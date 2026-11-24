import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3U8, parseAttributes, resolveUrl, pickBestVariant } from '../core/hls.mjs';

test('parseAttributes handles quoted values with commas', () => {
  const a = parseAttributes('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720');
  assert.equal(a.BANDWIDTH, '1280000');
  assert.equal(a.CODECS, 'avc1.4d401f,mp4a.40.2');
  assert.equal(a.RESOLUTION, '1280x720');
});

test('resolveUrl inherits signed query for relative segments', () => {
  const out = resolveUrl('https://cdn.example/hls/index.m3u8?token=abc', 'seg1.ts');
  assert.equal(out, 'https://cdn.example/hls/seg1.ts?token=abc');
});

test('parses a master playlist with variants and audio renditions', () => {
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"',
    '360/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,CODECS="avc1.4d401f,mp4a.40.2"',
    '1080/index.m3u8',
  ].join('\n');
  const p = parseM3U8(m3u8, 'https://cdn.example/hls/master.m3u8?sig=xyz');
  assert.equal(p.isMaster, true);
  assert.equal(p.variants.length, 2);
  assert.equal(p.audioRenditions.length, 1);
  assert.equal(p.audioRenditions[0].uri, 'https://cdn.example/hls/audio/en.m3u8?sig=xyz');
  const v1080 = p.variants.find((v) => v.height === 1080);
  assert.equal(v1080.url, 'https://cdn.example/hls/1080/index.m3u8?sig=xyz');
  assert.equal(v1080.bandwidth, 2000000);
  assert.equal(v1080.videoCodec, 'avc1.4d401f');
  assert.equal(v1080.audioCodec, 'mp4a.40.2');
});

test('parses a media playlist with durations and byte ranges', () => {
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:10',
    '#EXTINF:6.000,',
    '#EXT-X-BYTERANGE:1000@0',
    's1.m4s?tok=1',
    '#EXTINF:4.500,',
    's2.m4s?tok=1',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const p = parseM3U8(m3u8, 'https://cdn.example/media.m3u8');
  assert.equal(p.isMedia, true);
  assert.equal(p.live, false);
  assert.equal(p.segments.length, 2);
  assert.equal(p.segments[0].sequence, 10);
  assert.equal(p.segments[0].byteRange.length, 1000);
  assert.equal(p.segments[1].duration, 4.5);
  assert.equal(p.totalDuration, 10.5);
});

test('detects DRM and EXT-X-MAP init segments', () => {
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:2,',
    'seg1.m4s',
  ].join('\n');
  const p = parseM3U8(m3u8, 'https://cdn.example/v/index.m3u8');
  assert.equal(p.drm, true);
  assert.deepEqual(p.drmMethods, ['SAMPLE-AES']);
  assert.equal(p.initSegment, 'https://cdn.example/v/init.mp4');
  assert.equal(p.segments[0].map.url, 'https://cdn.example/v/init.mp4');
});

test('pickBestVariant respects the height cap', () => {
  const variants = [{ url: 'a', height: 1080 }, { url: 'b', height: 720 }, { url: 'c', height: 480 }];
  assert.equal(pickBestVariant(variants, 720).url, 'b');
  assert.equal(pickBestVariant(variants, 0).url, 'a');
});

test('implicit byte ranges continue after the previous range', () => {
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXTINF:4,',
    '#EXT-X-BYTERANGE:1000',
    'main.ts',
    '#EXTINF:4,',
    '#EXT-X-BYTERANGE:500',
    'main.ts',
    '#EXTINF:4,',
    '#EXT-X-BYTERANGE:250@5000',
    'main.ts',
  ].join('\n');
  const p = parseM3U8(m3u8, 'https://cdn.example/media.m3u8');
  assert.equal(p.segments[0].byteRange.offset, 0);
  assert.equal(p.segments[1].byteRange.offset, 1000);
  assert.equal(p.segments[2].byteRange.offset, 5000);
});

test('a media playlist without ENDLIST is flagged live', () => {
  const m3u8 = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXTINF:4,', 's1.ts'].join('\n');
  const p = parseM3U8(m3u8, 'https://cdn.example/live.m3u8');
  assert.equal(p.live, true);
});
