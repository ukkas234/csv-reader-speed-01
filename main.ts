// Driver for this entry: reads every case from $MAKEFUN_INPUT_DIR/cases.json
// (or /input/cases.json), answers each one alone with runJSON() from
// ./solve.js — the same parser as run(), but the answer comes back already
// serialized, so no answers object graph is built and no JSON.stringify pass
// runs over it — and writes $MAKEFUN_OUTPUT_DIR/answers.json (or
// /output/answers.json) as a JSON array of the answers, one per case and in
// the cases' order.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported, so all of
// the parser's work runs under it.
setFlagsFromString('--no-incremental-marking');

const { runJSON } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  runJSON: (input: unknown) => string;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(INPUT_DIR + '/cases.json', 'utf8')) as {
  id: string;
  input: unknown;
}[];

const parts: string[] = [];
for (const c of cases) parts.push(runJSON(c.input));

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(OUTPUT_DIR + '/answers.json', '[' + parts.join(',') + ']');
