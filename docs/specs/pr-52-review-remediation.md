# PR #52 review remediation spec

Date: 2026-09-16. Status: S1–S6 are present in PR head `52403f5`. F1–F5 and the additional mail warning fix are implemented locally but uncommitted; legacy platform-admin grants still need operator reconciliation before deployment.

Reviewed [PR #52 — Refactor auth](https://github.com/mackawara/grocery-shop/pull/52) at commit `1b9848dc74489b8ffc316deac3f3fdc7d482cfd4`, against base `5c0728fccb8826fff6e31c2081bcedecb754bb53`.

The PR contains one completed [Claude review](https://github.com/mackawara/grocery-shop/pull/52#issuecomment-5692566781) and seven Copilot inline comments. This spec assesses both. All seven Copilot findings are valid, although the suggested task-ID snapshot does not fully solve concurrent email attribution. Claude adds a valid CI coverage gap and an unverified identity-provider prerequisite. Its broader reuse and performance suggestions are follow-ups, rather than merge requirements.

## Recommendation and scope

Address S1–S6 before merging. These fix a reproducible test failure, misleading operator results, an incorrect recovery warning, and documentation that overstates the implemented security controls. Before deploying the relaxed email-binding policy, verify the Authentik trust assumptions in S6; this review did not inspect the deployed configuration.

Keep the email-verification feature in [issue #51](https://github.com/mackawara/grocery-shop/issues/51). Do not silently turn this remediation into a new authorization design, change tenant status policy, or restore a blanket requirement for Authentik's default `email_verified` claim. The default mapping changed to false in 2025.10; that is a default-mapping behavior, not a claim that every possible Authentik mapping is constant. [Authentik release notes](https://docs.goauthentik.io/releases/2025.10/#default-oauth-scope-mappings).

## Comment decisions

### Copilot

| Comment                                                                                                                         | Decision                     | Why / work item                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [Platform test imports application config](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4022652264)            | Address                      | Reproduced: config exits before the six test cases register. S1.                                                                   |
| [Approval warning promises a missing link](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4022652290)            | Address                      | When both email submission and recovery-link creation fail, approval still says “the link below.” S2.                              |
| [GET requests do not establish write permissions](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4022652317)     | Address                      | Listing users/groups cannot prove provisioning will work. S3.                                                                      |
| [Empty/pending email queue reports success](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4022652334)           | Address                      | Absence of failure is not delivery evidence. Includes the same issue at line 438 mentioned in the review's suppressed comment. S4. |
| [Test send matches an unrelated task](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4022652364)                 | Address, revise proposed fix | Timestamp matching is unsafe; a snapshot of new IDs alone still cannot distinguish simultaneous sends. S4.                         |
| [README describes future verification as shipped](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4022652386)     | Address                      | No vendor verification-token flow exists; provisioning provenance currently permits first binding. S5.                             |
| [VendorUser comment references a nonexistent service](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4022652412) | Address                      | The field exists, but the described vendor-side producer does not. S5.                                                             |

### Claude

The following items correspond to the sections/bullets in the [consolidated Claude review](https://github.com/mackawara/grocery-shop/pull/52#issuecomment-5692566781).

| Finding                                                  | Decision                                  | Reason                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate subject binding and login timestamp writes     | Defer                                     | Predates this PR. Vendor resolution includes staff activation and tenant scoping; platform resolution has different authorization rules. No new divergence was demonstrated.                                                                                                                                                                 |
| Shared tenant status decision for dashboard/WhatsApp     | Defer                                     | Both already allow ACTIVE/TRIAL. Dashboard must return a useful 403; WhatsApp must 200-ack permanent drops. Sharing response logic would be incorrect.                                                                                                                                                                                       |
| Duplicate recovery-email/link fallback                   | Address narrowly in S2                    | A small shared outcome helper is useful here because an actual inconsistent warning exists. Preserve each route's response contract.                                                                                                                                                                                                         |
| Unchecked disabled-self-enrolment assumption             | Address in S6                             | The diagnostic and deployment guide must expose this manual prerequisite. Disabled self-enrolment alone is not proof of mailbox control or account identity.                                                                                                                                                                                 |
| Admin scope only proves GET access                       | Address in S3                             | Same finding as Copilot; one fix.                                                                                                                                                                                                                                                                                                            |
| Vendor verification narrative is ahead of implementation | Address in S5                             | Same finding as Copilot; one documentation correction.                                                                                                                                                                                                                                                                                       |
| Run vendor/admin callback lookups concurrently           | Optional follow-up                        | Queries are independent, but sequential execution predates this PR. Potential latency improvement is credible; its magnitude was not measured.                                                                                                                                                                                               |
| Avoid saving lastLoginAt on every authenticated request  | Follow-up                                 | Predates this PR and needs a decision on timestamp semantics and activation writes. No caching or skipped authorization reads in this remediation.                                                                                                                                                                                           |
| Recovery link exposes a bearer credential to an admin    | Inspection completed; preserve safeguards | Admin routes are authenticated and CSRF guarded. No generic admin response-body logger, Morgan middleware registration, or error-tracker body capture was found in this backend. The inspected success path logs a user PK, not the link. Browser/proxy/dashboard telemetry was not audited. Optional response hardening is described below. |
| Broken platform test and CI not running tests            | Address in S1                             | Both confirmed. Pure unit tests and a CI test job are needed; a production-secret-filled CI environment is not.                                                                                                                                                                                                                              |

Claude's endorsement of removing the default-claim gate is not another change request. Preserve the intended first-login behavior while making its trust assumptions explicit.

## S1 — Make authorization tests independent of deployment configuration

**Priority:** merge requirement. **Files:** `test/platformMembership.test.ts`, `src/services/platformMembership.ts`, a small new pure allowlist module if needed, and `.github/workflows/ci.yml`.

**Evidence.** The test sets only `PLATFORM_ADMIN_EMAILS`, then imports `platformMembership.ts`. Its static `CONFIG` import reaches `src/config.ts:53–69`, which requires the complete application environment and calls `process.exit(1)`. The current CI workflow runs lint and build only.

A clean tracked-source export, without `.env`, using existing installed dependencies and only `PATH`/`TMPDIR` in the environment produced:

| Test run                                                        | Exit | Result                                                      |
| --------------------------------------------------------------- | ---- | ----------------------------------------------------------- |
| `node --import tsx --test test/platformMembership.test.ts`      | 1    | Zero cases pass; one test-file failure before registration. |
| `node --import tsx --test test/*.test.ts`                       | 1    | 16 cases pass; platform test file fails.                    |
| Platform test with synthetic mandatory environment placeholders | 0    | All six platform cases pass.                                |

These reproductions used Node 24.18.0. CI currently selects Node 20, so implementation validation must also use the CI runtime. No production credentials or external services were used.

**Required change.** Move allowlist decision logic into a module with no application-config or model imports, taking its allowed-email set explicitly. Keep the production wrapper reading the existing validated `CONFIG` and preserve its public behavior. Test the pure decision with supplied inputs. Merely exporting a pure function from the existing config-importing module will not solve module initialization.

Use a separate isolated wiring test with synthetic configuration only if needed to cover the production adapter. Add a CI job or step executing `yarn test`, with no `.env`, application secrets, MongoDB, Redis, or Authentik dependency. Keep production fail-fast config validation intact.

**Alternative considered.** Supplying every mandatory variable to all unit tests would unblock execution but couples unrelated authorization tests to application boot configuration. Prefer a pure unit boundary, with synthetic environment setup limited to tests that actually exercise the adapter.

**Acceptance criteria.** All six platform cases and the existing vendor cases execute in a clean checkout. Missing, empty, and non-allowlisted emails remain denied. Existing configured-email normalization remains unchanged. CI runs the suite and fails on a deliberately failing authorization assertion. The tests verify behavior rather than requiring a particular JavaScript function-arity value.

## S2 — Report recovery outcomes accurately

**Priority:** merge requirement. **File:** `src/controllers/dashboard/admin.controller.ts`, with focused handler tests.

**Evidence.** `transitionPendingTenant` assigns its warning before `ownerRecoveryLink` runs. That helper returns `undefined` on failure, so a successful approval can promise a link that is absent. `resendInvite` already distinguishes link success from total recovery failure.

**Required change.** Resolve the recovery outcome before building the response. Prefer a local helper returning a discriminated result such as `queued`, `link_only` with a link, or `failed`. It should reuse the existing `withOwnerPk` tenant-scoped lookup and leave HTTP response construction to each caller. Do not consolidate the two routes' different approval/retry semantics.

| Outcome                           | Approval response                                                                              | Resend response                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Email request accepted            | Existing HTTP 200 approval response; no fallback link                                          | Existing HTTP 200 success response            |
| Email request fails; link created | HTTP 200; approval retained; warning instructs safe link handoff; include link                 | Existing HTTP 200 `link_only` shape with link |
| Both operations fail              | HTTP 200; approval retained; warning says recovery setup failed and to repair/retry; omit link | Existing HTTP 502 failure; omit link          |

An accepted email request is not evidence of inbox delivery. Keep fallback creation limited to synchronous send/configuration failure; do not mint links just because the diagnostic cannot observe delivery. Existing invalid-ID, missing-tenant, and disallowed-status responses remain unchanged.

**Acceptance criteria.** Tests cover all three outcomes for both handlers. Neither warning nor success text refers to a missing link. Approval remains committed if notifications fail. A tenant-A request uses only tenant A's owner PK even when tenant B has an owner. Link values never reach application logs.

**Credential handling.** Retain admin authorization and CSRF protection. Use synthetic links when testing logs/errors. Adding `Cache-Control: no-store` to link-bearing responses is a small recommended hardening, not evidence of an existing logging leak. Document that dashboard/proxy telemetry must omit recovery-response bodies; changing that separate application requires its own inspection.

## S3 — Separate read access from provisioning capability

**Priority:** merge requirement. **Files:** `src/scripts/authDoctor.ts`, `deploy/README.md`, diagnostic tests.

**Evidence.** `checkAdminScope` at lines 176–209 GETs users/groups and labels success as “Admin scope.” The script and guide then imply signup provisioning should work. Those reads do not exercise the create/change/delete and recovery operations used by provisioning.

**Required change.** Name successful GET checks explicitly as read access. Emit a separate warning that provisioning permissions have not been verified, with the required operator check. Failure to read an essential collection remains a failed read check. Do not imply that a token must be a superuser or that listing permission definitions establishes effective permissions.

The default diagnostic must remain read-only. It must not create temporary users/groups or change passwords merely to probe access. A future effective-permission check is acceptable only against a supported, version-verified API, including inherited/object permissions; it is a larger alternative to the recommended truthful warning.

**Acceptance criteria.** Mock a token that can list users/groups but cannot provision: reads pass, provisioning is explicitly unverified, and the summary does not assert readiness. Assert no POST/PATCH/DELETE requests occur in a default diagnostic invocation. Update the deployment guide's “checks every prerequisite” and “clean run means ... will work” claims.

## S4 — Make email diagnostics reflect actual evidence

**Priority:** merge requirement. **Files:** `src/scripts/authDoctor.ts`, `deploy/README.md`, new isolated diagnostic tests.

**Evidence.** `checkMailDelivery` passes an empty queue and unfinished tasks without error logs. `listMailTasks` silently converts HTTP errors into empty or partial results. `awaitMailTask` chooses any task with recent logs, including a pre-existing retry or a concurrent unrelated email. The final summary declares readiness whenever there are no failures, even when warnings exist.

**Required outcomes.**

| Observation                                                                                                    | Diagnostic result                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Queue successfully read, but no relevant task exists                                                           | Warning: delivery untested                                                            |
| Pending/running/retrying/unknown task without reliable outcome                                                 | Warning: delivery unverified                                                          |
| Explicit terminal failure, including one without a parsed exception                                            | Failure with a safe actionable explanation                                            |
| API unavailable/forbidden, invalid response, partial pagination, or page limit reached while more pages remain | Warning: observation unavailable/incomplete; never treat as an empty successful queue |
| Reliable current-attempt evidence of SMTP acceptance                                                           | Pass for SMTP acceptance only; do not claim inbox receipt                             |
| Recovery request accepted but its task cannot be correlated                                                    | Warning: request accepted; delivery of this test email unverified                     |

Keep historical mail-queue health separate from a specific test-send result. A `done` state alone must not override errors or missing success evidence: the Authentik 2026.8.0 email worker has early-return paths for a missing stage or invalid backend configuration. Validate task interpretation against the deployed version and distinguish an old failed attempt from the final successful attempt. [Versioned worker source](https://github.com/goauthentik/authentik/blob/version/2026.8.0/authentik/stages/email/tasks.py).

**Correlation decision.** Remove timestamp-only attribution. Do not ship “snapshot IDs, choose a new ID” as a complete fix: multiple new messages can appear between the snapshot and the next poll, and even a lone observed new ID is not necessarily ours. The recovery-email API documents a 204 response rather than a returned task ID. [Authentik API reference](https://api.goauthentik.io/reference/core-users-recovery-email-create/).

The recommended bounded solution is to report acceptance/queued status and explicitly leave delivery unverified when no trustworthy correlation exists. Only retain automatic per-test delivery verdicts if the deployed API provides a proven correlation mechanism, such as a returned task ID. Do not assume task payload/recipient fields are available, log unrelated recipients, or modify shared email stages to manufacture correlation. If correlation is later supported, pin the exact task ID and bound the total observation time.

**Summary and CLI compatibility.** Preserve exit 1 for failures and exit 0 for warnings for this change, but print “Checks completed with unresolved warnings; readiness is not established” on warning-only runs. Even an all-pass summary must describe the checks performed rather than guarantee all login/signup paths. Document that exit 0 does not certify deployment readiness. A strict warning-as-error mode is an optional separate change.

Update the README's promise that `--send-test-email` waits for “that specific task.” Keep sending explicitly opt-in. Separate testable observation/evaluation functions from CLI startup, injecting HTTP/time dependencies where necessary so tests never contact Authentik.

**Acceptance criteria.** Cover empty queues, pending tasks, terminal failure without logs, successful retry, misleading `done`, 403/404/500, malformed response, later-page failure, and incomplete pagination. Old successes, recently retried old tasks, unrelated concurrent success/failure, and multiple new IDs must not decide the test send's outcome. Warning-only reports must not claim readiness. Default execution stays read-only; opt-in submission sends at most the intended request and never exposes credentials or recovery links.

## S5 — Document the implemented verification model

**Priority:** merge requirement. **Files:** `deploy/README.md`, comments in `src/models/VendorUser.ts`, `src/models/PlatformUser.ts`, `src/services/vendorMembership.ts`, `src/services/platformMembership.ts`, `src/controllers/auth/auth.controller.ts`, and `src/types/auth.ts` as applicable.

**Required description.** At this commit, membership resolves by subject first. If no subject matches, email fallback rejects an already differently bound row, then permits a match if the row has `emailVerified === true`, the token has `email_verified === true`, or the row has an `authUserPk`.

New vendor signup/invitation rows default `emailVerified` to false. They record `authUserPk`; they do not mint or consume application email-verification tokens. Already-bound vendor identities continue resolving by subject. Under the default false IdP claim, new provisioned vendor rows therefore use the interim provenance fallback. Platform bootstrap and the allowlist can stamp verification flags through operator attestation; this is distinct from proving mailbox possession.

Explain that `authUserPk` presence proves only a provisioning record exists: the resolver does not compare that PK with the identity presenting the token. Do not call it mailbox verification or claim that provisioning itself mailed a message. Correct references to the nonexistent `emailVerification` service, omitted interim fallback, and the removed allowlist claim requirement. Explain what issue #51 will add and that removal of the interim fallback depends on that rollout.

**Acceptance criteria.** Every statement about current flag producers agrees with signup, invitations, admin creation, and allowlist code. Current behavior and planned #51 behavior are clearly separated. This work changes comments/documentation only and needs no new runtime behavior tests. Model schema defaults, indexes, permissions, and tenant scoping remain intact.

## S6 — Expose the identity trust assumptions the diagnostic cannot verify

**Priority:** merge requirement for diagnostic/documentation honesty; deployment prerequisite for the relaxed binding policy. **Files:** `src/scripts/authDoctor.ts`, `deploy/README.md`, diagnostic tests.

**Required change.** Add an explicit warning/manual-check result for identity trust while the interim email binding and email allowlist are in use. State that `auth:doctor` does not currently prove self-enrolment is disabled or that asserted emails cannot be changed or duplicated through other identity paths. This warning must participate in S4's qualified summary.

Document the operator verification needed for this deployment: permitted enrolment paths, profile/email editing, upstream identity/source mappings, duplicate-email handling, and recovery/credential issuance. Include public application signup, which accepts an email and verifies a phone; do not equate “created through our admin API” with proof that the registrant owns that email. Authentik does not enforce unique email addresses by default. [Authentik email uniqueness documentation](https://docs.goauthentik.io/customize/policies/types/expression/unique_email/).

**Options.** Recommend the explicit warning and deployment runbook now. A complete automated policy audit is a larger option and must inspect effective access to flows/policies, not simply whether an enrolment flow exists. A manually configured boolean or absence of a flow name is not security evidence and must not produce a pass. Do not change Authentik settings or bypass login checks from the diagnostic.

This is a verified dependency on external policy, not a claim that an exploit was reproduced against the deployed system. If that policy permits another account to assert a target email and obtain usable credentials, documentation alone is insufficient: block rollout and require identity-bound authorization work. Keep that implementation explicit and separately reviewed; a historical row-level email flag alone is not proof that a new subject owns the seat.

**Acceptance criteria.** Ordinary preflight output cannot silently imply this prerequisite passed. Tests verify that unavailable/uninspected policy stays unverified. The deployment guide identifies which checks are manual and links issue #51. No OIDC validation, subject mismatch rejection, tenant-scoped lookup, disabled-user rejection, or staff phone-activation check is weakened.

## Deferred work and preserved boundaries

- A shared binder may be useful later, but it must preserve vendor phone activation and tenant scope, platform role/status gates, and the separate allowlist semantics. Do not move vendor queries/saves outside `runWithTenant` to simplify reuse.
- A shared status predicate, if introduced later, may return an allow/deny decision; each transport must keep its own response semantics. Dashboard PENDING stays 403 with `approval_pending`; WhatsApp permanent drops stay HTTP 200.
- Callback lookups can later run concurrently, keeping `runWithoutTenant` around only the sanctioned vendor membership discovery. Assess latency and preserve the callback's authorization and landing-page behavior.
- Reducing `lastLoginAt` writes requires defining whether it means login time or request activity. Always preserve authorization rechecks and required binding/activation writes.
- Implement #51 separately with explicit binding of verification evidence to the intended address, seat, and identity. Do not treat shipping a boolean field as completion of that feature.

## Implementation order and verification

1. S1: establish runnable authorization tests and a CI test job.
2. S2: fix recovery outcome reporting with scoped handler tests.
3. S3, S4, S6: correct diagnostic guarantees together; test with fixtures only.
4. S5: align comments and deployment instructions with the final behavior.

Review each bucket before expanding scope. No new required environment variables, production database migration, or changes to tenant context/tenantScope are proposed. Before later editing the widely imported model files, show the comment-only blast radius and follow AGENTS.md's approval requirement; this spec itself edits none of them.

Run `yarn test`, `yarn lint`, `yarn build`, and `yarn format:check` after implementation. Run tests without a private `.env` and on the CI-supported Node version. Report pre-existing formatting failures separately rather than reformatting unrelated files. Exercise any live email send only as a separate explicit operator action.

This assessment used PR comments, local source at the exact head, clean-environment test reproduction, and referenced Authentik documentation/source. It did not call the live Authentik service, send email, change application code, or post/resolve GitHub comments.

## Follow-up review at PR head `52403f5`

The second Copilot review raised five new comments, beginning with the [allowlist revocation finding](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4026437584). All five described behavior present at that review commit. This section supersedes the earlier spec where its acceptance criteria were not fully met. It also records one additional mail-diagnostic defect reproduced during evaluation. The first review's shared recovery-outcome helper is already implemented; it does not need another extraction.

### F1 — Make allowlist revocation effective

**Priority:** security/merge requirement. **Files:** `src/controllers/middleware/platformAdminResolver.ts`, `src/services/platformMembership.ts`, `src/models/PlatformUser.ts` if grant provenance is stored there, `src/scripts/createPlatformAdmin.ts`, `deploy/README.md`, and authorization tests. [Review comment](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4026437584).

**Why.** `ensureAllowlistedAdmin` persists an ACTIVE SUPER_ADMIN record with a bound subject. On later requests `resolvePlatformUser` accepts that record by subject even after its email is removed from `PLATFORM_ADMIN_EMAILS`. The comment claiming removal revokes access is therefore false. Platform admins can act across tenants, so a stale grant is a material authorization problem.

**Recommended change.** Track whether an admin's effective grant depends on the allowlist. Require current allowlist membership for such a grant on **both** session typing (`checkPlatformAdmin`) and every `/admin` request. Explicitly provisioned admins retain their independent DB grant. Only the allowlist path may create/refresh an allowlist-dependent grant; the explicit provisioning path must be deliberate about whether it converts that grant to an independent one. Keep the role/status check and existing disabled-user behavior. Do not solve this by requiring Authentik's default-false `email_verified` claim or by trusting a session's `isPlatformAdmin` flag without rechecking authorization.

**Existing records.** A new provenance field cannot classify historical PlatformUser rows: some may have been created by the allowlist and others by `admin:create`. Before rollout, audit those records and classify or disable them explicitly. Treat unknown provenance conservatively; never silently assume a legacy row is an independent permanent grant. Removing an email from the allowlist should be paired with disabling its existing record until this reconciliation is complete. Avoid deleting the Authentik identity automatically because it may be used elsewhere.

**Alternative.** If permanent bootstrap grants are the intended business rule, state that clearly and implement an audited revoke operation that removes the email from deployment configuration **and** disables the PlatformUser row. Disabling the row while the email remains allowlisted is ineffective because the next request reactivates it. The recommended provenance approach better matches the current removal-means-revocation contract.

**Acceptance criteria.** After a previously allowlisted email is removed, its old bound subject gets neither platform session typing nor `/admin` access. A current allowlisted email still bootstraps with an empty collection. A separately provisioned active super admin remains authorized when absent from the allowlist; a disabled admin stays denied unless explicitly restored by an authorized allowlist policy. Tests cover an existing row, a removed address, a still-allowlisted address, and a deliberately provisioned row. Review the model change's blast radius under AGENTS.md before implementation.

### F2 — Let `auth:doctor` report a missing Authentik configuration

**Priority:** merge requirement. **Files:** `src/scripts/authDoctor.ts`, a small CLI config reader if needed, and diagnostic tests. [Review comment](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4026437659).

**Why.** `authDoctor.ts` imports `CONFIG` at module load. `config.ts` calls `process.exit(1)` if any mandatory application variable is missing, before `checkEnv()` can report missing Authentik settings. This also makes an Authentik-only diagnostic depend on MongoDB, WhatsApp and Redis configuration.

**Required change.** Load the same local `.env` source and environment precedence as the application into a non-exiting, CLI-specific reader. Check the Authentik fields before constructing `BASE` or making HTTP requests. Derive the effective callback from `AUTH_REDIRECT_URI` or `PUBLIC_BASE_URL`/local `NGROK_DOMAIN`, and the effective post-logout URL from `AUTHENTIK_POST_LOGOUT_REDIRECT` or `DASHBOARD_URL`, using the same rules as `CONFIG`. Keep production `config.ts` fail-fast behavior unchanged. Print missing variable names, never their secret values.

**Acceptance criteria.** A clean environment produces the diagnostic's Environment failure and summary rather than a config-module exit or stack trace. Unrelated app variables may be absent when Authentik variables are present. Missing Authentik values prevent network requests. A configured run uses the same effective URLs as production. Tests require no real credentials or Authentik service.

### F3 — Check typed redirect entries using their matching modes

**Priority:** merge requirement. **Files:** `src/scripts/authDoctor.ts`, `deploy/README.md`, and pure redirect-check tests. [Review comment](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4026437698).

**Why.** The diagnostic flattens Authentik redirect entries to URL strings. Authentik 2026.8 distinguishes `redirect_uri_type: authorization` from `logout` and `matching_mode: strict` from `regex`; using either type for the other check can give a false pass, and literal comparison gives a false failure for a matching regex. [Versioned Authentik provider model](https://github.com/goauthentik/authentik/blob/version/2026.8.0/authentik/providers/oauth2/models.py).

**Required change.** Preserve URL, type and matching mode when parsing provider entries. Match the callback only against authorization entries and the effective post-logout URL only against logout entries. Apply strict equality or the configured regex according to the mode, handling malformed patterns and unknown modes without crashing or claiming success. Treat legacy string-only entries according to the deployed version's documented semantics; if the type cannot be established, report uncertainty rather than a confident pass. Update the guide's claim that both URLs need only appear in the same untyped list.

**Acceptance criteria.** A logout-only callback URL fails callback validation; an authorization-only logout URL fails logout validation. A matching regex entry passes for its own type. Mismatched, invalid, or unknown patterns do not pass. The diagnostic never changes provider settings.

### F4 — Evaluate the current email attempt and preserve incomplete-history warnings

**Priority:** merge requirement. **Files:** `src/scripts/authDoctorMailEvidence.ts`, `src/scripts/authDoctor.ts` if result propagation changes, and `test/authDoctorMailEvidence.test.ts`. [Review comment](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4026437744).

**Why.** `allLogs()` combines `previous_logs` with current `logs`. A task that failed SMTP once and then succeeded is currently reported as failed. A synthetic completed task with an archived error and current send-success log reproduced this. Also, `classifyMailDelivery` returns `pass` for a visible success even when `listMailTasks` warns that a later page was unreadable; a synthetic partial queue reproduced that false clean result.

**Required change.** Use current-attempt logs to decide current error or SMTP acceptance. Archived logs may explain retry history but cannot override the current attempt. Authentik marks logs from previous attempts separately, and its aggregated status ignores them; `aggregated_status: info` alone is still not proof of SMTP acceptance. [Versioned task model](https://github.com/goauthentik/authentik/blob/version/2026.8.0/authentik/tasks/models.py), [retry middleware](https://github.com/goauthentik/authentik/blob/version/2026.8.0/authentik/tasks/middleware.py). Do not use archived-log timestamps to select the newest task. If task ordering or queue completeness is uncertain, report that uncertainty; do not print a clean pass. Preserve a definite visible terminal failure even if a later page is missing. Continue to describe a success log as SMTP acceptance, not inbox delivery or proof about the opt-in test send.

**Acceptance criteria.** Tests cover failure followed by successful retry, current failure after a historical success, `done` without current send-success evidence, and a partial queue containing a visible success. The first is pass for SMTP acceptance; the second is fail; the last two warn. A visible terminal failure remains fail. Historical logs cannot determine task recency or the outcome of an unrelated test send.

### F5 — Validate the password before creating an admin identity

**Priority:** merge requirement. **File:** `src/scripts/createPlatformAdmin.ts`, with focused tests for the input/decision boundary. [Review comment](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4026437792).

**Why.** Under `--set-password`, the script looks up or creates the Authentik user before reading stdin or prompting. Empty input then exits with “aborting without changing anything,” even though a newly created user may remain in Authentik without a PlatformUser record. The same partial-state distinction matters if Authentik rejects a nonempty password later.

**Required change.** Parse flags and read/validate a `--set-password` value before connecting to services or creating an identity. Keep password input off argv and out of logs. If later provisioning fails after a new Authentik user was created, report the partial state and a safe rerun path; do not automatically delete an existing or newly created identity. Preserve intentional password reset for an existing Authentik user and the `--generate-password` flow.

**Acceptance criteria.** Empty TTY or piped input makes no Authentik/Mongo calls. A valid supplied password reaches provisioning without being logged. A later password-policy failure reports that the identity may already exist and how to rerun, without claiming no changes occurred.

### Scope and verification

Implement F1 first, then F2/F3, F4, and F5. The first two original reuse suggestions (shared subject-binding helper and tenant-status predicate) can remain separate follow-ups; the recovery-outcome helper already exists. [Claude's latest reply](https://github.com/mackawara/grocery-shop/pull/52#discussion_r4026588414) drafted an issue for those suggestions but states it could not create one. Moving helpers into `utils` by itself does not fix any finding above.

Run focused regression tests, then `yarn test`, `yarn lint`, `yarn build`, and `yarn format:check`. Keep tests isolated from production credentials and external services. Review changes to authorization and migration with tenant isolation and existing session behavior in mind. No live admin provisioning, recovery email, or external identity change is needed to verify this spec.
