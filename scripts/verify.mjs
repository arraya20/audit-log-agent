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

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

// --- independent raw-chain recomputation --------------------------------------
// This script intentionally has no implementation import and does not consume a
// report to discover which assets to check. It derives the head/window, discovers
// every token from raw Transfer logs, and then aggregates those logs independently.
const head = BigInt(await rpc("eth_blockNumber", []));
const fromBlock = Number(head) - Math.max(1, Math.round((hours * 3600) / 1.05)) + 1;
const toBlock = Number(head);
if (fromBlock < 0) throw new Error("window starts before genesis");

const tokenLogs = new Map();
const seenLogKeys = new Set();
let transferLogs = 0;
for (let start = fromBlock; start <= toBlock; start += LOG_SPAN) {
  const end = Math.min(start + LOG_SPAN - 1, toBlock);
  for (const topics of [[TRANSFER, "0x" + "0".repeat(24) + wallet.slice(2)], [TRANSFER, null, "0x" + "0".repeat(24) + wallet.slice(2)]]) {
    const logs = await rpc("eth_getLogs", [{ fromBlock: hex(start), toBlock: hex(end), topics }]);
    for (const log of logs) {
      const key = `${String(log.transactionHash).toLowerCase()}:${String(log.logIndex).toLowerCase()}`;
      if (seenLogKeys.has(key)) continue;
      seenLogKeys.add(key);
      const token = String(log.address).toLowerCase();
      if (!tokenLogs.has(token)) tokenLogs.set(token, []);
      tokenLogs.get(token).push(log);
      transferLogs++;
    }
  }
}

const tokenIn = new Map();
const tokenOut = new Map();
for (const [token, logs] of tokenLogs) {
  let inn = 0n;
  let out = 0n;
  for (const log of logs) {
    const amount = BigInt(log.data);
    if (topicToAddress(log.topics[1]) === wallet) out += amount;
    if (topicToAddress(log.topics[2]) === wallet) inn += amount;
  }
  tokenIn.set(token, inn);
  tokenOut.set(token, out);
}

// The implementation report is invoked through its CLI boundary, not imported.
// This preserves a module-independent verifier while still comparing raw-chain
// recomputation to the shipped report.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const report = JSON.parse(execFileSync(process.execPath, [
  join(projectRoot, "scripts/audit.mjs"), walletArg, String(hours), "--json",
  `--fromBlock=${fromBlock}`, `--toBlock=${toBlock}`,
], {
  cwd: projectRoot,
  env: process.env,
  encoding: "utf8",
}));

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

// --- raw-chain invariants ------------------------------------------------------

const checks = [];
const check = (label, ours, chain) => checks.push({ label, ours: String(ours), chain: String(chain), ok: String(ours) === String(chain) });

const reportedAssets = new Map(report.totals.byAsset.map((a) => [String(a.address).toLowerCase(), a]));
for (const [token, value] of tokenIn) {
  const asset = reportedAssets.get(token);
  check(`${token} present in report`, Boolean(asset), true);
  if (asset) {
    check(`${token} in (base units)`, asset.inRaw, value);
    check(`${token} out (base units)`, asset.outRaw, tokenOut.get(token));
  }
}
for (const [token] of reportedAssets) check(`${token} report asset exists on chain`, tokenLogs.has(token), true);
check("window block count", toBlock - fromBlock + 1, blocks.length);

check("gas paid (base units)", report.fees.totalRaw, feeTotal);
check("fee-paying tx count", report.fees.transactions, feeTx);
check("native out (base units)", report.totals.native.outRaw, nativeOut);

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.label.padEnd(26)} audit ${c.ours.padStart(22)}  chain ${c.chain.padStart(22)}`);
}

console.log(`\nwindow ${fromBlock}..${toBlock} (${blocks.length} blocks), ${transferLogs} transfer logs, ${myTxs.length} wallet txs`);
console.log(failed === 0 ? `\n${checks.length}/${checks.length} agree` : `\n${failed} of ${checks.length} DISAGREE`);
process.exitCode = failed === 0 ? 0 : 1;
