// Exact decimal formatting.
//
// A token balance divided by 10**18 in JavaScript is a lie with 17 significant
// digits. Audit totals are accumulated as BigInt and only formatted once, at the
// edge, so no rounding ever enters the ledger.

/** Format a raw integer amount as an exact decimal string. */
export function formatUnits(raw, decimals) {
  const value = BigInt(raw);
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 255) {
    throw new Error(`bad decimals: ${decimals}`);
  }
  if (places === 0) return value.toString();

  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(places);
  const whole = abs / base;
  const fraction = abs % base;

  let text = fraction.toString().padStart(places, "0").replace(/0+$/, "");
  if (text.length > 0) text = `${whole}.${text}`;
  else text = whole.toString();

  return negative ? `-${text}` : text;
}

/** Raw base units as a plain decimal string, for JSON (BigInt is not JSON). */
export function rawToString(raw) {
  return BigInt(raw).toString();
}

/** Sum a list of BigInt-able values without touching floating point. */
export function exactSum(values) {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  return total;
}

/** True when the value is exactly zero. */
export function isZero(raw) {
  return BigInt(raw) === 0n;
}
