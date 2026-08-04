// Bounded parallelism for the network-bound phases of the pipeline. A fetch run
// issues a hundred-odd Open Library queries that each take on the order of
// fifteen seconds, so running them one after another spends almost the whole
// wall clock waiting on a socket. Overlapping them turns that sum into a
// maximum, while the per-host pacing in http.mjs keeps the request rate polite.

/**
 * Runs `task` over every item with at most `limit` in flight, returning results
 * in INPUT order regardless of completion order — the pipeline's output must
 * not depend on which query happened to answer first.
 *
 * A task that rejects propagates, so a caller wanting per-item isolation
 * catches inside its own task function.
 */
export async function mapWithConcurrency(items, limit, task) {
  const list = [...items];
  const results = new Array(list.length);
  if (list.length === 0) return results;

  const width = Math.max(1, Math.min(limit, list.length));
  let next = 0;

  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= list.length) return;
      results[index] = await task(list[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
