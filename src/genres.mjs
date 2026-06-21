// The canonical genre vocabulary for the shelf. This MUST stay in lockstep with
// the consumer website's content-collection `z.enum(...)` build-gate — a genre
// the website's Zod schema rejects will fail `astro build` after `shelf export`.
// One constant here so `add`'s validation and `next`'s filtering can't drift.
export const GENRES = ['SFF', 'Thriller', 'Horror', 'Literary', 'Nonfiction'];
