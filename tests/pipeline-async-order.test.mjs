import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderedPipeline } from '../core/pipeline.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Regression for the orderedPipeline race: concurrent runners used to invoke
// async onResult concurrently, corrupting ordered writes (fMP4/TS mux).
test('orderedPipeline serializes async onResult in order', async () => {
  const items = [...Array(12).keys()];
  const entered = [];
  const exited = [];
  let concurrent = 0;
  let peak = 0;
  await orderedPipeline(items, 4, async (n) => {
    await sleep(Math.random() * 10);
    return n;
  }, async (value, index) => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    entered.push(index);
    assert.equal(value, index);
    await sleep(5); // simulate writer.write latency
    exited.push(index);
    concurrent--;
  });
  assert.deepEqual(entered, items);
  assert.deepEqual(exited, items);
  assert.equal(peak, 1);
});
