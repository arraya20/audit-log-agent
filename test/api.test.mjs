
// HTTP contract tests.
//
// The handler is exercised through its real entry points with real Request
// objects. The only thing replaced is the network: a recorded fixture stands in
// for Pharos, so a passing test means the handler produced that response from
// that chain data.
import { suite, test, eq, deepEq, assert, finish } from "./runner.mjs";
import { onRequest, onRequestPost, onRequestGet, onRequestOptions } from "../functions/api/audit.js";
import { replayFetch, loadFixture } from "./helpers/replay.mjs";
import { BUDGET, maxHoursForBudget } from "../src/config.mjs";

const WALLET = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";

async function withChain(fixtureName, fn) {
  const original = globalThis.fetch;
  const fx = loadFixture(fixtureName);
  const fetchImpl = replayFetch(fx);
  globalThis.fetch = fetchImpl;
  try {
    return await fn(fetchImpl, fx);
  } finally {
    globalThis.fetch = original;
  }
}

function post(body, asText = false) {
  return onRequest({
    request: new Request("https://example.test/api/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: asText ? body : JSON.stringify(body),
    }),
  });
}

suite("read-only limits");

await test("GET returns the chain limits the caller needs to size a window", async () => {
  const res = await onRequestGet();
  eq(res.status, 200);
  const body = await res.json();
  eq(body.chain.id, 1672);
  eq(body.window.maxBlocks, BUDGET.maxBlocks);
  assert(body.window.maxHours > 0, "max hours must be advertised");
});

suite("the happy path, against recorded chain data");

await test("a valid request returns the audit with a completeness verdict", async () => {
  await withChain("api", async (fetchImpl) => {
    const res = await post({ wallet: WALLET, hours: "0.01" });
    eq(res.status, 200);
    const body = await res.json();
    eq(body.wallet, WALLET);
    eq(body.completeness, "COMPLETE");
    eq(body.movements.length, 4);
    eq(body.fees.transactions, 2);
    eq(fetchImpl.misses.length, 0, "all chain reads must come from the fixture");
  });
});

await test("the response is JSON-serialisable and carries exact strings, not floats", async () => {
  await withChain("api", async () => {
    const res = await post({ wallet: WALLET, hours: "0.01" });
    const text = await res.text();
    const body = JSON.parse(text);
    const usdc = body.totals.byAsset.find((a) => a.symbol === "USDC");
    assert(typeof usdc.outRaw === "string", "raw amounts must be decimal strings");
    // Recomputed by summing the Transfer logs in the fixture directly: 110364734
    // base units of a six-decimal token. If the pipeline and this number ever
    // disagree, one of them is wrong and the test should stop.
    eq(usdc.outRaw, "110364734");
    eq(usdc.out, "110.364734");
  });
});

await test("a partial audit is a 200 that says so, never a silent empty log", async () => {
  await withChain("api", async (fetchImpl, fx) => {
    const blockKey = "eth_getBlockByNumber:" + JSON.stringify(["0x" + fx.window.fromBlock.toString(16), true]);
    delete fx.requests[blockKey];
    const res = await post({ wallet: WALLET, hours: "0.01" });
    eq(res.status, 200);
    const body = await res.json();
    eq(body.completeness, "PARTIAL");
    assert(body.reasons.length > 0, "a partial report must state why");
  });
});

await test("accepts an explicit date range (from/to) and resolves the matching block window", async () => {
  await withChain("api", async (fetchImpl) => {
    // Head block 0x1522434 in api.json has timestamp 0x6aec23b9 (1793860537);
    // a 36-second window (0.01h) resolves to the 34-block fixture [22160403..22160436].
    const res = await post({
      wallet: WALLET,
      from: new Date(1793860501 * 1000).toISOString(),
      to: new Date(1793860537 * 1000).toISOString(),
    });
    eq(res.status, 200);
    const body = await res.json();
    eq(body.wallet, WALLET);
    eq(body.completeness, "COMPLETE");
    eq(body.movements.length, 4);
    eq(fetchImpl.misses.length, 0);
  });
});

await test("exports markdown and csv when requested via query format parameter", async () => {
  await withChain("api", async () => {
    const mdRes = await onRequest({
      request: new Request("https://example.test/api/audit?format=markdown", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: WALLET, hours: "0.01" }),
      }),
    });
    eq(mdRes.status, 200);
    assert(mdRes.headers.get("content-type").includes("text/markdown"), "markdown content-type expected");
    const mdText = await mdRes.text();
    assert(mdText.includes("# Wallet Activity Audit Report"), "markdown title expected");

    const csvRes = await onRequest({
      request: new Request("https://example.test/api/audit?format=csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: WALLET, hours: "0.01" }),
      }),
    });
    eq(csvRes.status, 200);
    assert(csvRes.headers.get("content-type").includes("text/csv"), "csv content-type expected");
    const csvText = await csvRes.text();
    assert(csvText.includes("TRANSFERS_OUT,TOKEN_OUT,true"), "csv movement row expected");
  });
});

await test("rejects invalid or conflicting date ranges", async () => {
  const both = await post({ wallet: WALLET, hours: "0.01", from: "2026-11-05T06:00:00Z", to: "2026-11-05T06:15:00Z" });
  eq(both.status, 400);
  eq((await both.json()).error.code, "INVALID_DATE_RANGE");

  const inverted = await post({ wallet: WALLET, from: "2026-11-05T06:15:00Z", to: "2026-11-05T06:00:00Z" });
  eq(inverted.status, 400);
  eq((await inverted.json()).error.code, "INVALID_DATE_RANGE");

  const half = await post({ wallet: WALLET, from: "2026-11-05T06:00:00Z" });
  eq(half.status, 400);
  eq((await half.json()).error.code, "INVALID_DATE_RANGE");
});

suite("request validation");

await test("a caller-supplied transaction list is refused, not ignored", async () => {
  const res = await post({ wallet: WALLET, transactions: [{ hash: "0x1" }] });
  eq(res.status, 400);
  const body = await res.json();
  eq(body.error.code, "UNKNOWN_FIELD");
  assert(body.error.message.includes("transactions"), "the message should name the rejected field");
});

await test("a caller cannot supply categories, amounts or a verdict", async () => {
  for (const extra of [{ categories: [] }, { amountRaw: "1" }, { verdict: "CLEAN" }, { policy: {} }]) {
    const res = await post({ wallet: WALLET, ...extra });
    eq(res.status, 400, "expected rejection for " + JSON.stringify(Object.keys(extra)));
    eq((await res.json()).error.code, "UNKNOWN_FIELD");
  }
});

await test("a malformed wallet is rejected before any chain call", async () => {
  for (const wallet of ["", "0x123", "1f3546a29eec2102c8d52e21a45114124014c85c", "0xzz3546a29eec2102c8d52e21a45114124014c85c", null, 42]) {
    const res = await post({ wallet });
    eq(res.status, 400, "expected rejection for " + String(wallet));
    eq((await res.json()).error.code, "INVALID_WALLET");
  }
});

await test("hours are parsed strictly, so a typo cannot become a different window", async () => {
  for (const hours of ["0.25h", "1e3", "-1", "0", "", "abc", "0.2.5", {}]) {
    const res = await post({ wallet: WALLET, hours });
    eq(res.status, 400, "expected rejection for hours=" + JSON.stringify(hours));
    eq((await res.json()).error.code, "INVALID_HOURS");
  }
});

await test("a window beyond the budget is refused with the real cost", async () => {
  const res = await post({ wallet: WALLET, hours: 24 });
  eq(res.status, 400);
  const body = await res.json();
  eq(body.error.code, BUDGET.windowTooLarge);
  assert(body.error.detail.requestedBlocks > BUDGET.maxBlocks, "the refusal must state the block count");
  eq(body.error.detail.maxBlocks, BUDGET.maxBlocks);
  assert(body.error.detail.maxHours > 0, "the refusal must state what is possible");
});

await test("the advertised maximum is actually servable", async () => {
  // A limit that the endpoint then refuses would be worse than no limit.
  const res = await post({ wallet: WALLET, hours: maxHoursForBudget() });
  assert(res.status !== 400, "the advertised maximum must not be rejected");
});

await test("a non-JSON body is rejected instead of being coerced", async () => {
  const res = await post("not json at all", true);
  eq(res.status, 400);
  eq((await res.json()).error.code, "INVALID_JSON");
});

await test("an array body is rejected", async () => {
  const res = await post([{ wallet: WALLET }]);
  eq(res.status, 400);
  eq((await res.json()).error.code, "INVALID_BODY");
});

suite("transport failure is not an empty audit");

await test("an unreachable node is a 502, never a report with no activity", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network unreachable");
  };
  try {
    const res = await post({ wallet: WALLET, hours: "0.01" });
    eq(res.status, 502);
    const body = await res.json();
    assert(body.error, "an error body is required");
    assert(!("movements" in body), "a failed audit must not return a report shape");
  } finally {
    globalThis.fetch = original;
  }
});

suite("methods and CORS");

await test("an unsupported method is a 405 that names what is allowed", async () => {
  const res = await onRequest({ request: new Request("https://example.test/api/audit", { method: "DELETE" }) });
  eq(res.status, 405);
  assert(res.headers.get("allow").includes("POST"), "the Allow header must list POST");
});

await test("the preflight promise is actually delivered on real responses", async () => {
  // The bug this catches: OPTIONS advertising a CORS policy that POST and GET
  // never send, which passes preflight and then fails in the browser.
  const pre = await onRequestOptions();
  const promised = pre.headers.get("access-control-allow-origin");
  assert(promised, "the preflight must state an origin policy");

  await withChain("api", async () => {
    const postRes = await post({ wallet: WALLET, hours: "0.01" });
    eq(postRes.headers.get("access-control-allow-origin"), promised, "POST must match the preflight");
  });

  const getRes = await onRequestGet();
  eq(getRes.headers.get("access-control-allow-origin"), promised, "GET must match the preflight");
});

await test("audit responses are not cached, because they describe a moving chain", async () => {
  await withChain("api", async () => {
    const res = await post({ wallet: WALLET, hours: "0.01" });
    eq(res.headers.get("cache-control"), "no-store");
  });
});

finish(import.meta.url);
