// Normalize a phone number to digits only (strips '+', spaces, dashes, etc.) so
// the same number yields one canonical form everywhere it's keyed: Redis OTP/
// claim keys, the stored VendorUser.phoneNumber, and the WhatsApp send target.
export const normalizePhone = (raw: string): string => raw.replace(/\D/g, '');

// Loose E.164-ish sanity check on the normalized form: 8–15 digits. Carrier/
// country-specific validation is out of scope; this only rejects obvious junk.
export const isValidPhone = (normalized: string): boolean =>
  /^[1-9]\d{7,14}$/.test(normalized);
