// Minimal ABI decoding for the few things this agent reads: token metadata and
// event payloads.
//
// Every decoder returns null instead of guessing. A symbol we cannot decode is
// reported as unknown and the asset is flagged; substituting "UNKNOWN" or
// assuming 18 decimals would put an invented number into an accounting record.

import { strip0x, wordAt, wordToBigInt, wordToAddress } from "./hex.mjs";

/** Decode a uint256 return value. */
export function decodeUint(returnData) {
  if (typeof returnData !== "string" || strip0x(returnData).length < 64) return null;
  return wordToBigInt(wordAt(returnData, 0));
}

/** Decode a uint8 (e.g. decimals()) with a sanity range. */
export function decodeUint8(returnData) {
  const value = decodeUint(returnData);
  if (value == null) return null;
  if (value < 0n || value > 255n) return null;
  return Number(value);
}

/**
 * Decode symbol()/name(), which is either an ABI string or a bytes32.
 * Both shapes are common on older tokens, so both are accepted; anything else
 * is null rather than a guess.
 */
export function decodeString(returnData) {
  if (typeof returnData !== "string") return null;
  const body = strip0x(returnData);
  if (body.length < 64) return null;

  // bytes32: a single word whose trailing bytes are zero padding.
  if (body.length === 64) {
    return trimTrailingNul(body);
  }

  // dynamic string: offset word, then length word, then the bytes
  const offset = Number(wordToBigInt(wordAt(body, 0)));
  if (!Number.isFinite(offset) || offset % 32 !== 0) return null;
  const lengthWord = wordAt(body, offset / 32);
  if (lengthWord == null) return null;
  const length = Number(wordToBigInt(lengthWord));
  if (!Number.isFinite(length) || length < 0 || length > 1024) return null;

  const start = (offset + 32) * 2;
  const hex = body.slice(start, start + length * 2);
  if (hex.length !== length * 2) return null;
  return hexToUtf8(hex);
}

function trimTrailingNul(hex) {
  const trimmed = hex.replace(/(00)+$/, "");
  if (trimmed.length === 0) return null;
  if (trimmed.length % 2 !== 0) return null;
  return hexToUtf8(trimmed);
}

function hexToUtf8(hex) {
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Token symbols are short printable strings. Control characters mean we
    // decoded the wrong thing, not that the token is exotic.
    if (/[\u0000-\u001f]/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/** Decode an indexed address topic. */
export function decodeTopicAddress(topic) {
  return wordToAddress(topic);
}

/** Decode the uint256 in a Transfer/Approval log's data word 0. */
export function decodeLogUint(data) {
  const word = wordAt(data, 0);
  if (word == null) return null;
  return wordToBigInt(word);
}
