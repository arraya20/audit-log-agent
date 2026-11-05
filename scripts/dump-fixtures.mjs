
import { runAudit } from "../src/report.mjs";
import { replayFetch, loadFixture } from "../test/helpers/replay.mjs";

for (const name of ["swap", "approval", "native-out", "native-in"]) {
  const fx = loadFixture(name);
  const fetchImpl = replayFetch(fx);
  const r = await runAudit({
    wallet: fx.wallet,
    window: { fromBlock: fx.window.fromBlock, toBlock: fx.window.toBlock, blocks: fx.window.toBlock - fx.window.fromBlock + 1 },
    fetchImpl,
  });
  console.log("\n=====", name, " misses:", fetchImpl.misses.length, "completeness:", r.completeness, r.reasons);
  for (const m of r.movements) console.log("  M", m.kind, m.amount ?? m.amountRaw, m.asset?.symbol ?? "PROS", "cp", m.counterparty ?? m.from ?? m.to, "via", m.viaContract ?? "-");
  for (const a of r.approvals) console.log("  A", a.kind, a.amount ?? a.amountRaw, a.spender, "unlimited", a.unlimited);
  for (const c of r.calls) console.log("  C", c.kind, c.selector, c.callKind);
  console.log("  native", JSON.stringify(r.totals.native));
  console.log("  fees", JSON.stringify(r.fees));
  // A replacer that surfaces BigInt instead of crashing: if one ever reaches the
  // report, this script should show me where, not die.
  const J = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? "BIGINT:" + x.toString() : x));
  console.log("  byAsset", J(r.totals.byAsset));
  console.log("  json ok", (() => { try { JSON.stringify(r); return true; } catch (e) { return "THROWS: " + e.message; } })());
}
