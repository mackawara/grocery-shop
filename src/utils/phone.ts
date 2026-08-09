// Normalize a phone number to digits only (strips '+', spaces, dashes, etc.) so
// the same number yields one canonical form everywhere it's keyed: Redis OTP/
// claim keys, the stored VendorUser.phoneNumber, and the WhatsApp send target.
export const normalizePhone = (raw: string): string => raw.replace(/\D/g, '');

// Loose E.164-ish sanity check on the normalized form: 8–15 digits. Carrier/
// country-specific validation is out of scope; this only rejects obvious junk.
export const isValidPhone = (normalized: string): boolean =>
  /^[1-9]\d{7,14}$/.test(normalized);

// Log-safe rendering of a customer number: last 4 digits only, e.g. "…4821".
// Enough to correlate a log line with a conversation while debugging, without
// writing a full identifiable number into log storage on every message.
export const maskPhone = (raw: string): string => {
  const digits = normalizePhone(raw);
  if (digits.length <= 4) {
    return '…';
  }
  return `…${digits.slice(-4)}`;
};
