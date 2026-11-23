import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMpd, parseIsoDuration, looksLikeDash } from '../core/dash.mjs';

test('parseIsoDuration', () => {
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('PT10S'), 10);
  assert.equal(parseIsoDuration('PT1M30.5S'), 90.5);
});

test('looksLikeDash', () => {
  assert.equal(looksLikeDash('https://x/v/manifest.mpd?t=1'), true);
  assert.equal(looksLikeDash('https://x/v/index.m3u8'), false);
});

test('SegmentTemplate expands segments and init', () => {
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f">
      <SegmentTemplate initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number$.m4s" timescale="1" duration="2" startNumber="1"/>
      <Representation id="v0" bandwidth="1000000" width="1280" height="720"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  const p = parseMpd(xml, 'https://cdn.example/mpd/manifest.mpd');
  assert.equal(p.duration, 10);
  assert.equal(p.representations.length, 1);
  const rep = p.representations[0];
  assert.equal(rep.type, 'video');
  assert.equal(rep.height, 720);
  assert.equal(rep.initUrl, 'https://cdn.example/mpd/v0/init.mp4');
  assert.equal(rep.segments.length, 5);
  assert.equal(rep.segments[0].url, 'https://cdn.example/mpd/v0/seg-1.m4s');
  assert.equal(rep.segments[4].url, 'https://cdn.example/mpd/v0/seg-5.m4s');
});

test('SegmentList and DRM ContentProtection', () => {
  const xml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="v1" bandwidth="500000" width="640" height="360">
        <SegmentList>
          <Initialization sourceURL="init.mp4"/>
          <SegmentURL media="s1.m4s"/>
          <SegmentURL media="s2.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const p = parseMpd(xml, 'https://cdn.example/dash/manifest.mpd');
  assert.equal(p.drm, true);
  const rep = p.representations[0];
  assert.equal(rep.initUrl, 'https://cdn.example/dash/init.mp4');
  assert.equal(rep.segments.length, 2);
  assert.equal(rep.segments[1].url, 'https://cdn.example/dash/s2.m4s');
});
