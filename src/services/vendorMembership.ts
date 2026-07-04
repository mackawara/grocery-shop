// The single source of truth for "which VendorUser is this authenticated
// identity?". It is applied in two places that MUST agree, or a user could be
// routed to a tenant the dashboard resolver then refuses (a redirect loop):
//
//   1. At login (auth callback) — globally, before any tenant is known, to
//      derive the tenant to stamp into the session.
//   2. On every dashboard request (dashboardAuthResolver) — tenant-scoped, to
//      bind the subject on first login and gate status.
//
// The *rule* lives here once; the query strategy (global vs tenant-scoped,
// lean vs live document) is injected as `findOne` so each caller keeps its own
// scoping without duplicating the matching logic.
//
// Rule: match on the OIDC subject first — it is stable across email changes and
// is the permanent binding after first login. Only when no row is yet bound to
// this subject (first login) fall back to the email anchor, and ONLY if the IdP
// verified that email (an unverified email must never bind a seat) and it is not
// already bound to a different subject.
type MembershipFilter = { authSubject: string } | { email: string };

export const resolveMembership = async <T extends { authSubject?: string }>(
  sub: string,
  email: string | undefined,
  emailVerified: boolean,
  findOne: (filter: MembershipFilter) => Promise<T | null>,
): Promise<T | null> => {
  const bySubject = await findOne({ authSubject: sub });
  if (bySubject) {
    return bySubject;
  }
  if (!email || !emailVerified) {
    return null;
  }
  const byEmail = await findOne({ email });
  if (byEmail && byEmail.authSubject && byEmail.authSubject !== sub) {
    // Email belongs to a different identity — refuse rather than rebind.
    return null;
  }
  return byEmail ?? null;
};
