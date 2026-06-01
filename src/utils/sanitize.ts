/**
 * Input sanitisation helpers for user-supplied text (e.g. WhatsApp Flow form
 * fields). Keep these pure and side-effect free so they can be reused anywhere
 * untrusted strings are persisted.
 */

const MAX_FIELD_LENGTH = 200;
const MAX_PHONE_DIGITS = 15; // E.164 maximum

/**
 * Trim, strip control characters, collapse internal whitespace, then cap the
 * length. Returns undefined for empty/blank input so we never persist "".
 *
 * Only ASCII control chars (0x00–0x1F and DEL 0x7F) are stripped — printable
 * punctuation like ' , - . / stays intact so names ("O'Brien") and addresses
 * ("123 Main St, Apt 4") are preserved.
 */
export const sanitizeText = (
  value: unknown,
  maxLength: number = MAX_FIELD_LENGTH,
): string | undefined => {
  if (typeof value !== 'string') {return undefined;}
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : undefined;
};

/** Keep digits and a single leading '+', drop everything else. */
export const sanitizePhone = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {return undefined;}
  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '').slice(0, MAX_PHONE_DIGITS);
  if (digits.length === 0) {return undefined;}
  return hasPlus ? `+${digits}` : digits;
};
