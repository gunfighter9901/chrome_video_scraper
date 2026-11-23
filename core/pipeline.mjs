// core/pipeline.mjs
// Small, dependency-free concurrency helpers used by the offscreen downloader.

/**
 * Run `worker(item, index)` with bounded concurrency, but deliver results to `onResult` strictly
 * in input order. This lets segments download in parallel while being muxed/written in sequence,
 * which is required for correct container output.
 *
 * At most `concurrency` results are buffered at once (one per runner), so memory stays bounded
 * even when the head-of-line item is slow.
 *
 * @template T,R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {(result: R, index: number) => Promise<void>|void} onResult
 */
export async function orderedPipeline(items, concurrency, worker, onResult) {
  const list = items || [];
  const results = new Map();
  let nextToFetch = 0;
  let nextToDeliver = 0;
  const limit = Math.max(1, Math.floor(concurrency) || 1);

  // Serialize ordered delivery: multiple runners may finish concurrently, but
  // onResult (writer.write / transmux push) must never run concurrently or
  // out of order or the MP4 will be corrupt. Chain drains through one promise.
  let drainChain = Promise.resolve();
  const drain = () => {
    const runDrain = async () => {
      while (results.has(nextToDeliver)) {
        const value = results.get(nextToDeliver);
        results.delete(nextToDeliver);
        const index = nextToDeliver;
        nextToDeliver++;
        await onResult(value, index);
      }
    };
    drainChain = drainChain.then(runDrain, runDrain);
    return drainChain;
  };

  const run = async () => {
    while (true) {
      const index = nextToFetch++;
      if (index >= list.length) return;
      const value = await worker(list[index], index);
      results.set(index, value);
      await drain();
    }
  };

  const runners = [];
  for (let c = 0; c < limit; c++) runners.push(run());
  await Promise.all(runners);
  await drainChain;
}

/**
 * Map with bounded concurrency, returning results in input order.
 * @template T,R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, concurrency, worker) {
  const out = new Array((items || []).length);
  await orderedPipeline(items, concurrency, worker, (value, index) => { out[index] = value; });
  return out;
}
