/**
 * The demo profile. FAKE DATA ONLY (CLAUDE.md).
 *
 * Shared by the side panel's "load demo profile" button and by the eval harness,
 * so the numbers we report are produced with exactly the profile the demo runs
 * with — not a more favourable one.
 *
 * The Aadhaar is Verhoeff-valid and the card Luhn-valid on purpose: the detectors
 * have to fire on them for the demo to prove anything. They are not issued to
 * anyone. These values match `demo-site/` and `tests/fixtures.ts`.
 */

import type { ProfileKey } from './pii/vault';

export const DEMO_PROFILE: Record<ProfileKey, string> = {
  FULL_NAME: 'Ananya Iyer',
  EMAIL: 'ananya.iyer@example.com',
  PHONE: '9812345678',
  DOB: '14/03/2001',
  ADDRESS: '42 Nehru Road, Bandra West, Mumbai',
  PINCODE: '400050',
  AADHAAR: '2234 5678 9018',
  PAN: 'ABCPI1234K',
  PASSPORT: 'M1234567',
  UPI: 'ananya@okhdfcbank',
};
