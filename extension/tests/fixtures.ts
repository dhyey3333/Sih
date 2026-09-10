/**
 * Test fixtures.
 *
 * Every value here is FAKE and generated to satisfy the relevant checksum, so the
 * detectors are exercised for real without any person's actual data appearing in
 * the repo (CLAUDE.md). `4111111111111111` is the industry-standard Visa test
 * number; the Aadhaar numbers are Verhoeff-valid but not issued to anyone.
 */

export const FAKE = {
  email: 'ananya.iyer@example.com',
  emailAlt: 'r.mehta@mailinator.example',
  phone: '9812345678',
  phoneWithCode: '+91 9812345678',
  /** Verhoeff-valid. */
  aadhaar: '223456789018',
  aadhaarSpaced: '2234 5678 9018',
  /** Verhoeff-invalid: last digit changed. */
  aadhaarBadChecksum: '223456789012',
  /** Luhn-valid Visa test number. */
  card: '4111111111111111',
  cardSpaced: '4111 1111 1111 1111',
  /** Luhn-invalid. */
  cardBadChecksum: '4111111111111112',
  /** 4th letter P = individual. */
  pan: 'ABCPI1234K',
  /** 4th letter X is not a valid holder type. */
  panBadHolder: 'ABCXI1234K',
  ifsc: 'HDFC0001234',
  upi: 'ananya@okhdfcbank',
  passport: 'M1234567',
  pincode: '400050',
  dob: '14/03/2001',
  otp: '482913',
  cvv: '431',
  fullName: 'Ananya Iyer',
  address: '42 Nehru Road, Bandra West, Mumbai',
} as const;

/** Strings that must NOT be detected — the precision half of the metric. */
export const NOT_PII = {
  orderNumber: 'Order #100000000000 shipped',
  price: 'Total: 129900',
  year: 'Founded in 2001 by two engineers',
  buildHash: 'build ABCXI1234K9 from main',
  productCode: 'SKU 4111111111111112 out of stock',
  mention: 'thanks @teammate for the review',
  version: 'v1.29.0 released',
  counts: 'Showing 1234 of 5678 results',
} as const;
