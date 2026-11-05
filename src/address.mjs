// Addresses: normalise, validate, and derive EIP-55 casing.
//
// Checksummed addresses are never typed by hand anywhere in this project. They
// are derived from a lowercase constant, so a mistyped capital letter cannot
// create a plausible-looking address that points somewhere else.

import { keccak256Hex } from "./keccak.mjs";
import { strip0x } from "./hex.mjs";

// The 0x prefix is required, not optional. A bare 40-character hex string is
// ambiguous — it could be a hash fragment or a private key's tail — and guessing
// is exactly what an audit tool should not do with an address.
const ADDRESS_BODY = /^0x[0-9a-fA-F]{40}$/;

/** Lowercase an address, rejecting anything that is not 20 bytes of hex. */
export function normalizeAddress(value) {
  if (typeof value !== "string") throw new Error("address must be a string");
  if (!ADDRESS_BODY.test(value)) throw new Error(`not an address: ${value}`);
  return `0x${value.slice(2).toLowerCase()}`;
}

export function isAddress(value) {
  try {
    normalizeAddress(value);
    return true;
  } catch {
    return false;
  }
}

/** EIP-55 mixed-case form. */
export function toChecksumAddress(value) {
  const body = strip0x(normalizeAddress(value));
  const hash = keccak256Hex(body).slice(2);
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
  }
  return out;
}

/** True when the address is the zero address, which is never a real counterparty. */
export function isZeroAddress(value) {
  try {
    return strip0x(normalizeAddress(value)) === "0".repeat(40);
  } catch {
    return false;
  }
}

/** The address Word form used in log topics. */
export function toTopicWord(value) {
  return `0x${strip0x(normalizeAddress(value)).padStart(64, "0")}`;
}

export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
