# tools time-machine

> **Auto-bisect a failing command across git history to find the last green commit.**

`git bisect` without the interactive session: give it the command, and it walks back until the command passes.

---

## Quick start

```bash
tools time-machine -- bun run test
tools time-machine -- bun scripts/test.ts src/auth/token.test.ts
tools time-machine --depth 100 -- bun run tsgo
tools time-machine --good v1.4.0 -- bun run test
```

Everything after `--` is the command under test. The `--` marker ends option parsing, so the
tool forwards those arguments to the command unchanged. Your shell still parses the line first,
so use normal quoting when a command needs grouped arguments: `-- sh -c 'a && b'`.

> 🛑 Use `bun run test` or `bun scripts/test.ts <paths>` in this repo, never bare `bun test`.
> The wrapper repairs the dependency tree first, which matters here because this tool checks out
> other commits and a stale `node_modules` would fail every one of them for the wrong reason.

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

## ✅ Your working tree is never touched

The bisect does not check out commits over your files. It creates one temporary git worktree
(`createTempWorktree` in `lib/git.ts`), checks each candidate commit out **there**, runs the
command in that directory, and removes the worktree in a `finally` block. Your working tree,
branch and index are never modified, so you do not need to commit or stash first.

The one place your uncommitted changes do matter is the **first probe**. Before searching
history, the tool runs the command against your current working tree to confirm it actually
fails. If your uncommitted edits are what break it, that probe fails for your reasons, and the
history walk then reports the last commit where the command passed without them.

⚠️ If the command needs dependencies that changed across the range, a run can fail for install
reasons rather than code reasons, and the temporary worktree starts without `node_modules`.
Include the install in the command when that is a risk: `-- sh -c 'bun install && bun run test'`.
