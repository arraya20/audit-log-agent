---
name: pharos-audit-log
description: Produce an exact, fail-closed ledger of one wallet's Pharos activity — movements, approvals, calls and fees.
version: 1.0.0
---

# Pharos Audit Log

## Safety boundary

Read-only. No signing, no keys, no execution, no valuation.

## Input

`POST /api/audit` takes `wallet` and optional `hours`. Nothing else. The caller
may not supply transactions, categories, amounts or a verdict — every fact in the
report comes from chain data this service reads.

## Procedure

1. Normalise the address once, up front, and require the `0x` prefix. Reject
   ambiguous input rather than repairing it.
2. Resolve the window from the chain's own block time. A window larger than the
   **4000 block** budget is **rejected**, not truncated: a silently clipped
   window produces an audit that looks complete and is not.
3. Read every block body in range for transactions touching the wallet, and the
   transfer and approval logs for it.
4. Read receipts per transaction. Fees come from the receipt, for the sender
   only. A missing receipt raises `unverified` and lowers `completeness` — it does
   not contribute zero.
5. Classify each entry: token in/out, native in/out, approval (granted,
   unlimited, revoked, for-all), contract call, or `UNCLASSIFIED` for an unknown
   selector. An unknown selector is never guessed at.
6. Read token decimals from the chain. A token whose decimals cannot be read is
   **excluded from totals** and named, because an amount without a scale is not
   an amount.
7. A chunk that fails after the transport's retries becomes a declared gap over
   its range, and the report says `PARTIAL`. It does not take the whole audit
   down, and it does not disappear.

## Output requirement

Every number is a string in exact base units. No floats, no rounding, no price
applied, and totals across different assets are never added together.

`completeness` is `COMPLETE` only when nothing was missed. It drops to `PARTIAL`
with reasons for any scan gap, undecodable log, unreadable decimals, excluded
asset, unknown transaction status, or unreadable receipt. A `PARTIAL` report is
still a `200`: the audit ran, and it is telling you where it is blind.

Native net is reported both ways — `net` over movements only, and `netAfterFees`
which subtracts gas. `netAfterFeesExact` is false when any receipt was
unreadable, so the figure never overstates itself.

## What it does not do

No valuation, no USD conversion, no risk score. No intent inferred from a
function selector. No trace-based internal transfers: value moved *by a contract*
to the wallet is invisible in block bodies and logs, and the public RPC serves no
traces. That limitation is stated in every report rather than silently omitted.
