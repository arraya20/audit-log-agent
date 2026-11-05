// Differential check against the chain.
//
//   node scripts/verify.mjs <wallet> <hours>
//
// This script deliberately imports nothing from src/. It speaks JSON-RPC itself
// and recomputes the headline numbers from raw JSON: token movement by summing
// Transfer logs, gas by summing gasUsed * effectiveGasPrice over the wallet's own
// transactions. Then it compares both against what runAudit reports.
//
// The point is that a bug in the decoder, the classifier or the report builder
// cannot hide here, because none of that code runs. If both paths agree, the
// number is a property of the chain rather than of our arithmetic.

import { runAudit } from "../src/report.mjs";

const RPC = process.env.PHAROS_RPC ?? "https://rpc.pharos.xyz";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// The public RPC rejects eth_getLogs spanning more than 1000 blocks.
const LOG_SPAN = 1000;
// Batch size measured to sit under the node's request ceiling.
const BATCH = 20;

const [walletArg, hoursArg] = process.argv.slice(2);
if (!walletArg || !hoursArg) {
  console.error("usage: node scripts/verify.mjs <wallet> <hours>");
  process.exit(2);
}
const wallet = walletArg.toLowerCase();
const hours = Number(hoursArg);

const hex = (n) => "0x" + BigInt(n).toString(16);

async function send(payload) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 429 || res.status === 503) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      continue;
    }
    const body = await res.json();
    if (Array.isArray(body)) return body;
    if (body.error) throw new Error(`rpc: ${body.error.message}`);
    return body.result;
  }
  throw new Error("rpc: gave up after repeated throttling");
}

const rpc = (method, params) => send({ jsonrpc: "2.0", id: 1, method, params });

async function batch(entries) {
  const out = [];
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    const res = await send(chunk.map((e, j) => ({ jsonrpc: "2.0", id: i + j, method: e.method, params: e.params })));
    const byId = new Map(res.map((r) => [r.id, r]));
    for (let j = 0; j < chunk.length; j++) {
      const r = byId.get(i + j);
      if (!r) throw new Error(`${chunk[j].method}: missing batch response`);
      if (r.error) throw new Error(`${chunk[j].method}: ${r.error.message}`);
      out.push(r.result);
    }
    // Progress goes to a TTY only: piped output stays clean for logs and diffs.
    if (process.stderr.isTTY && chunk.length === BATCH && i > 0 && i % (BATCH * 10) === 0) {
      process.stderr.write(`\r  reading blocks ${i}/${entries.length}`);
    }
  }
  if (process.stderr.isTTY && entries.length >= BATCH) process.stderr.write("\r" + " ".repeat(44) + "\r");
  return out;
}

const topicToAddress = (topic) => "0x" + topic.slice(-40);

// --- independent recomputation -------------------------------------------------

const report = await runAudit({ wallet: walletArg, hours });
const { fromBlock, toBlock } = report.window;

// Token movement, straight from Transfer logs.
const tokenIn = new Map();
const tokenOut = new Map();
let transferLogs = 0;

for (const asset of report.totals.byAsset) {
  let inn = 0n;
  let out = 0n;
  for (let start = fromBlock; start <= toBlock; start += LOG_SPAN) {
    const end = Math.min(start + LOG_SPAN - 1, toBlock);
    const logs = await rpc("eth_getLogs", [
      { address: asset.address.toLowerCase(), fromBlock: hex(start), toBlock: hex(end), topics: [TRANSFER] },
    ]);
    for (const log of logs) {
      const amount = BigInt(log.data);
      if (topicToAddress(log.topics[1]) === wallet) out += amount;
      if (topicToAddress(log.topics[2]) === wallet) inn += amount;
      transferLogs++;
    }
  }
  tokenIn.set(asset.symbol, inn);
  tokenOut.set(asset.symbol, out);
}

// Gas, straight from the receipts of the wallet's own transactions.
const blocks = await batch(
  Array.from({ length: toBlock - fromBlock + 1 }, (_, i) => ({
    method: "eth_getBlockByNumber",
    params: [hex(fromBlock + i), true],
  })),
);

const myTxs = [];
for (const blk of blocks) {
  if (!blk || !blk.transactions) continue;
  for (const t of blk.transactions) {
    if (String(t.from).toLowerCase() === wallet) myTxs.push(t.hash);
  }
}

const receipts = await batch(myTxs.map((hash) => ({ method: "eth_getTransactionReceipt", params: [hash] })));

let feeTotal = 0n;
let feeTx = 0;
for (const receipt of receipts) {
  if (!receipt) continue;
  const price = receipt.effectiveGasPrice ?? receipt.gasPrice;
  feeTotal += BigInt(receipt.gasUsed) * BigInt(price);
  feeTx++;
}

// Native value moved by the wallet's own transactions, from block bodies.
let nativeOut = 0n;
for (const blk of blocks) {
  if (!blk || !blk.transactions) continue;
  for (const t of blk.transactions) {
    if (String(t.from).toLowerCase() !== wallet) continue;
    nativeOut += BigInt(t.value ?? "0x0");
  }
}

// --- compare -------------------------------------------------------------------

const checks = [];
const check = (label, ours, chain) => checks.push({ label, ours: String(ours), chain: String(chain), ok: String(ours) === String(chain) });

for (const asset of report.totals.byAsset) {
  check(`${asset.symbol} in (base units)`, asset.inRaw, tokenIn.get(asset.symbol));
  check(`${asset.symbol} out (base units)`, asset.outRaw, tokenOut.get(asset.symbol));
}
check("gas paid (base units)", report.fees.totalRaw, feeTotal);
check("fee-paying tx count", report.fees.transactions, feeTx);
check("native out (base units)", report.totals.native.outRaw, nativeOut);
check("window block count", report.window.blocks, blocks.length);

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.label.padEnd(26)} audit ${c.ours.padStart(22)}  chain ${c.chain.padStart(22)}`);
}

console.log(`\nwindow ${fromBlock}..${toBlock} (${blocks.length} blocks), ${transferLogs} transfer logs, ${myTxs.length} wallet txs, completeness ${report.completeness}`);
if (report.fees.unverified > 0) console.log(`note: ${report.fees.unverified} receipt(s) unreadable, so gas is a lower bound on both sides`);
console.log(failed === 0 ? `\n${checks.length}/${checks.length} agree` : `\n${failed} of ${checks.length} DISAGREE`);
process.exitCode = failed === 0 ? 0 : 1;
