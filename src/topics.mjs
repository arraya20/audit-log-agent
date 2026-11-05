// Event topics and function selectors, derived from their signatures.
//
// These are not typed as hex literals. A wrong topic silently matches nothing,
// and an audit log that finds nothing looks exactly like a wallet that did
// nothing — so the constants are computed by keccak and checked against known
// vectors in the test suite.

import { topicOf, selectorOf } from "./keccak.mjs";

export const EVENTS = Object.freeze({
  // ERC-20 and ERC-721 share this signature; ERC-721 puts tokenId in topic 3.
  TRANSFER: topicOf("Transfer(address,address,uint256)"),
  // ERC-20 allowance change.
  APPROVAL: topicOf("Approval(address,address,uint256)"),
  // ERC-721 operator grant/revoke.
  APPROVAL_FOR_ALL: topicOf("ApprovalForAll(address,address,bool)"),
  // Wrapped-native deposit/withdrawal, the two events that move the underlying.
  DEPOSIT: topicOf("Deposit(address,uint256)"),
  WITHDRAWAL: topicOf("Withdrawal(address,uint256)"),
});

export const SELECTORS = Object.freeze({
  TRANSFER: selectorOf("transfer(address,uint256)"),
  TRANSFER_FROM: selectorOf("transferFrom(address,address,uint256)"),
  APPROVE: selectorOf("approve(address,uint256)"),
  INCREASE_ALLOWANCE: selectorOf("increaseAllowance(address,uint256)"),
  DECREASE_ALLOWANCE: selectorOf("decreaseAllowance(address,uint256)"),
  SET_APPROVAL_FOR_ALL: selectorOf("setApprovalForAll(address,bool)"),
  SAFE_TRANSFER_FROM: selectorOf("safeTransferFrom(address,address,uint256)"),
  // Token metadata. Read, never trusted from a list.
  DECIMALS: selectorOf("decimals()"),
  SYMBOL: selectorOf("symbol()"),
});

/** Selectors whose meaning we actually decode, mapped to a call kind. */
export const CALL_KINDS = Object.freeze({
  [SELECTORS.TRANSFER]: "TOKEN_TRANSFER_CALL",
  [SELECTORS.TRANSFER_FROM]: "TOKEN_TRANSFER_FROM_CALL",
  [SELECTORS.APPROVE]: "APPROVAL_CALL",
  [SELECTORS.INCREASE_ALLOWANCE]: "APPROVAL_CALL",
  [SELECTORS.DECREASE_ALLOWANCE]: "APPROVAL_CALL",
  [SELECTORS.SET_APPROVAL_FOR_ALL]: "APPROVAL_CALL",
  [SELECTORS.SAFE_TRANSFER_FROM]: "TOKEN_TRANSFER_FROM_CALL",
});

export const UNLIMITED_ALLOWANCE = (1n << 256n) - 1n;
