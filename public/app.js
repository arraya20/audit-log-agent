// Renderer only.
//
// Every number on this page is a string the backend produced. The client does no
// arithmetic — it never sums movements, derives a decimal, or recomputes a fee.
// If a figure looks wrong here, it is wrong on the server, and that is the only
// place it should be fixed.

const form = document.getElementById("form");
const walletInput = document.getElementById("wallet");
const hoursSelect = document.getElementById("hours");
const runButton = document.getElementById("run");
const statusEl = document.getElementById("status");
const reportEl = document.getElementById("report");
const limitsEl = document.getElementById("limits");

// Guards against a slow first request overwriting a newer one.
let requestSeq = 0;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

function time(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

// Block-explorer convention: keep both ends, drop the middle. The full address
// stays in the title attribute and in the JSON response — this is a reading aid,
// not a redaction.
function shortAddress(value) {
  if (!value) return "—";
  if (value.length <= 14) return value;
  return value.slice(0, 6) + "…" + value.slice(-4);
}

function addrCell(value, extraClass) {
  if (!value) return el("td", { class: "addr", text: "—" });
  return el("td", { class: "addr" + (extraClass ? " " + extraClass : ""), title: value, text: shortAddress(value) });
}

function table(headers, rows, emptyText) {
  if (rows.length === 0) return el("p", { class: "empty", text: emptyText });
  const thead = el("thead", {}, [
    el("tr", {}, headers.map((h) => el("th", { class: h.num ? "num" : "", text: h.label }))),
  ]);
  const tbody = el("tbody", {}, rows);
  return el("table", {}, [thead, tbody]);
}

function section(title, body) {
  return el("section", { class: "block" }, [el("h2", { text: title }), body]);
}

function renderVerdict(report) {
  const state = el("span", {
    class: "state " + (report.completeness === "COMPLETE" ? "complete" : "partial"),
    text: report.completeness,
  });

  const meta = el("span", {
    class: "meta",
    text: `${report.wallet} · chain ${report.chain.id} · blocks ${report.window.fromBlock}–${report.window.toBlock} · ${time(report.window.fromTime)} → ${time(report.window.toTime)}`,
  });

  const fees = el("span", {
    class: "meta",
    text: `gas ${report.fees.total} ${report.fees.symbol} over ${report.fees.transactions} tx` + (report.fees.unverified ? ` · ${report.fees.unverified} unverified` : ""),
  });

  const box = el("div", { class: "verdict" }, [state, meta, fees]);

  if (report.reasons.length > 0) {
    const list = el("ul", { class: "reasons" }, report.reasons.map((r) => el("li", { text: r })));
    const wrap = el("div", {}, [box, list]);
    return wrap;
  }
  return box;
}

function renderTotals(report) {
  const rows = report.totals.byAsset.map((asset) =>
    el("tr", {}, [
      el("td", { text: asset.symbol ?? asset.address }),
      el("td", { class: "num", text: asset.in }),
      el("td", { class: "num", text: asset.out }),
      el("td", { class: "num", text: asset.net }),
      el("td", { class: "num", text: String(asset.count) }),
    ]),
  );

  // Native is a separate row because it has no token contract, and because
  // folding it into the asset table would imply a shared unit.
  // The native row's net is taken after gas, because gas is paid in native
  // currency and a token-only trading window would otherwise read as "native
  // unchanged" while the balance quietly fell.
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

function renderMovements(report) {
  const rows = report.movements.map((m) =>
    el("tr", {}, [
      el("td", { class: "when", text: time(m.blockTimestamp) }),
      el("td", { class: "kind", text: m.kind }),
      el("td", { class: "num", text: m.amount ?? `${m.amountRaw} raw` }),
      el("td", { text: m.asset ? m.asset.symbol ?? m.asset.address : report.totals.native.symbol }),
      addrCell(m.counterparty ?? m.to ?? m.from),
      addrCell(m.viaContract),
    ]),
  );

  const headers = [
    { label: "time" },
    { label: "kind" },
    { label: "amount", num: true },
    { label: "asset" },
    { label: "counterparty" },
    { label: "called" },
  ];
  return table(headers, rows, "nothing moved in this window");
}

function renderApprovals(report) {
  const rows = report.approvals.map((a) =>
    el("tr", {}, [
      el("td", { class: "when", text: time(a.blockTimestamp) }),
      el("td", { class: "kind", text: a.kind }),
      el("td", { text: a.asset ? a.asset.symbol ?? a.asset.address : "—" }),
      el("td", { class: "num", text: a.unlimited ? "unlimited" : a.amount ?? `${a.amountRaw} raw` }),
      addrCell(a.spender ?? a.operator),
    ]),
  );

  const headers = [
    { label: "time" },
    { label: "kind" },
    { label: "asset" },
    { label: "allowance", num: true },
    { label: "granted to" },
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
    ]),
  );

  const headers = [
    { label: "time" },
    { label: "kind" },
    { label: "target" },
    { label: "selector" },
    { label: "reading" },
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
  reportEl.replaceChildren(
    renderVerdict(report),
    section("totals", renderTotals(report)),
    section("movements", renderMovements(report)),
    section("allowances", renderApprovals(report)),
    section("calls", renderCalls(report)),
  );
  for (const note of renderNotes(report)) reportEl.append(note);
  reportEl.hidden = false;
}

async function loadLimits() {
  try {
    const res = await fetch("/api/audit");
    const cfg = await res.json();
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

  const seq = ++requestSeq;
  runButton.disabled = true;
  statusEl.className = "status";
  statusEl.textContent = "reading blocks and logs…";

  try {
    const res = await fetch("/api/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet, hours: hoursSelect.value }),
    });
    const body = await res.json();

    // A newer submission has already started; this answer is stale.
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
