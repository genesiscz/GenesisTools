## What changed and why

<!-- The problem in a sentence or two, then how this change fixes it. Link the issue if there is one. -->

## How it was tested

<!-- Name the checks you ran and what you saw. "Tests pass" alone is not enough. -->

- [ ] `bun run test` (never bare `bun test`)
- [ ] `bun run app:test` (Swift changes)
- [ ] Ran the changed tool or app by hand: <!-- command, or what you clicked, and the result -->

## Screenshots

<!-- For UI changes: before and after, in windows of the same size. A short recording if motion matters. -->

## Checklist

- [ ] Commit messages are a title line only, focused on why. Scopes follow `scripts/git/commit-scopes.ts`. Check with `bun scripts/git/check-commits.ts origin/master..HEAD`.
- [ ] `bash scripts/ci/placeholder-check.sh` passes.
- [ ] No secrets, tokens, real account names, emails or personal data in code, tests, fixtures or logs.
- [ ] The rules in `.claude/rules/` for the areas I touched were followed.
