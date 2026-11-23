import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function exists(rel) {
  try { await access(path.join(root, rel)); return true; } catch { return false; }
}

test('manifest.json is valid MV3 and references existing files', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Universal Video Downloader');
  assert.ok(manifest.background && manifest.background.service_worker, 'has service worker');
  assert.equal(manifest.background.type, 'module');
  assert.ok(await exists(manifest.background.service_worker), 'background file exists');

  for (const perm of ['activeTab', 'scripting', 'storage', 'downloads', 'offscreen']) {
    assert.ok(manifest.permissions.includes(perm), `has permission ${perm}`);
  }
  assert.ok(!manifest.host_permissions, 'no blanket host_permissions in v1');

  assert.ok(await exists(manifest.action.default_popup), 'popup exists');
  for (const size of ['16', '48', '128']) {
    assert.ok(await exists(manifest.icons[size]), `icon ${size} exists`);
  }

  const war = manifest.web_accessible_resources.flatMap((w) => w.resources);
  assert.ok(war.includes('page/sniffer-page.js'));
  assert.ok(war.includes('offscreen.js'));
  assert.ok(await exists('page/sniffer-page.js'));
  assert.ok(await exists('offscreen.html'));
});

test('entry modules and scripts referenced by the build exist', async () => {
  const files = [
    'background.js', 'popup.js', 'offscreen.js', 'offscreen.html', 'popup.html',
    'content/sniffer.js', 'content/panel.js', 'content/button.js',
    'core/messaging.mjs', 'core/hls.mjs', 'core/dash.mjs', 'core/formats.mjs',
    'core/adapters.mjs', 'core/opfs.mjs', 'core/pipeline.mjs',
    'modules/hls2mp4/simple-converter.mjs', 'modules/FSBlob.mjs',
    'modules/mediabunny/dist/bundles/mediabunny.min.mjs',
  ];
  for (const f of files) assert.ok(await exists(f), `missing ${f}`);
});

test('popup.html loads popup.js as a module', async () => {
  const html = await readFile(path.join(root, 'popup.html'), 'utf8');
  assert.match(html, /<script[^>]+type="module"[^>]+src="popup\.js"/);
});

test('manifest does not reference legacy content scripts', async () => {
  const raw = await readFile(path.join(root, 'manifest.json'), 'utf8');
  assert.ok(!raw.includes('background-enhanced.js'));
  assert.ok(!raw.includes('content.js'));
});

test('mediabunny bundle exposes the streaming API used by the downloader', async () => {
  const bundle = path.join(root, 'modules/mediabunny/dist/bundles/mediabunny.min.mjs');
  const src = await readFile(bundle, 'utf8');
  for (const name of ['Mp4OutputFormat', 'StreamTarget', 'EncodedVideoPacketSource', 'EncodedAudioPacketSource', 'EncodedPacketSink']) {
    assert.ok(src.includes(name), `bundle should export ${name}`);
  }
});
