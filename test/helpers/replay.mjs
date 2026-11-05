import { readFileSync } from "node:fs";

// Replay a recorded fixture as a fake fetch.
//
// Missing keys are reported rather than silently returning empty data: a fixture
// miss means the test is no longer exercising the code path it claims to, which
// is exactly the kind of quiet drift a green suite hides.

export function replayFetch(fixture) {
  const misses = [];
  const served = new Map();

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const items = Array.isArray(body) ? body : [body];
    const out = items.map((it) => {
      const key = it.method + ":" + JSON.stringify(it.params ?? []);
      const rec = fixture.requests[key];
      if (!rec) {
        misses.push(key);
        return { jsonrpc: "2.0", id: it.id, error: { code: -32000, message: "fixture miss: " + key } };
      }
      served.set(key, (served.get(key) ?? 0) + 1);
      if (rec.error) return { jsonrpc: "2.0", id: it.id, error: rec.error };
      return { jsonrpc: "2.0", id: it.id, result: rec.result };
    });
    const payload = Array.isArray(body) ? out : out[0];
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };

  fetchImpl.misses = misses;
  fetchImpl.served = served;
  return fetchImpl;
}

export function loadFixture(name) {
  // Read at call time so a missing fixture is a test failure, not a load crash.
  const url = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}
