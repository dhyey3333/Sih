import { describe, expect, it } from 'vitest';
import { classifyField, imageHint, type FieldDescriptor } from '../lib/pii/dom-heuristics';

const field = (partial: Partial<FieldDescriptor>): FieldDescriptor => ({ tag: 'INPUT', ...partial });

describe('password fields', () => {
  it('are sensitive with no label at all', () => {
    expect(classifyField(field({ type: 'password' }))).toMatchObject({
      type: 'PASSWORD',
      confidence: 1,
    });
  });
});

describe('autocomplete beats every heuristic', () => {
  it.each([
    ['cc-number', 'CARD'],
    ['cc-csc', 'CVV'],
    ['email', 'EMAIL'],
    ['tel', 'PHONE'],
    ['bday', 'DOB'],
    ['street-address', 'ADDRESS'],
    ['postal-code', 'PINCODE'],
    ['one-time-code', 'OTP'],
    ['family-name', 'NAME'],
  ])('maps autocomplete=%s to %s', (autocomplete, expected) => {
    expect(classifyField(field({ type: 'text', autocomplete }))?.type).toBe(expected);
  });

  it('reads a multi-token autocomplete value', () => {
    expect(classifyField(field({ type: 'text', autocomplete: 'shipping street-address' }))?.type).toBe(
      'ADDRESS',
    );
  });
});

describe('label heuristics', () => {
  it.each([
    ['Aadhaar Number', 'AADHAAR'],
    ['PAN card number', 'PAN'],
    ['Passport number', 'PASSPORT'],
    ['CVV', 'CVV'],
    ['Credit card number', 'CARD'],
    ['IFSC code', 'IFSC'],
    ['UPI ID', 'UPI'],
    ['Bank account number', 'ACCOUNT'],
    ['Enter OTP', 'OTP'],
    ['Email address', 'EMAIL'],
    ['Mobile number', 'PHONE'],
    ['Date of birth', 'DOB'],
    ['PIN code', 'PINCODE'],
    ['Street address', 'ADDRESS'],
    ["Father's name", 'NAME'],
    ['Full name', 'NAME'],
    ['Annual salary', 'GENERIC'],
  ])('flags "%s" as %s', (label, expected) => {
    expect(classifyField(field({ type: 'text', label }))?.type).toBe(expected);
  });

  it.each([
    ['aadhaar_no', 'AADHAAR'],
    ['panNumber', 'PAN'],
    ['date-of-birth', 'DOB'],
    ['user_email_id', 'EMAIL'],
    ['mobileNo', 'PHONE'],
  ])('reads the name attribute "%s" when there is no label', (name, expected) => {
    expect(classifyField(field({ type: 'text', name }))?.type).toBe(expected);
  });

  it('reads the placeholder', () => {
    expect(classifyField(field({ type: 'text', placeholder: 'you@example.com' }))).toBeNull();
    expect(classifyField(field({ type: 'text', placeholder: 'Enter your mobile number' }))?.type).toBe(
      'PHONE',
    );
  });
});

describe('precision — ordinary fields are not flagged', () => {
  it.each([
    'Search',
    'Company name',
    'Product name',
    'File name',
    'Quantity',
    'Control panel',
    'Coupon code',
    'Message',
  ])('leaves "%s" alone', (label) => {
    expect(classifyField(field({ type: 'text', label }))).toBeNull();
  });

  it('does not fire on "panel" via the PAN rule', () => {
    expect(classifyField(field({ type: 'text', label: 'Admin panel access' }))).toBeNull();
  });

  it('ignores non-data controls', () => {
    expect(classifyField(field({ type: 'submit', label: 'Submit my Aadhaar' }))).toBeNull();
    expect(classifyField(field({ type: 'checkbox', label: 'Email me updates' }))).toBeNull();
    expect(classifyField(field({ tag: 'BUTTON', label: 'Pay with card' }))).toBeNull();
    expect(classifyField(field({ tag: 'DIV', label: 'Email' }))).toBeNull();
  });

  it('ignores a field with nothing to go on', () => {
    expect(classifyField(field({ type: 'text' }))).toBeNull();
  });
});

describe('imageHint', () => {
  it('flags avatars', () => {
    expect(imageHint('', 'user-avatar rounded', '')).toBe('avatar-like');
    expect(imageHint('Profile photo', '', '')).toBe('avatar-like');
  });

  it('flags identity documents', () => {
    expect(imageHint('', '', '/uploads/aadhaar-front.png')).toBe('document-like');
  });

  it('ignores the query string, which can itself contain PII', () => {
    expect(imageHint('', '', '/logo.png?user=avatar@example.com')).toBeNull();
  });

  it('returns null for an ordinary image', () => {
    expect(imageHint('Product shot', 'hero', '/img/banner.jpg')).toBeNull();
  });
});
