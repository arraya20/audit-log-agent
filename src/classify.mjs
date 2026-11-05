// Turning chain data into audit entries.
//
// The organising principle: a movement of money is what gets recorded, and it is
// read from the place the chain cannot misrepresent. Token movements come from
// Transfer logs, which exist only when the transaction succeeded. Native
// movements come from transaction value. Nothing is inferred from a selector,
// because a selector tells you what a function is called, not what it did.
//
// The scaffold this replaces classified a transaction by its 4-byte selector and
// called two hardcoded router selectors "DEX Swap". That label was a guess with
// no ledger behind it. Here a swap simply appears as what it is: tokens out and
// tokens in.
//
// Anything that cannot be decoded does not get a category. It goes into
// `unresolved` with a reason, and its asset is excluded from totals, because an
// amount with unknown decimals cannot be added to anything.

import { EVENTS, CALL_KINDS, UNLIMITED_ALLOWANCE } from "./topics.mjs";
import { wordToBigInt, hexToBigInt, isHex, wordAt, strip0x } from "./hex.mjs";
import { formatUnits } from "./numbers.mjs";
import { normalizeAddress } from "./address.mjs";

export const KIND = Object.freeze({
  TOKEN_OUT: "TOKEN_OUT",
  TOKEN_IN: "TOKEN_IN",
  NFT_OUT: "NFT_OUT",
  NFT_IN: "NFT_IN",
  APPROVAL_GRANTED: "APPROVAL_GRANTED",
  APPROVAL_UNLIMITED: "APPROVAL_UNLIMITED",
  APPROVAL_REVOKED: "APPROVAL_REVOKED",
  APPROVAL_FOR_ALL: "APPROVAL_FOR_ALL",
  NATIVE_OUT: "NATIVE_OUT",
  NATIVE_IN: "NATIVE_IN",
  NATIVE_SELF: "NATIVE_SELF",
  CONTRACT_CALL: "CONTRACT_CALL",
  FAILED: "FAILED",
  UNKNOWN_STATUS: "UNKNOWN_STATUS",
});

const ZERO = "0x0000000000000000000000000000000000000000";

function addressFromTopic(topic) {
  if (!isHex(topic) || strip0x(topic).length !== 64) return null;
  const body = strip0x(topic).slice(24);
  if (!/^[0-9a-fA-F]{40}$/.test(body)) return null;
  return normalizeAddress("0x" + body);
}

function assetOf(address, meta) {
  if (!meta || meta.decimals === null || meta.decimals === undefined) {
    return { address, symbol: null, decimals: null, resolved: false };
  }
  return { address, symbol: meta.symbol ?? null, decimals: meta.decimals, resolved: true };
}

/**
 * Classify one log.
 *
 * `meta` is the token metadata the caller managed to read ({symbol, decimals}) or
 * null when it could not. A null meta does not discard the movement; it records
 * it with the amount in raw base units and marks the asset unresolved so totals
 * cannot silently absorb it.
 */
export function classifyLog({ log, wallet, meta = null }) {
  const w = normalizeAddress(wallet);
  const topic0 = log?.topics?.[0];
  const token = log?.address ? normalizeAddress(log.address) : null;
  if (!token) return { ok: false, reason: "LOG_WITHOUT_ADDRESS" };

  const base = {
    token,
    txHash: log.transactionHash ?? null,
    logIndex: typeof log.logIndex === "string" ? Number(log.logIndex) : log.logIndex ?? null,
    blockNumber: typeof log.blockNumber === "string" ? Number(log.blockNumber) : log.blockNumber ?? null,
  };

  if (topic0 === EVENTS.TRANSFER) {
    // ERC-721 Transfer carries tokenId as a fourth topic. Treating its uint256 as
    // a fungible amount would invent a quantity of money that does not exist.
    const isNft = Array.isArray(log.topics) && log.topics.length === 4;
    if (!Array.isArray(log.topics) || log.topics.length < 3) {
      return { ok: false, reason: "TRANSFER_TOPICS_INCOMPLETE", ...base };
    }
    const from = addressFromTopic(log.topics[1]);
    const to = addressFromTopic(log.topics[2]);
    if (!from || !to) return { ok: false, reason: "TRANSFER_ADDRESS_UNREADABLE", ...base };

    if (isNft) {
      const tokenId = wordToBigInt(log.topics[3]);
      const direction = from === w ? KIND.NFT_OUT : to === w ? KIND.NFT_IN : null;
      if (!direction) return { ok: false, reason: "LOG_NOT_INVOLVING_WALLET", ...base };
      return { ok: true, entry: { kind: direction, asset: assetOf(token, meta), tokenId: tokenId === null ? null : tokenId.toString(), counterparty: direction === KIND.NFT_OUT ? to : from, ...base } };
    }

    const value = isHex(log.data) && strip0x(log.data).length >= 64 ? wordToBigInt(wordAt(log.data, 0)) : null;
    if (value === null) return { ok: false, reason: "TRANSFER_AMOUNT_UNREADABLE", ...base };

    const direction = from === w ? KIND.TOKEN_OUT : to === w ? KIND.TOKEN_IN : null;
    if (!direction) return { ok: false, reason: "LOG_NOT_INVOLVING_WALLET", ...base };

    const asset = assetOf(token, meta);
    return {
      ok: true,
      entry: {
        kind: direction,
        asset,
        amountRaw: value.toString(),
        amount: asset.resolved ? formatUnits(value, asset.decimals) : null,
        counterparty: direction === KIND.TOKEN_OUT ? to : from,
        ...base,
      },
    };
  }

  if (topic0 === EVENTS.APPROVAL) {
    if (!Array.isArray(log.topics) || log.topics.length < 3) {
      return { ok: false, reason: "APPROVAL_TOPICS_INCOMPLETE", ...base };
    }
    const owner = addressFromTopic(log.topics[1]);
    const spender = addressFromTopic(log.topics[2]);
    if (!owner || !spender) return { ok: false, reason: "APPROVAL_ADDRESS_UNREADABLE", ...base };
    if (owner !== w) return { ok: false, reason: "LOG_NOT_INVOLVING_WALLET", ...base };

    const value = isHex(log.data) && strip0x(log.data).length >= 64 ? wordToBigInt(wordAt(log.data, 0)) : null;
    if (value === null) return { ok: false, reason: "APPROVAL_AMOUNT_UNREADABLE", ...base };

    const asset = assetOf(token, meta);
    // An unlimited allowance is the single most consequential thing a wallet can
    // grant, and it is the thing a compliance log must never round away.
    const kind = value === 0n ? KIND.APPROVAL_REVOKED : value === UNLIMITED_ALLOWANCE ? KIND.APPROVAL_UNLIMITED : KIND.APPROVAL_GRANTED;
    return {
      ok: true,
      entry: {
        kind,
        asset,
        amountRaw: value.toString(),
        amount: asset.resolved && value !== UNLIMITED_ALLOWANCE ? formatUnits(value, asset.decimals) : null,
        unlimited: value === UNLIMITED_ALLOWANCE,
        spender,
        ...base,
      },
    };
  }

  if (topic0 === EVENTS.APPROVAL_FOR_ALL) {
    if (!Array.isArray(log.topics) || log.topics.length < 3) {
      return { ok: false, reason: "APPROVAL_TOPICS_INCOMPLETE", ...base };
    }
    const owner = addressFromTopic(log.topics[1]);
    const operator = addressFromTopic(log.topics[2]);
    if (!owner || !operator) return { ok: false, reason: "APPROVAL_ADDRESS_UNREADABLE", ...base };
    if (owner !== w) return { ok: false, reason: "LOG_NOT_INVOLVING_WALLET", ...base };
    const flag = isHex(log.data) && strip0x(log.data).length >= 64 ? wordToBigInt(wordAt(log.data, 0)) : null;
    if (flag === null) return { ok: false, reason: "APPROVAL_FLAG_UNREADABLE", ...base };
    return {
      ok: true,
      entry: {
        kind: KIND.APPROVAL_FOR_ALL,
        asset: assetOf(token, meta),
        approved: flag !== 0n,
        operator,
        ...base,
      },
    };
  }

  // A log we do not understand is not a log we can count.
  return { ok: false, reason: "UNRECOGNISED_EVENT", topic0: topic0 ?? null, ...base };
}

/**
 * Classify one transaction the wallet sent, or one that paid the wallet.
 *
 * `status` is the receipt status: 1, 0, or null when the receipt could not be
 * read. null is not treated as success — a transaction whose outcome is unknown
 * becomes UNKNOWN_STATUS, which keeps its money out of the totals.
 */
export function classifyTx({ tx, wallet, status, gasUsed = null, effectiveGasPrice = null }) {
  const w = normalizeAddress(wallet);
  const from = tx?.from ? normalizeAddress(tx.from) : null;
  const to = tx?.to ? normalizeAddress(tx.to) : null;
  // A transaction value is a quantity, not a padded word, so it is parsed with
  // hexToBigInt. Reading it as a 32-byte word silently yields nothing.
  const parsedValue = hexToBigInt(tx?.value);
  const value = parsedValue === null ? 0n : parsedValue;
  const input = isHex(tx?.input) ? tx.input : "0x";
  const selector = strip0x(input).length >= 8 ? "0x" + strip0x(input).slice(0, 8).toLowerCase() : null;
  const base = {
    txHash: tx?.hash ?? null,
    blockNumber: typeof tx?.blockNumber === "string" ? Number(tx.blockNumber) : tx?.blockNumber ?? null,
    txIndex: typeof tx?.transactionIndex === "string" ? Number(tx.transactionIndex) : tx?.transactionIndex ?? null,
  };

  const feeRaw = gasUsed !== null && effectiveGasPrice !== null ? BigInt(gasUsed) * BigInt(effectiveGasPrice) : null;
  const fee = { feeRaw: feeRaw === null ? null : feeRaw.toString() };

  const sent = from === w;
  const received = to === w && from !== w;
  if (!sent && !received) return [];

  // Unknown outcome: reported, never counted.
  if (status === null || status === undefined) {
    return [{ kind: KIND.UNKNOWN_STATUS, ...base, ...fee }];
  }
  if (status === 0) {
    // A reverted transaction moved nothing but still cost gas. Calling it a
    // transfer would be the same class of mistake as the scaffold's.
    return [{ kind: KIND.FAILED, ...base, ...fee, valueRaw: value.toString(), selector, to, counterparty: to }];
  }

  const out = [];
  const isNative = value > 0n;

  if (sent) {
    if (to === w) {
      out.push({ kind: KIND.NATIVE_SELF, ...base, ...fee, amountRaw: value.toString(), amount: formatUnits(value, 18), counterparty: w });
    } else if (isNative) {
      // Value is a native transfer even when the calldata is a contract call.
      // The scaffold only counted this when input was exactly "0x", which loses
      // every payable function call.
      out.push({ kind: KIND.NATIVE_OUT, ...base, ...fee, amountRaw: value.toString(), amount: formatUnits(value, 18), to, counterparty: to });
    } else {
      out.push({
        kind: KIND.CONTRACT_CALL,
        ...base,
        ...fee,
        to,
        counterparty: to,
        selector,
        callKind: selector ? CALL_KINDS[selector] ?? "UNCLASSIFIED" : "NO_CALLDATA",
      });
    }
  }

  if (received && isNative) {
    // Incoming value to the wallet. `status` here belongs to the sender's
    // transaction, which is what determines whether the money arrived.
    // feeRaw is null rather than absent: the recipient never pays the sender's
    // gas, and a consumer reading the field should not have to distinguish
    // "absent" from "zero".
    out.push({ kind: KIND.NATIVE_IN, ...base, feeRaw: null, amountRaw: value.toString(), amount: formatUnits(value, 18), from, counterparty: from });
  }

  if (out.length === 0 && received && !isNative) {
    // A zero-value call to the wallet delivers nothing; recorded so the count of
    // transactions reconciles, but it carries no money.
    out.push({ kind: KIND.CONTRACT_CALL, ...base, feeRaw: null, to: w, selector, callKind: "INBOUND_NO_VALUE" });
  }

  return out;
}

/** Stable identity for an entry, used to make double counting impossible. */
export function entryKey(e) {
  if (e.logIndex !== undefined && e.logIndex !== null) return `${e.txHash}:${e.logIndex}:${e.kind}`;
  return `${e.txHash}:${e.txIndex ?? "?"}:${e.kind}`;
}
