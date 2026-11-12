// Deployment configuration.
//
// These are trusted constants shipped with the code, not request parameters.
// The scanner's budget in particular is a measurement, not a preference: the
// public RPC sustains roughly 400 blocks/second of full-block reads and answers
// 429 once you push past it, so a request that asks for a week of history cannot
// be served honestly inside one HTTP call. Rather than silently truncating the
// window, the API refuses it and states the real cost.

import { normalizeAddress, toChecksumAddress } from "./address.mjs";

export const CHAIN = Object.freeze({
  id: 1672,
  name: "Pharos Pacific Mainnet",
  rpc: "https://rpc.pharos.xyz",
  explorer: "https://explorer.pharos.xyz",
  nativeSymbol: "PROS",
  nativeDecimals: 18,
  // Measured: 100 blocks span 105 seconds. Used only for cost estimates and
  // block->time conversion, never for accounting.
  secondsPerBlock: 1.05,
});

export const BUDGET = Object.freeze({
  // Hard cap on blocks touched by one request. 4000 blocks ~= 70 minutes.
  maxBlocks: 4000,
  // The RPC rejects ranges above 1000 with -32602.
  maxLogRange: 1000,
  // Blocks per JSON-RPC batch. Above ~200 the node starts returning 429.
  blockBatch: 100,
  logBatch: 100,
  // Parallel batches in flight. Throughput is capped by the node, not by us;
  // more workers only produce more 429s.
  concurrency: 3,
  retries: 5,
  backoffBaseMs: 400,
  backoffMaxMs: 8000,
  // A request that would exceed maxBlocks is refused with this code.
  windowTooLarge: "WINDOW_EXCEEDS_BUDGET",
});

export const JOB = Object.freeze({
  defaultHours: 0.25,
  maxHours: 1.1,
  minHours: 0.001,
  // Logs only exist for successful transactions, so receipts are fetched only
  // for transactions the wallet itself sent. This bounds that fan-out.
  maxReceipts: 400,
});

/** Blocks covered by an hours window, using the measured block time. */
export function blocksForHours(hours) {
  return Math.max(1, Math.round((Number(hours) * 3600) / CHAIN.secondsPerBlock));
}

/** The largest window the budget allows, in hours. */
export function maxHoursForBudget() {
  return (BUDGET.maxBlocks * CHAIN.secondsPerBlock) / 3600;
}

export const TOKENS = Object.freeze({
  // Lowercase constants; checksums are derived, never typed.
  USDC: { address: normalizeAddress("0xc879c018db60520f4355c26ed1a6d572cdac1815"), symbol: "USDC", decimals: 6 },
  WPROS: { address: normalizeAddress("0x52c48d4213107b20bc583832b0d951fb9ca8f0b0"), symbol: "WPROS", decimals: 18 },
});

/** Public view of the deployment policy, safe to serve. */
export function publicConfig() {
  return {
    chain: {
      id: CHAIN.id,
      name: CHAIN.name,
      explorer: CHAIN.explorer,
      nativeSymbol: CHAIN.nativeSymbol,
      nativeDecimals: CHAIN.nativeDecimals,
      secondsPerBlock: CHAIN.secondsPerBlock,
    },
    window: {
      defaultHours: JOB.defaultHours,
      minHours: JOB.minHours,
      maxHours: Number(maxHoursForBudget().toFixed(3)),
      maxBlocks: BUDGET.maxBlocks,
    },
    tokens: Object.values(TOKENS).map((t) => ({ address: toChecksumAddress(t.address), symbol: t.symbol, decimals: t.decimals })),
  };
}
