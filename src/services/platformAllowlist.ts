export const parsePlatformAdminEmails = (raw: string): Set<string> =>
  new Set(
    raw
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );

export const isAllowlistedEmail = (
  email: string | undefined,
  allowedEmails: ReadonlySet<string>,
): boolean => Boolean(email) && allowedEmails.has(email ?? '');
