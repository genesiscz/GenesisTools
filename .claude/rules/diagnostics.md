---
paths:
  - "src/**/doctor/**"
  - "src/**/*doctor*"
  - "src/**/*probe*"
  - "src/**/*health*"
  - "src/**/commands/*status*"
  - "src/**/commands/*test*"
  - "src/**/commands/*check*"
  - "src/utils/ai/**"
  - "src/utils/security/**"
---

# Side effects: diagnostics and irreversible operations

Covers commands that inspect (`doctor`, `test`, `probe`, `status`, …) and every shared path that spends a single-use credential or other irreversible resource. The one-line rule also stands in the root `CLAUDE.md` and `.claude/rules/code.md`.

The recurring bug shape in this repo is a path that READS like an inspection but MUTATES durable state. Two of them shipped in one week: `tools ai config doctor` and `tools ai config account test` both spent single-use Anthropic refresh tokens, because both reached a shared auth path that refreshed on expiry. Diagnosing an account could brick it.

- **A diagnostic must never mutate.** If the name says it inspects (`doctor`, `test`, `probe`, `health`, `check`, `status`, `list`, `show`, `--dry-run`, `--check`) it may READ durable state and REPORT on it, and nothing else. No writes, no token rotation, no cache mint that changes what a later process observes. When a diagnostic finds a problem it prints the fix command; it does not apply the fix.
- **Guard above the consuming call, not at the caller.** Single-use credentials (OAuth refresh tokens), machine-global state (the OS keychain), and anything with a rotation counter get their guard in the shared function, immediately BEFORE the line that spends them. A guard at the call site only protects the callers you thought of.
- **A new safety parameter leaves every existing caller unsafe.** Adding `{ noRefresh: true }` fixes exactly the one caller you pass it to. Prefer inverting the default so the DANGEROUS behavior is the opt-in. When you cannot invert (too many callers, public API), `rg` every call site and classify each one in the same commit — an unclassified caller is an unfixed bug, and "I fixed it at the root" is not a defense if the root still defaults to dangerous.
- **Ship the negative control.** A test proving the guarded path is safe is half a test. The other half proves normal use still WORKS: `a bind without probe still reaches the refresh call`. Without it, a guard that leaks into the normal path silently breaks every account at token expiry, which is worse than the bug it fixed.
- **Spy on the irreversible call itself.** Assert against the primitive that spends the resource (the `refresh` call, the keychain `setPassword`, the `DELETE`), not on a symptom downstream. Make the spy THROW as well as record, so a path that reaches it fails loudly instead of passing quietly.
