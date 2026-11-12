// Renderer and client-side export.
//
// Every number on this page is a string the backend produced. The client does no
// balance arithmetic — it never sums movements into new floats, derives a
// decimal, or recomputes a fee. Swaps are grouped strictly when a single
// transaction hash contains both an outgoing and an incoming movement for the
// wallet, never inferred from a function selector.

const form = document.getElementById("form");
const walletInput = document.getElementById("wallet");
const modeSelect = document.getElementById("mode");
const hoursField = document.getElementById("hours-field");
const hoursSelect = document.getElementById("hours");
const fromField = document.getElementById("from-field");
const fromInput = document.getElementById("from");
const toField = document.getElementById("to-field");
const toInput = document.getElementById("to");
const runButton = document.getElementById("run");
const statusEl = document.getElementById("status");
const reportEl = document.getElementById("report");
const limitsEl = document.getElementById("limits");

let explorerBase = "https://explorer.pharos.xyz";
let requestSeq = 0;

const IN_KINDS = new Set(["TOKEN_IN", "NFT_IN", "NATIVE_IN"]);
const OUT_KINDS = new Set(["TOKEN_OUT", "NFT_OUT", "NATIVE_OUT", "NATIVE_SELF"]);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "onclick") node.addEventListener("click", v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function time(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function shortHex(value) {
  if (!value) return "—";
  if (value.length <= 14) return value;
  return value.slice(0, 6) + "…" + value.slice(-4);
}

function txUrl(txHash) {
  if (!txHash) return null;
  return `${explorerBase.replace(/\/$/, "")}/tx/${txHash}`;
}

function addrUrl(address) {
  if (!address) return null;
  return `${explorerBase.replace(/\/$/, "")}/address/${address}`;
}

function addrCell(value, extraClass) {
  if (!value) return el("td", { class: "addr", text: "—" });
  return el("td", { class: "addr" + (extraClass ? " " + extraClass : ""), title: value }, [
    el("a", { class: "chain-link", href: addrUrl(value), target: "_blank", rel: "noopener noreferrer", text: shortHex(value) }),
  ]);
}

function txCell(txHash) {
  if (!txHash) return el("td", { class: "addr", text: "—" });
  return el("td", { class: "addr", title: txHash }, [
    el("a", { class: "chain-link", href: txUrl(txHash), target: "_blank", rel: "noopener noreferrer", text: shortHex(txHash) }),
  ]);
}

function table(headers, rows, emptyText) {
  if (rows.length === 0) return el("p", { class: "empty", text: emptyText });
  const thead = el("thead", {}, [
    el("tr", {}, headers.map((h) => el("th", { class: h.num ? "num" : "", text: h.label }))),
  ]);
  const tbody = el("tbody", {}, rows);
  return el("table", {}, [thead, tbody]);
}

function section(title, body, captionText = null) {
  const children = [el("h2", { text: title })];
  if (captionText) children.push(el("p", { class: "sub-caption", text: captionText }));
  children.push(body);
  return el("section", { class: "block" }, children);
}

function assetLabel(entry, nativeSymbol) {
  if (entry.kind === "NATIVE_IN" || entry.kind === "NATIVE_OUT" || entry.kind === "NATIVE_SELF") {
    return nativeSymbol;
  }
  if (entry.asset) return entry.asset.symbol ?? entry.asset.address;
  return nativeSymbol;
}

function entryAmountText(entry, nativeSymbol) {
  const sym = assetLabel(entry, nativeSymbol);
  if (entry.kind === "NFT_IN" || entry.kind === "NFT_OUT") {
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

function deriveCategories(report) {
  const nativeSymbol = report.totals.native.symbol;
  const transfersIn = report.movements.filter((m) => IN_KINDS.has(m.kind));
  const transfersOut = report.movements.filter((m) => OUT_KINDS.has(m.kind));

  const byTx = new Map();
  for (const m of report.movements) {
    if (!m.txHash) continue;
    const k = m.txHash.toLowerCase();
    if (!byTx.has(k)) {
      byTx.set(k, {
        txHash: m.txHash,
        blockNumber: m.blockNumber,
        blockTimestamp: m.blockTimestamp,
        viaContract: m.viaContract ?? null,
        out: [],
        in: [],
      });
    }
    const g = byTx.get(k);
    if (!g.viaContract && m.viaContract) g.viaContract = m.viaContract;
    if (OUT_KINDS.has(m.kind) && m.kind !== "NATIVE_SELF") g.out.push(m);
    else if (IN_KINDS.has(m.kind)) g.in.push(m);
  }

  const swaps = [];
  for (const g of byTx.values()) {
    if (g.out.length > 0 && g.in.length > 0) {
      swaps.push({
        ...g,
        sentText: g.out.map((e) => entryAmountText(e, nativeSymbol)).join(" + "),
        receivedText: g.in.map((e) => entryAmountText(e, nativeSymbol)).join(" + "),
      });
    }
  }

  const approvals = report.approvals ?? [];
  const contractInteractions = report.calls ?? [];

  // Notable transactions
  const notable = [];
  const seen = new Set();
  const pushNotable = (item) => {
    const key = `${item.txHash ?? "?"}:${item.category}:${item.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    notable.push(item);
  };

  for (const a of approvals) {
    if (a.kind === "APPROVAL_UNLIMITED") {
      pushNotable({
        blockTimestamp: a.blockTimestamp,
        category: "approvals",
        reason: "Unlimited token allowance granted",
        details: `Unlimited ${assetLabel(a, nativeSymbol)} to ${shortHex(a.spender)}`,
        txHash: a.txHash,
      });
    } else if (a.kind === "APPROVAL_FOR_ALL" && a.approved) {
      pushNotable({
        blockTimestamp: a.blockTimestamp,
        category: "approvals",
        reason: "Collection-wide operator approval granted",
        details: `ApprovalForAll on ${assetLabel(a, nativeSymbol)} to ${shortHex(a.operator)}`,
        txHash: a.txHash,
      });
    } else if (a.kind === "APPROVAL_GRANTED") {
      pushNotable({
        blockTimestamp: a.blockTimestamp,
        category: "approvals",
        reason: "Token allowance granted",
        details: `Approved ${entryAmountText(a, nativeSymbol)} for ${shortHex(a.spender)}`,
        txHash: a.txHash,
      });
    }
  }

  for (const s of swaps) {
    pushNotable({
      blockTimestamp: s.blockTimestamp,
      category: "swaps",
      reason: "Same-transaction two-way asset exchange",
      details: `${s.sentText} → ${s.receivedText}`,
      txHash: s.txHash,
    });
  }

  const largest = new Map();
  for (const m of report.movements) {
    if (m.amountRaw === undefined || m.amountRaw === null) continue;
    const val = BigInt(m.amountRaw);
    if (val === 0n) continue;
    const dir = IN_KINDS.has(m.kind) ? "in" : "out";
    const sym = assetLabel(m, nativeSymbol);
    const key = `${dir}:${sym}`;
    const prev = largest.get(key);
    if (!prev || val > prev.val) largest.set(key, { val, entry: m, dir, sym });
  }
  for (const { entry, dir, sym } of largest.values()) {
    const party = entry.counterparty ?? entry.to ?? entry.from ?? null;
    pushNotable({
      blockTimestamp: entry.blockTimestamp,
      category: dir === "in" ? "transfers in" : "transfers out",
      reason: `Largest ${sym} ${dir === "in" ? "inflow" : "outflow"} in period`,
      details: `${dir === "in" ? "Received" : "Sent"} ${entryAmountText(entry, nativeSymbol)} ${dir === "in" ? "from" : "to"} ${shortHex(party)}`,
      txHash: entry.txHash,
    });
  }

  for (const c of contractInteractions) {
    if (c.kind === "FAILED" || c.kind === "UNKNOWN_STATUS") {
      pushNotable({
        blockTimestamp: c.blockTimestamp,
        category: "contract interactions",
        reason: c.kind === "FAILED" ? "Reverted transaction (gas spent, no value moved)" : "Unverified receipt status",
        details: `${c.kind} call to ${shortHex(c.to)}${c.selector ? ` (${c.selector})` : ""}`,
        txHash: c.txHash,
      });
    }
  }

  const statusText =
    report.completeness === "COMPLETE"
      ? "The audit is COMPLETE: every block, log query, token decimal call, and transaction receipt in the window was read without gaps."
      : `The audit is PARTIAL (${report.reasons.join("; ")}). Unreadable items are excluded from totals rather than estimated.`;

  const assetSummary = report.totals.byAsset.map(
    (a) => `${a.symbol ?? shortHex(a.address)}: +${a.in} in / -${a.out} out (net ${a.net})`,
  );
  const nat = report.totals.native;
  assetSummary.push(
    `${nat.symbol} (native): +${nat.in} in / -${nat.out} out, gas ${nat.feesPaid}, net after gas ${nat.netAfterFees}${nat.netAfterFeesExact ? "" : " (lower bound)"}`,
  );

  const narrative = [
    `Activity report for wallet ${report.wallet} on ${report.chain.name} (chain ${report.chain.id}), covering blocks ${report.window.fromBlock}–${report.window.toBlock} (${report.window.blocks} blocks, ${time(report.window.fromTime)} → ${time(report.window.toTime)}).`,
    statusText,
    `Recorded activity comprises ${transfersIn.length} transfer(s) in, ${transfersOut.length} transfer(s) out, ${swaps.length} same-transaction exchange(s) (swaps), ${approvals.length} allowance change(s), and ${contractInteractions.length} zero-value or non-transfer contract interaction(s), with ${report.fees.total} ${report.fees.symbol} paid in gas across ${report.fees.transactions} transaction(s).`,
    `Net balance movements: ${assetSummary.join("; ")}.`,
  ].join(" ");

  return {
    transfersIn,
    transfersOut,
    swaps,
    approvals,
    contractInteractions,
    notable,
    narrative,
  };
}

function downloadFile(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildMarkdown(report, derived) {
  const nativeSymbol = report.totals.native.symbol;
  const lines = [];
  lines.push(`# Wallet Activity Audit Report`);
  lines.push(``);
  lines.push(`- **Wallet:** [\`${report.wallet}\`](${addrUrl(report.wallet)})`);
  lines.push(`- **Chain:** ${report.chain.name} (${report.chain.id})`);
  lines.push(`- **Block Window:** \`${report.window.fromBlock}\` – \`${report.window.toBlock}\` (${report.window.blocks} blocks)`);
  lines.push(`- **Period (UTC):** ${time(report.window.fromTime)} to ${time(report.window.toTime)}`);
  lines.push(`- **Completeness Verdict:** **${report.completeness}**${report.reasons.length ? ` (${report.reasons.join("; ")})` : ""}`);
  lines.push(``);
  lines.push(`## Executive Summary`);
  lines.push(``);
  lines.push(derived.narrative);
  lines.push(``);
  lines.push(`## Totals per Category`);
  lines.push(``);
  lines.push(`| Category | Count | Details |`);
  lines.push(`| :--- | ---: | :--- |`);
  lines.push(`| Transfers In | ${derived.transfersIn.length} | Incoming native and token movements |`);
  lines.push(`| Transfers Out | ${derived.transfersOut.length} | Outgoing native and token movements |`);
  lines.push(`| Swaps (Same-Tx Exchanges) | ${derived.swaps.length} | Transactions with both outgoing and incoming wallet movements |`);
  lines.push(`| Approvals | ${derived.approvals.length} | ERC-20 Approval and ERC-721 ApprovalForAll grants/revocations |`);
  lines.push(`| Contract Interactions | ${derived.contractInteractions.length} | Zero-value calls, reverted calls, and unverified status calls |`);
  lines.push(`| Gas Fees Paid | ${report.fees.transactions} | ${report.fees.total} ${report.fees.symbol} |`);
  lines.push(``);
  lines.push(`## Totals per Asset`);
  lines.push(``);
  lines.push(`| Asset | Inflow | Outflow | Net | Rows |`);
  lines.push(`| :--- | ---: | ---: | ---: | ---: |`);
  for (const a of report.totals.byAsset) {
    lines.push(`| ${a.symbol ?? a.address} | ${a.in} | ${a.out} | ${a.net} | ${a.count} |`);
  }
  const nat = report.totals.native;
  lines.push(`| ${nat.symbol} (native, after gas) | ${nat.in} | ${nat.out} | ${nat.netAfterFeesExact ? nat.netAfterFees : nat.netAfterFees + "+"} | — |`);
  lines.push(``);
  lines.push(`## Notable Transactions`);
  lines.push(``);
  if (derived.notable.length === 0) {
    lines.push(`No notable transactions in this period.`);
  } else {
    lines.push(`| Time (UTC) | Category | Reason | Details | Transaction |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
    for (const n of derived.notable) {
      lines.push(`| ${time(n.blockTimestamp)} | ${n.category} | ${n.reason} | ${n.details} | ${n.txHash ? `[\`${shortHex(n.txHash)}\`](${txUrl(n.txHash)})` : "—"} |`);
    }
  }
  lines.push(``);
  lines.push(`## Transfers In (${derived.transfersIn.length})`);
  lines.push(``);
  if (derived.transfersIn.length === 0) {
    lines.push(`No incoming transfers in this period.`);
  } else {
    lines.push(`| Time (UTC) | Kind | Amount | Asset | From | Via Contract | Tx |`);
    lines.push(`| :--- | :--- | ---: | :--- | :--- | :--- | :--- |`);
    for (const m of derived.transfersIn) {
      const from = m.counterparty ?? m.from;
      lines.push(`| ${time(m.blockTimestamp)} | \`${m.kind}\` | ${m.amount ?? `${m.amountRaw ?? m.tokenId} raw`} | ${assetLabel(m, nativeSymbol)} | ${from ? `[\`${shortHex(from)}\`](${addrUrl(from)})` : "—"} | ${m.viaContract ? `[\`${shortHex(m.viaContract)}\`](${addrUrl(m.viaContract)})` : "—"} | ${m.txHash ? `[\`${shortHex(m.txHash)}\`](${txUrl(m.txHash)})` : "—"} |`);
    }
  }
  lines.push(``);
  lines.push(`## Transfers Out (${derived.transfersOut.length})`);
  lines.push(``);
  if (derived.transfersOut.length === 0) {
    lines.push(`No outgoing transfers in this period.`);
  } else {
    lines.push(`| Time (UTC) | Kind | Amount | Asset | To | Via Contract | Tx |`);
    lines.push(`| :--- | :--- | ---: | :--- | :--- | :--- | :--- |`);
    for (const m of derived.transfersOut) {
      const to = m.counterparty ?? m.to;
      lines.push(`| ${time(m.blockTimestamp)} | \`${m.kind}\` | ${m.amount ?? `${m.amountRaw ?? m.tokenId} raw`} | ${assetLabel(m, nativeSymbol)} | ${to ? `[\`${shortHex(to)}\`](${addrUrl(to)})` : "—"} | ${m.viaContract ? `[\`${shortHex(m.viaContract)}\`](${addrUrl(m.viaContract)})` : "—"} | ${m.txHash ? `[\`${shortHex(m.txHash)}\`](${txUrl(m.txHash)})` : "—"} |`);
    }
  }
  lines.push(``);
  lines.push(`## Swaps — Same-Transaction Exchanges (${derived.swaps.length})`);
  lines.push(``);
  if (derived.swaps.length === 0) {
    lines.push(`No same-transaction exchanges in this period.`);
  } else {
    lines.push(`| Time (UTC) | Sent | Received | Contract Called | Tx |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
    for (const s of derived.swaps) {
      lines.push(`| ${time(s.blockTimestamp)} | ${s.sentText} | ${s.receivedText} | ${s.viaContract ? `[\`${shortHex(s.viaContract)}\`](${addrUrl(s.viaContract)})` : "—"} | ${s.txHash ? `[\`${shortHex(s.txHash)}\`](${txUrl(s.txHash)})` : "—"} |`);
    }
  }
  lines.push(``);
  lines.push(`## Approvals (${derived.approvals.length})`);
  lines.push(``);
  if (derived.approvals.length === 0) {
    lines.push(`No allowance changes in this period.`);
  } else {
    lines.push(`| Time (UTC) | Kind | Asset | Allowance | Granted To | Tx |`);
    lines.push(`| :--- | :--- | :--- | ---: | :--- | :--- |`);
    for (const a of derived.approvals) {
      const who = a.spender ?? a.operator;
      const amt = a.kind === "APPROVAL_FOR_ALL" ? (a.approved ? "approved" : "revoked") : a.unlimited ? "unlimited" : a.amount ?? `${a.amountRaw} raw`;
      lines.push(`| ${time(a.blockTimestamp)} | \`${a.kind}\` | ${assetLabel(a, nativeSymbol)} | ${amt} | ${who ? `[\`${shortHex(who)}\`](${addrUrl(who)})` : "—"} | ${a.txHash ? `[\`${shortHex(a.txHash)}\`](${txUrl(a.txHash)})` : "—"} |`);
    }
  }
  lines.push(``);
  lines.push(`## Contract Interactions (${derived.contractInteractions.length})`);
  lines.push(``);
  if (derived.contractInteractions.length === 0) {
    lines.push(`No contract calls without value in this period.`);
  } else {
    lines.push(`| Time (UTC) | Kind | Target | Selector | Reading | Tx |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- |`);
    for (const c of derived.contractInteractions) {
      lines.push(`| ${time(c.blockTimestamp)} | \`${c.kind}\` | ${c.to ? `[\`${shortHex(c.to)}\`](${addrUrl(c.to)})` : "—"} | \`${c.selector ?? "—"}\` | \`${c.callKind ?? "—"}\` | ${c.txHash ? `[\`${shortHex(c.txHash)}\`](${txUrl(c.txHash)})` : "—"} |`);
    }
  }
  lines.push(``);
  lines.push(`## Blind Spots`);
  lines.push(``);
  for (const b of report.blindSpots) {
    lines.push(`- **${b.id}:** ${b.detail}`);
  }
  return lines.join("\n") + "\n";
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(report, derived) {
  const nativeSymbol = report.totals.native.symbol;
  const swapSet = new Set(derived.swaps.map((s) => s.txHash?.toLowerCase()).filter(Boolean));
  const rows = [
    ["category", "kind", "inSwapTx", "timestamp", "blockNumber", "txHash", "explorerUrl", "asset", "amount", "amountRaw", "counterparty", "viaContract", "unlimited", "selector", "callKind", "feeRaw"].join(","),
  ];
  for (const m of report.movements) {
    const cat = IN_KINDS.has(m.kind) ? "TRANSFERS_IN" : "TRANSFERS_OUT";
    const inSwap = m.txHash && swapSet.has(m.txHash.toLowerCase()) ? "true" : "false";
    rows.push(
      [cat, m.kind, inSwap, m.blockTimestamp ? time(m.blockTimestamp) : "", m.blockNumber ?? "", m.txHash ?? "", txUrl(m.txHash) ?? "", assetLabel(m, nativeSymbol), m.amount ?? "", m.amountRaw ?? "", m.counterparty ?? m.to ?? m.from ?? "", m.viaContract ?? "", "", "", "", m.feeRaw ?? ""].map(csvCell).join(","),
    );
  }
  for (const a of report.approvals) {
    rows.push(
      ["APPROVALS", a.kind, "false", a.blockTimestamp ? time(a.blockTimestamp) : "", a.blockNumber ?? "", a.txHash ?? "", txUrl(a.txHash) ?? "", assetLabel(a, nativeSymbol), a.unlimited ? "unlimited" : a.amount ?? "", a.amountRaw ?? "", a.spender ?? a.operator ?? "", "", a.unlimited ?? "", "", "", ""].map(csvCell).join(","),
    );
  }
  for (const c of report.calls) {
    rows.push(
      ["CONTRACT_INTERACTIONS", c.kind, c.txHash && swapSet.has(c.txHash.toLowerCase()) ? "true" : "false", c.blockTimestamp ? time(c.blockTimestamp) : "", c.blockNumber ?? "", c.txHash ?? "", txUrl(c.txHash) ?? "", "", "", c.valueRaw ?? "", c.counterparty ?? c.to ?? "", "", "", c.selector ?? "", c.callKind ?? "", c.feeRaw ?? ""].map(csvCell).join(","),
    );
  }
  return rows.join("\n") + "\n";
}

function renderVerdict(report, derived) {
  const state = el("span", {
    class: "state " + (report.completeness === "COMPLETE" ? "complete" : "partial"),
    text: report.completeness,
  });

  const walletLink = el("a", {
    class: "chain-link",
    href: addrUrl(report.wallet),
    target: "_blank",
    rel: "noopener noreferrer",
    text: report.wallet,
  });

  const meta = el("span", { class: "meta" }, [
    walletLink,
    document.createTextNode(` · chain ${report.chain.id} · blocks ${report.window.fromBlock}–${report.window.toBlock} · ${time(report.window.fromTime)} → ${time(report.window.toTime)}`),
  ]);

  const fees = el("span", {
    class: "meta",
    text: `gas ${report.fees.total} ${report.fees.symbol} over ${report.fees.transactions} tx` + (report.fees.unverified ? ` · ${report.fees.unverified} unverified` : ""),
  });

  const box = el("div", { class: "verdict" }, [state, meta, fees]);
  const summaryBox = el("p", { class: "summary-prose", text: derived.narrative });

  const fileStem = `pharos-audit-${report.wallet.slice(0, 10)}-${report.window.fromBlock}-${report.window.toBlock}`;
  const exportBar = el("div", { class: "export-bar" }, [
    el("span", { class: "label", text: "export" }),
    el("button", {
      type: "button",
      class: "secondary",
      text: "markdown (.md)",
      onclick: () => downloadFile(`${fileStem}.md`, "text/markdown;charset=utf-8", buildMarkdown(report, derived)),
    }),
    el("button", {
      type: "button",
      class: "secondary",
      text: "csv (.csv)",
      onclick: () => downloadFile(`${fileStem}.csv`, "text/csv;charset=utf-8", buildCsv(report, derived)),
    }),
    el("button", {
      type: "button",
      class: "secondary",
      text: "json (.json)",
      onclick: () => downloadFile(`${fileStem}.json`, "application/json;charset=utf-8", JSON.stringify(report, null, 2)),
    }),
    el("button", {
      type: "button",
      class: "secondary",
      text: "print / save pdf",
      onclick: () => window.print(),
    }),
  ]);

  const children = [box];
  if (report.reasons.length > 0) {
    children.push(el("ul", { class: "reasons" }, report.reasons.map((r) => el("li", { text: r }))));
  }
  children.push(summaryBox, exportBar);
  return el("div", {}, children);
}

function renderCategoryTotals(report, derived) {
  const rows = [
    el("tr", {}, [
      el("td", { text: "transfers in" }),
      el("td", { class: "num", text: String(derived.transfersIn.length) }),
      el("td", { class: "dim", text: "incoming native and token movements" }),
    ]),
    el("tr", {}, [
      el("td", { text: "transfers out" }),
      el("td", { class: "num", text: String(derived.transfersOut.length) }),
      el("td", { class: "dim", text: "outgoing native and token movements" }),
    ]),
    el("tr", {}, [
      el("td", { text: "swaps (same-tx exchanges)" }),
      el("td", { class: "num", text: String(derived.swaps.length) }),
      el("td", { class: "dim", text: `${derived.swaps.reduce((n, s) => n + s.out.length, 0)} outgoing leg(s), ${derived.swaps.reduce((n, s) => n + s.in.length, 0)} incoming leg(s) in same tx` }),
    ]),
    el("tr", {}, [
      el("td", { text: "approvals" }),
      el("td", { class: "num", text: String(derived.approvals.length) }),
      el("td", { class: "dim", text: `${derived.approvals.filter((a) => a.unlimited).length} unlimited, ${derived.approvals.filter((a) => a.kind === "APPROVAL_REVOKED").length} revoked` }),
    ]),
    el("tr", {}, [
      el("td", { text: "contract interactions" }),
      el("td", { class: "num", text: String(derived.contractInteractions.length) }),
      el("td", { class: "dim", text: `${derived.contractInteractions.filter((c) => c.kind === "FAILED").length} failed, ${derived.contractInteractions.filter((c) => c.kind === "UNKNOWN_STATUS").length} unknown status` }),
    ]),
    el("tr", {}, [
      el("td", { text: "gas fees paid" }),
      el("td", { class: "num", text: String(report.fees.transactions) }),
      el("td", { class: "dim", text: `${report.fees.total} ${report.fees.symbol}` }),
    ]),
  ];

  const headers = [
    { label: "category" },
    { label: "count", num: true },
    { label: "summary" },
  ];
  return table(headers, rows, "no activity");
}

function renderTotals(report) {
  const rows = report.totals.byAsset.map((asset) =>
    el("tr", {}, [
      el("td", {}, [
        el("a", { class: "chain-link", href: addrUrl(asset.address), target: "_blank", rel: "noopener noreferrer", text: asset.symbol ?? shortHex(asset.address) }),
      ]),
      el("td", { class: "num", text: asset.in }),
      el("td", { class: "num", text: asset.out }),
      el("td", { class: "num", text: asset.net }),
      el("td", { class: "num", text: String(asset.count) }),
    ]),
  );

  const nat = report.totals.native;
  const nativeNet = nat.netAfterFeesExact ? nat.netAfterFees : nat.netAfterFees + "+";
  rows.push(
    el("tr", {}, [
      el("td", {}, [
        el("span", { text: `${nat.symbol} (native)` }),
        el("span", { class: "dim", text: " after gas" }),
      ]),
      el("td", { class: "num", text: nat.in }),
      el("td", { class: "num", text: nat.out }),
      el("td", { class: "num", text: nativeNet, title: nat.netAfterFeesExact ? "" : "gas cost is a lower bound: some receipts were unreadable" }),
      el("td", { class: "num", text: "—" }),
    ]),
  );

  const headers = [
    { label: "asset" },
    { label: "in", num: true },
    { label: "out", num: true },
    { label: "net", num: true },
    { label: "rows", num: true },
  ];

  const parts = [table(headers, rows, "no movements in this window")];

  if (report.totals.unpriceable.length > 0) {
    parts.push(
      el("div", { class: "note" }, [
        el("b", { text: "Excluded from totals: " }),
        el("span", { text: report.totals.unpriceable.join(", ") }),
        el("div", { text: "Token decimals could not be read, so these amounts cannot be expressed in units. Their raw values appear in the movements below." }),
      ]),
    );
  }
  return el("div", {}, parts);
}

function renderNotable(derived) {
  const rows = derived.notable.map((n) =>
    el("tr", {}, [
      el("td", { class: "when", text: time(n.blockTimestamp) }),
      el("td", { class: "kind", text: n.category }),
      el("td", { text: n.reason }),
      el("td", { class: "kind", text: n.details }),
      txCell(n.txHash),
    ]),
  );

  const headers = [
    { label: "time" },
    { label: "category" },
    { label: "reason" },
    { label: "details" },
    { label: "tx" },
  ];
  return table(headers, rows, "no notable transactions in this window");
}

function renderTransferList(list, nativeSymbol, counterpartyHeader, emptyText) {
  const rows = list.map((m) =>
    el("tr", {}, [
      el("td", { class: "when", text: time(m.blockTimestamp) }),
      el("td", { class: "kind", text: m.kind }),
      el("td", { class: "num", text: m.amount ?? `${m.amountRaw ?? m.tokenId} raw` }),
      el("td", { text: assetLabel(m, nativeSymbol) }),
      addrCell(m.counterparty ?? m.to ?? m.from),
      addrCell(m.viaContract),
      txCell(m.txHash),
    ]),
  );

  const headers = [
    { label: "time" },
    { label: "kind" },
    { label: "amount", num: true },
    { label: "asset" },
    { label: counterpartyHeader },
    { label: "called" },
    { label: "tx" },
  ];
  return table(headers, rows, emptyText);
}

function renderSwaps(derived) {
  const rows = derived.swaps.map((s) =>
    el("tr", {}, [
      el("td", { class: "when", text: time(s.blockTimestamp) }),
      el("td", { class: "num", text: s.sentText }),
      el("td", { class: "num", text: s.receivedText }),
      addrCell(s.viaContract),
      txCell(s.txHash),
    ]),
  );

  const headers = [
    { label: "time" },
    { label: "sent", num: true },
    { label: "received", num: true },
    { label: "called" },
    { label: "tx" },
  ];
  return table(headers, rows, "no same-transaction exchanges in this window");
}

function renderApprovals(report) {
  const rows = report.approvals.map((a) =>
    el("tr", {}, [
      el("td", { class: "when", text: time(a.blockTimestamp) }),
      el("td", { class: "kind", text: a.kind }),
      el("td", { text: a.asset ? a.asset.symbol ?? shortHex(a.asset.address) : "—" }),
      el("td", { class: "num", text: a.kind === "APPROVAL_FOR_ALL" ? (a.approved ? "approved" : "revoked") : a.unlimited ? "unlimited" : a.amount ?? `${a.amountRaw} raw` }),
      addrCell(a.spender ?? a.operator),
      txCell(a.txHash),
    ]),
  );

  const headers = [
    { label: "time" },
    { label: "kind" },
    { label: "asset" },
    { label: "allowance", num: true },
    { label: "granted to" },
    { label: "tx" },
  ];
  return table(headers, rows, "no allowance changes in this window");
}

function renderCalls(report) {
  const rows = report.calls.map((c) =>
    el("tr", {}, [
      el("td", { class: "when", text: time(c.blockTimestamp) }),
      el("td", { class: "kind", text: c.kind }),
      addrCell(c.to),
      el("td", { class: "kind", text: c.selector ?? "—" }),
      el("td", { class: "kind", text: c.callKind ?? "—" }),
      txCell(c.txHash),
    ]),
  );

  const headers = [
    { label: "time" },
    { label: "kind" },
    { label: "target" },
    { label: "selector" },
    { label: "reading" },
    { label: "tx" },
  ];
  return table(headers, rows, "no contract calls without value in this window");
}

function renderNotes(report) {
  const parts = [];

  if (report.unresolved.length > 0) {
    parts.push(
      el("div", { class: "note" }, [
        el("b", { text: `${report.unresolved.length} event(s) could not be decoded.` }),
        el("ul", {}, report.unresolved.slice(0, 12).map((u) => el("li", { text: `${u.reason} · tx ${u.txHash ?? "—"}` }))),
        el("div", { text: "These are excluded from every category and from every total." }),
      ]),
    );
  }

  if (report.gaps.length > 0) {
    parts.push(
      el("div", { class: "note" }, [
        el("b", { text: `${report.gaps.length} block range(s) could not be read.` }),
        el("ul", {}, report.gaps.slice(0, 12).map((g) => el("li", { text: `${g.stage} ${g.fromBlock}–${g.toBlock} · ${g.reason}` }))),
        el("div", { text: "A window with gaps is not a complete ledger, which is why the verdict above is not COMPLETE." }),
      ]),
    );
  }

  parts.push(
    el("div", { class: "note" }, [
      el("b", { text: "What this log cannot see." }),
      el("ul", {}, report.blindSpots.map((b) => el("li", { text: b.detail }))),
    ]),
  );

  return parts;
}

function render(report) {
  const derived = deriveCategories(report);
  const nativeSymbol = report.totals.native.symbol;
  reportEl.replaceChildren(
    renderVerdict(report, derived),
    section("totals per category", renderCategoryTotals(report, derived)),
    section("totals per asset", renderTotals(report)),
    section("notable transactions", renderNotable(derived)),
    section("transfers in", renderTransferList(derived.transfersIn, nativeSymbol, "from", "no incoming transfers in this window")),
    section("transfers out", renderTransferList(derived.transfersOut, nativeSymbol, "to", "no outgoing transfers in this window")),
    section(
      "swaps (same-transaction exchanges)",
      renderSwaps(derived),
      "Grouped when a single transaction contains both outgoing and incoming wallet movements; never inferred from function selectors.",
    ),
    section("approvals", renderApprovals(report)),
    section("contract interactions", renderCalls(report)),
  );
  for (const note of renderNotes(report)) reportEl.append(note);
  reportEl.hidden = false;
}

function toDatetimeLocalUTC(ms) {
  return new Date(ms).toISOString().slice(0, 19);
}

modeSelect.addEventListener("change", () => {
  const isRange = modeSelect.value === "range";
  hoursField.hidden = isRange;
  fromField.hidden = !isRange;
  toField.hidden = !isRange;
  if (isRange && !fromInput.value && !toInput.value) {
    const now = Date.now();
    toInput.value = toDatetimeLocalUTC(now);
    fromInput.value = toDatetimeLocalUTC(now - 15 * 60 * 1000);
  }
});

async function loadLimits() {
  try {
    const res = await fetch("/api/audit");
    const cfg = await res.json();
    if (cfg.chain && cfg.chain.explorer) explorerBase = cfg.chain.explorer;
    const candidates = ["0.05", "0.1", "0.25", "0.5", "1"];
    const allowed = candidates.filter((h) => Number(h) <= cfg.window.maxHours);
    if (allowed.length === 0) allowed.push(String(cfg.window.maxHours));
    hoursSelect.replaceChildren(...allowed.map((h) => el("option", { value: h, text: `${h} h` })));
    if (allowed.includes(String(cfg.window.defaultHours))) hoursSelect.value = String(cfg.window.defaultHours);

    limitsEl.replaceChildren(
      el("div", {}, [
        el("b", { text: "chain " }),
        el("span", { text: `${cfg.chain.name} (${cfg.chain.id})` }),
      ]),
      el("div", {}, [
        el("b", { text: "window budget " }),
        el("span", { text: `${cfg.window.maxBlocks} blocks, up to ${cfg.window.maxHours} h per request` }),
      ]),
      el("div", {}, [
        el("b", { text: "why a limit " }),
        el("span", { text: "finding native transfers means reading every block body, and the public RPC throttles. A longer window is refused rather than quietly shortened." }),
      ]),
    );
  } catch (err) {
    limitsEl.replaceChildren(el("div", { text: "limits unavailable: " + err.message }));
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const wallet = walletInput.value.trim();
  if (!wallet) return;

  const payload = { wallet };
  if (modeSelect.value === "range") {
    if (!fromInput.value || !toInput.value) {
      statusEl.className = "status error";
      statusEl.textContent = "INVALID_DATE_RANGE: both from and to UTC timestamps are required";
      return;
    }
    payload.from = fromInput.value.endsWith("Z") ? fromInput.value : fromInput.value + "Z";
    payload.to = toInput.value.endsWith("Z") ? toInput.value : toInput.value + "Z";
  } else {
    payload.hours = hoursSelect.value;
  }

  const seq = ++requestSeq;
  runButton.disabled = true;
  statusEl.className = "status";
  statusEl.textContent = "reading blocks and logs…";

  try {
    const res = await fetch("/api/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();

    if (seq !== requestSeq) return;

    if (!res.ok) {
      statusEl.className = "status error";
      statusEl.textContent = body.error ? `${body.error.code}: ${body.error.message}` : `request failed (${res.status})`;
      reportEl.hidden = true;
      return;
    }

    statusEl.textContent = "";
    render(body);
  } catch (err) {
    if (seq !== requestSeq) return;
    statusEl.className = "status error";
    statusEl.textContent = "request failed: " + err.message;
  } finally {
    if (seq === requestSeq) runButton.disabled = false;
  }
});

loadLimits();
