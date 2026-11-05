
// Record real RPC traffic into a replayable fixture.
//
// The fixture stores per-call results keyed by method+params, not whole HTTP
// exchanges, so changing the batch size later does not invalidate it. Replay then
// exercises the real batching code path offline.
import { runAudit } from "../src/report.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const [, , name, wallet, fromBlockArg, toBlockArg] = process.argv;
if (!name || !wallet) {
  console.error("usage: node scripts/record-fixture.mjs <name> <wallet> <fromBlock> <toBlock>");
  process.exit(2);
}
// "h:0.01" records by hours, exercising window resolution from the chain head.
// Two integers record an explicit block range instead.
const byHours = String(fromBlockArg ?? "").startsWith("h:");
const hours = byHours ? Number(String(fromBlockArg).slice(2)) : null;
const fromBlock = byHours ? null : Number(fromBlockArg);
const toBlock = byHours ? null : Number(toBlockArg);

const requests = {};
let calls = 0;
let transient = 0;
const finalErrors = [];

function key(method, params) {
  return method + ":" + JSON.stringify(params ?? []);
}

const recordingFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const items = Array.isArray(body) ? body : [body];
  for (const it of items) calls++;
  const res = await fetch(url, init);
  const json = await res.json();
  const list = Array.isArray(json) ? json : [json];
  for (let i = 0; i < list.length; i++) {
    const it = items[i];
    const item = list[i];
    const k = key(it.method, it.params);
    if (item && item.error) {
      // A throttle that the transport retries is not a fixture hole; the success
      // that follows overwrites it. Only a final error is a real chain fact.
      const throttled = res.status === 429 || item.error.code === -32011 || /rate/i.test(item.error.message ?? "");
      if (throttled) transient++;
      requests[k] = { error: item.error };
    } else if (item && item.result !== undefined) {
      requests[k] = { result: item.result };
    }
  }
  return new Response(JSON.stringify(json), { status: res.status, headers: { "content-type": "application/json" } });
};

const report = await runAudit({
  wallet,
  hours,
  window: byHours ? null : { fromBlock, toBlock, blocks: toBlock - fromBlock + 1 },
  fetchImpl: recordingFetch,
});

mkdirSync("test/fixtures", { recursive: true });
const path = `test/fixtures/${name}.json`;
writeFileSync(
  path,
  JSON.stringify(
    {
      name,
      wallet: report.wallet,
      window: { fromBlock: report.window.fromBlock, toBlock: report.window.toBlock, hours },
      recordedAt: new Date().toISOString(),
      chainId: report.chain.id,
      requests,
    },
    null,
    1,
  ),
);

console.log(`wrote ${path}`);
// What the fixture will actually replay: any key still holding an error.
for (const [k, v] of Object.entries(requests)) {
  if (v && v.error) finalErrors.push({ key: k, error: v.error });
}
console.log(`  calls ${calls}  distinct ${Object.keys(requests).length}  transient ${transient}  finalErrors ${finalErrors.length}`);
for (const e of finalErrors) console.log(`  final error: ${e.key.slice(0, 90)} -> ${JSON.stringify(e.error).slice(0, 120)}`);
console.log(`  completeness ${report.completeness}  movements ${report.movements.length}  approvals ${report.approvals.length}  calls ${report.calls.length}`);
console.log(`  fees ${report.fees.total} ${report.fees.symbol}`);
for (const r of report.reasons) console.log(`  reason: ${r}`);
