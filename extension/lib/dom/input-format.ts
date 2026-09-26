/**
 * Fitting a stored value to the control it is being typed into.
 *
 * A profile holds a date of birth as the user wrote it — "14/03/2001", the way
 * every Indian form prints one. An `<input type="date">` accepts only the ISO form
 * "2001-03-14", and silently discards anything else: the field stays empty, the
 * agent reports success, and the user finds out at submission. So the value is
 * converted to what the control actually accepts, and left alone for a plain text
 * field, where the page's own format is whatever it asked for.
 *
 * Pure and DOM-free so it can be unit-tested and shared by the content script.
 */

/** DD/MM/YYYY, DD-MM-YYYY or DD.MM.YYYY — day first, as Indian forms write it. */
const DAY_FIRST = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s*$/;
/** Already ISO. */
const ISO_DATE = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** The ISO date for a day-first or ISO string, or null if it is not a real date. */
export function toIsoDate(value: string): string | null {
  const iso = ISO_DATE.exec(value);
  if (iso) return isRealDate(+iso[1]!, +iso[2]!, +iso[3]!) ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;

  const dmy = DAY_FIRST.exec(value);
  if (!dmy) return null;
  const day = +dmy[1]!;
  const month = +dmy[2]!;
  const year = +dmy[3]!;
  return isRealDate(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * The value to write into an `<input>` of the given `type`.
 *
 * Returns the value unchanged for every type that accepts free text. For date-like
 * types, returns the converted value — or the original when it cannot be converted,
 * so the failure is visible in the field rather than swallowed.
 */
export function formatForInput(inputType: string | undefined, value: string): string {
  switch ((inputType ?? '').toLowerCase()) {
    case 'date':
      return toIsoDate(value) ?? value;
    case 'month': {
      const iso = toIsoDate(value);
      return iso ? iso.slice(0, 7) : value;
    }
    case 'datetime-local': {
      const iso = toIsoDate(value);
      return iso ? `${iso}T00:00` : value;
    }
    case 'tel':
    case 'number':
      // Browsers reject spaces in a number field; a phone field keeps its digits.
      return inputType === 'number' ? value.replace(/\s+/g, '') : value;
    default:
      return value;
  }
}
