// zsh facts the Bash tool cannot infer: it runs zsh 5.9 with NO_BARE_GLOB_QUAL
// set, and `log` is a zsh builtin that shadows /usr/bin/log.

import { commandTokenIndex, commandWord, originalSlice, RESERVED_PREFIX, splitPipeline, tokenize } from "../scan";
import type { ShellMatch, ShellRule } from "./types";

export const zshGlobQualifier: ShellRule = {
    id: "zsh-glob-qualifier",
    kind: "misread",
    title: "(N) / (#q…) glob qualifiers fail here: NO_BARE_GLOB_QUAL is set",
    severity: "block",
    why:
        'Claude Code sets NO_BARE_GLOB_QUAL on every Bash call, so `ls *.log(N)` does not mean "empty ' +
        'list when nothing matches"; it fails with the very `no matches found` error the qualifier was ' +
        'meant to avoid, and the failure reads as "there are no files".',
    wrong: "ls *.log(N)",
    right: "[ -e app.log ] && ls *.log   # or: ( setopt NULL_GLOB; ls -d *.log )",
    evidence: "0 uses in 30 days; CLAUDE.md lists it under zsh facts because it is the idiom a model reaches for.",
    detect(scan): ShellMatch | null {
        // Glued to the word before it, so `$(N)`, `<(N)` and `; (N)` are not globs.
        const m = /(?<![$<>\s])\((N|#q[^)\s]*)\)(?=\s|$|[;&|)])/.exec(scan.cleaned);

        if (!m) {
            return null;
        }

        return { matched: scan.command.slice(m.index, m.index + m[0].length), index: m.index };
    },
};

export const bareLogCommand: ShellRule = {
    id: "bare-log-command",
    kind: "misread",
    title: "bare `log show` runs the zsh builtin, not /usr/bin/log",
    severity: "block",
    why:
        "`log` is a zsh builtin (it lists logged-in users) and shadows /usr/bin/log. `log show --predicate …` " +
        'answers `too many arguments`, which looks like "no matching events" when the output is skimmed. ' +
        "`command log` bypasses the builtin.",
    wrong: "log show --last 5m --predicate 'process == \"sharingd\"'",
    right: "command log show --last 5m --predicate 'process == \"sharingd\"'",
    evidence: "223 `log show/stream` calls in 30 days; 200 already used `command log`, the rest hit the builtin.",
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            for (const statement of statements) {
                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const cmd = commandTokenIndex(tokens);

                    if (cmd === -1 || tokens[cmd].text !== "log") {
                        continue;
                    }

                    // commandTokenIndex skipped the wrappers. Every wrapper except
                    // `builtin` (and `time`, a reserved word) execs the real binary, so
                    // `command log`, `sudo log`, `env log`, `exec log` all bypass the
                    // builtin; only a bare `log` or `builtin log` hits it. The reserved words
                    // commandTokenIndex also skips (`do`, `then`, `!` …) run nothing themselves,
                    // so `for f in a; do log show …; done` still reaches the builtin.
                    if (
                        tokens
                            .slice(0, cmd)
                            .some(
                                (t) =>
                                    !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text) &&
                                    !RESERVED_PREFIX.has(t.text) &&
                                    !["builtin", "time"].includes(commandWord(t.text))
                            )
                    ) {
                        continue;
                    }

                    const sub = tokens[cmd + 1]?.text;

                    if (sub !== "show" && sub !== "stream" && sub !== "collect" && sub !== "config") {
                        continue;
                    }

                    const start = tokens[cmd].start;
                    const matched = originalSlice(scan, start, element.start + element.text.length);
                    const suggestion = `${scan.command.slice(0, start)}command ${scan.command.slice(start)}`;

                    return { matched, index: start, suggestion };
                }
            }
        }

        return null;
    },
};

export const zshRules: readonly ShellRule[] = [zshGlobQualifier, bareLogCommand];
