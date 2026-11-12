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

/** Resolve the block window for a date range [fromSeconds, toSeconds]. Refuses rather than truncating. */
export async function resolveDateRangeWindow(rpc, { fromSeconds, toSeconds }) {
  if (!Number.isFinite(fromSeconds) || !Number.isFinite(toSeconds) || toSeconds <= fromSeconds) {
    const err = new Error("date range requires valid from < to timestamps");
    err.code = "INVALID_DATE_RANGE";
    throw err;
  }
  const spanHours = (toSeconds - fromSeconds) / 3600;
  const requestedBlocks = blocksForHours(spanHours);
  if (requestedBlocks > BUDGET.maxBlocks) {
    const err = new Error(`window needs ${requestedBlocks} blocks, budget is ${BUDGET.maxBlocks}`);
    err.code = BUDGET.windowTooLarge;
    err.detail = { requestedBlocks, maxBlocks: BUDGET.maxBlocks, requestedHours: Number(spanHours.toFixed(4)) };
    throw err;
  }
  const latest = Number(await rpc.call("eth_blockNumber"));
  const headBlk = await rpc.call("eth_getBlockByNumber", ["0x" + latest.toString(16), true]);
  const headTs = headBlk && headBlk.timestamp ? Number(headBlk.timestamp) : Math.floor(Date.now() / 1000);
  if (fromSeconds > headTs) {
    const err = new Error(`range starts after chain head timestamp (${headTs})`);
    err.code = "INVALID_DATE_RANGE";
    err.detail = { fromSeconds, toSeconds, headTimestamp: headTs };
    throw err;
  }
  const effectiveTo = Math.min(toSeconds, headTs);
  const offsetTo = Math.max(0, Math.floor((headTs - effectiveTo) / CHAIN.secondsPerBlock));
  const toBlock = Math.max(0, latest - offsetTo);
  const blocks = Math.max(1, Math.round((effectiveTo - fromSeconds) / CHAIN.secondsPerBlock));
  if (blocks > BUDGET.maxBlocks) {
    const err = new Error(`window needs ${blocks} blocks, budget is ${BUDGET.maxBlocks}`);
    err.code = BUDGET.windowTooLarge;
    err.detail = { requestedBlocks: blocks, maxBlocks: BUDGET.maxBlocks, requestedHours: Number(spanHours.toFixed(4)) };
    throw err;
  }
  const fromBlock = Math.max(0, toBlock - blocks + 1);
  return { latest, fromBlock, toBlock, blocks: toBlock - fromBlock + 1 };
}

// A chunk that fails as a whole is one gap for its range, not one per block:
// same information, readable report.
function errText(err) {
  if (!err) return "rpc failure";
  const code = err.code ? String(err.code) : "RPC_FAILURE";
  return `${code}: ${err.message ? String(err.message) : ""}`.trim();
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
    // A throttle that outlives the transport's retries used to reject out of
    // here and take the entire audit with it. The honest outcome is a declared
    // gap: the report then says PARTIAL instead of disappearing.
    try {
      return { a, b, items: await rpc.batch(calls) };
    } catch (err) {
      return { a, b, items: null, error: err };
    }
  });

  for (const { a, b, items, error } of perChunk) {
    if (!items) {
      gaps.push({ stage: "blocks", fromBlock: a, toBlock: b, reason: errText(error) });
      continue;
    }
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
    try {
      return { a, b, items: await rpc.batch(calls) };
    } catch (err) {
      return { a, b, items: null, error: err };
    }
  });

  const names = ["transfer-out", "transfer-in", "approval", "approval-for-all"];
  for (const { a, b, items, error } of perChunk) {
    if (!items) {
      for (const name of names) {
        gaps.push({ stage: "logs", query: name, fromBlock: a, toBlock: b, reason: errText(error) });
      }
      continue;
    }
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
export async function scanReceipts(rpc, { blockNumbers, maxReceipts = Infinity }) {
  const numbers = [...new Set(blockNumbers)].sort((x, y) => x - y);
  const receipts = new Map();
  const gaps = [];
  if (numbers.length === 0) return { receipts, gaps };
  if (numbers.length > maxReceipts) {
    gaps.push({
      stage: "receipts",
      fromBlock: numbers[0],
      toBlock: numbers[numbers.length - 1],
      reason: `receipt budget exceeded: ${numbers.length} blocks requested, maximum is ${maxReceipts}`,
      code: "RECEIPT_BUDGET_EXCEEDED",
    });
    return { receipts, gaps };
  }

  const ranges = chunkRange(0, numbers.length - 1, BUDGET.blockBatch);
  const perChunk = await mapWithConcurrency(ranges, BUDGET.concurrency, async ([a, b]) => {
    const slice = numbers.slice(a, b + 1);
    const calls = slice.map((n) => ({ method: "eth_getBlockReceipts", params: ["0x" + n.toString(16)] }));
    try {
      return { slice, items: await rpc.batch(calls) };
    } catch (err) {
      return { slice, items: null, error: err };
    }
  });

  for (const { slice, items, error } of perChunk) {
    if (!items) {
      gaps.push({ stage: "receipts", fromBlock: slice[0], toBlock: slice[slice.length - 1], reason: errText(error) });
      continue;
    }
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
  // A throttle that survives the transport's retries must not take the whole
  // audit down with it. Without decimals the amounts cannot be expressed, so the
  // honest outcome is: keep the raw movements, exclude the asset from totals and
  // say why. Throwing here produced a 502 where a PARTIAL report was available.
  let items;
  try {
    items = await rpc.batch(calls);
  } catch (err) {
    for (const token of unique) {
      meta.set(token, null);
      unresolved.push({ token, reason: `metadata unreadable: ${err && err.code ? err.code : "rpc failure"}` });
    }
    return { meta, unresolved };
  }

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
