// Transport and degradation tests.
//
// The whole design leans on two things that had no direct test: that a 429 is
// retried and then raised rather than swallowed, and that a chunk which dies
// after retries becomes a declared gap instead of killing the audit. A recorded
// fixture cannot exercise either — it replays successful answers.

import { suite, test, eq, deepEq, assert, finish } from "./runner.mjs";
import { createRpc, RpcError } from "../src/rpc.mjs";
import { scanBlocks, scanLogs, scanReceipts, resolveTokenMeta } from "../src/scan.mjs";

suite("transport");

const noSleep = async () => {};
const url = "https://rpc.invalid";

function rpcWith(handler, opts = {}) {
  let calls = 0;
  const rpc = createRpc({
    url,
    fetchImpl: async (_url, init) => {
      calls++;
      return handler(JSON.parse(init.body), calls);
    },
    sleep: noSleep,
    ...opts,
  });
  return { rpc, attempts: () => calls };
}

const json = (status, body) => ({ status, text: async () => JSON.stringify(body), ok: status === 200 });

await test("a throttled request is retried and then succeeds", async () => {
  const { rpc, attempts } = rpcWith((_body, n) =>
    n < 3 ? json(429, { error: { message: "slow down" } }) : json(200, { jsonrpc: "2.0", id: 1, result: "0x2a" }),
  );
  eq(await rpc.call("eth_blockNumber", []), "0x2a");
  eq(attempts(), 3, "two throttles, then the answer");
  eq(rpc.stats.throttled, 2);
});

await test("a throttle that never clears is raised, not swallowed", async () => {
  const { rpc, attempts } = rpcWith(() => json(429, { error: { message: "slow down" } }), { retries: 3 });
  let caught = null;
  try {
    await rpc.call("eth_blockNumber", []);
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof RpcError, "a failed read must throw, never return a value");
  eq(caught.code, "THROTTLED");
  eq(attempts(), 4, "the first try plus three retries");
});

await test("a client error is not retried", async () => {
  const { rpc, attempts } = rpcWith(() => json(400, { error: { message: "bad request" } }));
  let code = null;
  try {
    await rpc.call("eth_getLogs", [{}]);
  } catch (err) {
    code = err.code;
  }
  eq(code, "HTTP_STATUS");
  eq(attempts(), 1, "retrying a 400 only wastes the caller's time");
});

await test("a batch keeps per-item failures instead of collapsing them", async () => {
  const { rpc } = rpcWith(() =>
    json(200, [
      { jsonrpc: "2.0", id: 1, result: "0x1" },
      { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "execution reverted" } },
    ]),
  );
  const out = await rpc.batch([
    { method: "eth_call", params: [{ to: "0x1", data: "0x" }] },
    { method: "eth_call", params: [{ to: "0x2", data: "0x" }] },
  ]);
  deepEq(out[0], { ok: true, value: "0x1" });
  eq(out[1].ok, false);
  eq(out[1].code, -32000);
});

await test("a batch item the node never answered is a failure, not an empty value", async () => {
  const { rpc } = rpcWith(() => json(200, [{ jsonrpc: "2.0", id: 1, result: "0x1" }]));
  const out = await rpc.batch([
    { method: "eth_call", params: [] },
    { method: "eth_call", params: [] },
  ]);
  eq(out[1].ok, false);
  eq(out[1].code, "MISSING");
});

await test("a node that refuses the whole batch with a throttle code is retried", async () => {
  const { rpc, attempts } = rpcWith((_body, n) =>
    n === 1
      ? json(200, { jsonrpc: "2.0", id: 1, error: { code: -32011, message: "limit exceeded" } })
      : json(200, [{ jsonrpc: "2.0", id: 1, result: "0x9" }]),
  );
  const out = await rpc.batch([{ method: "eth_blockNumber", params: [] }]);
  eq(out[0].value, "0x9");
  eq(attempts(), 2);
});

// --- scanner degradation -------------------------------------------------------

const deadRpc = {
  async batch() {
    throw new RpcError("THROTTLED", "http 429", { retryable: true, status: 429 });
  },
};

await test("a dead block scan becomes a gap over its range, not an exception", async () => {
  const out = await scanBlocks(deadRpc, { fromBlock: 100, toBlock: 149, wallet: "0x0000000000000000000000000000000000000000" });
  eq(out.gaps.length, 1);
  eq(out.gaps[0].stage, "blocks");
  eq(out.gaps[0].fromBlock, 100);
  eq(out.gaps[0].toBlock, 149, "one gap for the range, not one per block");
  assert(out.gaps[0].reason.includes("THROTTLED"), "the reason names the failure");
  eq(out.txs.length, 0);
});

await test("a dead log scan declares a gap per query it could not run", async () => {
  const out = await scanLogs(deadRpc, { fromBlock: 100, toBlock: 149, wallet: "0x0000000000000000000000000000000000000000" });
  eq(out.gaps.length, 4, "four queries cover transfers in, out and both approval kinds");
  for (const g of out.gaps) eq(g.stage, "logs");
});

await test("a dead receipt scan becomes a gap rather than a missing receipt treated as success", async () => {
  const out = await scanReceipts(deadRpc, { blockNumbers: [10, 11, 12] });
  eq(out.gaps.length, 1);
  eq(out.gaps[0].stage, "receipts");
  eq(out.receipts.size, 0);
});

await test("unreadable token metadata excludes the asset instead of failing the audit", async () => {
  const a = "0x1111111111111111111111111111111111111111";
  const b = "0x2222222222222222222222222222222222222222";
  const out = await resolveTokenMeta(deadRpc, [a, b]);
  eq(out.meta.size, 2);
  eq(out.meta.get(a), null, "an unreadable token has no invented scale");
  eq(out.meta.get(b), null);
  eq(out.unresolved.length, 2);
  assert(out.unresolved[0].reason.includes("THROTTLED"), "the reason is carried into the report");
});

await test("decimals outside a plausible range are refused, not clamped", async () => {
  const token = "0x3333333333333333333333333333333333333333";
  const { rpc } = rpcWith(() =>
    json(200, [
      { jsonrpc: "2.0", id: 1, result: "0x" + (40n).toString(16).padStart(64, "0") },
      { jsonrpc: "2.0", id: 2, result: "0x" + "55534443".padEnd(64, "0") },
    ]),
  );
  const out = await resolveTokenMeta(rpc, [token]);
  eq(out.meta.get(token), null);
  eq(out.unresolved.length, 1);
});

finish(import.meta.url);
