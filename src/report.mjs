// Assembling the audit log.
//
// The report keeps four separate ledgers, because collapsing them is how audit
// logs start lying:
//
//   movements  money that actually moved, and the only thing that feeds totals
//   calls      transactions the wallet sent that moved no value
//   approvals  allowance changes: not movements, but the part a reviewer reads
//   fees       gas paid, deduplicated per transaction
//
// A reverted transaction appears in `calls` and never in `movements`. A swap
// appears as the tokens that went out and the tokens that came in, with no claim
// about which protocol it was.

import { KIND, classifyLog, classifyTx, entryKey } from "./classify.mjs";
import { formatUnits } from "./numbers.mjs";
import { CHAIN, BUDGET } from "./config.mjs";
import { toChecksumAddress, normalizeAddress } from "./address.mjs";
import { scanBlocks, scanLogs, scanReceipts, resolveTokenMeta, resolveWindow } from "./scan.mjs";
import { createRpc } from "./rpc.mjs";

const MOVEMENT_KINDS = new Set([
  KIND.TOKEN_OUT,
  KIND.TOKEN_IN,
  KIND.NFT_OUT,
  KIND.NFT_IN,
  KIND.NATIVE_OUT,
  KIND.NATIVE_IN,
  KIND.NATIVE_SELF,
]);
const APPROVAL_KINDS = new Set([KIND.APPROVAL_GRANTED, KIND.APPROVAL_UNLIMITED, KIND.APPROVAL_REVOKED, KIND.APPROVAL_FOR_ALL]);

// Structural blind spots. These are properties of the chain and the RPC, not of
// this run, and they are always reported because a reader has to know what an
// "empty" audit does and does not rule out.
const BLIND_SPOTS = [
  {
    id: "INTERNAL_NATIVE_TRANSFERS",
    detail:
      "Native value moved by a contract to the wallet (internal transfer) is not visible in block bodies or logs. Seeing it requires traces, which the public RPC disables. Native inflow is therefore exact for externally-submitted transactions only.",
  },
  {
    id: "EVENT_COVERAGE",
    detail:
      "Token movement is read from Transfer and allowance changes from Approval and ApprovalForAll. A token that does not emit these events moves without appearing here.",
  },
  {
    id: "NO_PRICE_DATA",
    detail:
      "Amounts are reported in token units. No price or valuation is applied, so totals across different assets are never added together.",
  },
];

function bucket(kind) {
  if (MOVEMENT_KINDS.has(kind)) return "movements";
  if (APPROVAL_KINDS.has(kind)) return "approvals";
  return "calls";
}

/**
 * Run one audit.
 *
 * `wallet` must already be normalised. `hours` must already be validated. Every
 * failure mode below results in a recorded gap and a PARTIAL report; nothing is
 * dropped to make the output look clean.
 */
export async function buildReport(rpc, { wallet, hours, window, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (typeof window !== "object" || window === null) throw new Error("buildReport: window required");

  // Normalise exactly once. Chain data is lowercase; a checksummed address from a
  // caller would compare unequal against every tx and silently produce an empty
  // audit that looks like a quiet wallet.
  const w = normalizeAddress(wallet);

  // Stage 1: what the chain says about blocks and logs, independently.
  const [blockScan, logScan] = await Promise.all([
    scanBlocks(rpc, { fromBlock: window.fromBlock, toBlock: window.toBlock, wallet: w }),
    scanLogs(rpc, { fromBlock: window.fromBlock, toBlock: window.toBlock, wallet: w }),
  ]);

  // Stage 2: receipts only for blocks that contain wallet transactions.
  const receiptScan = await scanReceipts(rpc, { blockNumbers: blockScan.txs.map((t) => t.blockNumber) });

  // Stage 3: metadata for every token that appears in a log.
  const tokenScan = await resolveTokenMeta(rpc, logScan.logs.map((l) => String(l.address).toLowerCase()));

  const gaps = [...blockScan.gaps, ...logScan.gaps, ...receiptScan.gaps];
  const unresolved = [];

  // --- transactions ---
  const rawEntries = [];
  for (const tx of blockScan.txs) {
    const blockMap = receiptScan.receipts.get(tx.blockNumber);
    const receipt = blockMap ? blockMap.get(String(tx.hash).toLowerCase()) : undefined;
    // A missing receipt is an unknown outcome, never an assumed success.
    const status = receipt ? Number(receipt.status) : null;
    const entries = classifyTx({
      tx,
      wallet: w,
      status,
      // Raw hex, converted once inside classifyTx with BigInt. Going through
      // Number here would round the fee, which is money.
      gasUsed: receipt ? receipt.gasUsed : null,
      effectiveGasPrice: receipt ? receipt.effectiveGasPrice ?? receipt.gasPrice ?? null : null,
    });
    for (const e of entries) rawEntries.push({ ...e, blockTimestamp: tx.blockTimestamp ?? null });
  }

  // --- logs ---
  for (const log of logScan.logs) {
    const token = String(log.address).toLowerCase();
    const res = classifyLog({ log, wallet: w, meta: tokenScan.meta.get(token) ?? null });
    if (!res.ok) {
      // A log we cannot decode is reported with its reason, and does not become
      // an entry of any kind.
      if (res.reason !== "LOG_NOT_INVOLVING_WALLET") unresolved.push(res);
      continue;
    }
    const ts = blockScan.timestamps.get(res.entry.blockNumber) ?? null;
    rawEntries.push({ ...res.entry, blockTimestamp: ts });
  }

  // --- deduplicate ---
  // The same movement can be reached twice (a self-send appears in both the
  // outgoing and incoming log query). Identity is the transaction plus log index
  // plus kind, so a genuine duplicate collapses and a genuine second event does
  // not.
  const seen = new Map();
  for (const e of rawEntries) {
    const key = entryKey(e);
    if (seen.has(key)) continue;
    seen.set(key, e);
  }
  const entries = [...seen.values()].sort((x, y) => {
    if (x.blockNumber !== y.blockNumber) return (x.blockNumber ?? 0) - (y.blockNumber ?? 0);
    if ((x.txIndex ?? 0) !== (y.txIndex ?? 0)) return (x.txIndex ?? 0) - (y.txIndex ?? 0);
    return (x.logIndex ?? 0) - (y.logIndex ?? 0);
  });

  const movements = entries.filter((e) => bucket(e.kind) === "movements");
  const approvals = entries.filter((e) => bucket(e.kind) === "approvals");
  const calls = entries.filter((e) => bucket(e.kind) === "calls");

  // Which contract the money travelled through.
  //
  // For a swap the token transfer's counterparty is the pool while the
  // transaction's target is the router. Both are true and they are different
  // facts, so they get different fields instead of one ambiguous "counterparty".
  // Unknown when the transaction was submitted by someone else, which is stated
  // as null rather than guessed.
  const txTargetByHash = new Map();
  for (const tx of blockScan.txs) {
    txTargetByHash.set(String(tx.hash).toLowerCase(), tx.to ? normalizeAddress(tx.to) : null);
  }
  for (const e of movements) {
    if (e.kind !== KIND.TOKEN_IN && e.kind !== KIND.TOKEN_OUT && e.kind !== KIND.NFT_IN && e.kind !== KIND.NFT_OUT) continue;
    if (!e.txHash) continue;
    e.viaContract = txTargetByHash.has(String(e.txHash).toLowerCase()) ? txTargetByHash.get(String(e.txHash).toLowerCase()) : null;
  }

  // --- fees, per transaction, straight from the receipts ---
  //
  // Deriving fees from the entries looked tidy and was wrong. A token transfer
  // the wallet sends produces a movement entry read from a log, and a log carries
  // no gas information, so exactly the transactions that cost the most gas
  // contributed nothing. The fee ledger therefore comes from the transactions
  // and their receipts, not from what the entries happened to carry.
  const feeByTx = new Map();
  let feesUnverified = 0;
  for (const tx of blockScan.txs) {
    if (String(tx.from).toLowerCase() !== w) continue; // only the sender pays
    const blockReceipts = receiptScan.receipts.get(tx.blockNumber);
    const receipt = blockReceipts ? blockReceipts.get(String(tx.hash).toLowerCase()) : undefined;
    if (!receipt) {
      // Unknown is not zero. It is counted and it degrades completeness below.
      feesUnverified++;
      continue;
    }
    const price = receipt.effectiveGasPrice ?? receipt.gasPrice ?? null;
    if (receipt.gasUsed === null || receipt.gasUsed === undefined || price === null) {
      feesUnverified++;
      continue;
    }
    feeByTx.set(String(tx.hash).toLowerCase(), (BigInt(receipt.gasUsed) * BigInt(price)).toString());
  }
  let totalFees = 0n;
  for (const v of feeByTx.values()) totalFees += BigInt(v);

  // --- totals ---
  const nativeIn = movements.filter((e) => e.kind === KIND.NATIVE_IN).reduce((a, e) => a + BigInt(e.amountRaw), 0n);
  const nativeOut = movements.filter((e) => e.kind === KIND.NATIVE_OUT).reduce((a, e) => a + BigInt(e.amountRaw), 0n);

  const assets = new Map();
  for (const e of movements) {
    if (e.kind !== KIND.TOKEN_IN && e.kind !== KIND.TOKEN_OUT) continue;
    if (!e.asset || !e.asset.resolved) continue;
    const key = e.asset.address;
    if (!assets.has(key)) {
      assets.set(key, { address: toChecksumAddress(key), symbol: e.asset.symbol, decimals: e.asset.decimals, inRaw: 0n, outRaw: 0n, count: 0 });
    }
    const agg = assets.get(key);
    agg.count++;
    if (e.kind === KIND.TOKEN_IN) agg.inRaw += BigInt(e.amountRaw);
    else agg.outRaw += BigInt(e.amountRaw);
  }

  const byAsset = [...assets.values()]
    .map((a) => ({
      address: a.address,
      symbol: a.symbol,
      decimals: a.decimals,
      in: formatUnits(a.inRaw, a.decimals),
      out: formatUnits(a.outRaw, a.decimals),
      net: formatUnits(a.inRaw - a.outRaw, a.decimals),
      inRaw: a.inRaw.toString(),
      outRaw: a.outRaw.toString(),
      netRaw: (a.inRaw - a.outRaw).toString(),
      count: a.count,
    }))
    .sort((x, y) => (x.symbol ?? x.address).localeCompare(y.symbol ?? y.address));

  // Assets whose decimals could not be read cannot be summed; they are named so
  // the exclusion is visible rather than silent.
  const unpriceable = [...new Set(movements.filter((e) => e.asset && !e.asset.resolved).map((e) => e.asset.address))].sort();

  // --- completeness ---
  const reasons = [];
  if (gaps.length > 0) reasons.push(`${gaps.length} scan gap(s)`);
  if (unresolved.length > 0) reasons.push(`${unresolved.length} undecodable log(s)`);
  if (tokenScan.unresolved.length > 0) reasons.push(`${tokenScan.unresolved.length} token(s) without readable decimals`);
  if (unpriceable.length > 0) reasons.push(`${unpriceable.length} asset(s) excluded from totals`);
  const unknownStatus = entries.filter((e) => e.kind === KIND.UNKNOWN_STATUS);
  if (unknownStatus.length > 0) reasons.push(`${unknownStatus.length} transaction(s) with unknown outcome`);
  if (feesUnverified > 0) reasons.push(`${feesUnverified} transaction(s) with unverified gas cost`);

  const completeness = reasons.length === 0 ? "COMPLETE" : "PARTIAL";

  const fromTs = blockScan.timestamps.get(window.fromBlock) ?? null;
  const toTs = blockScan.timestamps.get(window.toBlock) ?? null;

  return {
    wallet: toChecksumAddress(w),
    chain: { id: CHAIN.id, name: CHAIN.name, nativeSymbol: CHAIN.nativeSymbol },
    window: {
      fromBlock: window.fromBlock,
      toBlock: window.toBlock,
      blocks: window.toBlock - window.fromBlock + 1,
      fromTime: fromTs,
      toTime: toTs,
      hours,
      generatedAt: nowSeconds,
    },
    completeness,
    reasons,
    totals: {
      native: {
        symbol: CHAIN.nativeSymbol,
        decimals: CHAIN.nativeDecimals,
        in: formatUnits(nativeIn, CHAIN.nativeDecimals),
        out: formatUnits(nativeOut, CHAIN.nativeDecimals),
        net: formatUnits(nativeIn - nativeOut, CHAIN.nativeDecimals),
        inRaw: nativeIn.toString(),
        outRaw: nativeOut.toString(),
        netRaw: (nativeIn - nativeOut).toString(),
        feesPaid: formatUnits(totalFees, CHAIN.nativeDecimals),
        feesPaidRaw: totalFees.toString(),
        // Gas is paid in native currency, so a wallet that only moves tokens
        // still ends the window with less native balance than it started with.
        // Reporting native net as 0 in that case is arithmetically true of the
        // transfers and misleading about the wallet. This is the number a reader
        // actually wants, and it is flagged inexact when any receipt was missing.
        netAfterFees: formatUnits(nativeIn - nativeOut - totalFees, CHAIN.nativeDecimals),
        netAfterFeesRaw: (nativeIn - nativeOut - totalFees).toString(),
        netAfterFeesExact: feesUnverified === 0,
      },
      byAsset,
      unpriceable,
    },
    fees: {
      symbol: CHAIN.nativeSymbol,
      decimals: CHAIN.nativeDecimals,
      total: formatUnits(totalFees, CHAIN.nativeDecimals),
      totalRaw: totalFees.toString(),
      transactions: feeByTx.size,
      unverified: feesUnverified,
    },
    counts: {
      transactions: blockScan.txs.length,
      logs: logScan.logs.length,
      movements: movements.length,
      calls: calls.length,
      approvals: approvals.length,
    },
    movements,
    calls,
    approvals,
    unresolved,
    gaps,
    blindSpots: BLIND_SPOTS,
    scan: {
      blocks: window.toBlock - window.fromBlock + 1,
      blockBatch: BUDGET.blockBatch,
      stats: { ...rpc.stats },
    },
  };
}

// Orchestrator: build a transport, resolve the window from the chain head, and
// produce the report. Anyone calling this gets the same code path the HTTP
// handler uses, so a CLI run and an API run cannot drift apart.
export async function runAudit({ wallet, hours = null, atSeconds = null, window = null, fetchImpl = undefined, retries = undefined, backoffBaseMs = undefined, sleep = undefined } = {}) {
  const rpc = createRpc({
    url: CHAIN.rpc,
    fetchImpl,
    retries,
    backoffBaseMs,
    sleep,
  });

  // An explicit window is how tests and fixture recording pin exact blocks. A
  // caller who does not supply one gets the chain head, which is what the API does.
  const resolved = window ?? (await resolveWindow(rpc, hours, atSeconds));
  const report = await buildReport(rpc, { wallet, hours, window: resolved, nowSeconds: atSeconds });

  return report;
}
