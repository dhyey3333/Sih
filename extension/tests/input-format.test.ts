import { describe, expect, it } from 'vitest';
import { formatForInput, toIsoDate } from '../lib/dom/input-format';

describe('dates, as Indian forms write them', () => {
  it.each([
    ['14/03/2001', '2001-03-14'],
    ['14-03-2001', '2001-03-14'],
    ['14.03.2001', '2001-03-14'],
    ['1/3/2001', '2001-03-01'],
    ['2001-03-14', '2001-03-14'],
  ])('reads %s as %s', (input, iso) => {
    expect(toIsoDate(input)).toBe(iso);
  });

  it.each(['31/02/2001', '00/01/2001', '14/13/2001', 'yesterday', ''])('rejects %j', (input) => {
    expect(toIsoDate(input)).toBeNull();
  });
});

describe('fitting a value to its control', () => {
  it('converts for <input type="date">, which silently drops anything else', () => {
    expect(formatForInput('date', '14/03/2001')).toBe('2001-03-14');
  });

  it('leaves a text field in the format the page asked for', () => {
    expect(formatForInput('text', '14/03/2001')).toBe('14/03/2001');
  });

  it('handles month and datetime-local controls', () => {
    expect(formatForInput('month', '14/03/2001')).toBe('2001-03');
    expect(formatForInput('datetime-local', '14/03/2001')).toBe('2001-03-14T00:00');
  });

  it('keeps an unconvertible date as-is, so the failure is visible', () => {
    expect(formatForInput('date', 'not a date')).toBe('not a date');
  });

  it('strips spaces for a number field', () => {
    expect(formatForInput('number', '2234 5678 9018')).toBe('223456789018');
  });
});
