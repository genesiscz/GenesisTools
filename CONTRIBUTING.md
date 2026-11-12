# Contributing to GenesisTools

Issues are welcome. Pull requests are even more welcome.

## Report a bug or ask for a feature

- Bug: open an issue with the [bug report form](https://github.com/genesiscz/GenesisTools/issues/new?template=bug_report.yml). It lists the command that prints each detail it asks for (commit, macOS version, `bun run app:status`, `tools macos permissions`, the log).
- Feature: use the [feature request form](https://github.com/genesiscz/GenesisTools/issues/new?template=feature_request.yml). Describe the problem before the solution.
- Security problem or leaked secret: use a [private advisory](https://github.com/genesiscz/GenesisTools/security/advisories/new). Do not open a public issue.
- Before you post a log, remove tokens, personal data and private file names.

## Set up

GenesisTools runs on [Bun](https://bun.sh). There is no build step.

```bash
bun install && ./install.sh
source ~/.zshrc   # or ~/.bashrc
tools             # pick a tool, or run: tools <tool> [args]
```

On macOS, `install.sh` also offers to build GenesisTools.app. That needs the full Xcode app.

## Change code

- A tool is a folder `src/<tool>/` with an `index.ts` or `index.tsx`. Shared code is in `src/utils/`.
- In a git worktree, run `./tools <tool>` from the worktree root. The `tools` on your PATH runs the main checkout.
- Swift changes (`src/macos/`): build and launch with `bun run app`, test with `bun run app:test`.
- Rules for each area are in [.claude/rules/](.claude/rules/). Read the file that matches the folder you change. [CLAUDE.md](CLAUDE.md) lists which file covers what.

## Test

```bash
bun run test                  # all tests, or: bun run test <paths>
bun run app:test              # Swift tests
```

Use `bun run test`, never bare `bun test`. The wrapper repairs the dependency tree first. Tests use invented data (`alice@example.com`, an account called `work`), never real accounts. Read [.claude/rules/tests.md](.claude/rules/tests.md) before you add a test file.

## Commit

- A commit message is one title line that says why, with no per-file list in the body.
- The scope comes from one vocabulary, for example `feat(recorder): ...` or `fix(GenesisKit, permissions): ...`. The rules are in [scripts/git/commit-scopes.ts](scripts/git/commit-scopes.ts). The `commit-msg` hook prints the corrected subject.
- Check a branch with `bun scripts/git/check-commits.ts origin/master..HEAD`.

## Open a pull request

1. Branch from `origin/master`.
2. Keep one problem per pull request.
3. Run `bash scripts/ci/placeholder-check.sh`. It scans the tracked files for the patterns in a local marker list that you supply: one `label<TAB>pattern` line per name, host or value that must not be published, in `~/.genesis-tools/placeholder-check/markers.txt` or the file that `$PLACEHOLDER_MARKERS_FILE` names. Without that list it scans nothing and still exits 0. The pre-push hook runs it too. Know its limits:
   - A pattern is a PCRE regular expression, matched without case. Escape the metacharacters of a literal value: write `abc\+123` to find `abc+123`.
   - It reads the files in your working tree, not your commits. A value that an earlier commit added and a later one removed is still in the history you push.
   - It skips binary files (`git grep -I`).
   - It finds only what the list names.

   So also read your diff, every commit you push and every binary file you add or change (an image, a fixture, an
   archive: the diff does not show its contents) for personal data and secrets.
4. Fill in the pull request template: what changed and why, how you tested it, screenshots for UI changes.
5. Answer review comments with a fix or a reason.

## Questions

Open an issue with the feature request form and say that it is a question. Thanks for helping.
