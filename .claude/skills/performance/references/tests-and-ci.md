# Tests and CI: executables in tests, a Linux check, and reading a run

Contents: 1. tests that start an executable · 2. checking Linux without CI · 3. a green run is not a passing
suite · 4. the Linux worker hang.

Written 2026-10-14 22:43, from the #516 work (process layer) and the master fixes after it.

## 1. Tests that start an executable

- On 2026-10-14 the Mac froze at 20:06 (WindowServer watchdog) after syspolicyd crashed five times on executables
  that tests had just made and then renamed or deleted: a copy of bun per run, and fake tools inside the per-run temp
  root that is removed after every green run. Analysis: `<notes vault>/GenesisTools/2026-10-14-MacFreeze-Syspolicyd.md`.
  The swift skill holds the syspolicyd side.
- **Rule: a test that executes a file gets it from `persistentFixture(name, key, create)`**
  (`src/utils/test/persistent-fixture.ts`, 7ed611df5). The file is made once per key in `<real temp>/gt-test-fixtures/`,
  next to the per-run root and outside its cleanup, and nothing renames or deletes it. The key is the content: the
  source's path, size and mtime for a binary copy, the body for a script. Concurrent runs hard-link a draft into
  place, so the loser of a race uses the winner's file instead of overwriting one that may be running.
- A fake tool inside a run folder is a symlink to the persistent script; removing the folder removes only the link.
- A test whose whole point is a move ("a moved executable keeps its inode") runs on macOS only with `RUN_LIVE=1`.
  Linux has no syspolicyd and runs it every time.
- On macOS the real temp folder is the per-user `/var/folders/.../T`, not `/tmp`. When macOS cleans it, the next run
  makes each fixture once again; a run never makes one per run. Check `find "$TMPDIR/gt-test-fixtures" -type f` to
  see which fixtures exist (2026-10-14 22:49: three files, all from one run at 21:27, reused since).
- Proof that it reuses: both changed test files run twice in the Linux container (section 2), 70 pass in each round,
  and round 2 listed the same three fixture inodes as round 1.

## 2. Checking Linux without CI

CI runs the suite on ubuntu only, and every push buys a paid bot review. A Linux-only failure (a macOS-only binary in
an argv, a spawn count, a `/proc` read) is cheaper to reproduce in a container first.

- Image `gt-ci-linux:git255` in OrbStack (start it with `orb start` after a reboot): `oven/bun:1.4.2`, git 2.55 built
  from source, ripgrep, procps, lsof, psmisc, user `bun`.
- Git: mount the main repo's `.git` read-only at `/src.git`. In the container, `git init` an empty repo, write
  `/src.git/objects` into `.git/objects/info/alternates`, then `git checkout <sha>`. Any commit in the host object
  store checks out, with no branch needed. Only committed work is visible, so commit (a temporary commit is fine).
- Dependencies: `bun install --frozen-lockfile` inside the container, with a named cache volume so it takes about a
  minute. Give parallel containers different volumes.
- **The container is not CI.** The full suite at master cc39e1171 failed 52 tests there (the personal-data probe tests,
  CDP browser launches, tmux sessions and more) that CI's run of the same commit does not fail. So a full-suite run in
  the container proves nothing alone: run the base SHA in the same container and compare the sorted `(fail)` lists.
  The daemon fix c977a1b00 had 51: the base's 52 minus "run log meta", and nothing new (2026-10-14 22:52).
- Run the old SHA and the fixed SHA with the same test file: the old one must fail and the fixed one pass.
  Measured 2026-10-14: `src/utils/process-identity.test.ts` 1 fail at 9d0d0f824, 0 at fd0486ee0;
  `src/daemon/lib/runner.test.ts` 1 fail at cc39e1171 (ENOENT on `/usr/sbin/taskpolicy`), 0 at 21670ffff.

```bash
# run-pairs.sh, mounted at /run.sh: for each <sha>:<test file>, check out, install, run
for pair in "$@"; do
    sha=${pair%%:*}; file=${pair#*:}; dir=/home/bun/repo-$sha
    git init -q "$dir" && cd "$dir" || exit 2
    echo /src.git/objects > .git/objects/info/alternates
    git checkout -q "$sha" || continue
    bun install --frozen-lockfile > "/out/install-$sha.log" 2>&1
    bun scripts/test.ts "$file" > "/out/test-$sha.log" 2>&1
    echo "$sha $file test exit $?" >> /out/summary.txt
done
```

```bash
docker run -d --rm --name gt-linux-check --cpuset-cpus 0-3 --memory 6g \
  -v <main checkout>/.git:/src.git:ro \
  -v <scratch>/run-pairs.sh:/run.sh:ro \
  -v <scratch>/out:/out \
  -v gt-bun-cache-c:/home/bun/.bun/install/cache \
  gt-ci-linux:git255 bash /run.sh <old sha>:<test file> <new sha>:<test file>
docker wait gt-linux-check; cat <scratch>/out/summary.txt
```

## 3. A green run is not a passing suite

- The test step is `continue-on-error: true`, so a failing test does not fail the job. Only two steps make it red: a
  missing `[test] suite complete` line (a hang or a timeout) and the per-file runtime ceiling
  (`scripts/ci/test-runtime-guard.ts`, about 6% of the summed file time: 25 s, 33 s and 34 s on three runs).
- Read the failures from the log, never from the check's colour:
  `gh run view <id> --log > run.log`, then `rg -o "\(fail\) .{0,100}" run.log | sort -u`. The step that made a job
  red: `gh run view <id> --json jobs --jq '.jobs[].steps[] | select(.conclusion=="failure") | .name'`.
- Measured 2026-10-14: master's run at 171e40678 was green while two tests failed on every run: a missing
  `./storage/atomic-file` export in `src/utils/package.json` (fixed on master in cc39e1171) and the daemon's
  `/usr/sbin/taskpolicy` argv on Linux (fixed in 21670ffff, branch `fix/2026-10-14-daemon-taskpolicy-linux`).

## 4. The Linux worker hang

- Signature: 20 to 40 s timeouts in unrelated files, starting right after `killed 1 dangling process`, a different set
  of files on each run, and the job red from the per-file ceiling. Measured 2026-10-14: master at db889dd20 timed out
  five `notify.test.ts` tests; master at cc39e1171 timed out tests in five other files; the re-run of that same
  commit had no timeout at all. A set of timed-out files that changes with no related code change is the hang, not a
  defect in those files.
- bun prints `killed N dangling process` at a LATER file, so the log blames the wrong one. The repository variable
  `TEST_WORKER_LOG=1` (set 2026-10-14 19:34) makes every CI run write the worker log and put its report
  (`bun scripts/test-worker-log.ts`) into the job summary: the report names the file that left the process.
- `gh run rerun <id> --failed` gets a second sample without a push, so it costs no paid review.

## 5. Make a check cheaper without making it weaker

- **Typecheck only what a change can reach, incrementally.** CI checks the projects a change reaches against the PR
  base (or the commit before a push) with that commit's build info; locally against each project's last pass
  (c16b113da6).
- **Shorten a timing test by its phases, keep its margin.** The idle-then-busy CPU test waits one second per phase
  instead of three, with the same ratio margin: 6.70 to 2.69 s (fcdfb11031).
- **Freeze the clock in a test that prints times**, so a slow second cannot turn "30s" into "31s" (a20257abac).
- **Git hooks stay cheap and bounded.** A hook never starts a whole `tools` run and never uses Bun's `$` shell, and
  each pre-push guard has a deadline (ad23abfe41, 5e121bd229). `references/patterns.md` has the details.
