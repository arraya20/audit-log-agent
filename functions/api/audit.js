
// POST /api/audit  { wallet, hours? }
//
// The caller supplies a wallet and a window. Nothing else. It cannot supply
// transactions, categories, amounts or a verdict — that was the whole defect of
// the scaffold, which audited whatever list the browser handed it and returned
// success: true.
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

const ALLOWED_KEYS = new Set(["wallet", "hours"]);
const DECIMAL = /^\d+(\.\d+)?$/;

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

export async function onRequestPost({ request }) {
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
    return fail("UNKNOWN_FIELD", `this endpoint accepts only wallet and hours; got ${unknown.join(", ")}`, 400, { allowed: [...ALLOWED_KEYS] });
  }

  const wallet = body.wallet;
  if (typeof wallet !== "string" || !isAddress(wallet)) {
    return fail("INVALID_WALLET", "wallet must be a 0x-prefixed 20-byte hex address", 400);
  }

  const hours = parseHours(body.hours);
  if (!hours.ok) return fail("INVALID_HOURS", hours.reason, 400);

  const blocks = blocksForHours(hours.value);
  if (blocks > BUDGET.maxBlocks) {
    return fail("WINDOW_EXCEEDS_BUDGET", `a ${hours.value}h window needs ${blocks} blocks; the budget is ${BUDGET.maxBlocks}`, 400, {
      requestedHours: hours.value,
      requestedBlocks: blocks,
      maxBlocks: BUDGET.maxBlocks,
      maxHours: Number(maxHoursForBudget().toFixed(3)),
    });
  }

  try {
    const report = await runAudit({ wallet: toChecksumAddress(wallet), hours: hours.value });
    return json(report, 200);
  } catch (err) {
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
