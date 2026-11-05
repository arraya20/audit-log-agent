
// Classification tests. The subject is the rule set, so the inputs are built by
// hand: each case states one decoded fact and one thing that must never happen to
// it. Chain integration is a separate file.
import { suite, test, eq, deepEq, assert, finish } from "./runner.mjs";
import { KIND, classifyLog, classifyTx, entryKey } from "../src/classify.mjs";
import { EVENTS, UNLIMITED_ALLOWANCE } from "../src/topics.mjs";
import { toTopicWord } from "../src/address.mjs";

const W = "0x1f3546a29eec2102c8d52e21a45114124014c85c";
const OTHER = "0x912c9ade24d44d8922f0866d8dcb079f1363f647";
const TOKEN = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const ZERO = "0x0000000000000000000000000000000000000000";

const meta6 = { symbol: "USDC", decimals: 6 };

function word(n) {
  return "0x" + BigInt(n).toString(16).padStart(64, "0");
}

function transferLog({ from, to, value = 0n, token = TOKEN, logIndex = 0, txHash = "0xaaa", topics = null }) {
  return {
    address: token,
    topics: topics ?? [EVENTS.TRANSFER, toTopicWord(from), toTopicWord(to)],
    data: word(value),
    transactionHash: txHash,
    logIndex: "0x" + logIndex.toString(16),
    blockNumber: "0x10",
  };
}

function approvalLog({ owner, spender, value, token = TOKEN }) {
  return {
    address: token,
    topics: [EVENTS.APPROVAL, toTopicWord(owner), toTopicWord(spender)],
    data: word(value),
    transactionHash: "0xbbb",
    logIndex: "0x0",
    blockNumber: "0x10",
  };
}

suite("token movements");

await test("an outgoing transfer records the exact amount and the recipient", () => {
  const r = classifyLog({ log: transferLog({ from: W, to: OTHER, value: 55157793n }), wallet: W, meta: meta6 });
  eq(r.ok, true);
  eq(r.entry.kind, KIND.TOKEN_OUT);
  eq(r.entry.amount, "55.157793");
  eq(r.entry.amountRaw, "55157793");
  eq(r.entry.counterparty, OTHER);
  eq(r.entry.asset.decimals, 6);
});

await test("an incoming transfer reads the sender as the counterparty", () => {
  const r = classifyLog({ log: transferLog({ from: OTHER, to: W, value: 100000000000000000000n }), wallet: W, meta: { symbol: "WPROS", decimals: 18 } });
  eq(r.ok, true);
  eq(r.entry.kind, KIND.TOKEN_IN);
  eq(r.entry.amount, "100");
  eq(r.entry.counterparty, OTHER);
});

await test("a mint is an inflow from the zero address, not a decode failure", () => {
  const r = classifyLog({ log: transferLog({ from: ZERO, to: W, value: 5000n }), wallet: W, meta: meta6 });
  eq(r.ok, true);
  eq(r.entry.kind, KIND.TOKEN_IN);
  eq(r.entry.counterparty, ZERO);
});

await test("a transfer that does not involve the wallet is skipped, not counted as undecodable", () => {
  const r = classifyLog({ log: transferLog({ from: OTHER, to: OTHER }), wallet: W, meta: meta6 });
  eq(r.ok, false);
  eq(r.reason, "LOG_NOT_INVOLVING_WALLET");
});

suite("nfts are not fungible amounts");

await test("a four-topic Transfer is an NFT movement carrying a tokenId", () => {
  const log = {
    address: TOKEN,
    topics: [EVENTS.TRANSFER, toTopicWord(OTHER), toTopicWord(W), word(42)],
    data: "0x",
    transactionHash: "0xccc",
    logIndex: "0x1",
    blockNumber: "0x10",
  };
  const r = classifyLog({ log, wallet: W, meta: meta6 });
  eq(r.ok, true);
  eq(r.entry.kind, KIND.NFT_IN);
  eq(r.entry.tokenId, "42");
  // The critical part: an NFT must not contribute a fungible amount.
  eq(r.entry.amount, undefined);
  eq(r.entry.amountRaw, undefined);
});

await test("an NFT outflow is likewise excluded from fungible sums", () => {
  const log = {
    address: TOKEN,
    topics: [EVENTS.TRANSFER, toTopicWord(W), toTopicWord(OTHER), word(7)],
    data: "0x",
    transactionHash: "0xccc",
    logIndex: "0x2",
    blockNumber: "0x10",
  };
  const r = classifyLog({ log, wallet: W, meta: meta6 });
  eq(r.entry.kind, KIND.NFT_OUT);
  eq(r.entry.amount, undefined);
});

suite("undecodable input never becomes an entry");

await test("a Transfer with two topics is refused", () => {
  const log = transferLog({ from: W, to: OTHER, topics: [EVENTS.TRANSFER, toTopicWord(W)] });
  const r = classifyLog({ log, wallet: W, meta: meta6 });
  eq(r.ok, false);
  eq(r.reason, "TRANSFER_TOPICS_INCOMPLETE");
});

await test("a Transfer with an unreadable address topic is refused", () => {
  const log = transferLog({ from: W, to: OTHER, topics: [EVENTS.TRANSFER, "0x1234", toTopicWord(OTHER)] });
  const r = classifyLog({ log, wallet: W, meta: meta6 });
  eq(r.ok, false);
  eq(r.reason, "TRANSFER_ADDRESS_UNREADABLE");
});

await test("a Transfer with a short data field is refused rather than read as zero", () => {
  const log = { ...transferLog({ from: W, to: OTHER }), data: "0x1234" };
  const r = classifyLog({ log, wallet: W, meta: meta6 });
  eq(r.ok, false);
  eq(r.reason, "TRANSFER_AMOUNT_UNREADABLE");
});

await test("an unknown event topic is refused instead of being bucketed as activity", () => {
  const log = { ...transferLog({ from: W, to: OTHER }), topics: ["0x" + "11".repeat(32), toTopicWord(W), toTopicWord(OTHER)] };
  const r = classifyLog({ log, wallet: W, meta: meta6 });
  eq(r.ok, false);
  eq(r.reason, "UNRECOGNISED_EVENT");
});

suite("unknown decimals");

await test("a movement with unreadable metadata keeps its raw amount and refuses to invent a scale", () => {
  const r = classifyLog({ log: transferLog({ from: W, to: OTHER, value: 12345n }), wallet: W, meta: null });
  eq(r.ok, true);
  eq(r.entry.amountRaw, "12345");
  eq(r.entry.amount, null);
  eq(r.entry.asset.resolved, false);
  eq(r.entry.asset.decimals, null);
});

await test("metadata whose decimals are explicitly null is treated as unresolved", () => {
  const r = classifyLog({ log: transferLog({ from: W, to: OTHER, value: 1n }), wallet: W, meta: { symbol: "X", decimals: null } });
  eq(r.entry.asset.resolved, false);
  eq(r.entry.amount, null);
});

suite("approvals");

await test("an ordinary allowance is recorded with its amount", () => {
  const r = classifyLog({ log: approvalLog({ owner: W, spender: OTHER, value: 412502n }), wallet: W, meta: meta6 });
  eq(r.ok, true);
  eq(r.entry.kind, KIND.APPROVAL_GRANTED);
  eq(r.entry.amount, "0.412502");
  eq(r.entry.unlimited, false);
});

await test("an unlimited allowance is flagged and carries no finite amount", () => {
  const r = classifyLog({ log: approvalLog({ owner: W, spender: OTHER, value: UNLIMITED_ALLOWANCE }), wallet: W, meta: meta6 });
  eq(r.entry.kind, KIND.APPROVAL_UNLIMITED);
  eq(r.entry.unlimited, true);
  eq(r.entry.amount, null);
  eq(r.entry.amountRaw, UNLIMITED_ALLOWANCE.toString());
});

await test("a zero allowance is a revocation, not a grant of zero", () => {
  const r = classifyLog({ log: approvalLog({ owner: W, spender: OTHER, value: 0n }), wallet: W, meta: meta6 });
  eq(r.entry.kind, KIND.APPROVAL_REVOKED);
});

await test("an approval by someone else is not this wallet's approval", () => {
  const r = classifyLog({ log: approvalLog({ owner: OTHER, spender: W, value: 1n }), wallet: W, meta: meta6 });
  eq(r.ok, false);
  eq(r.reason, "LOG_NOT_INVOLVING_WALLET");
});

await test("ApprovalForAll records an operator grant and its flag", () => {
  const log = {
    address: TOKEN,
    topics: [EVENTS.APPROVAL_FOR_ALL, toTopicWord(W), toTopicWord(OTHER)],
    data: word(1),
    transactionHash: "0xddd",
    logIndex: "0x0",
    blockNumber: "0x10",
  };
  const r = classifyLog({ log, wallet: W, meta: null });
  eq(r.ok, true);
  eq(r.entry.kind, KIND.APPROVAL_FOR_ALL);
  eq(r.entry.approved, true);
  eq(r.entry.operator, OTHER);
});

suite("transactions");

const tx = (over = {}) => ({
  hash: "0x" + "ab".repeat(32),
  from: W,
  to: OTHER,
  value: "0x0",
  input: "0x",
  blockNumber: "0x10",
  transactionIndex: "0x0",
  ...over,
});

await test("a plain native send is an outflow", () => {
  const out = classifyTx({ tx: tx({ value: "0xde0b6b3a7640000" }), wallet: W, status: 1, gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00" });
  eq(out.length, 1);
  eq(out[0].kind, KIND.NATIVE_OUT);
  eq(out[0].amount, "1");
  eq(out[0].feeRaw, "21000000000000");
});

await test("value attached to a contract call is still a native outflow", () => {
  // The defect this replaces: the scaffold only counted value when input was "0x".
  const out = classifyTx({ tx: tx({ value: "0xde0b6b3a7640000", input: "0x38ed1739" + "00".repeat(64) }), wallet: W, status: 1 });
  eq(out.length, 1);
  eq(out[0].kind, KIND.NATIVE_OUT);
  eq(out[0].amount, "1");
});

await test("a reverted transaction is not a transfer, and keeps its gas", () => {
  const out = classifyTx({ tx: tx({ value: "0xde0b6b3a7640000" }), wallet: W, status: 0, gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00" });
  eq(out.length, 1);
  eq(out[0].kind, KIND.FAILED);
  // The amount that was attempted is kept as valueRaw. It is deliberately not
  // called amountRaw, because nothing moved and totals must not pick it up.
  eq(out[0].valueRaw, "1000000000000000000");
  eq(out[0].amountRaw, undefined);
  eq(out[0].feeRaw, "21000000000000");
});

await test("an unreadable receipt is unknown, never an assumed success", () => {
  const out = classifyTx({ tx: tx({ value: "0xde0b6b3a7640000" }), wallet: W, status: null });
  eq(out[0].kind, KIND.UNKNOWN_STATUS);
  eq(out[0].amountRaw, undefined, "an unknown outcome must not contribute an amount");
});

await test("a zero-value call becomes a call, with the selector and target kept", () => {
  const out = classifyTx({ tx: tx({ input: "0xdb3e2198" + "00".repeat(32) }), wallet: W, status: 1 });
  eq(out[0].kind, KIND.CONTRACT_CALL);
  eq(out[0].selector, "0xdb3e2198");
  eq(out[0].to, OTHER);
  eq(out[0].callKind, "UNCLASSIFIED");
});

await test("a recognised selector is still only a call, not a movement", () => {
  const out = classifyTx({ tx: tx({ input: "0xa9059cbb" + "00".repeat(64) }), wallet: W, status: 1 });
  eq(out[0].kind, KIND.CONTRACT_CALL);
  eq(out[0].callKind, "TOKEN_TRANSFER_CALL");
  // No amount is claimed here: the movement is recorded from the log instead.
  eq(out[0].amountRaw, undefined);
});

await test("a self-send is recorded as such and moves nothing net", () => {
  const out = classifyTx({ tx: tx({ to: W, value: "0xde0b6b3a7640000" }), wallet: W, status: 1 });
  eq(out.length, 1);
  eq(out[0].kind, KIND.NATIVE_SELF);
});

await test("a contract creation with value is an outflow to no recipient", () => {
  const out = classifyTx({ tx: tx({ to: null, value: "0x1" }), wallet: W, status: 1 });
  eq(out[0].kind, KIND.NATIVE_OUT);
  eq(out[0].to, null);
});

await test("incoming native value is an inflow and charges the sender the gas", () => {
  const out = classifyTx({ tx: tx({ from: OTHER, to: W, value: "0xde0b6b3a7640000" }), wallet: W, status: 1, gasUsed: "0x5208", effectiveGasPrice: "0x1" });
  eq(out[0].kind, KIND.NATIVE_IN);
  eq(out[0].amount, "1");
  eq(out[0].feeRaw, null, "the recipient does not pay the fee");
});

await test("a transaction that does not touch the wallet yields nothing", () => {
  const out = classifyTx({ tx: tx({ from: OTHER, to: OTHER, value: "0x1" }), wallet: W, status: 1 });
  eq(out.length, 0);
});

suite("entry identity");

await test("two logs in one transaction are two entries, not one", () => {
  const a = { txHash: "0xab", logIndex: 0, kind: KIND.TOKEN_OUT };
  const b = { txHash: "0xab", logIndex: 1, kind: KIND.TOKEN_OUT };
  assert(entryKey(a) !== entryKey(b), "distinct logs must not collapse");
});

await test("the same log reached twice is one entry", () => {
  const a = { txHash: "0xab", logIndex: 3, kind: KIND.TOKEN_IN };
  const b = { txHash: "0xab", logIndex: 3, kind: KIND.TOKEN_IN };
  eq(entryKey(a), entryKey(b));
});

finish(import.meta.url);
