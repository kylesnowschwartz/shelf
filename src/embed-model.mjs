// Local sentence-embedding model (MiniLM via transformers.js). Runs entirely
// offline after the one-time model download — no API key, no per-call cost.
// Also owns how a book/candidate becomes embeddable text, so `embed` and any
// future re-embed share one definition of "the text that represents this book".
import { createHash } from 'node:crypto';

let _embed = null;

/** Lazy-load the pipeline once. The `why` field and subjects carry the signal. */
async function pipe() {
  if (_embed) return _embed;
  const { pipeline, env } = await import('@xenova/transformers');
  env.allowLocalModels = false; // always use the cached HF download, not a local path
  _embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return _embed;
}

/** Embed one string → plain number[] (mean-pooled, L2-normalized, 384-dim). */
export async function embedText(text) {
  const model = await pipe();
  const out = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

/** Text representing a read book: title + the editorial `why` + fine tags. */
export const readText = (b) =>
  [b.t, b.why, (b.s || []).join(', '), (b.b || []).join(', ')].filter(Boolean).join('. ');

/** Text representing a candidate: title + blurb/first-sentence + subjects. */
export const candText = (c) =>
  [c.t, c.firstSentence, (c.subjects || []).slice(0, 6).join(', ')].filter(Boolean).join('. ');

/** Short stable hash so the cache only re-embeds when the text actually changes. */
export const textHash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);
