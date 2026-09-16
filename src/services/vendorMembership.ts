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
// this subject (first login) fall back to the email anchor, and ONLY if that
// email has been verified and it is not already bound to a different subject.
//
// "Verified enough to bind" currently means any one of these signals:
//
//   * `row.emailVerified` — first-party proof, or operator attestation for
//     platform admins. Vendor signup/invitation rows do not set it yet.
//   * `idpEmailVerified` — the ID token's `email_verified` claim. Kept as an
//     alternative so a federated/upstream IdP that genuinely does verify email
//     still works. It is NOT sufficient on its own to be relied upon: Authentik
//     hardcodes this claim rather than deriving it, and since 2025.10 hardcodes
//     it to FALSE precisely because it "cannot vouch" for it. Requiring it was
//     therefore a total lockout — no first login could ever bind a seat.
//   * `row.authUserPk` — INTERIM (see issue #51). Provisioning provenance: this
//     row's Authentik account was created by us for this address. The resolver
//     does not compare that pk with the identity presenting the token, so this
//     depends on the deployment's identity policy: no open self-enrolment, no
//     untrusted email edits, and no duplicate email path that can claim the
//     address. REMOVE once #51 ships.
//
// The order matters: look the row up first, then decide whether its email may
// be trusted. Deciding before the lookup (the previous shape) meant our own
// verification state could never participate in the decision.
type MembershipFilter = { authSubject: string } | { email: string };

export const resolveMembership = async <
  T extends { authSubject?: string; emailVerified?: boolean; authUserPk?: number },
>(
  sub: string,
  email: string | undefined,
  idpEmailVerified: boolean,
  findOne: (filter: MembershipFilter) => Promise<T | null>,
): Promise<T | null> => {
  const bySubject = await findOne({ authSubject: sub });
  if (bySubject) {
    return bySubject;
  }
  if (!email) {
    return null;
  }
  const byEmail = await findOne({ email });
  if (!byEmail) {
    return null;
  }
  if (byEmail.authSubject && byEmail.authSubject !== sub) {
    // Email belongs to a different identity — refuse rather than rebind.
    return null;
  }
  const provisionedByUs = byEmail.authUserPk !== undefined;
  if (byEmail.emailVerified !== true && !idpEmailVerified && !provisionedByUs) {
    // Unverified email, from an identity we did not provision — never bind.
    return null;
  }
  return byEmail;
};
