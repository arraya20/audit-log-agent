
// POST /api/audit  { wallet, hours? } | { wallet, from, to }
//
// The caller supplies a wallet and a window (either relative `hours` or an
// explicit `from`..`to` date range). Nothing else. It cannot supply
// transactions, categories, amounts or a verdict — that was the whole defect of
// the scaffold, which audited whatever list the browser handed it and returned
// success: true.
//
// Optional query parameter `?format=markdown` or `?format=csv` exports the
// report directly as Markdown or CSV.
//
// Two responses deserve comment:
//
//   200 with completeness "PARTIAL" is a success. The audit ran and is telling
//   you which parts of the ledger it could not read. A client that wants only
//   fully-covered periods must check the field; the API will not pretend by
//   returning an empty report.
//
//   400 WINDOW_EXCEEDS_BUDGET is a refusal, not a truncation. Scanning a day of
//   blocks needs ~82,000 block reads and the public RPC will throttle long before
//   that, so the endpoint states the cost instead of quietly returning less data
//   than was asked for.

import { runAudit } from "../../src/report.mjs";
import { toMarkdown, toCsv } from "../../src/export.mjs";
import { isAddress, toChecksumAddress } from "../../src/address.mjs";
import { BUDGET, JOB, blocksForHours, maxHoursForBudget, publicConfig } from "../../src/config.mjs";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });
}

function fail(code, message, status, detail = undefined) {
  const error = { code, message };
  if (detail !== undefined) error.detail = detail;
  return json({ error }, status);
}

const ALLOWED_KEYS = new Set(["wallet", "hours", "from", "to"]);
const DECIMAL = /^\d+(\.\d+)?$/;
const INT_DIGITS = /^\d+$/;

/** Parse hours strictly. "0.25" is fine; "0.25h", "1e3" and "" are not. */
function parseHours(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: JOB.defaultHours };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return { ok: false, reason: "hours must be a positive number" };
    return { ok: true, value: raw };
  }
  if (typeof raw === "string") {
    if (!DECIMAL.test(raw)) return { ok: false, reason: "hours must be a plain decimal such as 0.25" };
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: "hours must be greater than zero" };
    return { ok: true, value };
  }
  return { ok: false, reason: "hours must be a number" };
}

/** Parse a date/time bound (unix seconds or ISO-8601 string) into unix seconds. */
function parseTimestamp(raw, label) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return { ok: false, reason: `${label} must be a positive timestamp` };
    return { ok: true, value: Math.floor(raw > 1e12 ? raw / 1000 : raw) };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, reason: `${label} must not be empty` };
    if (INT_DIGITS.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: `${label} must be a positive timestamp` };
      return { ok: true, value: Math.floor(n > 1e12 ? n / 1000 : n) };
    }
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms) || ms <= 0) return { ok: false, reason: `${label} must be a valid ISO-8601 date or unix timestamp` };
    return { ok: true, value: Math.floor(ms / 1000) };
  }
  return { ok: false, reason: `${label} must be an ISO-8601 string or unix timestamp` };
}

export async function onRequestPost({ request }) {
  const url = new URL(request.url);
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();
  if (format !== "json" && format !== "markdown" && format !== "csv") {
    return fail("INVALID_FORMAT", "format must be json, markdown, or csv", 400);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_JSON", "body must be JSON", 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("INVALID_BODY", "body must be an object", 400);
  }

  // Unknown keys are rejected rather than ignored: a caller sending
  // "transactions" or "policy" should learn that those inputs do not exist here.
  const unknown = Object.keys(body).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknown.length > 0) {
    return fail("UNKNOWN_FIELD", `this endpoint accepts only wallet and a window (hours or from/to); got ${unknown.join(", ")}`, 400, { allowed: [...ALLOWED_KEYS] });
  }

  const wallet = body.wallet;
  if (typeof wallet !== "string" || !isAddress(wallet)) {
    return fail("INVALID_WALLET", "wallet must be a 0x-prefixed 20-byte hex address", 400);
  }

  const hasRange = body.from !== undefined || body.to !== undefined;
  let hoursValue = null;
  let fromSeconds = null;
  let toSeconds = null;

  if (hasRange) {
    if (body.hours !== undefined && body.hours !== null) {
      return fail("INVALID_DATE_RANGE", "supply either hours or from/to date range, not both", 400);
    }
    if (body.from === undefined || body.to === undefined) {
      return fail("INVALID_DATE_RANGE", "both from and to are required when specifying a date range", 400);
    }
    const parsedFrom = parseTimestamp(body.from, "from");
    if (!parsedFrom.ok) return fail("INVALID_DATE_RANGE", parsedFrom.reason, 400);
    const parsedTo = parseTimestamp(body.to, "to");
    if (!parsedTo.ok) return fail("INVALID_DATE_RANGE", parsedTo.reason, 400);
    if (parsedTo.value <= parsedFrom.value) {
      return fail("INVALID_DATE_RANGE", "to must be later than from", 400);
    }
    fromSeconds = parsedFrom.value;
    toSeconds = parsedTo.value;
    hoursValue = Number(((toSeconds - fromSeconds) / 3600).toFixed(4));
  } else {
    const hours = parseHours(body.hours);
    if (!hours.ok) return fail("INVALID_HOURS", hours.reason, 400);
    hoursValue = hours.value;
  }

  const blocks = blocksForHours(hoursValue);
  if (blocks > BUDGET.maxBlocks) {
    return fail("WINDOW_EXCEEDS_BUDGET", `a ${hoursValue}h window needs ${blocks} blocks; the budget is ${BUDGET.maxBlocks}`, 400, {
      requestedHours: hoursValue,
      requestedBlocks: blocks,
      maxBlocks: BUDGET.maxBlocks,
      maxHours: Number(maxHoursForBudget().toFixed(3)),
    });
  }

  try {
    const report = await runAudit({
      wallet: toChecksumAddress(wallet),
      hours: hasRange ? null : hoursValue,
      fromSeconds,
      toSeconds,
    });
    if (format === "markdown") {
      return new Response(toMarkdown(report), {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", ...CORS },
      });
    }
    if (format === "csv") {
      return new Response(toCsv(report), {
        status: 200,
        headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", ...CORS },
      });
    }
    return json(report, 200);
  } catch (err) {
    if (err && err.code === "INVALID_DATE_RANGE") {
      return fail("INVALID_DATE_RANGE", err.message, 400, err.detail);
    }
    if (err && err.code === BUDGET.windowTooLarge) {
      return fail(BUDGET.windowTooLarge, err.message, 400, err.detail);
    }
    // A transport failure means no audit happened at all. It is not an empty log.
    const code = err && err.code ? err.code : "UPSTREAM_UNAVAILABLE";
    return fail(code, err && err.message ? err.message : "audit failed", 502, err && err.detail ? err.detail : undefined);
  }
}

export async function onRequestGet() {
  // The limits are part of the contract, so they are readable without guessing.
  return json(publicConfig(), 200);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequest({ request }) {
  const method = request.method.toUpperCase();
  if (method === "POST") return onRequestPost({ request });
  if (method === "GET") return onRequestGet({ request });
  if (method === "OPTIONS") return onRequestOptions();
  return new Response(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: `${method} is not supported` } }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", allow: "POST, GET, OPTIONS", ...CORS },
  });
}
