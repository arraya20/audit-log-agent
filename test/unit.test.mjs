
// Pure-function tests. These are logic tests: hand-built inputs are appropriate
// here because the subject is the decoder, not the chain. Anything that claims to
// describe real activity is tested in report.test.mjs against recorded fixtures.
import { suite, test, eq, deepEq, assert, finish } from "./runner.mjs";
import { keccak256Hex, selectorOf, topicOf } from "../src/keccak.mjs";
import { EVENTS, SELECTORS, UNLIMITED_ALLOWANCE } from "../src/topics.mjs";
import { formatUnits } from "../src/numbers.mjs";
import { normalizeAddress, toChecksumAddress, isAddress, isZeroAddress } from "../src/address.mjs";
import { decodeUint, decodeString, decodeTopicAddress } from "../src/abi.mjs";
import { blocksForHours, maxHoursForBudget, publicConfig, BUDGET } from "../src/config.mjs";

suite("keccak");

await test("matches the published empty-string digest", () => {
  eq(keccak256Hex(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
});

await test("matches the published 'abc' digest", () => {
  eq(keccak256Hex("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
});

await test("handles input longer than the 136-byte rate", () => {
  // A single-block implementation passes the short vectors and fails this one.
  const d = keccak256Hex("a".repeat(200));
  eq(d.length, 66);
  assert(d !== keccak256Hex("a".repeat(199)), "digest must change with input length");
});

await test("derives the ERC-20 transfer selector", () => {
  eq(selectorOf("transfer(address,uint256)"), "0xa9059cbb");
});

suite("topics");

await test("Transfer and Approval match their canonical topics", () => {
  eq(EVENTS.TRANSFER, "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  eq(EVENTS.APPROVAL, "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925");
  eq(EVENTS.APPROVAL_FOR_ALL, "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31");
});

await test("topics are distinct, so one cannot stand in for another", () => {
  const list = Object.values(EVENTS);
  eq(new Set(list).size, list.length);
});

suite("numbers");

await test("formats eighteen decimals without losing a digit", () => {
  eq(formatUnits(1234567890123456789n, 18), "1.234567890123456789");
  eq(formatUnits(1n, 18), "0.000000000000000001");
  eq(formatUnits(1000000000000000000n, 18), "1");
});

await test("formats a uint256 maximum exactly", () => {
  const max = UNLIMITED_ALLOWANCE;
  eq(formatUnits(max, 18), "115792089237316195423570985008687907853269984665640564039457.584007913129639935");
});

await test("formats zero decimals and handles the sign", () => {
  eq(formatUnits(42n, 0), "42");
  eq(formatUnits(-1500000n, 6), "-1.5");
  eq(formatUnits(0n, 6), "0");
});

await test("six decimals stay exact where a float would not", () => {
  // 0.1 + 0.2 in float is the canonical counter-example; in BigInt it is not.
  const a = 100000n;
  const b = 200000n;
  eq(formatUnits(a + b, 6), "0.3");
});

suite("addresses");

await test("normalises case and rejects malformed input", () => {
  eq(normalizeAddress("0x1F3546a29EeC2102c8d52E21a45114124014c85C"), "0x1f3546a29eec2102c8d52e21a45114124014c85c");
  eq(isAddress("0x1f3546a29eec2102c8d52e21a45114124014c85c"), true);
  eq(isAddress("0x1f3546a29eec2102c8d52e21a45114124014c85"), false);
  eq(isAddress("1f3546a29eec2102c8d52e21a45114124014c85c"), false);
  eq(isAddress("0xzz3546a29eec2102c8d52e21a45114124014c85c"), false);
});

await test("derives the EIP-55 checksum rather than trusting input casing", () => {
  eq(toChecksumAddress("0x1f3546a29eec2102c8d52e21a45114124014c85c"), "0x1F3546a29EeC2102c8d52E21a45114124014c85C");
  eq(toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
});

await test("recognises the zero address, which is never a real counterparty", () => {
  eq(isZeroAddress("0x0000000000000000000000000000000000000000"), true);
  eq(isZeroAddress("0x0000000000000000000000000000000000000001"), false);
});

suite("abi decoding");

await test("reads a uint word", () => {
  eq(decodeUint("0x0000000000000000000000000000000000000000000000000000000000000012"), 18n);
});

await test("reads a dynamic string symbol", () => {
  const data = "0x" +
    "0000000000000000000000000000000000000000000000000000000000000020" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "5750524f53000000000000000000000000000000000000000000000000000000";
  eq(decodeString(data), "WPROS");
});

await test("reads a bytes32 symbol", () => {
  const data = "0x" + "4d4b520000000000000000000000000000000000000000000000000000000000";
  eq(decodeString(data), "MKR");
});

await test("returns null for metadata it cannot parse instead of inventing a name", () => {
  eq(decodeString("0x"), null);
  eq(decodeString("0x1234"), null);
  eq(decodeString(null), null);
  // A length field that runs past the buffer must not be sliced into nonsense.
  eq(decodeString("0x" + "0000000000000000000000000000000000000000000000000000000000000020" + "00000000000000000000000000000000000000000000000000000000000000ff"), null);
});

await test("reads an indexed address topic and rejects a bad one", () => {
  eq(decodeTopicAddress("0x0000000000000000000000001f3546a29eec2102c8d52e21a45114124014c85c"), "0x1f3546a29eec2102c8d52e21a45114124014c85c");
  eq(decodeTopicAddress("0x1234"), null);
});

suite("config");

await test("converts hours to blocks using the measured block time", () => {
  eq(blocksForHours(1), Math.round(3600 / 1.05));
  eq(blocksForHours(0.25), Math.round(900 / 1.05));
});

await test("the advertised maximum window fits the block budget", () => {
  assert(maxHoursForBudget() > 1, "budget should allow more than an hour");
  assert(blocksForHours(maxHoursForBudget()) <= BUDGET.maxBlocks + 1, "advertised max must fit the budget");
});

await test("public config exposes limits but no internals", () => {
  const cfg = publicConfig();
  eq(cfg.chain.id, 1672);
  assert(cfg.window.maxBlocks > 0, "maxBlocks must be advertised");
  assert(!JSON.stringify(cfg).includes("rpc"), "the RPC url should not be advertised as policy");
});

finish(import.meta.url);
