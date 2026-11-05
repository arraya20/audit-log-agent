// Aggregate entry point for `npm test`.
//
// Each test file is imported in order and prints its own progress; a single
// tally is printed at the end. Files check whether they are the entry point
// before printing a total, so running one directly still reports one number.
//
// Order matters: the cheapest and most deterministic suites run first, so a
// broken decoder fails in under a second instead of after the chain fixtures.
import "./unit.test.mjs";
import "./classify.test.mjs";
import "./transport.test.mjs";
import "./report.test.mjs";
import "./api.test.mjs";

import { report } from "./runner.mjs";

const state = report();
if (state.failed > 0) {
  process.stdout.write("\nfailed:\n");
  for (const f of state.failures) {
    process.stdout.write(`  ${f.suite} :: ${f.name}\n    ${f.err && f.err.message ? f.err.message : f.err}\n`);
  }
}
