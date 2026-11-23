import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderedPipeline, mapLimit } from '../core/pipeline.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('orderedPipeline delivers results in input order despite out-of-order completion', async () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  const delivered = [];
  await orderedPipeline(items, 3, async (n) => {
    await sleep((items.length - n) * 3); // earlier items take longer
    return `r${n}`;
  }, (value) => { delivered.push(value); });
  assert.deepEqual(delivered, items.map((n) => `r${n}`));
});

test('orderedPipeline never exceeds the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  await orderedPipeline([...Array(20).keys()], 4, async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(5);
    active--;
    return 1;
  }, () => {});
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
  assert.ok(peak >= 3, `expected some parallelism, got ${peak}`);
});

test('orderedPipeline handles empty and single-item inputs', async () => {
  const empty = [];
  await orderedPipeline(empty, 3, async () => 1, () => { assert.fail('should not run'); });
  const single = [];
  await orderedPipeline([42], 3, async (n) => n, (v) => single.push(v));
  assert.deepEqual(single, [42]);
});

test('orderedPipeline propagates worker errors', async () => {
  await assert.rejects(
    orderedPipeline([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }, () => {}),
    /boom/,
  );
});

test('mapLimit returns results in order', async () => {
  const out = await mapLimit([5, 4, 3, 2, 1], 3, async (n) => {
    await sleep(n * 2);
    return n * 10;
  });
  assert.deepEqual(out, [50, 40, 30, 20, 10]);
});
