
// Tiny test runner. No framework, no dependencies, no network.
//
// Exits non-zero on the first failure count > 0 so a green run means every
// assertion executed, and prints the name of anything that failed rather than a
// bare stack trace.

import { pathToFileURL } from "node:url";

const state = { suite: "", passed: 0, failed: 0, failures: [] };

export function suite(name) {
  state.suite = name;
  process.stdout.write(`\n${name}\n`);
}

export async function test(name, fn) {
  try {
    await fn();
    state.passed++;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    state.failed++;
    state.failures.push({ suite: state.suite, name, err });
    process.stdout.write(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}\n`);
  }
}

export function assert(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}

export function eq(actual, expected, msg = "") {
  if (actual !== expected) {
    throw new Error(`${msg} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`.trim());
  }
}

export function deepEq(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`.trim());
}

export function throws(fn, matcher, msg = "") {
  try {
    fn();
  } catch (err) {
    const text = String(err && err.message ? err.message : err);
    if (matcher && !text.includes(matcher)) throw new Error(`${msg} threw "${text}", wanted match "${matcher}"`.trim());
    return err;
  }
  throw new Error(`${msg} expected a throw, nothing was thrown`.trim());
}

export async function rejects(fn, matcher, msg = "") {
  try {
    await fn();
  } catch (err) {
    const text = String(err && err.message ? err.message : err);
    if (matcher && !text.includes(matcher)) throw new Error(`${msg} rejected with "${text}", wanted match "${matcher}"`.trim());
    return err;
  }
  throw new Error(`${msg} expected a rejection, nothing was thrown`.trim());
}

/**
 * Print the tally only when this file is the process entry point.
 *
 * Without this, every test file imported by the aggregate runner would print its
 * own partial tally, and the last one printed would look like the total. A test
 * suite that reports four totals has not reported anything.
 */
export function finish(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return;
  let entryUrl;
  try {
    entryUrl = pathToFileURL(entry).href;
  } catch {
    return;
  }
  if (entryUrl === importMetaUrl) report();
}

export function report() {
  const total = state.passed + state.failed;
  process.stdout.write(`\n${state.passed}/${total} passed`);
  if (state.failed > 0) {
    process.stdout.write(`, ${state.failed} failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("\n");
  }
  return state;
}
