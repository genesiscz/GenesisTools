# tools time-machine

> **Auto-bisect a failing command across git history to find the last green commit.**

`git bisect` without the interactive session: give it the command, and it walks back until the command passes.

---

## Quick start

```bash
tools time-machine -- bun run test
tools time-machine -- bun test src/auth/token.test.ts
tools time-machine --depth 100 -- bun run tsgo
tools time-machine --good v1.4.0 -- bun run test
```

Everything after `--` is the command under test. Quote nothing, escape nothing: the shell hands the argv straight through.

## Arguments and options

| Item | Description |
|------|-------------|
| `[command...]` | The command to run, everything after `--` |
| `--depth <n>` | How many commits back to search (default: 30) |
| `--good <ref>` | Known-good lower bound (branch, tag or sha). Limits the search to `good..HEAD`. |
| `-v, --verbose` | Enable verbose logging |
| `--readme` | Print this file and exit |

---

## Choosing the bounds

`--depth` is the blunt instrument and the default. It searches the last N commits, which is right when you have no idea when the breakage arrived.

`--good <ref>` is much faster when you do know. If the last release was fine, `--good v1.4.0` turns an unbounded walk into a bisect over a known range. Fewer checkouts, fewer test runs.

The command's exit code is the verdict: zero is good, non-zero is bad. That means the command has to be a real gate. `bun run test` works. Something that always exits zero and only prints failures does not.

## ⚠️ Before you run it

Bisecting checks out other commits in your working tree. Commit or stash your work first. A dirty tree either blocks the checkout or, worse, makes every run test a mixture of old committed code and your new uncommitted code, which produces a confident and wrong answer.

If the command needs dependencies that changed across the range, the run may fail for install reasons rather than code reasons. Include the install in the command when that is a risk: `-- sh -c 'bun install && bun run test'`.
