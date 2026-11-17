// Irreversible operations: data that is gone with no snapshot to restore, or a live session that is broken.

import { constants } from "node:os";
import { commandTokenIndex, commandWord, originalSlice, splitPipeline, tokenize, wordsFrom } from "../scan";
import type { ShellMatch, ShellRule } from "./types";

/** Docker global options that consume the next token, in their separate-value spelling. */
const DOCKER_GLOBAL_WITH_VALUE = new Set([
    "-H",
    "--host",
    "-c",
    "--context",
    "--config",
    "-l",
    "--log-level",
    "--tlscacert",
    "--tlscert",
    "--tlskey",
]);

// docker volume rm|prune, docker system prune, docker rm with -f and -v, compose down -v.
export const dockerVolumeDestroy: ShellRule = {
    id: "docker-volume-destroy",
    kind: "destructive",
    title: "docker volume rm / prune and rm -fv delete data with no snapshot to recover",
    severity: "block",
    why:
        "OrbStack and Docker Desktop do not snapshot volumes. `docker volume rm`, `docker volume prune`, " +
        "`docker system prune` (with volumes), `docker rm -fv` and `docker compose down -v` delete the " +
        "database files inside the " +
        "volume, and recovery is generally impossible. Even a volume that looks broken needs an explicit yes.",
    wrong: "docker volume prune -f",
    right: "docker volume ls   # list, then ask before removing anything by name",
    evidence: "0 uses in 30 days; CLAUDE.md marks it 🛑 because there is no undo.",
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            for (const statement of statements) {
                if (!statement.text.includes("docker")) {
                    continue;
                }

                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const cmd = commandTokenIndex(tokens, scan.command);

                    const word = cmd === -1 ? "" : commandWord(tokens[cmd].text);

                    if (word !== "docker" && word !== "docker-compose") {
                        continue;
                    }

                    // Docker's global options come before the subcommand, and some take a value:
                    // `docker --context orbstack volume prune` read `orbstack` as the subcommand, so
                    // the volume deletion passed. They are skipped the way `git -C dir` is.
                    const all = tokens.slice(cmd + 1).map((t) => t.text);
                    let first = 0;

                    while (word === "docker" && first < all.length && all[first].startsWith("-")) {
                        first += DOCKER_GLOBAL_WITH_VALUE.has(all[first]) ? 2 : 1;
                    }

                    const args = all.slice(first);
                    const positional = args.filter((a) => !a.startsWith("-"));
                    const shortFlags = args.filter((a) => a.startsWith("-") && !a.startsWith("--"));
                    const [a, b] = positional;
                    // Both spellings, for both flags. `shortFlags` kept only `-fv`-style
                    // clusters, so `docker rm --force --volumes app` — which deletes exactly
                    // the same data — was never detected, while the prune branch below
                    // already accepted `--volumes`. The two paths disagreed.
                    const hasForce = shortFlags.some((f) => f.includes("f")) || args.includes("--force");
                    const hasVolumes = shortFlags.some((f) => f.includes("v")) || args.includes("--volumes");
                    const forceAndVolumes = hasForce && hasVolumes;
                    // `docker system prune` alone keeps volumes since Docker 23; only
                    // `--volumes` (or a `v` in a short cluster) reaches them.
                    const pruneVolumes = hasVolumes;
                    // `compose down -v` removes the project's named volumes: the most common way
                    // to lose a Compose database. `down` is searched, not taken by position,
                    // because `compose -f stack.yml down -v` puts the file name first.
                    const composeDown =
                        (word === "docker" && a === "compose" && positional.includes("down")) ||
                        (word === "docker-compose" && positional.includes("down"));
                    const destructive =
                        (composeDown && hasVolumes) ||
                        (word === "docker" &&
                            ((a === "volume" && (b === "rm" || b === "prune" || b === "remove")) ||
                                (a === "system" && b === "prune" && pruneVolumes) ||
                                (a === "rm" && forceAndVolumes) ||
                                (a === "container" && b === "rm" && forceAndVolumes)));

                    if (!destructive) {
                        continue;
                    }

                    const start = tokens[cmd].start;
                    return { matched: originalSlice(scan, start, element.start + element.text.length), index: start };
                }
            }
        }

        return null;
    },
};

/** `kill`'s options that take the signal as the next word. */
const KILL_SIGNAL_OPTIONS = new Set(["-s", "-n", "--signal"]);

/** SIGCONT by name, in any case, with or without `SIG`, or by this platform's number (19 on macOS, 18 on Linux). */
function isContSignal(signal: string): boolean {
    return signal.toUpperCase().replace(/^SIG/, "") === "CONT" || signal === String(constants.signals.SIGCONT);
}

/** The signal and the targets of `kill`'s arguments; no signal option means SIGTERM. */
function killArguments(args: readonly string[]): { signal: string; targets: string[] } {
    const [first, second] = args;

    if (first !== undefined && KILL_SIGNAL_OPTIONS.has(first)) {
        return { signal: second ?? "", targets: args.slice(2) };
    }

    if (first?.startsWith("-") && first !== "--") {
        return { signal: first.slice(1), targets: args.slice(1) };
    }

    return { signal: "TERM", targets: [...args] };
}

// kill -CONT -<pgid>, in every spelling of the signal: the end of the usual "TERM, then CONT" way to stop a job.
export const stoppedJobWake: ShellRule = {
    id: "stopped-job-wake",
    kind: "destructive",
    title: "kill -CONT to a process group wakes a stopped job, which then rewrites the tty a live TUI may use",
    severity: "block",
    why:
        "SIGCONT lets a stopped (Ctrl-Z) job run again on its old tty, where a live TUI such as Claude may run now. " +
        "The woken job writes to that tty: its resume code turns its input modes back on (mouse, kitty keyboard), " +
        "and its exit code restores the termios it saved at its own start, which is the shell's cooked mode. The " +
        "live TUI does not know, so the kernel echoes every key and mouse report as text (`^[[<35;x;yM`) and holds " +
        "it in a line buffer the TUI never reads. SIGKILL ends a stopped group without letting it run.",
    wrong: 'kill -TERM -"$pgid"; kill -CONT -"$pgid"',
    right:
        'T=/dev/ttysNNN; saved=$(stty -g -f $T); kill -KILL -"$pgid"; ' +
        '[ "$(stty -g -f $T)" = "$saved" ] || stty -f $T "$saved"   # every pgid of the job; Linux: stty -F',
    evidence:
        "2026-11-17 13:47: TERM then CONT to 8 stopped Claude jobs left ttys006 in `icanon echo` under a live " +
        "Claude, and salon's input on ttys003 arrived as `xt/exit` and `^[[117;5u`. 2026-10-30: the same codes " +
        "in another pane after its stopped launcher was killed.",
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            for (const statement of statements) {
                if (!statement.text.includes("kill")) {
                    continue;
                }

                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const cmd = commandTokenIndex(tokens, scan.command);

                    if (cmd === -1 || commandWord(tokens[cmd].text) !== "kill") {
                        continue;
                    }

                    // The words as the shell splits them: the scan blanks quotes, so `-"$g"` tokenizes as `-` and `$g`.
                    const { signal, targets } = killArguments(wordsFrom(scan, tokens[cmd].start).words.slice(1));
                    const groups = targets.filter((target) => target.startsWith("-") && target !== "--");

                    if (!isContSignal(signal) || groups.length === 0) {
                        continue;
                    }

                    const start = tokens[cmd].start;

                    return {
                        matched: originalSlice(scan, start, element.start + element.text.length),
                        index: start,
                        detail: `SIGCONT to the process group ${groups.join(", ")}`,
                    };
                }
            }
        }

        return null;
    },
};

export const destructiveRules: readonly ShellRule[] = [dockerVolumeDestroy, stoppedJobWake];
