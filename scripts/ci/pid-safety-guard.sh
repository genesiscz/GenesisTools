#!/usr/bin/env bash
# PID-recycling guard (2026-08-19, after the third incident of the same shape).
#
# The recurring defect: code reads a pid out of durable state (a pidfile, a
# JSON runtime record, a DB row) and asks `process.kill(pid, 0)` whether it is
# still alive. The kernel recycles pid numbers, so that probe answers about
# whatever program now holds the number:
#   2026-08-11  ai-proxy's pid landed on `darwinkit serve` — `status` reported a
#               week-dead proxy as running, `down` would have SIGKILLed it.
#   2026-08-19  the scheduler daemon's pidfile held 891, by then
#               WiFiCloudAssetsXPCService — 4284 launchd restarts over 12h with
#               nothing polling Claude usage.
#
# Three sanctioned entry points, and nothing else may hand-roll the probe:
#   isProcessAlive()  src/utils/process-alive.ts     — liveness only, correct about ESRCH/EPERM
#   classifyPid()     src/utils/process-identity.ts  — liveness + identity
#   pidfile module    src/utils/process/pidfile.ts   — durable pid records, read as a verdict
#
# USES `grep`, NOT `rg`, ON PURPOSE. ripgrep is NOT installed on the GitHub
# ubuntu runner. The sibling guards call `rg` from inside `if rg …; then`, where
# a 127 "command not found" is indistinguishable from "no matches", so both of
# them print their OK line and pass having checked nothing (verified in run
# 32243392511). A guard that cannot fail is worse than no guard, so this one
# depends only on POSIX tools.
set -euo pipefail

# Reach the repo root first: the source roots below are relative, so running the
# guard from a subdirectory would scan nothing.
cd "$(dirname "$0")/../.."

fail=0

# Shared exclusions. `grep -r` has no --glob, so directories and suffixes are
# filtered separately.
common_excludes=(
    --binary-files=without-match
    --exclude-dir=node_modules
    --exclude-dir=.git
    --exclude-dir=dist
    --exclude-dir=build
    --exclude=*.md
    --exclude=pid-safety-guard.sh
)

# Scan the source roots by name instead of the whole repo.
#
# This used to be `.` plus `--exclude-dir=worktrees` / `--exclude-dir=logs`, and
# review t26 on PR #330 was right to call that a bypass: `--exclude-dir` matches
# a bare directory NAME at EVERY depth, so a real source file at
# `src/<tool>/logs/process.ts` was silently skipped by a required guard.
#
# Naming the roots fixes both halves. Git worktrees live at `.worktrees/` and
# `.claude/worktrees/`, neither of which is a source root, so the scan no longer
# walks another branch's full checkout (100s+ down to ~24s locally, and it no
# longer reports violations belonging to a different branch). Nothing under a
# source root is excluded by directory name any more.
scan_roots=(src apps scripts plugins tools)

for scan_root in "${scan_roots[@]}"; do
    if [ ! -e "$scan_root" ]; then
        echo "::error:: source root '$scan_root' is missing, so this guard would scan less than it claims to."
        exit 1
    fi
done

# 1. The signal-0 liveness probe belongs to the two helpers that own it.
#    A hand-rolled `process.kill(x, 0)` anywhere else is either a pid-recycling
#    bug or a re-implementation of ESRCH/EPERM handling that has been gotten
#    wrong before (collapsing EPERM into "dead" reports live cross-uid
#    processes as gone).
probe_hits=$(grep -rnE "${common_excludes[@]}" \
    --exclude=process-alive.ts --exclude=process-identity.ts \
    'process\.kill\([^,)]*,[[:space:]]*0[[:space:]]*\)' "${scan_roots[@]}" || true)

if [ -n "$probe_hits" ]; then
    printf '%s\n' "$probe_hits"
    echo "::error:: hand-rolled \`process.kill(pid, 0)\` liveness probe. Use isProcessAlive() from @genesiscz/utils/process-alive for a pid you just spawned, classifyPid() from @genesiscz/utils/process-identity for a pid that came from anywhere else, or the @genesiscz/utils/process/pidfile module when the pid lives in a file. A bare probe cannot tell your process from a recycled pid."
    fail=1
fi

# 2. A pidfile written as a bare number is unverifiable forever after — the
#    identity has to be captured at WRITE time, which is what writePidFile does.
#    Tests are exempt: constructing a legacy bare-number file by hand is how the
#    backward-compatible read path is proved to still work.
bare_write_hits=$(grep -rnE "${common_excludes[@]}" \
    --exclude=*.test.ts --exclude=pidfile.ts \
    'write(File)?(Sync)?\([[:space:]]*[A-Za-z0-9_$]*[Pp][Ii][Dd][A-Za-z0-9_$]*[[:space:]]*,[[:space:]]*(String\(|`)' "${scan_roots[@]}" || true)

if [ -n "$bare_write_hits" ]; then
    printf '%s\n' "$bare_write_hits"
    echo "::error:: pidfile written as a bare number — use writePidFile() from @genesiscz/utils/process/pidfile, which records the owner's command line so a later reader can tell it apart from a recycled pid."
    fail=1
fi

# 3. Every SIGNAL site carries its own justification, at the site.
#
#    The worst version of this bug does NOT trip rule 1 — it skips the probe
#    entirely and signals straight from stored state. Two sweeps on 2026-08-19
#    found four such sites, including an HTTP route that SIGTERMed a
#    client-supplied pid.
#
#    This started as a per-FILE allowlist and that was not good enough: once a
#    file was listed, any kill added to it later passed forever. Review t31
#    proved it with the file already on the list — `port/lib/scanner.ts` sent its
#    FIRST SIGTERM with no identity check while the guard reported "every kill
#    site reviewed". So the unit is now the call site, and the marker lives next
#    to the code it describes, where a diff shows it.
#
#    To add a signal: verify identity first (classifyPid / readSignalablePid / a
#    live command match), then put `pid-verified: <why>` on that line or the one
#    above it.
#
#    Three call shapes, because a review found two the first version missed:
#      process.kill(pid, "SIGTERM")  string or identifier signal
#      process.kill(pid, 15)         numeric signal — the char class excluded digits
#      process.kill(pid)             DEFAULT signal, no comma at all, so it tripped
#                                    neither this rule nor rule 1 and was invisible
#    Never `, 0)`, which is rule 1's business. The `[^.[:alnum:]_$]` prefix keeps
#    `child.process.kill(...)` out — a handle you hold cannot have been recycled.
signal_re='(^|[^.[:alnum:]_$])process\.kill\([^,)]*,[[:space:]]*['"'"'"`A-Za-z_$1-9]|(^|[^.[:alnum:]_$])process\.kill\([^,)]*\)'
unmarked=""

while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    hit_file=${hit%%:*}
    rest=${hit#*:}
    hit_line=${rest%%:*}
    # Clamp to 1: a hit on line 1 would ask for line 0, and `sed -n '0,1p'` is a
    # GNU extension that BSD sed rejects. That error used to be sent to
    # /dev/null, which meant a failing sed produced empty output and read as
    # "no marker here" — the silent-pass shape this whole PR exists to remove.
    previous=$((hit_line - 1))
    [ "$previous" -ge 1 ] || previous=1

    # The marker may sit on the signal line itself or immediately above it.
    if ! sed -n "${previous},${hit_line}p" "$hit_file" | grep -q 'pid-verified:'; then
        unmarked="${unmarked}${hit_file}:${hit_line}"$'\n'
    fi
done <<EOF
$(grep -rnE "${common_excludes[@]}" --exclude=*.test.ts "$signal_re" "${scan_roots[@]}" || true)
EOF

if [ -n "${unmarked//[$'\n' ]/}" ]; then
    printf '%s' "$unmarked"
    echo "::error:: this line signals a pid with no \`pid-verified:\` marker. Verify the pid's identity before signalling it (classifyPid with the command recorded at write time, readSignalablePid, or a live command match), then add \`pid-verified: <why>\` on that line or the one above. A pid read from a file, a DB row, or an HTTP body may have been reissued to an unrelated process."
    fail=1
fi

# 4. The sanctioned modules and their regression tests must stay present.
for required in \
    src/utils/process-alive.ts \
    src/utils/process-identity.ts \
    src/utils/process/pidfile.ts \
    src/utils/process/pidfile.test.ts ; do
    if [ ! -f "$required" ]; then
        echo "::error:: $required missing — it is the sanctioned pid-safety surface this guard points every caller at."
        fail=1
    fi
done

if [ "$fail" -eq 0 ]; then
    echo "pid-safety-guard: OK (no hand-rolled probes / no bare-number pidfiles / every kill site reviewed / helpers present)"
fi
exit "$fail"
