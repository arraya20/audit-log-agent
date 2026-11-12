# audit log agent

Wallet activity audit log for Pharos Pacific Mainnet (chain 1672). Give it an
address and a time window; it reads the blocks, logs and receipts in that window
and reports what moved, what was approved, what was called, and what it could not
read.

The last part matters. Most tools in this space answer "no suspicious activity"
when they mean "I did not look". This one distinguishes the two.

## What it does

For a window of blocks it collects:

- **movements** — native transfers, token transfers in and out, with the
  counterparty and, when a router was involved, the contract that was actually
  called
- **allowances** — `Approval` and `ApprovalForAll` grants, including the unlimited
  case, which is reported as `unlimited` rather than as a large number
- **calls** — contract calls that move no value, with the raw selector and an
  honest reading of whether that selector is known
- **fees** — gas actually paid, from `gasUsed * effectiveGasPrice` on the wallet's
  own transactions
- **totals** — per-asset inflow, outflow and net, in exact base units

Every number is a string. Nothing is a float, nothing is rounded, no price is
applied, and totals across different assets are never added together.

## What it does not do

- no valuation, no USD conversion, no risk score
- no inference of intent from a function selector. An unknown selector is
  reported as `UNCLASSIFIED`; guessing that `0xdb3e2198` is a swap would be a
  fabrication
- no trace-based internal transfers. Native value moved *by a contract* to the
  wallet is invisible in block bodies and logs, and the public RPC does not serve
  traces. This is stated in every report rather than silently omitted

## The verdict

`completeness` is `COMPLETE` only when nothing was missed. It drops to `PARTIAL`
with reasons when any of the following happens: a scan gap, an undecodable log, a
token whose decimals could not be read, an asset excluded from totals, a
transaction with unknown status, or a receipt that could not be read.

A `PARTIAL` report is still a 200. The audit ran; it is telling you where it is
blind. A caller that wants only fully covered periods checks the field.

When the node throttles, the transport retries with backoff for about 50 seconds
and then gives up *for that chunk only*. That chunk becomes a gap and the report
says `PARTIAL`. The earlier behaviour — raising out of the scan — turned a
recoverable read into a 502 with no report at all, which is the opposite of
useful. Both paths are tested in `test/transport.test.mjs`, against a fake node,
because a recorded fixture can only replay successful answers.

## Why windows are capped

Finding native transfers means reading every block body, and the public RPC
throttles. Measured on Pacific Mainnet: about 25 ms per block at the node's
ceiling, roughly 38 requests per second, regardless of client concurrency. So a
24-hour window needs around 82,000 block reads — about 35 minutes of sustained
load against a shared endpoint.

The budget is 4,000 blocks (~70 minutes of chain time). A larger request is
refused with `WINDOW_EXCEEDS_BUDGET` and the real cost, rather than quietly
returning less than was asked for.

## Layout

    src/keccak.mjs      keccak-256, from scratch, verified against canonical vectors
    src/hex.mjs         quantity and word helpers, no floating point
    src/numbers.mjs     exact base-unit formatting with BigInt
    src/address.mjs     normalisation and EIP-55, checksum derived not typed
    src/abi.mjs         minimal decoders that return null instead of guessing
    src/topics.mjs      event topics and selectors derived from signatures
    src/rpc.mjs         batched JSON-RPC with throttling backoff
    src/scan.mjs        block, log and receipt scanning with gap tracking
    src/classify.mjs    turns logs and transactions into audit entries
    src/report.mjs      assembles the report
    src/export.mjs      plain-language summary, category grouping, notable links, Markdown & CSV export
    functions/api/audit.js   the HTTP surface
    public/             dashboard, rendering and export only, no arithmetic

## Run it

    npm test                                            # 104 tests, no network, no dependencies
    npm run audit -- <wallet> <hours>
    npm run audit -- <wallet> --from=<iso> --to=<iso> --markdown
    npm run audit -- <wallet> <hours> --csv
    npm run verify -- <wallet> <hours>
    npm run dev                                         # wrangler pages dev public

`npm run verify` recomputes the same numbers without importing anything from
`src/` — it speaks JSON-RPC itself and sums raw logs and receipts. If the audit
and the verifier agree, the number belongs to the chain rather than to our
arithmetic.

Runs against the live chain (`<wallet> 0.5` and `0.02`; the clock moves, so a
re-run lands on a different window):

    window 22159468..22161181 (1714 blocks), 255 transfer logs, 32 wallet txs
    window 22161507..22161575    (69 blocks),  14 transfer logs,  1 wallet tx

    USDC in/out, WPROS in/out, gas paid, tx count, native out, block count
    8/8 agree on both

## API

    POST /api/audit                  {"wallet": "0x…", "hours": "0.5"}
    POST /api/audit                  {"wallet": "0x…", "from": "2026-11-05T06:00:00Z", "to": "2026-11-05T06:30:00Z"}
    POST /api/audit?format=markdown  → Markdown compliance report
    POST /api/audit?format=csv       → RFC-4180 CSV ledger

Accepts `wallet` and a window (`hours` or `from` + `to`). Anything else —
`transactions`, `categories`, `verdict`, `policy` — is rejected with
`UNKNOWN_FIELD` rather than ignored. The caller supplies a wallet and a window;
it does not supply the evidence.

    GET /api/audit   → chain limits, so a client can size a window without guessing

## Tests

    unit          keccak, hex, formatting, addresses, ABI decoding, topics
    classify      the rule set, one decoded fact per case
    report        recorded Pharos traffic replayed through the real transport
    api           the HTTP contract, including refusals and CORS

The fixtures in `test/fixtures/` are real RPC responses captured from mainnet via
`npm run fixtures:record`. Integration tests replay them, so a passing test means
the handler produced that output from that chain data — not from a fixture I
wrote to match the code.

## Licence

MIT
