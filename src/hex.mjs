// Hex and 32-byte word helpers.
//
// Everything here works on strings and BigInt. No Number, ever: a uint256 does
// not fit in a double, and a token amount that loses precision is not an audit
// record.

export function strip0x(value) {
  const text = String(value ?? "");
  return text.startsWith("0x") || text.startsWith("0X") ? text.slice(2) : text;
}

// Parse a hex quantity of ANY length, odd or even.
//
// This exists because `isHex` requires an even number of digits, and a uint256
// quantity is not required to have one: "0xde0b6b3a7640000" (1 PROS) has 15.
// Gating value parsing on isHex therefore turned every native transfer into zero,
// silently, which is the worst possible failure for a ledger. Quantities go
// through here; only genuine 32-byte words go through wordToBigInt.
export function hexToBigInt(value) {
  const body = strip0x(value);
  if (body.length === 0 || body.length > 64 || !/^[0-9a-fA-F]+$/.test(body)) return null;
  return BigInt("0x" + body);
}

export function isHex(value) {
  const body = strip0x(value);
  return body.length > 0 && body.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(body);
}

export function bytesToHex(bytes) {
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Left-pad an address to a 32-byte topic word. */
export function addressToWord(address) {
  return "0x" + strip0x(address).toLowerCase().padStart(64, "0");
}

/** Read the 32-byte word at `index` from calldata or log data (0-based). */
export function wordAt(data, index) {
  const body = strip0x(data);
  const start = index * 64;
  if (body.length < start + 64) return null;
  return body.slice(start, start + 64);
}

export function wordToBigInt(word) {
  if (word == null) return null;
  return BigInt("0x" + strip0x(word));
}

/** The low 20 bytes of a 32-byte word, as a lowercase address. */
export function wordToAddress(word) {
  if (word == null) return null;
  const body = strip0x(word);
  if (body.length !== 64) return null;
  return "0x" + body.slice(24).toLowerCase();
}

/** The 4-byte selector of calldata, or null when there is no calldata. */
export function selectorOfCalldata(data) {
  const body = strip0x(data);
  if (body.length < 8) return null;
  return "0x" + body.slice(0, 8).toLowerCase();
}

export function sameHex(a, b) {
  return strip0x(a).toLowerCase() === strip0x(b).toLowerCase();
}
