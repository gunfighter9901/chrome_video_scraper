import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

test('offscreen never calls chrome.downloads (only chrome.runtime is available there)', async () => {
  const src = await read('offscreen.js');
  assert.ok(!/chrome\.downloads\s*\./.test(src), 'offscreen.js must delegate downloads to the service worker');
});

test('service worker owns the chrome.downloads save bridge', async () => {
  const src = await read('background.js');
  assert.match(src, /MSG\.SAVE_FILE/);
  assert.match(src, /MSG\.SAVE_STATUS/);
  assert.match(src, /chrome\.downloads\.download/);
  assert.match(src, /chrome\.downloads\.search/);
});

test('offscreen creates blob URLs and requests a save through messaging', async () => {
  const src = await read('offscreen.js');
  assert.match(src, /URL\.createObjectURL/);
  assert.match(src, /MSG\.SAVE_FILE/);
  assert.match(src, /MSG\.SAVE_STATUS/);
});
