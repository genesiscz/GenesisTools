// Irreversible operations: data that is gone with no snapshot to restore, or a live session that is broken.

import { constants } from "node:os";
import { commandTokenIndex, commandWord, originalSlice, type Span, splitPipeline, tokenize, wordsFrom } from "../scan";
import type { ShellMatch, ShellRule, ShellScan } from "./types";

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

/** A decimal number as the shell and `kill` read it: `019` is 19, so `-019` and `-19` name one signal. */
function decimal(word: string): string | null {
    return /^\d+$/.test(word) ? String(Number.parseInt(word, 10)) : null;
}

/** True when `signal` is one of `names`, by name in any case, with or without `SIG`, or by this platform's number. */
function isSignal(signal: string, names: readonly (keyof typeof constants.signals)[]): boolean {
    const name = signal.toUpperCase().replace(/^SIG/, "");
    const number = decimal(signal);
    return names.some((n) => name === n.slice(3) || number === String(constants.signals[n]));
}

/** The signals that end a process once it runs again. SIGKILL is not one: it ends a stopped process at once. */
const ENDING_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const;

/** `pkill` and `killall` signal every process whose name matches, not a pid. */
const NAME_KILLERS = new Set(["pkill", "killall"]);

/** True when `word` (without its dash) names a signal of this platform, or is a signal number. */
function isSignalWord(word: string): boolean {
    return /^\d+$/.test(word) || Object.hasOwn(constants.signals, `SIG${word.toUpperCase().replace(/^SIG/, "")}`);
}

/**
 * The signal of a `pkill` or `killall` word list: `-<signal>`, `--signal <signal>`, `--signal=<signal>`, and Linux's
 * `killall -s <signal>`. No signal option means SIGTERM; "" means the call sends no signal at all: outside Linux,
 * `killall -s` only shows what it would do and `killall -d` only describes it. Options end at `--`. `killall` takes
 * its last signal option (macOS's `-TERM -CONT` sends CONT); `pkill` reads only its first.
 */
function nameKillerSignal(program: string, args: readonly string[]): string {
    const linux = process.platform === "linux";
    let signal: string | null = null;
    let preview = false;

    for (let k = 0; k < args.length; k++) {
        const arg = args[k];
        let found: string | null = null;

        if (arg === "--") {
            break;
        }

        if (program === "killall" && !linux && (arg === "-s" || arg === "-d")) {
            preview = true;
        } else if (arg === "--signal" || (arg === "-s" && program === "killall" && linux)) {
            found = args[k + 1] ?? "";
            k++;
        } else if (arg.startsWith("--signal=")) {
            found = arg.slice("--signal=".length);
        } else if (arg.startsWith("-") && !arg.startsWith("--") && isSignalWord(arg.slice(1))) {
            found = arg.slice(1);
        }

        if (found !== null && (signal === null || program === "killall")) {
            signal = found;
        }
    }

    if (preview) {
        return "";
    }

    return signal ?? "TERM";
}

interface KillCall {
    /** `kill`, `pkill` or `killall`. */
    program: string;
    signal: string;
    /** `kill`'s pids and process groups; empty for `pkill` and `killall`, which match names. */
    targets: string[];
    /** Offset of the program word in the original command. */
    start: number;
    /** The whole call in the original command. */
    matched: string;
}

/** `>`, `2>>`, `&>`, `>&2`, `<<<`: the operator of a redirection and the target glued to it, if any. */
const REDIRECTION = /^(?:\d*|&)(?:>>|>&|>\||<<<|<<-?|<&|<>|>|<)(.*)$/s;

/** The words without their redirections: the shell takes `>/dev/null` and `2> err` out of the command's argv. */
function withoutRedirections(words: readonly string[]): string[] {
    const argv: string[] = [];

    for (let k = 0; k < words.length; k++) {
        const m = REDIRECTION.exec(words[k]);

        if (!m) {
            argv.push(words[k]);
            continue;
        }

        if (m[1] === "") {
            k++;
        }
    }

    return argv;
}

/**
 * Where the element's simple command starts in the original command. The scan blanks a quoted word, so an element
 * whose first word is quoted (`'/bin/kill' -CONT 0`) starts at its second word; walk back over the blanks to the
 * separator before it, without leaving the `-c` or backtick body that holds the element.
 */
function elementStart(scan: ShellScan, element: { start: number }): number {
    const floor = scan.executableRanges
        .filter((range) => element.start >= range.start && element.start <= range.end)
        .reduce((best, range) => Math.max(best, range.start), 0);
    let start = element.start;

    while (start > floor && /[ \t]/.test(scan.cleaned[start - 1] ?? "")) {
        start--;
    }

    return start;
}

/**
 * Every `kill`, `pkill` and `killall` call of the command, in order. The program and its arguments are the words
 * the shell passes as argv, read from the original command: quotes removed (`'/bin/kill'` is kill, and the `kill` of
 * `'/bin/echo' kill` is an argument), redirections dropped.
 */
function killCalls(scan: ShellScan): KillCall[] {
    const calls: KillCall[] = [];

    if (!scan.command.includes("kill")) {
        return calls;
    }

    for (const statements of scan.units) {
        for (const statement of statements) {
            for (const element of splitPipeline(statement)) {
                const from = elementStart(scan, element);

                if (!scan.command.slice(from, element.start + element.text.length).includes("kill")) {
                    continue;
                }

                const words = withoutRedirections(wordsFrom(scan, from).words);
                const cmd = commandTokenIndex(words.map((text) => ({ text, start: 0 })));
                const program = cmd === -1 ? "" : commandWord(words[cmd]);

                if (program !== "kill" && !NAME_KILLERS.has(program)) {
                    continue;
                }

                const args = words.slice(cmd + 1);
                const start = programOffset(scan, element, from, program);
                const { signal, targets } =
                    program === "kill" ? killArguments(args) : { signal: nameKillerSignal(program, args), targets: [] };
                calls.push({
                    program,
                    signal,
                    targets,
                    start,
                    matched: originalSlice(scan, start, element.start + element.text.length),
                });
            }
        }
    }

    return calls.sort((a, b) => a.start - b.start);
}

/**
 * The offset of the program word in the original command: its scanned token when the scan kept it, else the first
 * character of the element's command (the word is quoted, so the scan blanked it).
 */
function programOffset(scan: ShellScan, element: Span, from: number, program: string): number {
    const tokens = tokenize(element);
    const cmd = commandTokenIndex(tokens, scan.command);

    if (cmd !== -1 && commandWord(tokens[cmd].text) === program) {
        return tokens[cmd].start;
    }

    return from + (/^\s*/.exec(scan.command.slice(from))?.[0].length ?? 0);
}

/**
 * The signal and the targets of `kill`'s arguments; no signal option means SIGTERM. The signal is the first word
 * only: `-<signal>`, `-s <signal>`, `-n <number>`, `--signal <signal>`, `--signal=<signal>`, or bash's glued
 * `-s<signal>` and `-n<number>`. `--` ends the options.
 */
function killArguments(args: readonly string[]): { signal: string; targets: string[] } {
    const [first, second] = args;
    const rest = (from: number) => args.slice(from).filter((target, k) => !(k === 0 && target === "--"));

    if (first === undefined || first === "--" || !first.startsWith("-")) {
        return { signal: "TERM", targets: first === "--" ? args.slice(1) : [...args] };
    }

    if (KILL_SIGNAL_OPTIONS.has(first)) {
        return { signal: second ?? "", targets: rest(2) };
    }

    if (first.startsWith("--signal=")) {
        return { signal: first.slice("--signal=".length), targets: rest(1) };
    }

    const glued = /^-[sn](.+)$/.exec(first);

    if (glued && !isSignalWord(first.slice(1)) && isSignalWord(glued[1])) {
        return { signal: glued[1], targets: rest(1) };
    }

    return { signal: first.slice(1), targets: rest(1) };
}

/**
 * True when a `kill` target names a process group, not one process: `-<pgid>`, `0` (the caller's own group), or a
 * job spec such as `%1` (the job's group, in a shell with job control).
 */
function isGroupTarget(target: string): boolean {
    return target.startsWith("-") || decimal(target) === "0" || target.startsWith("%");
}

/** A simple assignment statement: `p=1`, `export p=1`, `local p=1`. The names it binds, else none. */
const DECLARE_WORDS = new Set(["export", "local", "declare", "typeset", "readonly"]);

function assignedNames(words: readonly string[]): string[] {
    const rest = DECLARE_WORDS.has(words[0] ?? "") ? words.slice(1).filter((word) => !word.startsWith("-")) : words;
    const names = rest.map((word) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word)?.[1]);

    if (rest.length === 0 || names.some((name) => name === undefined)) {
        return [];
    }

    return names.filter((name): name is string => name !== undefined);
}

/** Every simple assignment of the command with the offset of its statement, in order. */
function assignments(scan: ShellScan): { name: string; at: number }[] {
    const out: { name: string; at: number }[] = [];

    for (const statements of scan.units) {
        for (const statement of statements) {
            const from = elementStart(scan, statement);

            for (const name of assignedNames(withoutRedirections(wordsFrom(scan, from).words))) {
                out.push({ name, at: from });
            }
        }
    }

    return out;
}

/**
 * The key two `kill` targets share when the shell gives them one pid: a literal pid by its number (`01234` is 1234),
 * and a `$p` or `${p}` by its name and the last assignment to it before the call, so `p=2; kill -CONT "$p"` after
 * `kill -TERM "$p"` is a different pid.
 */
function targetKey(target: string, at: number, binds: readonly { name: string; at: number }[]): string {
    const number = decimal(target);

    if (number !== null) {
        return number;
    }

    const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(target)?.[1];

    if (variable === undefined) {
        return target;
    }

    const bound = binds.filter((bind) => bind.name === variable && bind.at < at).at(-1);
    return `$${variable}@${bound?.at ?? -1}`;
}

// kill -CONT to a process group, or to a pid the same command also sends TERM: the end of the usual "TERM, then
// CONT" way to stop a job. pkill and killall -CONT wake every stopped match. A plain resume of one pid stays allowed
// (a process a debugger left stopped).
export const stoppedJobWake: ShellRule = {
    id: "stopped-job-wake",
    kind: "destructive",
    title:
        "kill -CONT to a process group or to a pid this command ends, or pkill / killall -CONT, wakes a stopped " +
        "job, which then rewrites the tty a live TUI may use",
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
        const calls = killCalls(scan);
        const binds = calls.some((call) => call.targets.some((target) => target.includes("$")))
            ? assignments(scan)
            : [];
        const ended = new Set(
            calls
                .filter((call) => isSignal(call.signal, ENDING_SIGNALS))
                .flatMap((call) => call.targets.map((target) => targetKey(target, call.start, binds)))
        );

        for (const call of calls) {
            if (!isSignal(call.signal, ["SIGCONT"])) {
                continue;
            }

            if (call.program !== "kill") {
                return {
                    matched: call.matched,
                    index: call.start,
                    detail:
                        `SIGCONT by name (${call.program}) wakes every stopped process that matches; ` +
                        "resume one process with kill -CONT <pid>",
                };
            }

            const groups = call.targets.filter(isGroupTarget);
            const pids = call.targets.filter(
                (target) => !isGroupTarget(target) && ended.has(targetKey(target, call.start, binds))
            );

            if (groups.length > 0) {
                return {
                    matched: call.matched,
                    index: call.start,
                    detail: `SIGCONT to the process group ${groups.join(", ")}`,
                };
            }

            if (pids.length > 0) {
                return {
                    matched: call.matched,
                    index: call.start,
                    detail: `SIGCONT to ${pids.join(", ")}, which this command also sends a terminating signal`,
                };
            }
        }

        return null;
    },
};

export const destructiveRules: readonly ShellRule[] = [dockerVolumeDestroy, stoppedJobWake];
