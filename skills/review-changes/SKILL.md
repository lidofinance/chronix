---
name: review-changes
description: Review Chronix correctness, protocol time, EL/CL consistency, Docker ownership, and regression risk. Use when the user asks to review a diff, branch, PR or fix in this repository, or to check a change for lifecycle, cleanup, clock, automine or Lighthouse patch problems. Returns concrete findings only and verifies fixes in a separate pass.
---

Read git diff and untracked source, preserving the user's existing staging. Trace startup, partial
failure, shutdown, retry and reset. Confirm resource labels are checked, cleanup errors remain
visible, and unowned volumes cannot be removed.

Trace serialized advancement and automine together. Check phase barriers, cancellation/timeouts,
forward-only timestamps, nonce gaps, RPC batch/notification semantics, and pending requests during
shutdown. Validate that the Lighthouse patch retains real signature/state checks and leaves
network/watchdog deadlines on real time. Check pins against the sources actually built. EL-specific
behavior must live in the client profiles of `src/el_client.ts` and be checked on every EL in
`clients/el/` that it changes.

For API changes check that `client/types.d.ts`, `client/mod.js` and the controller agree, that
generated docs and OpenAPI were regenerated, that a wire change updates every caller in the
repository (including scenarios catching specific error classes) without compatibility shims for old
callers, and that the OpenAPI schemas accept the controller's real replies.

Use deno task check, deno task test and deno task diagnose where applicable. Consult actual
integration evidence rather than treating an API stub as a completed feature.

Return only concrete findings: severity, file:line, trigger, consequence, and a reproduction/check.
Do not invent findings for volume. After fixes make a distinct verification pass and mark each
finding fixed, still open or unverified.

For Lighthouse changes, apply the minimal-change rule in
[develop-feature](../develop-feature/SKILL.md). Independently verify why Chronix cannot solve the
problem and reject unnecessary client changes.
