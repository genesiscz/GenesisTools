// git shapes that destroy work or someone else's commits.

import {
    commandTokenIndex,
    commandWord,
    originalSlice,
    type ShellScan,
    type Span,
    splitPipeline,
    tokenize,
} from "../scan";
import type { ShellMatch, ShellRule } from "./types";

interface GitInvocation {
    element: Span;
    tokens: Span[];
    /** Index of the subcommand token (`checkout`, `push`, …). */
    sub: number;
}

// Every `git <sub>` in the command, with `git -C dir` / `git --no-pager`
// global options skipped.
function gitInvocations(scan: ShellScan): GitInvocation[] {
    const out: GitInvocation[] = [];

    for (const statements of scan.units) {
        for (const statement of statements) {
            for (const element of splitPipeline(statement)) {
                const tokens = tokenize(element);
                const cmd = commandTokenIndex(tokens);

                if (cmd === -1 || commandWord(tokens[cmd].text) !== "git") {
                    continue;
                }

                let i = cmd + 1;

                while (i < tokens.length && tokens[i].text.startsWith("-")) {
                    i +=
                        tokens[i].text === "-C" ||
                        tokens[i].text === "-c" ||
                        tokens[i].text === "--git-dir" ||
                        tokens[i].text === "--work-tree"
                            ? 2
                            : 1;
                }

                if (i < tokens.length) {
                    out.push({ element, tokens, sub: i });
                }
            }
        }
    }

    return out;
}

function elementMatch(scan: ShellScan, inv: GitInvocation, suggestion?: string): ShellMatch {
    const start = inv.tokens[0].start;
    const matched = originalSlice(scan, start, inv.element.start + inv.element.text.length);
    return { matched, index: start, ...(suggestion !== undefined ? { suggestion } : {}) };
}

export const gitCheckoutOverwritesFile: ShellRule = {
    id: "git-checkout-overwrites-file",
    kind: "destructive",
    title: "git checkout -- / git restore overwrites uncommitted work with no way back",
    severity: "block",
    why:
        "`git checkout -- <file>`, `git checkout HEAD -- <file>`, `git checkout <branch> -- <file>` and " +
        "`git restore <file>` replace the working-tree copy and discard whatever was there. Nothing records " +
        "the old content, so a fix you just wrote is gone. `git stash push -- <files>` gets the same clean " +
        "tree and keeps the change recoverable. Only `git restore --staged` (index only) is safe.",
    wrong: "git checkout -- src/utils/ai/grok/models.ts",
    right: 'git stash push -m "models.ts before revert" -- src/utils/ai/grok/models.ts',
    evidence:
        "CLAUDE.md records two offences on 2026-08-27 with the rule on screen, both mutation checks that " +
        "destroyed an uncommitted fix, plus a scrubbed README regressed by `git checkout <branch> -- file`. " +
        "64 pattern hits in 30 days (Claude 60, Grok 1, Codex 3), the Codex ones all `--staged`.",
    detect(scan): ShellMatch | null {
        for (const inv of gitInvocations(scan)) {
            const sub = inv.tokens[inv.sub].text;
            const args = inv.tokens.slice(inv.sub + 1).map((t) => t.text);

            if (sub === "checkout") {
                const dash = args.indexOf("--");

                // `--ours` / `--theirs` on a conflicted file is conflict resolution, not
                // a revert: the working copy holds markers, not work.
                if (dash === -1 || args.includes("--ours") || args.includes("--theirs")) {
                    continue;
                }

                const files = args.slice(dash + 1);
                const ref = args.slice(0, dash).filter((a) => !a.startsWith("-"));
                const plainRevert = ref.length === 0 || ref[0] === "HEAD";
                const suggestion =
                    plainRevert && files.length > 0
                        ? `git stash push -m "before revert" -- ${files.join(" ")}`
                        : undefined;

                return elementMatch(scan, inv, suggestion);
            }

            if (sub === "restore") {
                const flags = args.filter((a) => a.startsWith("-"));
                const indexOnly =
                    flags.some((f) => f === "--staged" || f === "-S") &&
                    !flags.some((f) => f === "--worktree" || f === "-W");

                if (indexOnly) {
                    continue;
                }

                const files = args.filter((a) => !a.startsWith("-") && a !== "--");
                const suggestion =
                    files.length > 0 ? `git stash push -m "before restore" -- ${files.join(" ")}` : undefined;

                return elementMatch(scan, inv, suggestion);
            }
        }

        return null;
    },
};

export const gitPushForceWithoutLease: ShellRule = {
    id: "git-push-force-without-lease",
    kind: "destructive",
    title: "git push --force without --force-with-lease overwrites commits you never saw",
    severity: "block",
    why:
        "A plain --force replaces the remote branch with yours whatever the remote holds. If anyone (or " +
        "another session, or a merge) pushed since your last fetch, those commits are gone. " +
        "--force-with-lease refuses when the remote moved, which is exactly the case that destroys work.",
    wrong: "git push --force origin feat/x",
    right: 'git push --force-with-lease origin feat/x   # on "stale info": fetch and look, never escalate to --force',
    evidence: "0 plain --force pushes in 30 days against 296 --force-with-lease; the rule exists so it stays 0.",
    detect(scan): ShellMatch | null {
        for (const inv of gitInvocations(scan)) {
            if (inv.tokens[inv.sub].text !== "push") {
                continue;
            }

            const flag = inv.tokens
                .slice(inv.sub + 1)
                .find(
                    (t) =>
                        t.text === "--force" ||
                        t.text === "-f" ||
                        (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(t.text) && !t.text.startsWith("--"))
                );

            if (!flag) {
                continue;
            }

            const replaced =
                flag.text === "--force" || flag.text === "-f"
                    ? "--force-with-lease"
                    : `${flag.text.replace("f", "")} --force-with-lease`;
            const suggestion =
                scan.command.slice(0, flag.start) + replaced + scan.command.slice(flag.start + flag.text.length);

            return elementMatch(scan, inv, suggestion);
        }

        return null;
    },
};

export const gitRules: readonly ShellRule[] = [gitCheckoutOverwritesFile, gitPushForceWithoutLease];
