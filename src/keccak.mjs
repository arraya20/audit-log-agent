// Keccak-256, self-contained.
//
// Event topics and function selectors are derived from signature strings at load
// time instead of being typed into the trust path as hex constants. A mistyped
// topic hash would silently match nothing, and "no events found" is
// indistinguishable from "this wallet did nothing" — the exact failure an audit
// log cannot afford.
//
// This is Keccak (0x01 padding), not SHA3-256 (0x06 padding). Node's crypto has
// SHA3 but not Keccak, so the permutation is implemented here. Lanes are BigInt,
// which is slow but irrelevant: we hash a handful of signature strings once.

const MASK = (1n << 64n) - 1n;

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// rho rotation offsets, indexed [x + 5y].
const ROTATIONS = [
  0n, 1n, 62n, 28n, 27n,
  36n, 44n, 6n, 55n, 20n,
  3n, 10n, 43n, 25n, 39n,
  41n, 45n, 15n, 21n, 8n,
  18n, 2n, 61n, 56n, 14n,
];

function rotl(value, shift) {
  if (shift === 0n) return value & MASK;
  return ((value << shift) | (value >> (64n - shift))) & MASK;
}

function permute(state) {
  for (let round = 0; round < 24; round++) {
    // theta
    const c = new Array(5);
    for (let x = 0; x < 5; x++) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
    }

    // rho + pi
    const b = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const nx = y;
        const ny = (2 * x + 3 * y) % 5;
        b[nx + 5 * ny] = rotl(state[x + 5 * y], ROTATIONS[x + 5 * y]);
      }
    }

    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        state[x + y] = b[x + y] ^ ((~b[((x + 1) % 5) + y] & MASK) & b[((x + 2) % 5) + y]);
      }
    }

    // iota
    state[0] ^= ROUND_CONSTANTS[round];
  }
}

/** Hash bytes to a 32-byte Uint8Array. */
export function keccak256Bytes(input) {
  const rate = 136; // 1088-bit rate for a 256-bit output
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);

  const paddedLength = Math.ceil((bytes.length + 1) / rate) * rate;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[paddedLength - 1] ^= 0x80;

  const state = new Array(25).fill(0n);

  for (let offset = 0; offset < paddedLength; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane++) {
      let value = 0n;
      for (let i = 7; i >= 0; i--) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + i]);
      }
      state[lane] ^= value;
    }
    permute(state);
  }

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let value = state[lane];
    for (let i = 0; i < 8; i++) {
      out[lane * 8 + i] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return out;
}

/** Hash a UTF-8 string to lowercase 0x-prefixed hex. */
export function keccak256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  return "0x" + [...keccak256Bytes(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The 4-byte function selector for a signature, e.g. "transfer(address,uint256)". */
export function selectorOf(signature) {
  return keccak256Hex(signature).slice(0, 10);
}

/** The 32-byte event topic for a signature, e.g. "Transfer(address,address,uint256)". */
export function topicOf(signature) {
  return keccak256Hex(signature);
}
