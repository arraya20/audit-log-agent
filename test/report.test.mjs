
// Integration tests over recorded chain traffic.
//
// The fixtures are real RPC responses captured from Pharos, replayed through the
// same batching transport the API uses. That makes these tests deterministic
// without pretending the data came from anywhere but the chain.
import { suite, test, eq, deepEq, assert, finish } from "./runner.mjs";
import { runAudit } from "../src/report.mjs";
import { replayFetch, loadFixture } from "./helpers/replay.mjs";

const SWAP_WALLET = "0x1F3546a29EeC2102c8d52E21a45114124014c85C";
const ROUTER = "0xf38d34c8382b9079b0f85309578b43b8479cd875";
const POOL = "0x912c9ade24d44d8922f0866d8dcb079f1363f647";

async function auditFixture(name, overrides = {}) {
  const fx = loadFixture(name);
  const fetchImpl = replayFetch(fx);
  const result = await runAudit({
    wallet: overrides.wallet ?? fx.wallet,
    window: { fromBlock: fx.window.fromBlock, toBlock: fx.window.toBlock, blocks: fx.window.toBlock - fx.window.fromBlock + 1 },
    fetchImpl,
  });
  return { result, fetchImpl, fx };
}

suite("swap window (real chain traffic)");

const swap = await auditFixture("swap");

await test("every chain read was answered from the fixture", () => {
  eq(swap.fetchImpl.misses.length, 0, "fixture misses: " + swap.fetchImpl.misses.slice(0, 3).join(" | "));
});

await test("the report is complete and produces no excuses", () => {
  eq(swap.result.completeness, "COMPLETE");
  eq(swap.result.reasons.length, 0);
});

await test("both legs of both swaps are present as movements", () => {
  eq(swap.result.movements.length, 4);
  eq(swap.result.movements.filter((m) => m.kind === "TOKEN_IN").length, 2);
  eq(swap.result.movements.filter((m) => m.kind === "TOKEN_OUT").length, 2);
});

await test("token totals are exact to the base unit", () => {
  const usdc = swap.result.totals.byAsset.find((a) => a.symbol === "USDC");
  const wpros = swap.result.totals.byAsset.find((a) => a.symbol === "WPROS");
  // Verified independently against eth_getTransactionReceipt: 55157793 and
  // 55173458 base units of a six-decimal token.
  eq(usdc.in, "0");
  eq(usdc.out, "110.331251");
  eq(usdc.outRaw, "110331251");
  eq(wpros.in, "200");
  eq(wpros.inRaw, "200000000000000000000");
});

await test("fees are the sum of gasUsed times effectiveGasPrice", () => {
  eq(swap.result.fees.total, "0.00402204");
  eq(swap.result.fees.totalRaw, "4022040000000000");
  eq(swap.result.fees.transactions, 2);
  eq(swap.result.fees.unverified, 0);
});

await test("native net accounts for gas, so a token-only window does not read as unchanged", () => {
  // The wallet moved only tokens here, so its native transfers net to zero. It
  // still paid 0.00402204 PROS in gas, and a report that shows "native net 0"
  // without that is arithmetically true and practically wrong.
  const nat = swap.result.totals.native;
  eq(nat.in, "0");
  eq(nat.out, "0");
  eq(nat.net, "0");
  eq(nat.feesPaid, "0.00402204");
  eq(nat.netAfterFees, "-0.00402204");
  eq(nat.netAfterFeesRaw, "-4022040000000000");
  eq(nat.netAfterFeesExact, true);
  // The two ways of computing it must agree, or one of them is lying.
  eq(nat.netAfterFeesRaw, (BigInt(nat.netRaw) - BigInt(nat.feesPaidRaw)).toString());
});

await test("the pool is the counterparty while the router is the contract called", () => {
  for (const m of swap.result.movements) {
    eq(m.counterparty, POOL, "token movement counterparty");
    eq(m.viaContract, ROUTER, "outer call target");
  }
});

await test("an unrecognised selector is reported as a call, not guessed into a category", () => {
  eq(swap.result.calls.length, 2);
  for (const c of swap.result.calls) {
    eq(c.selector, "0xdb3e2198");
    eq(c.callKind, "UNCLASSIFIED");
    eq(c.to, ROUTER);
  }
  // Nothing anywhere claims to know this was a swap.
  assert(!JSON.stringify(swap.result).toLowerCase().includes("swap\""), "the report must not invent a swap category");
});

await test("the same input twice produces byte-identical output", async () => {
  const again = await auditFixture("swap");
  eq(JSON.stringify(again.result), JSON.stringify(swap.result));
});

await test("a checksummed wallet and a lowercase wallet describe the same activity", async () => {
  const lower = await auditFixture("swap", { wallet: SWAP_WALLET.toLowerCase() });
  eq(lower.result.movements.length, swap.result.movements.length);
  eq(lower.result.wallet, swap.result.wallet, "the report always echoes the checksummed form");
});

suite("approval window");

const approval = await auditFixture("approval");

await test("the allowance grant is recorded with its exact amount and spender", () => {
  eq(approval.result.approvals.length, 1);
  const a = approval.result.approvals[0];
  eq(a.kind, "APPROVAL_GRANTED");
  eq(a.amount, "0.412502");
  eq(a.amountRaw, "412502");
  eq(a.spender, "0x946dc10e5d56a3d7619859be53f99d3e4e3c4cef");
  eq(a.unlimited, false);
});

await test("an approval is not counted as money moving", () => {
  const usdc = approval.result.totals.byAsset.find((x) => x.symbol === "USDC");
  eq(usdc.out, "0.412502", "only the transfer moves value");
  eq(approval.result.approvals.length, 1);
});

await test("the approve call is recognised by its selector", () => {
  const kinds = approval.result.calls.map((c) => c.callKind);
  assert(kinds.includes("APPROVAL_CALL"), "expected an APPROVAL_CALL, got " + kinds.join(","));
});

suite("native outflow");

const nativeOut = await auditFixture("native-out");

await test("native value is recorded even though the call carried calldata", () => {
  const out = nativeOut.result.movements.find((m) => m.kind === "NATIVE_OUT");
  assert(out, "expected a NATIVE_OUT");
  eq(out.amount, "10");
  eq(out.amountRaw, "10000000000000000000");
  eq(out.counterparty, "0xf7177baf6442fb76b0833aeca3de8d4dc8ffd695");
});

await test("native totals and the staked receipt agree in direction", () => {
  eq(nativeOut.result.totals.native.out, "10");
  eq(nativeOut.result.totals.native.net, "-10");
  const stpros = nativeOut.result.totals.byAsset.find((a) => a.symbol === "stPROS");
  assert(stpros, "expected the stPROS inflow");
  eq(stpros.in, "10.020867973082811346");
});

suite("native inflow");

const nativeIn = await auditFixture("native-in");

await test("incoming native value is an inflow from the sender", () => {
  const inflow = nativeIn.result.movements.find((m) => m.kind === "NATIVE_IN");
  assert(inflow, "expected a NATIVE_IN");
  eq(inflow.amount, "10");
  eq(inflow.counterparty, "0x9f857e7894e34d1cd09e55a8a27a8742729ea37c");
});

await test("a wallet that sent nothing pays no fees", () => {
  eq(nativeIn.result.fees.total, "0");
  eq(nativeIn.result.fees.transactions, 0);
});

await test("equal inflows and outflows of one asset net to exactly zero", () => {
  const stpros = nativeIn.result.totals.byAsset.find((a) => a.symbol === "stPROS");
  eq(stpros.inRaw, stpros.outRaw);
  eq(stpros.net, "0");
  eq(stpros.netRaw, "0");
});

suite("fail-closed behaviour");

await test("a block that cannot be read becomes a declared gap and degrades completeness", async () => {
  const fx = loadFixture("approval");
  const blockKey = "eth_getBlockByNumber:" + JSON.stringify(["0x" + fx.window.fromBlock.toString(16), true]);
  assert(fx.requests[blockKey], "fixture should contain the first block");
  delete fx.requests[blockKey];

  const fetchImpl = replayFetch(fx);
  const r = await runAudit({
    wallet: fx.wallet,
    window: { fromBlock: fx.window.fromBlock, toBlock: fx.window.toBlock, blocks: fx.window.toBlock - fx.window.fromBlock + 1 },
    fetchImpl,
  });

  eq(r.completeness, "PARTIAL", "a hole in the scan must not be reported as complete");
  assert(r.gaps.length > 0, "the gap must be listed");
  assert(r.reasons.join(" ").includes("gap"), "the reason must mention the gap: " + r.reasons.join("; "));
});

await test("unreadable token metadata excludes the asset from totals instead of assuming 18 decimals", async () => {
  const fx = loadFixture("swap");
  for (const k of Object.keys(fx.requests)) {
    if (k.startsWith("eth_call:")) delete fx.requests[k];
  }
  const fetchImpl = replayFetch(fx);
  const r = await runAudit({
    wallet: fx.wallet,
    window: { fromBlock: fx.window.fromBlock, toBlock: fx.window.toBlock, blocks: fx.window.toBlock - fx.window.fromBlock + 1 },
    fetchImpl,
  });

  eq(r.completeness, "PARTIAL");
  assert(r.totals.unpriceable.length > 0, "assets without decimals must be named");
  eq(r.totals.byAsset.length, 0, "nothing may be summed without a scale");
});

await test("the report always carries its structural blind spots", async () => {
  const ids = swap.result.blindSpots.map((b) => b.id);
  assert(ids.includes("INTERNAL_NATIVE_TRANSFERS"), "internal native transfers must be disclosed");
  assert(ids.includes("EVENT_COVERAGE"), "event coverage must be disclosed");
});

await test("a report survives JSON serialisation, which BigInt would break", async () => {
  for (const name of ["swap", "approval", "native-out", "native-in"]) {
    const { result } = await auditFixture(name);
    const text = JSON.stringify(result);
    assert(!text.includes("BIGINT"), name + " leaked a BigInt");
    const parsed = JSON.parse(text);
    eq(parsed.wallet, result.wallet);
  }
});

finish(import.meta.url);
