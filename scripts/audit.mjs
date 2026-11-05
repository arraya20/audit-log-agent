// CLI: node scripts/audit.mjs <wallet> [hours]
//
// A CLI can afford a longer window than the HTTP API, so this is also where the
// scan budget gets exercised honestly: it prints what it actually covered.

import { runAudit } from "../src/report.mjs";
import { toChecksumAddress, isAddress } from "../src/address.mjs";
import { CHAIN, JOB } from "../src/config.mjs";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const positional = args.filter((x) => !x.startsWith("--"));
const fromArg = args.find((x) => x.startsWith("--fromBlock="))?.split("=", 2)[1];
const toArg = args.find((x) => x.startsWith("--toBlock="))?.split("=", 2)[1];
const [walletArg, hoursArg] = positional;

if (!walletArg || !isAddress(walletArg)) {
  console.error("usage: node scripts/audit.mjs <wallet> [hours]");
  process.exit(2);
}

const hours = hoursArg === undefined ? JOB.defaultHours : Number(hoursArg);
if (!Number.isFinite(hours) || hours <= 0) {
  console.error("hours must be a positive number");
  process.exit(2);
}

const window = fromArg !== undefined && toArg !== undefined
  ? {
      fromBlock: Number(fromArg),
      toBlock: Number(toArg),
      blocks: Number(toArg) - Number(fromArg) + 1,
    }
  : null;
if (window && (!Number.isSafeInteger(window.fromBlock) || !Number.isSafeInteger(window.toBlock) || window.fromBlock < 0 || window.toBlock < window.fromBlock)) {
  console.error("invalid explicit block window");
  process.exit(2);
}

const report = await runAudit({ wallet: toChecksumAddress(walletArg), hours, window });

if (jsonOutput) {
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exit(0);
}

const line = (s = "") => process.stdout.write(s + "\n");
const when = (ts) => (ts === null || ts === undefined ? "?".padEnd(20) : new Date(ts * 1000).toISOString().replace(".000Z", "Z").padEnd(20));

function assetLabel(e) {
  if (e.asset && e.asset.symbol) return e.asset.symbol;
  if (e.asset && e.asset.address) return e.asset.address.slice(0, 10) + "…";
  return "PROS";
}

function amountLabel(e) {
  if (e.amount !== undefined && e.amount !== null) return e.amount;
  if (e.amountRaw !== undefined) return `${e.amountRaw} raw`;
  return "-";
}

line(`wallet        ${report.wallet}`);
line(`chain         ${report.chain.id} (${report.chain.name})`);
line(`window        blocks ${report.window.fromBlock}..${report.window.toBlock}  ${when(report.window.fromTime)} -> ${when(report.window.toTime)}`);
line(`completeness  ${report.completeness}`);
for (const r of report.reasons) line(`  - ${r}`);
line();

line(`movements (${report.movements.length})`);
for (const m of report.movements.slice(0, 40)) {
  const via = m.viaContract ? ` via ${m.viaContract}` : "";
  line(`  ${when(m.blockTimestamp)} ${String(m.kind).padEnd(12)} ${amountLabel(m).padStart(22)} ${assetLabel(m).padEnd(8)} ${m.counterparty ?? m.to ?? m.from ?? "-"}${via}`);
}
if (report.movements.length > 40) line(`  ... ${report.movements.length - 40} more`);
line();

line(`approvals (${report.approvals.length})`);
for (const a of report.approvals) {
  const who = a.spender ?? a.operator ?? "-";
  line(`  ${when(a.blockTimestamp)} ${String(a.kind).padEnd(20)} ${who} ${a.unlimited ? "UNLIMITED" : amountLabel(a)}`);
}
line();

line(`calls (${report.calls.length})`);
for (const c of report.calls) {
  line(`  ${when(c.blockTimestamp)} ${String(c.kind).padEnd(14)} to ${c.to ?? "-"} selector ${c.selector ?? "-"} (${c.callKind ?? "-"})`);
}
line();

line(`fees paid   ${report.fees.total} ${report.fees.symbol} across ${report.fees.transactions} tx(s)` + (report.fees.unverified ? `  UNVERIFIED: ${report.fees.unverified}` : ""));
line();
line(`totals`);
for (const t of report.totals.byAsset) {
  line(`  ${String(t.symbol ?? t.address).padEnd(10)} in ${t.in} out ${t.out} net ${t.net} (${t.count} movement(s))`);
}
line(`  ${CHAIN.nativeSymbol.padEnd(10)} in ${report.totals.native.in} out ${report.totals.native.out} net ${report.totals.native.net}`);
line();

if (report.unresolved.length > 0) {
  line(`unresolved (${report.unresolved.length})`);
  for (const u of report.unresolved.slice(0, 20)) line(`  ${u.reason} tx ${u.txHash ?? "-"} log ${u.logIndex ?? "-"}`);
  line();
}
if (report.gaps.length > 0) {
  line(`gaps (${report.gaps.length})`);
  for (const g of report.gaps.slice(0, 20)) line(`  ${g.stage} ${g.fromBlock}..${g.toBlock} ${g.reason}`);
  line();
}
line(`scan        ${JSON.stringify(report.scan.stats)}`);
line(`counts      ${JSON.stringify(report.counts)}`);
