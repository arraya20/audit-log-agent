// Plain-language compliance summary, category aggregation, notable transactions,
// and Markdown / CSV export.
//
// Every figure here is derived strictly from the report produced by buildReport.
// In particular, a "swap" is never inferred from a function selector: a
// transaction appears in `swaps` if and only if the verified movement ledger
// records both an outgoing transfer and an incoming transfer for the wallet in
// that same transaction hash.

import { CHAIN } from "./config.mjs";
import { KIND } from "./classify.mjs";
import { formatUnits } from "./numbers.mjs";
import { toChecksumAddress } from "./address.mjs";

const IN_KINDS = new Set([KIND.TOKEN_IN, KIND.NFT_IN, KIND.NATIVE_IN]);
const OUT_KINDS = new Set([KIND.TOKEN_OUT, KIND.NFT_OUT, KIND.NATIVE_OUT, KIND.NATIVE_SELF]);

export function txExplorerUrl(txHash, explorer = CHAIN.explorer) {
  if (!txHash) return null;
  return `${explorer.replace(/\/$/, "")}/tx/${txHash}`;
}

export function addressExplorerUrl(address, explorer = CHAIN.explorer) {
  if (!address) return null;
  return `${explorer.replace(/\/$/, "")}/address/${address}`;
}

function isoTime(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function assetSymbol(entry, nativeSymbol = CHAIN.nativeSymbol) {
  if (entry.kind === KIND.NATIVE_IN || entry.kind === KIND.NATIVE_OUT || entry.kind === KIND.NATIVE_SELF) {
    return nativeSymbol;
  }
  if (entry.asset) {
    return entry.asset.symbol ?? entry.asset.address;
  }
  return nativeSymbol;
}

function formatEntryAmount(entry, nativeSymbol = CHAIN.nativeSymbol) {
  const sym = assetSymbol(entry, nativeSymbol);
  if (entry.kind === KIND.NFT_IN || entry.kind === KIND.NFT_OUT) {
    return `tokenId #${entry.tokenId ?? "?"} ${sym}`;
  }
  if (entry.amount !== null && entry.amount !== undefined) {
    return `${entry.amount} ${sym}`;
  }
  if (entry.amountRaw !== null && entry.amountRaw !== undefined) {
    return `${entry.amountRaw} raw ${sym}`;
  }
  return sym;
}

function aggregateMovementAssets(movements, nativeSymbol = CHAIN.nativeSymbol, nativeDecimals = CHAIN.nativeDecimals) {
  const map = new Map();
  for (const m of movements) {
    if (m.kind === KIND.NFT_IN || m.kind === KIND.NFT_OUT) continue;
    if (m.amountRaw === undefined || m.amountRaw === null) continue;
    const isNative = m.kind === KIND.NATIVE_IN || m.kind === KIND.NATIVE_OUT || m.kind === KIND.NATIVE_SELF;
    if (!isNative && (!m.asset || !m.asset.resolved)) continue;
    const key = isNative ? "native" : m.asset.address;
    const symbol = isNative ? nativeSymbol : m.asset.symbol ?? toChecksumAddress(m.asset.address);
    const decimals = isNative ? nativeDecimals : m.asset.decimals;
    if (!map.has(key)) {
      map.set(key, { key, symbol, decimals, totalRaw: 0n, count: 0 });
    }
    const item = map.get(key);
    item.totalRaw += BigInt(m.amountRaw);
    item.count++;
  }
  return [...map.values()].map((x) => ({
    symbol: x.symbol,
    decimals: x.decimals,
    total: formatUnits(x.totalRaw, x.decimals),
    totalRaw: x.totalRaw.toString(),
    count: x.count,
  }));
}

/**
 * Derive categorized views, category totals, notable transactions with explorer
 * links, and a plain-language compliance narrative from a report.
 */
export function summarizeReport(report) {
  const nativeSymbol = report.chain?.nativeSymbol ?? CHAIN.nativeSymbol;
  const nativeDecimals = report.totals?.native?.decimals ?? CHAIN.nativeDecimals;
  const explorer = CHAIN.explorer;

  const transfersIn = report.movements.filter((m) => IN_KINDS.has(m.kind));
  const transfersOut = report.movements.filter((m) => OUT_KINDS.has(m.kind));

  // Group movements by transaction hash to identify same-transaction exchanges
  // (swaps) purely from ledger evidence: at least one outflow and at least one
  // inflow for the wallet in the same transaction.
  const byTx = new Map();
  for (const m of report.movements) {
    if (!m.txHash) continue;
    const key = m.txHash.toLowerCase();
    if (!byTx.has(key)) {
      byTx.set(key, {
        txHash: m.txHash,
        blockNumber: m.blockNumber ?? null,
        blockTimestamp: m.blockTimestamp ?? null,
        viaContract: m.viaContract ?? null,
        out: [],
        in: [],
      });
    }
    const group = byTx.get(key);
    if (!group.viaContract && m.viaContract) group.viaContract = m.viaContract;
    if (OUT_KINDS.has(m.kind) && m.kind !== KIND.NATIVE_SELF) group.out.push(m);
    else if (IN_KINDS.has(m.kind)) group.in.push(m);
  }

  const swaps = [];
  for (const group of byTx.values()) {
    if (group.out.length > 0 && group.in.length > 0) {
      swaps.push({
        txHash: group.txHash,
        explorerUrl: txExplorerUrl(group.txHash, explorer),
        blockNumber: group.blockNumber,
        blockTimestamp: group.blockTimestamp,
        viaContract: group.viaContract,
        viaContractUrl: addressExplorerUrl(group.viaContract, explorer),
        out: group.out,
        in: group.in,
        summary: `${group.out.map((e) => formatEntryAmount(e, nativeSymbol)).join(" + ")} -> ${group.in.map((e) => formatEntryAmount(e, nativeSymbol)).join(" + ")}`,
      });
    }
  }

  const approvals = report.approvals ?? [];
  const contractInteractions = report.calls ?? [];

  const categoryTotals = {
    transfersIn: {
      count: transfersIn.length,
      byAsset: aggregateMovementAssets(transfersIn, nativeSymbol, nativeDecimals),
    },
    transfersOut: {
      count: transfersOut.length,
      byAsset: aggregateMovementAssets(transfersOut, nativeSymbol, nativeDecimals),
    },
    swaps: {
      count: swaps.length,
      outLegs: swaps.reduce((n, s) => n + s.out.length, 0),
      inLegs: swaps.reduce((n, s) => n + s.in.length, 0),
      byAssetOut: aggregateMovementAssets(swaps.flatMap((s) => s.out), nativeSymbol, nativeDecimals),
      byAssetIn: aggregateMovementAssets(swaps.flatMap((s) => s.in), nativeSymbol, nativeDecimals),
    },
    approvals: {
      count: approvals.length,
      granted: approvals.filter((a) => a.kind === KIND.APPROVAL_GRANTED).length,
      unlimited: approvals.filter((a) => a.kind === KIND.APPROVAL_UNLIMITED).length,
      revoked: approvals.filter((a) => a.kind === KIND.APPROVAL_REVOKED).length,
      forAll: approvals.filter((a) => a.kind === KIND.APPROVAL_FOR_ALL).length,
    },
    contractInteractions: {
      count: contractInteractions.length,
      calls: contractInteractions.filter((c) => c.kind === KIND.CONTRACT_CALL).length,
      failed: contractInteractions.filter((c) => c.kind === KIND.FAILED).length,
      unknownStatus: contractInteractions.filter((c) => c.kind === KIND.UNKNOWN_STATUS).length,
    },
  };

  // Notable transactions with links.
  const notable = [];
  const seenNotable = new Set();
  function addNotable(item) {
    const key = `${item.txHash ?? "?"}:${item.category}:${item.reason}`;
    if (seenNotable.has(key)) return;
    seenNotable.add(key);
    notable.push(item);
  }

  for (const a of approvals) {
    if (a.kind === KIND.APPROVAL_UNLIMITED) {
      addNotable({
        txHash: a.txHash,
        explorerUrl: txExplorerUrl(a.txHash, explorer),
        blockNumber: a.blockNumber,
        blockTimestamp: a.blockTimestamp,
        category: "approvals",
        reason: "Unlimited token allowance granted",
        summary: `Unlimited ${assetSymbol(a, nativeSymbol)} allowance to ${a.spender}`,
        counterparty: a.spender,
        counterpartyUrl: addressExplorerUrl(a.spender, explorer),
      });
    } else if (a.kind === KIND.APPROVAL_FOR_ALL && a.approved) {
      addNotable({
        txHash: a.txHash,
        explorerUrl: txExplorerUrl(a.txHash, explorer),
        blockNumber: a.blockNumber,
        blockTimestamp: a.blockTimestamp,
        category: "approvals",
        reason: "Collection-wide operator approval granted",
        summary: `ApprovalForAll on ${assetSymbol(a, nativeSymbol)} to ${a.operator}`,
        counterparty: a.operator,
        counterpartyUrl: addressExplorerUrl(a.operator, explorer),
      });
    } else if (a.kind === KIND.APPROVAL_GRANTED) {
      addNotable({
        txHash: a.txHash,
        explorerUrl: txExplorerUrl(a.txHash, explorer),
        blockNumber: a.blockNumber,
        blockTimestamp: a.blockTimestamp,
        category: "approvals",
        reason: "Token allowance granted",
        summary: `Approved ${formatEntryAmount(a, nativeSymbol)} for ${a.spender}`,
        counterparty: a.spender,
        counterpartyUrl: addressExplorerUrl(a.spender, explorer),
      });
    }
  }

  for (const s of swaps) {
    addNotable({
      txHash: s.txHash,
      explorerUrl: s.explorerUrl,
      blockNumber: s.blockNumber,
      blockTimestamp: s.blockTimestamp,
      category: "swaps",
      reason: "Same-transaction two-way asset exchange",
      summary: s.summary,
      counterparty: s.viaContract,
      counterpartyUrl: s.viaContractUrl,
    });
  }

  // Largest inflow and largest outflow per asset.
  const largestByBucket = new Map();
  for (const m of report.movements) {
    if (m.amountRaw === undefined || m.amountRaw === null) continue;
    const dir = IN_KINDS.has(m.kind) ? "in" : "out";
    const sym = assetSymbol(m, nativeSymbol);
    const key = `${dir}:${sym}`;
    const val = BigInt(m.amountRaw);
    if (val === 0n) continue;
    const prev = largestByBucket.get(key);
    if (!prev || val > prev.val) {
      largestByBucket.set(key, { val, entry: m, dir, sym });
    }
  }
  for (const { entry, dir, sym } of largestByBucket.values()) {
    const target = entry.counterparty ?? entry.to ?? entry.from ?? null;
    addNotable({
      txHash: entry.txHash,
      explorerUrl: txExplorerUrl(entry.txHash, explorer),
      blockNumber: entry.blockNumber,
      blockTimestamp: entry.blockTimestamp,
      category: dir === "in" ? "transfersIn" : "transfersOut",
      reason: `Largest ${sym} ${dir === "in" ? "inflow" : "outflow"} in period`,
      summary: `${dir === "in" ? "Received" : "Sent"} ${formatEntryAmount(entry, nativeSymbol)} ${dir === "in" ? "from" : "to"} ${target ?? "—"}`,
      counterparty: target,
      counterpartyUrl: addressExplorerUrl(target, explorer),
    });
  }

  for (const c of contractInteractions) {
    if (c.kind === KIND.FAILED || c.kind === KIND.UNKNOWN_STATUS) {
      addNotable({
        txHash: c.txHash,
        explorerUrl: txExplorerUrl(c.txHash, explorer),
        blockNumber: c.blockNumber,
        blockTimestamp: c.blockTimestamp,
        category: "contractInteractions",
        reason: c.kind === KIND.FAILED ? "Reverted transaction (gas spent, no value moved)" : "Transaction with unreadable receipt status",
        summary: `${c.kind} call to ${c.to ?? "contract creation"}${c.selector ? ` (${c.selector})` : ""}`,
        counterparty: c.to ?? null,
        counterpartyUrl: addressExplorerUrl(c.to, explorer),
      });
    }
  }

  // Plain-language compliance narrative.
  const fromStr = isoTime(report.window.fromTime);
  const toStr = isoTime(report.window.toTime);
  const statusLine =
    report.completeness === "COMPLETE"
      ? `The audit is COMPLETE: every block, log query, token decimal call, and transaction receipt in the window was read without gaps.`
      : `The audit is PARTIAL (${report.reasons.join("; ")}). Unreadable items are excluded from totals rather than estimated.`;

  const activityParts = [
    `${categoryTotals.transfersIn.count} transfer(s) in`,
    `${categoryTotals.transfersOut.count} transfer(s) out`,
    `${categoryTotals.swaps.count} same-transaction exchange(s) (swaps)`,
    `${categoryTotals.approvals.count} allowance change(s)`,
    `${categoryTotals.contractInteractions.count} zero-value or non-transfer contract interaction(s)`,
  ];

  const assetLines = report.totals.byAsset.map(
    (a) => `${a.symbol ?? a.address}: +${a.in} in / -${a.out} out (net ${a.net})`,
  );
  const nat = report.totals.native;
  assetLines.push(
    `${nat.symbol} (native): +${nat.in} in / -${nat.out} out, gas ${nat.feesPaid}, net after gas ${nat.netAfterFees}${nat.netAfterFeesExact ? "" : " (lower bound)"}`,
  );

  const narrative = [
    `Activity report for wallet ${report.wallet} on ${report.chain.name} (chain ${report.chain.id}), covering blocks ${report.window.fromBlock} to ${report.window.toBlock} (${report.window.blocks} blocks, ${fromStr} to ${toStr}).`,
    statusLine,
    `Recorded activity comprises ${activityParts.join(", ")}, with ${report.fees.total} ${report.fees.symbol} paid in gas across ${report.fees.transactions} wallet-submitted transaction(s).`,
    `Net balance movements over the period: ${assetLines.join("; ")}.`,
  ].join(" ");

  return {
    explorer,
    walletUrl: addressExplorerUrl(report.wallet, explorer),
    narrative,
    categories: {
      transfersIn,
      transfersOut,
      swaps,
      approvals,
      contractInteractions,
    },
    categoryTotals,
    notableTransactions: notable,
  };
}

function mdLink(label, url) {
  if (!url) return label;
  return `[${label}](${url})`;
}

function shortHex(h) {
  if (!h || h.length <= 14) return h ?? "—";
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

/**
 * Format the audit report as a plain-language + structured Markdown document.
 */
export function toMarkdown(report) {
  const s = summarizeReport(report);
  const nativeSymbol = report.chain?.nativeSymbol ?? CHAIN.nativeSymbol;
  const lines = [];

  lines.push(`# Wallet Activity Audit Report`);
  lines.push(``);
  lines.push(`- **Wallet:** ${mdLink(`\`${report.wallet}\``, s.walletUrl)}`);
  lines.push(`- **Chain:** ${report.chain.name} (${report.chain.id})`);
  lines.push(`- **Block Window:** \`${report.window.fromBlock}\` – \`${report.window.toBlock}\` (${report.window.blocks} blocks)`);
  lines.push(`- **Period (UTC):** ${isoTime(report.window.fromTime)} to ${isoTime(report.window.toTime)}`);
  lines.push(`- **Completeness Verdict:** **${report.completeness}**${report.reasons.length > 0 ? ` (${report.reasons.join("; ")})` : ""}`);
  lines.push(``);

  lines.push(`## Executive Summary`);
  lines.push(``);
  lines.push(s.narrative);
  lines.push(``);

  lines.push(`## Totals per Category`);
  lines.push(``);
  lines.push(`| Category | Count | Totals / Breakdown |`);
  lines.push(`| :--- | ---: | :--- |`);
  lines.push(
    `| Transfers In | ${s.categoryTotals.transfersIn.count} | ${s.categoryTotals.transfersIn.byAsset.map((a) => `${a.total} ${a.symbol}`).join(", ") || "—"} |`,
  );
  lines.push(
    `| Transfers Out | ${s.categoryTotals.transfersOut.count} | ${s.categoryTotals.transfersOut.byAsset.map((a) => `${a.total} ${a.symbol}`).join(", ") || "—"} |`,
  );
  lines.push(
    `| Swaps (Same-Tx Exchanges) | ${s.categoryTotals.swaps.count} | Out: ${s.categoryTotals.swaps.byAssetOut.map((a) => `${a.total} ${a.symbol}`).join(", ") || "—"} / In: ${s.categoryTotals.swaps.byAssetIn.map((a) => `${a.total} ${a.symbol}`).join(", ") || "—"} |`,
  );
  lines.push(
    `| Approvals | ${s.categoryTotals.approvals.count} | ${s.categoryTotals.approvals.granted} granted, ${s.categoryTotals.approvals.unlimited} unlimited, ${s.categoryTotals.approvals.revoked} revoked, ${s.categoryTotals.approvals.forAll} operator |`,
  );
  lines.push(
    `| Contract Interactions | ${s.categoryTotals.contractInteractions.count} | ${s.categoryTotals.contractInteractions.calls} call(s), ${s.categoryTotals.contractInteractions.failed} failed, ${s.categoryTotals.contractInteractions.unknownStatus} unknown status |`,
  );
  lines.push(
    `| Gas Fees Paid | ${report.fees.transactions} | ${report.fees.total} ${report.fees.symbol}${report.fees.unverified ? ` (${report.fees.unverified} unverified)` : ""} |`,
  );
  lines.push(``);

  lines.push(`## Totals per Asset`);
  lines.push(``);
  lines.push(`| Asset | Inflow | Outflow | Net | Rows |`);
  lines.push(`| :--- | ---: | ---: | ---: | ---: |`);
  for (const a of report.totals.byAsset) {
    lines.push(`| ${a.symbol ?? a.address} | ${a.in} | ${a.out} | ${a.net} | ${a.count} |`);
  }
  const nat = report.totals.native;
  const natNet = nat.netAfterFeesExact ? nat.netAfterFees : `${nat.netAfterFees}+`;
  lines.push(`| ${nat.symbol} (native, net after gas) | ${nat.in} | ${nat.out} | ${natNet} | — |`);
  lines.push(``);

  if (report.totals.unpriceable.length > 0) {
    lines.push(`> **Excluded from totals (unreadable decimals):** ${report.totals.unpriceable.join(", ")}`);
    lines.push(``);
  }

  lines.push(`## Notable Transactions`);
  lines.push(``);
  if (s.notableTransactions.length === 0) {
    lines.push(`No notable transactions in this period.`);
  } else {
    lines.push(`| Time (UTC) | Category | Reason | Details | Transaction |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
    for (const n of s.notableTransactions) {
      lines.push(
        `| ${isoTime(n.blockTimestamp)} | ${n.category} | ${n.reason} | ${n.summary} | ${n.txHash ? mdLink(`\`${shortHex(n.txHash)}\``, n.explorerUrl) : "—"} |`,
      );
    }
  }
  lines.push(``);

  lines.push(`## Transfers In (${s.categories.transfersIn.length})`);
  lines.push(``);
  if (s.categories.transfersIn.length === 0) {
    lines.push(`No incoming transfers in this period.`);
  } else {
    lines.push(`| Time (UTC) | Kind | Amount | Asset | From | Via Contract | Tx |`);
    lines.push(`| :--- | :--- | ---: | :--- | :--- | :--- | :--- |`);
    for (const m of s.categories.transfersIn) {
      const from = m.counterparty ?? m.from ?? null;
      lines.push(
        `| ${isoTime(m.blockTimestamp)} | \`${m.kind}\` | ${m.amount ?? `${m.amountRaw ?? m.tokenId} raw`} | ${assetSymbol(m, nativeSymbol)} | ${from ? mdLink(`\`${shortHex(from)}\``, addressExplorerUrl(from)) : "—"} | ${m.viaContract ? mdLink(`\`${shortHex(m.viaContract)}\``, addressExplorerUrl(m.viaContract)) : "—"} | ${m.txHash ? mdLink(`\`${shortHex(m.txHash)}\``, txExplorerUrl(m.txHash)) : "—"} |`,
      );
    }
  }
  lines.push(``);

  lines.push(`## Transfers Out (${s.categories.transfersOut.length})`);
  lines.push(``);
  if (s.categories.transfersOut.length === 0) {
    lines.push(`No outgoing transfers in this period.`);
  } else {
    lines.push(`| Time (UTC) | Kind | Amount | Asset | To | Via Contract | Tx |`);
    lines.push(`| :--- | :--- | ---: | :--- | :--- | :--- | :--- |`);
    for (const m of s.categories.transfersOut) {
      const to = m.counterparty ?? m.to ?? null;
      lines.push(
        `| ${isoTime(m.blockTimestamp)} | \`${m.kind}\` | ${m.amount ?? `${m.amountRaw ?? m.tokenId} raw`} | ${assetSymbol(m, nativeSymbol)} | ${to ? mdLink(`\`${shortHex(to)}\``, addressExplorerUrl(to)) : "—"} | ${m.viaContract ? mdLink(`\`${shortHex(m.viaContract)}\``, addressExplorerUrl(m.viaContract)) : "—"} | ${m.txHash ? mdLink(`\`${shortHex(m.txHash)}\``, txExplorerUrl(m.txHash)) : "—"} |`,
      );
    }
  }
  lines.push(``);

  lines.push(`## Swaps — Same-Transaction Exchanges (${s.categories.swaps.length})`);
  lines.push(``);
  lines.push(`_Derived from transactions containing both outgoing and incoming asset movements for the wallet; never guessed from function selectors._`);
  lines.push(``);
  if (s.categories.swaps.length === 0) {
    lines.push(`No same-transaction exchanges in this period.`);
  } else {
    lines.push(`| Time (UTC) | Sent | Received | Contract Called | Tx |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
    for (const sw of s.categories.swaps) {
      const sent = sw.out.map((e) => formatEntryAmount(e, nativeSymbol)).join(" + ");
      const recv = sw.in.map((e) => formatEntryAmount(e, nativeSymbol)).join(" + ");
      lines.push(
        `| ${isoTime(sw.blockTimestamp)} | ${sent} | ${recv} | ${sw.viaContract ? mdLink(`\`${shortHex(sw.viaContract)}\``, sw.viaContractUrl) : "—"} | ${sw.txHash ? mdLink(`\`${shortHex(sw.txHash)}\``, sw.explorerUrl) : "—"} |`,
      );
    }
  }
  lines.push(``);

  lines.push(`## Approvals (${s.categories.approvals.length})`);
  lines.push(``);
  if (s.categories.approvals.length === 0) {
    lines.push(`No allowance changes in this period.`);
  } else {
    lines.push(`| Time (UTC) | Kind | Asset | Allowance | Spender / Operator | Tx |`);
    lines.push(`| :--- | :--- | :--- | ---: | :--- | :--- |`);
    for (const a of s.categories.approvals) {
      const who = a.spender ?? a.operator ?? null;
      const amt = a.kind === KIND.APPROVAL_FOR_ALL ? (a.approved ? "approved" : "revoked") : a.unlimited ? "unlimited" : a.amount ?? `${a.amountRaw} raw`;
      lines.push(
        `| ${isoTime(a.blockTimestamp)} | \`${a.kind}\` | ${assetSymbol(a, nativeSymbol)} | ${amt} | ${who ? mdLink(`\`${shortHex(who)}\``, addressExplorerUrl(who)) : "—"} | ${a.txHash ? mdLink(`\`${shortHex(a.txHash)}\``, txExplorerUrl(a.txHash)) : "—"} |`,
      );
    }
  }
  lines.push(``);

  lines.push(`## Contract Interactions (${s.categories.contractInteractions.length})`);
  lines.push(``);
  if (s.categories.contractInteractions.length === 0) {
    lines.push(`No zero-value contract calls in this period.`);
  } else {
    lines.push(`| Time (UTC) | Kind | Target | Selector | Reading | Tx |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- |`);
    for (const c of s.categories.contractInteractions) {
      lines.push(
        `| ${isoTime(c.blockTimestamp)} | \`${c.kind}\` | ${c.to ? mdLink(`\`${shortHex(c.to)}\``, addressExplorerUrl(c.to)) : "—"} | \`${c.selector ?? "—"}\` | \`${c.callKind ?? "—"}\` | ${c.txHash ? mdLink(`\`${shortHex(c.txHash)}\``, txExplorerUrl(c.txHash)) : "—"} |`,
      );
    }
  }
  lines.push(``);

  lines.push(`## Blind Spots & Methodology`);
  lines.push(``);
  for (const b of report.blindSpots ?? []) {
    lines.push(`- **${b.id}:** ${b.detail}`);
  }

  return lines.join("\n") + "\n";
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

/**
 * Format the audit report as an RFC-4180 CSV ledger.
 */
export function toCsv(report) {
  const s = summarizeReport(report);
  const nativeSymbol = report.chain?.nativeSymbol ?? CHAIN.nativeSymbol;
  const swapTxHashes = new Set(s.categories.swaps.map((sw) => sw.txHash?.toLowerCase()).filter(Boolean));

  const headers = [
    "category",
    "kind",
    "inSwapTx",
    "timestamp",
    "blockNumber",
    "txHash",
    "explorerUrl",
    "asset",
    "amount",
    "amountRaw",
    "counterparty",
    "viaContract",
    "unlimited",
    "selector",
    "callKind",
    "feeRaw",
  ];

  const rows = [csvRow(headers)];

  for (const m of report.movements) {
    const category = IN_KINDS.has(m.kind) ? "TRANSFERS_IN" : "TRANSFERS_OUT";
    const inSwap = m.txHash && swapTxHashes.has(m.txHash.toLowerCase()) ? "true" : "false";
    rows.push(
      csvRow([
        category,
        m.kind,
        inSwap,
        m.blockTimestamp !== null && m.blockTimestamp !== undefined ? isoTime(m.blockTimestamp) : "",
        m.blockNumber ?? "",
        m.txHash ?? "",
        txExplorerUrl(m.txHash) ?? "",
        assetSymbol(m, nativeSymbol),
        m.amount ?? (m.tokenId !== undefined && m.tokenId !== null ? `tokenId:${m.tokenId}` : ""),
        m.amountRaw ?? "",
        m.counterparty ?? m.to ?? m.from ?? "",
        m.viaContract ?? "",
        "",
        "",
        "",
        m.feeRaw ?? "",
      ]),
    );
  }

  for (const a of report.approvals) {
    rows.push(
      csvRow([
        "APPROVALS",
        a.kind,
        "false",
        a.blockTimestamp !== null && a.blockTimestamp !== undefined ? isoTime(a.blockTimestamp) : "",
        a.blockNumber ?? "",
        a.txHash ?? "",
        txExplorerUrl(a.txHash) ?? "",
        assetSymbol(a, nativeSymbol),
        a.unlimited ? "unlimited" : a.amount ?? (a.approved !== undefined ? String(a.approved) : ""),
        a.amountRaw ?? "",
        a.spender ?? a.operator ?? "",
        "",
        a.unlimited !== undefined ? String(a.unlimited) : "",
        "",
        "",
        "",
      ]),
    );
  }

  for (const c of report.calls) {
    rows.push(
      csvRow([
        "CONTRACT_INTERACTIONS",
        c.kind,
        c.txHash && swapTxHashes.has(c.txHash.toLowerCase()) ? "true" : "false",
        c.blockTimestamp !== null && c.blockTimestamp !== undefined ? isoTime(c.blockTimestamp) : "",
        c.blockNumber ?? "",
        c.txHash ?? "",
        txExplorerUrl(c.txHash) ?? "",
        "",
        "",
        c.valueRaw ?? "",
        c.counterparty ?? c.to ?? "",
        "",
        "",
        c.selector ?? "",
        c.callKind ?? "",
        c.feeRaw ?? "",
      ]),
    );
  }

  return rows.join("\n") + "\n";
}
