import { describe, expect, it } from 'vitest';
import { describeIncidents, guardPayload } from '../lib/pii/egress';
import { Vault } from '../lib/pii/vault';
import { FAKE } from './fixtures';

const cleanPayload = {
  session_id: 'a1b2',
  task: 'Fill the form with my profile',
  page: { origin: 'https://demo.local', path: '/apply', title: 'Scholarship application' },
  elements: [
    { id: 5, role: 'textbox', label: 'Email', value: '⟦PROFILE.EMAIL⟧' },
    { id: 7, role: 'textbox', label: 'Aadhaar number', value: '⟦AADHAAR_1⟧' },
    { id: 12, role: 'button', text: 'Submit' },
  ],
  redactions: [{ token: '⟦FACE_1⟧', type: 'FACE', bbox: [40, 80, 96, 96] }],
  profile_keys: ['EMAIL', 'PHONE'],
};

describe('a properly sanitized payload', () => {
  it('passes', () => {
    const report = guardPayload(cleanPayload);
    expect(report.ok).toBe(true);
    expect(report.incidents).toEqual([]);
  });

  it('counts what it scanned, so the UI can show the guard actually ran', () => {
    const report = guardPayload(cleanPayload);
    expect(report.stringsScanned).toBeGreaterThan(5);
    expect(report.charsScanned).toBeGreaterThan(0);
  });

  it('does not treat tokens as PII', () => {
    expect(guardPayload({ value: '⟦PROFILE.EMAIL⟧' }).ok).toBe(true);
  });
});

describe('leaks are caught', () => {
  it.each([
    ['email', FAKE.email, 'EMAIL'],
    ['phone', FAKE.phone, 'PHONE'],
    ['Aadhaar', FAKE.aadhaarSpaced, 'AADHAAR'],
    ['card', FAKE.card, 'CARD'],
    ['PAN', FAKE.pan, 'PAN'],
  ])('blocks a raw %s that slipped into a label', (_name, value, type) => {
    const payload = structuredClone(cleanPayload);
    payload.elements[0]!.label = `Email (${value})`;
    const report = guardPayload(payload);
    expect(report.ok).toBe(false);
    expect(report.incidents.map((i) => i.type)).toContain(type);
  });

  it('reports the exact path so the bug is findable', () => {
    const payload = structuredClone(cleanPayload);
    payload.elements[1]!.value = FAKE.aadhaar;
    const report = guardPayload(payload);
    expect(report.incidents[0]!.path).toBe('elements[1].value');
  });

  it('catches a leak nested deep in the payload', () => {
    const report = guardPayload({ a: { b: { c: [{ d: `contact ${FAKE.email}` }] } } });
    expect(report.ok).toBe(false);
    expect(report.incidents[0]!.path).toBe('a.b.c[0].d');
  });

  it('catches a vault value even when no pattern matches it', () => {
    const vault = new Vault();
    vault.setProfile('FULL_NAME', FAKE.fullName);
    const payload = { elements: [{ label: `Welcome ${FAKE.fullName}` }] };

    expect(guardPayload(payload).ok).toBe(true); // no pattern knows this is a name
    const report = guardPayload(payload, { secrets: vault.secrets() });
    expect(report.ok).toBe(false);
    expect(report.incidents[0]!.kind).toBe('vault-value');
  });

  it('matches a vault value through different separators', () => {
    const vault = new Vault();
    vault.tokenize('CARD', FAKE.card);
    const report = guardPayload({ note: `ref 4111-1111-1111-1111` }, { secrets: vault.secrets() });
    expect(report.ok).toBe(false);
  });
});

describe('the screenshot field', () => {
  it('is skipped, because scanning JPEG bytes as text is meaningless', () => {
    const payload = {
      screen: { image_jpeg_b64: '9'.repeat(50_000), width: 1280, height: 800 },
    };
    const report = guardPayload(payload);
    expect(report.ok).toBe(true);
    expect(report.skipped).toContain('screen.image_jpeg_b64');
  });
});

describe('incident reporting', () => {
  it('never contains the offending value', () => {
    const payload = { label: `mail ${FAKE.email}` };
    const report = guardPayload(payload);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(FAKE.email);
    expect(serialized).not.toContain('ananya');
  });

  it('summarises counts by type', () => {
    const report = guardPayload({ a: FAKE.email, b: FAKE.emailAlt, c: FAKE.phone });
    expect(describeIncidents(report.incidents)).toMatch(/EMAIL×2/);
  });

  it('says "clean" when there is nothing to report', () => {
    expect(describeIncidents([])).toBe('clean');
  });
});
