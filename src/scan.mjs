// Window scanning.
//
// Two independent sources are read, because they answer different questions:
//
//   Blocks  -> did the wallet send or receive native value? Only the block body
//              knows a transaction's value, and no log exists for native PROS.
//              The block body also supplies timestamps, which logs lack.
//   Logs    -> what tokens moved, and what allowances changed? A log exists only
//              if the transaction succeeded, so a log can never describe a
//              reverted transfer.
//
// Both are gathered with explicit gap tracking. A block that fails to load is a
// hole in the ledger, and a ledger with an undeclared hole is worse than an
// error, so failures are collected and reported rather than retried into
// oblivion or quietly skipped.

import { BUDGET, JOB, CHAIN, blocksForHours } from "./config.mjs";
import { EVENTS } from "./topics.mjs";
import { addressToWord, wordAt, strip0x } from "./hex.mjs";
import { decodeString, decodeUint } from "./abi.mjs";
import { SELECTORS } from "./topics.mjs";

const SELECTOR_DECIMALS = SELECTORS.DECIMALS;
const SELECTOR_SYMBOL = SELECTORS.SYMBOL;

function chunkRange(from, to, size) {
  const out = [];
  for (let start = from; start <= to; start += size) {
    out.push([start, Math.min(to, start + size - 1)]);
  }
  return out;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Resolve the block window for a request. Refuses rather than truncating. */
export async function resolveWindow(rpc, hours) {
  const latest = Number(await rpc.call("eth_blockNumber"));
  const blocks = blocksForHours(hours);
  if (blocks > BUDGET.maxBlocks) {
    const err = new Error(`window needs ${blocks} blocks, budget is ${BUDGET.maxBlocks}`);
    err.code = BUDGET.windowTooLarge;
    err.detail = { requestedBlocks: blocks, maxBlocks: BUDGET.maxBlocks, requestedHours: hours };
    throw err;
  }
  return { latest, fromBlock: Math.max(0, latest - blocks + 1), toBlock: latest, blocks };
}

/**
 * Read every block in range, keeping only the transactions that touch the wallet.
 * Returns a blockNumber -> timestamp map for the whole range, which the log stage
 * reuses so timestamps are never guessed from block arithmetic.
 */
export async function scanBlocks(rpc, { fromBlock, toBlock, wallet }) {
  const ranges = chunkRange(fromBlock, toBlock, BUDGET.blockBatch);
  const timestamps = new Map();
  const txs = [];
  const gaps = [];

  const perChunk = await mapWithConcurrency(ranges, BUDGET.concurrency, async ([a, b]) => {
    const calls = [];
    for (let n = a; n <= b; n++) calls.push({ method: "eth_getBlockByNumber", params: ["0x" + n.toString(16), true] });
    const items = await rpc.batch(calls);
    return { a, b, items };
  });

  for (const { a, b, items } of perChunk) {
    for (let i = 0; i < items.length; i++) {
      const n = a + i;
      const it = items[i];
      if (!it.ok) {
        gaps.push({ stage: "blocks", fromBlock: n, toBlock: n, reason: `rpc ${it.code}: ${it.message}` });
        continue;
      }
      const blk = it.value;
      if (!blk || !blk.number) {
        gaps.push({ stage: "blocks", fromBlock: n, toBlock: n, reason: "block missing from response" });
        continue;
      }
      const ts = blk.timestamp ? Number(blk.timestamp) : null;
      if (ts !== null) timestamps.set(n, ts);
      const list = Array.isArray(blk.transactions) ? blk.transactions : [];
      for (const t of list) {
        const from = t.from ? t.from.toLowerCase() : null;
        const to = t.to ? t.to.toLowerCase() : null;
        if (from !== wallet && to !== wallet) continue;
        txs.push({ ...t, blockNumber: n, blockTimestamp: ts });
      }
    }
  }

  return { timestamps, txs, gaps };
}

/** Read token movements and allowance changes involving the wallet. */
export async function scanLogs(rpc, { fromBlock, toBlock, wallet }) {
  const padded = addressToWord(wallet);
  const ranges = chunkRange(fromBlock, toBlock, BUDGET.maxLogRange);
  const logs = [];
  const gaps = [];

  const perChunk = await mapWithConcurrency(ranges, BUDGET.concurrency, async ([a, b]) => {
    const range = { fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) };
    const calls = [
      { method: "eth_getLogs", params: [{ ...range, topics: [EVENTS.TRANSFER, padded] }] },
      { method: "eth_getLogs", params: [{ ...range, topics: [EVENTS.TRANSFER, null, padded] }] },
      { method: "eth_getLogs", params: [{ ...range, topics: [EVENTS.APPROVAL, padded] }] },
      { method: "eth_getLogs", params: [{ ...range, topics: [EVENTS.APPROVAL_FOR_ALL, padded] }] },
    ];
    const items = await rpc.batch(calls);
    return { a, b, items };
  });

  const names = ["transfer-out", "transfer-in", "approval", "approval-for-all"];
  for (const { a, b, items } of perChunk) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.ok) {
        gaps.push({ stage: "logs", query: names[i] ?? `query-${i}`, fromBlock: a, toBlock: b, reason: `rpc ${it.code}: ${it.message}` });
        continue;
      }
      if (!Array.isArray(it.value)) {
        gaps.push({ stage: "logs", query: names[i] ?? `query-${i}`, fromBlock: a, toBlock: b, reason: "response was not a log array" });
        continue;
      }
      for (const l of it.value) if (l && !l.removed) logs.push(l);
    }
  }

  return { logs, gaps };
}

/**
 * Receipts for the blocks that contain wallet transactions.
 *
 * Only those blocks: the wallet touches a handful of blocks out of thousands, so
 * asking for receipts per block would multiply the call count for no gain.
 * eth_getBlockReceipts returns the whole block's receipts in one call.
 */
export async function scanReceipts(rpc, { blockNumbers }) {
  const numbers = [...new Set(blockNumbers)].sort((x, y) => x - y);
  const receipts = new Map();
  const gaps = [];
  if (numbers.length === 0) return { receipts, gaps };

  const ranges = chunkRange(0, numbers.length - 1, BUDGET.blockBatch);
  const perChunk = await mapWithConcurrency(ranges, BUDGET.concurrency, async ([a, b]) => {
    const slice = numbers.slice(a, b + 1);
    const calls = slice.map((n) => ({ method: "eth_getBlockReceipts", params: ["0x" + n.toString(16)] }));
    const items = await rpc.batch(calls);
    return { slice, items };
  });

  for (const { slice, items } of perChunk) {
    for (let i = 0; i < items.length; i++) {
      const n = slice[i];
      const it = items[i];
      if (!it.ok || !Array.isArray(it.value)) {
        gaps.push({ stage: "receipts", fromBlock: n, toBlock: n, reason: it.ok ? "not an array" : `rpc ${it.code}: ${it.message}` });
        continue;
      }
      const map = new Map();
      for (const r of it.value) if (r && r.transactionHash) map.set(r.transactionHash.toLowerCase(), r);
      receipts.set(n, map);
    }
  }
  return { receipts, gaps };
}

/**
 * Token metadata, read from each token contract.
 *
 * A token whose decimals cannot be read is returned with decimals null. That is
 * not a cosmetic gap: without decimals there is no way to express its amount, so
 * the asset is excluded from totals and reported as unresolved.
 */
export async function resolveTokenMeta(rpc, tokens) {
  const unique = [...new Set(tokens)].sort();
  const meta = new Map();
  const unresolved = [];
  if (unique.length === 0) return { meta, unresolved };

  const calls = [];
  for (const t of unique) {
    calls.push({ method: "eth_call", params: [{ to: t, data: SELECTOR_DECIMALS }, "latest"] });
    calls.push({ method: "eth_call", params: [{ to: t, data: SELECTOR_SYMBOL }, "latest"] });
  }
  const items = await rpc.batch(calls);

  for (let i = 0; i < unique.length; i++) {
    const decItem = items[i * 2];
    const symItem = items[i * 2 + 1];
    const rawDecimals = decItem && decItem.ok ? decodeUint(decItem.value) : null;
    const symbol = symItem && symItem.ok ? decodeString(symItem.value) : null;
    // decimals is the one that must be right; symbol is presentation.
    //
    // Converted to a Number here, at the boundary, because it is a uint8 and not
    // money. Leaving it as a BigInt put a value into the report that JSON cannot
    // serialise, which turns every API response into a 500.
    const decimals = rawDecimals === null ? null : rawDecimals > 36n ? null : Number(rawDecimals);
    if (decimals === null) {
      meta.set(unique[i], null);
      unresolved.push({ token: unique[i], reason: decItem && decItem.ok ? `decimals out of range or unreadable: ${rawDecimals}` : `decimals call failed: ${decItem && decItem.message}` });
      continue;
    }
    meta.set(unique[i], { symbol, decimals });
  }
  return { meta, unresolved };
}

export { chunkRange, mapWithConcurrency };
