export type RedirectType = 'authorization' | 'logout';

export interface RedirectVerdict {
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

interface RedirectEntry {
  url: string;
  matching_mode: 'strict' | 'regex';
  redirect_uri_type: RedirectType;
}

const isRedirectEntry = (value: unknown): value is RedirectEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { url?: unknown }).url === 'string' &&
  ['strict', 'regex'].includes(String((value as { matching_mode?: unknown }).matching_mode)) &&
  ['authorization', 'logout'].includes(
    String((value as { redirect_uri_type?: unknown }).redirect_uri_type),
  );

export const checkRedirectEntry = (
  raw: unknown,
  wanted: string,
  type: RedirectType,
): RedirectVerdict => {
  if (!Array.isArray(raw)) {
    return { status: 'warn', detail: 'provider returned untyped redirect entries; check manually' };
  }

  let uncertain = false;
  for (const value of raw) {
    if (!isRedirectEntry(value)) {
      uncertain = true;
      continue;
    }
    const entry = value;
    if (entry.redirect_uri_type !== type) {
      continue;
    }
    if (entry.matching_mode === 'strict' && entry.url === wanted) {
      return { status: 'pass', detail: `${wanted} matches a ${type} redirect entry` };
    }
    if (entry.matching_mode === 'regex') {
      try {
        // Authentik uses a full regex match, not a substring search.
        if (new RegExp(`^(?:${entry.url})$`).test(wanted)) {
          return { status: 'pass', detail: `${wanted} matches a ${type} redirect entry` };
        }
      } catch {
        uncertain = true;
      }
    }
  }
  return uncertain
    ? { status: 'warn', detail: `some ${type} redirect entries could not be interpreted` }
    : { status: 'fail', detail: `${wanted} is not registered as a ${type} redirect` };
};
