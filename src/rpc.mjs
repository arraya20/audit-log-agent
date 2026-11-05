// JSON-RPC transport.
//
// Three rules, all of them learned from watching this RPC misbehave:
//
//   1. Batches are supported and are the only way to scan many blocks cheaply.
//   2. A batch can fail per item, so per-item results are returned rather than a
//      single list of values. A caller that cannot tell which items failed will
//      eventually present a hole as data.
//   3. 429 is normal under load. It is retried with backoff, and if retries run
//      out the failure is raised, never swallowed. The scanner turns that into a
//      recorded gap, which makes the report incomplete instead of wrong.

export class RpcError extends Error {
  constructor(code, message, { retryable = false, status = null } = {}) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

const THROTTLE_CODES = new Set([429, -32011, -32005]);
const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"]);

function isRetryable(status, payload) {
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  if (payload && typeof payload === "object" && THROTTLE_CODES.has(payload.code)) return true;
  return false;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRpc({
  url,
  fetchImpl = globalThis.fetch,
  // Measured on the public endpoint: a throttle window lasts tens of seconds,
  // so 5 tries over 12 s gave up while the node was still recovering. The
  // schedule below waits about 50 s in total, then raises — never swallows.
  retries = 7,
  backoffBaseMs = 800,
  backoffMaxMs = 15000,
  sleep = defaultSleep,
  timeoutMs = 30000,
} = {}) {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("rpc: url required");
  if (typeof fetchImpl !== "function") throw new Error("rpc: fetch required");

  const stats = { httpCalls: 0, rpcCalls: 0, retries: 0, throttled: 0 };

  async function postOnce(body) {
    stats.httpCalls++;
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined,
      });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: res.status, parsed, text };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function backoff(attempt) {
    const ms = Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempt);
    // Jitter keeps retries from landing in lockstep against a per-window limiter.
    return ms + Math.floor(Math.random() * (backoffBaseMs / 2));
  }

  /** One request, retried on throttling. Returns the decoded result or throws. */
  async function call(method, params = []) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        stats.retries++;
        await sleep(backoff(attempt - 1));
      }
      let out;
      try {
        out = await postOnce({ jsonrpc: "2.0", id: 1, method, params });
      } catch (e) {
        lastErr = new RpcError("TRANSPORT", String(e && e.message ? e.message : e), { retryable: true });
        continue;
      }
      const payload = out.parsed;
      if (isRetryable(out.status, payload)) {
        stats.throttled++;
        lastErr = new RpcError("THROTTLED", `http ${out.status}`, { retryable: true, status: out.status });
        continue;
      }
      if (out.status !== 200) {
        throw new RpcError("HTTP_STATUS", `http ${out.status}: ${String(out.text).slice(0, 200)}`, { status: out.status });
      }
      if (!payload || typeof payload !== "object") throw new RpcError("BAD_JSON", "response was not JSON");
      if (payload.error) {
        throw new RpcError(payload.error.code ?? "RPC_ERROR", String(payload.error.message ?? "rpc error"));
      }
      stats.rpcCalls++;
      return payload.result;
    }
    throw lastErr ?? new RpcError("RETRIES_EXHAUSTED", "retries exhausted");
  }

  /**
   * Batch request. Returns one entry per input, in order:
   *   { ok: true, value } | { ok: false, code, message }
   * The whole batch is retried only when the transport itself fails; per-item
   * errors are surfaced to the caller untouched.
   */
  async function batch(calls) {
    if (!Array.isArray(calls) || calls.length === 0) return [];
    const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params ?? [] }));

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        stats.retries++;
        await sleep(backoff(attempt - 1));
      }
      let out;
      try {
        out = await postOnce(body);
      } catch (e) {
        lastErr = new RpcError("TRANSPORT", String(e && e.message ? e.message : e), { retryable: true });
        continue;
      }
      if (isRetryable(out.status, out.parsed)) {
        stats.throttled++;
        lastErr = new RpcError("THROTTLED", `http ${out.status}`, { retryable: true, status: out.status });
        continue;
      }
      if (out.status !== 200) {
        throw new RpcError("HTTP_STATUS", `http ${out.status}: ${String(out.text).slice(0, 200)}`, { status: out.status });
      }
      const payload = out.parsed;
      if (!Array.isArray(payload)) {
        // Some nodes answer a single object when they refuse the whole batch.
        if (payload && payload.error) {
          if (THROTTLE_CODES.has(payload.error.code)) {
            stats.throttled++;
            lastErr = new RpcError("THROTTLED", String(payload.error.message ?? "throttled"), { retryable: true });
            continue;
          }
          throw new RpcError(payload.error.code ?? "RPC_ERROR", String(payload.error.message ?? "rpc error"));
        }
        throw new RpcError("BAD_JSON", "batch response was not an array");
      }
      stats.rpcCalls += calls.length;

      const byId = new Map();
      for (const item of payload) {
        if (item && typeof item === "object" && item.id !== undefined) byId.set(item.id, item);
      }
      return calls.map((_, i) => {
        const item = byId.get(i + 1);
        if (!item) return { ok: false, code: "MISSING", message: "no response for this batch item" };
        if (item.error) return { ok: false, code: item.error.code ?? "RPC_ERROR", message: String(item.error.message ?? "rpc error") };
        return { ok: true, value: item.result };
      });
    }
    throw lastErr ?? new RpcError("RETRIES_EXHAUSTED", "retries exhausted");
  }

  return { call, batch, stats };
}
