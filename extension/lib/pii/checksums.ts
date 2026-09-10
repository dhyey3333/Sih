/**
 * Checksums that turn weak digit patterns into high-precision detections.
 *
 * Why this matters for the score: "12 digits in a row" fires on order numbers,
 * timestamps and phone lists. Aadhaar's Verhoeff check and a card's Luhn check
 * cut those false positives by ~90% while costing nothing at runtime, which is
 * what keeps *precision* of PII detection high without hurting recall.
 */

/** Dihedral group D5 multiplication table. */
const D5_MUL: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

/** Permutation table, applied by position. */
const D5_PERM: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const D5_INV: readonly number[] = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function digitsOf(input: string): number[] {
  const out: number[] = [];
  for (const ch of input) {
    if (ch >= '0' && ch <= '9') out.push(ch.charCodeAt(0) - 48);
  }
  return out;
}

/**
 * Verhoeff check, as used by UIDAI for Aadhaar. The last digit is the check digit.
 * Returns false for anything that isn't exactly 12 digits, since that's the only
 * length we ever apply it to here.
 */
export function isVerhoeffValid(input: string): boolean {
  const digits = digitsOf(input);
  if (digits.length !== 12) return false;

  let c = 0;
  // Walk right-to-left; position 0 is the check digit itself.
  for (let i = 0; i < digits.length; i++) {
    const digit = digits[digits.length - 1 - i]!;
    const permuted = D5_PERM[i % 8]![digit]!;
    c = D5_MUL[c]![permuted]!;
  }
  return c === 0;
}

/** Compute the Verhoeff check digit for an 11-digit body (used by the data generator). */
export function verhoeffCheckDigit(body: string): number {
  const digits = digitsOf(body);
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = digits[digits.length - 1 - i]!;
    const permuted = D5_PERM[(i + 1) % 8]![digit]!;
    c = D5_MUL[c]![permuted]!;
  }
  return D5_INV[c]!;
}

/** Luhn (mod 10) check for payment card numbers. */
export function isLuhnValid(input: string): boolean {
  const digits = digitsOf(input);
  if (digits.length < 12 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i]!;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * The 4th character of a PAN encodes the holder type. Anything outside this set
 * is not a real PAN, which kills matches on random 5-letter/4-digit/1-letter
 * strings such as build hashes or SKU codes.
 */
const PAN_HOLDER_TYPES = new Set(['P', 'C', 'H', 'F', 'A', 'T', 'B', 'L', 'J', 'G']);

export function isPanStructureValid(input: string): boolean {
  const value = input.toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(value)) return false;
  return PAN_HOLDER_TYPES.has(value.charAt(3));
}
