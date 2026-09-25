import { basename, isAbsolute, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { RESERVED_PREFIX, scanShell, splitPipeline } from "@genesiscz/utils/shell/scan";
import { SCRIPT_RUNNERS, type StageKind, stageOf, WRAPPERS, WRAPPERS_WITH_NUMBER } from "./stages";
import { elementText, expandHome, expandVariables, heredocBody, shellWords, type Word } from "./words";

export type { StageKind } from "./stages";
export { fableSpecPaths, isLockOrManifest } from "./stages";
export { expandVariables, heredocBody, shellWords } from "./words";

const { log } = logger.scoped("session-changes");

export interface CommandAnalysis {
    kinds: StageKind[];
    /** Absolute files the command names as write targets: redirects, `tee`, `sed -i` files, `rm`/`mv` args, fable-replace `@@` sections. */
    writes: string[];
    /** Absolute directories the command writes under (`mkdir`, `rm -r`, `cp -r` targets): they cover every file below, and are never files themselves. */
    dirs: string[];
    /** Every directory a stage of the command ran in: its cwd unless it `cd`s first, and each `cd` target something ran in. */
    workDirs: string[];
    /** Files an inline script names as literals: a change to one is attributed with more confidence, but a literal alone is no evidence of a write. */
    hints: string[];
    /** Some stage may write files it does not name (a script, a codemod, a formatter over the tree). */
    writesUnnamed: boolean;
    /** The command runs a package install/add/remove, so lockfile and manifest changes are its own. */
    installs: boolean;
    /** A test run asked to rewrite its snapshots (`-u`). */
    updatesSnapshots: boolean;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const SHELLS = new Set(["bash", "sh", "zsh", "source", "."]);
/** xargs options (BSD and GNU) whose value is the next word when it is not attached: `-I {}`, `-n 1`. */
const XARGS_VALUE_FLAGS = new Set([
    "-a",
    "-d",
    "-E",
    "-I",
    "-J",
    "-L",
    "-n",
    "-P",
    "-R",
    "-S",
    "-s",
    "--arg-file",
    "--delimiter",
    "--max-args",
    "--max-chars",
    "--max-procs",
    "--process-slot-var",
]);

/** The command `xargs` runs, past its options and their values, with the arguments it names itself. */
function xargsInner(rest: Word[]): { program: string; args: string[] } {
    let at = 0;

    while (at < rest.length && (rest[at]?.value ?? "").startsWith("-")) {
        at += XARGS_VALUE_FLAGS.has(rest[at]?.value ?? "") ? 2 : 1;
    }

    return { program: basename(rest[at]?.value ?? ""), args: rest.slice(at + 1).map((arg) => arg.value) };
}

/** A word with `$VAR` references the command resolved itself becomes one word per value; any other stays as is. */
function substitute(word: Word, vars: ReadonlyMap<string, readonly string[]>): Word[] {
    if (!word.dynamic || word.op) {
        return [word];
    }

    const values = expandVariables(word.value, vars);
    return values ? values.map((value) => ({ value, dynamic: false })) : [word];
}

function mergeAnalysis(into: CommandAnalysis, from: CommandAnalysis): void {
    into.kinds.push(...from.kinds);
    into.writesUnnamed ||= from.writesUnnamed;
    into.installs ||= from.installs;
    into.updatesSnapshots ||= from.updatesSnapshots;

    for (const key of ["writes", "dirs", "workDirs", "hints"] as const) {
        for (const path of from[key]) {
            if (!into[key].includes(path)) {
                into[key].push(path);
            }
        }
    }
}

export interface AnalyzeCommandInput {
    command: string;
    /** The directory the command starts in. */
    cwd: string;
    /**
     * Files earlier commands (or this one) wrote with known text, by absolute path: a heredoc
     * `cat > f <<EOF`, or a file tool's Write. A later `--spec f` or `zsh f` is read from here.
     * The map is updated as the command writes more.
     */
    files?: Map<string, string>;
    /** Nesting of scripts analyzed through `files`; stops runaway recursion. */
    depth?: number;
}

/**
 * Read what a shell command does to files, from its text alone. Relative paths resolve against
 * the directory the command is in at that point (`cd` is followed, and `$VAR` when the command
 * assigned the variable itself). A script the session wrote itself is read through `files`.
 * An argument with any other expansion is never guessed at.
 */
export function analyzeCommand(input: AnalyzeCommandInput): CommandAnalysis {
    const { command, cwd } = input;
    const depth = input.depth ?? 0;
    const analysis: CommandAnalysis = {
        kinds: [],
        writes: [],
        dirs: [],
        workDirs: [],
        hints: [],
        writesUnnamed: false,
        installs: false,
        updatesSnapshots: false,
    };
    let scanned: ReturnType<typeof scanShell>;

    try {
        scanned = scanShell(command);
    } catch (error) {
        log.debug({ error }, "could not scan a shell command; treating it as an unknown writer");
        analysis.kinds.push("write");
        analysis.writesUnnamed = true;
        return analysis;
    }

    const vars = new Map<string, string[]>();
    let current = cwd;
    const addPath = (into: string[], raw: Word | undefined, base = current) => {
        if (!raw || raw.dynamic || raw.value.length === 0 || raw.value === "-" || raw.value.startsWith("/dev/")) {
            return;
        }

        const value = expandHome(raw.value);
        const path = isAbsolute(value) ? resolve(value) : resolve(base, value);

        if (!into.includes(path)) {
            into.push(path);
        }
    };
    const addWrite = (raw: Word | undefined) => addPath(analysis.writes, raw);
    const heredocFiles = input.files ?? new Map<string, string>();
    const absolute = (raw: string) => {
        const value = expandHome(raw);
        return isAbsolute(value) ? resolve(value) : resolve(current, value);
    };

    for (const unit of scanned.units) {
        for (const statement of unit) {
            for (const element of splitPipeline(statement)) {
                // `F=(a b c)`: the scanner splits on the parens, so the array's items arrive as a
                // "command" of their own. They are data.
                if (/=\(\s*$/.test(command.slice(Math.max(0, element.start - 64), element.start))) {
                    continue;
                }

                const text = elementText(scanned, element.start, element.start + element.text.length);
                const words = shellWords(text).flatMap((word) => substitute(word, vars));
                const args: Word[] = [];
                let stdin: string | null = null;

                for (let i = 0; i < words.length; i++) {
                    const word = words[i];

                    if (!word) {
                        continue;
                    }

                    if (word.op) {
                        const target = words[i + 1];
                        i++;

                        if (word.op.startsWith("<<") && word.op !== "<<<" && target) {
                            stdin = heredocBody({
                                command,
                                from: element.start,
                                delimiter: target.value,
                                stripTabs: word.op === "<<-",
                            });
                        }

                        // Output redirections name a file; `>&2`, heredocs and inputs do not.
                        if (/>/.test(word.op) && !word.op.endsWith("&") && target && !/^&?\d*-?$/.test(target.value)) {
                            addWrite(target);
                        }

                        continue;
                    }

                    args.push(word);
                }

                let at = 0;

                while (at < args.length) {
                    const word = args[at];
                    const assignment = word ? ASSIGNMENT.exec(word.value) : null;

                    if (word && assignment?.[1] && assignment[2] !== undefined) {
                        if (word.dynamic) {
                            vars.delete(assignment[1]);
                        } else {
                            vars.set(assignment[1], [expandHome(assignment[2])]);
                        }

                        at++;
                        continue;
                    }

                    const name = basename(word?.value ?? "");

                    if (RESERVED_PREFIX.has(name) || WRAPPERS.has(name)) {
                        at++;

                        while (at < args.length && (args[at]?.value ?? "").startsWith("-")) {
                            at++;
                        }

                        continue;
                    }

                    if (WRAPPERS_WITH_NUMBER.has(name)) {
                        at++;

                        while (at < args.length && /^-|^[0-9.]+[smhd]?$/.test(args[at]?.value ?? "")) {
                            at++;
                        }

                        continue;
                    }

                    break;
                }

                const program = basename(args[at]?.value ?? "");
                const rest = args.slice(at + 1);

                if (program === "cd") {
                    const target = rest[0];

                    if (target && !target.dynamic) {
                        current = resolve(current, expandHome(target.value));
                    }

                    continue;
                }

                // `for F in a b c`: each item is a value `$F` takes in the loop body.
                if (program === "for" && rest[1]?.value === "in" && rest[0]) {
                    const items = rest.slice(2);

                    if (items.length > 0 && items.every((item) => !item.dynamic)) {
                        vars.set(
                            rest[0].value,
                            items.map((item) => expandHome(item.value))
                        );
                    } else {
                        vars.delete(rest[0].value);
                    }

                    continue;
                }

                if (program !== "" && !analysis.workDirs.includes(current)) {
                    analysis.workDirs.push(current);
                }

                // `xargs <cmd>` runs a command whose arguments arrive on stdin, so its targets are unknown.
                // Its own flags still decide whether it writes: `xargs sed -i`, `xargs prettier --write`.
                if (program === "xargs") {
                    const inner = stageOf(xargsInner(rest));
                    analysis.kinds.push(inner.kind);
                    analysis.writesUnnamed ||= inner.kind === "write";
                    continue;
                }

                // A script this session wrote runs here: read it as the command it is.
                const invoked = args[at]?.value ?? "";
                const scriptArg = SHELLS.has(program) ? rest.find((arg) => !arg.value.startsWith("-")) : undefined;
                const scriptPath =
                    scriptArg && !scriptArg.dynamic
                        ? scriptArg.value
                        : /\/.*\.(?:sh|zsh|bash)$/.test(invoked)
                          ? invoked
                          : null;
                const script = scriptPath ? heredocFiles.get(absolute(scriptPath)) : undefined;

                if (script !== undefined && depth < 3) {
                    mergeAnalysis(
                        analysis,
                        analyzeCommand({ command: script, cwd: current, files: heredocFiles, depth: depth + 1 })
                    );
                    continue;
                }

                const redirectAt = words.findIndex((word) => word.op === ">" || word.op === ">|");
                const redirected = redirectAt === -1 ? undefined : words[redirectAt + 1];

                if (program === "cat" && stdin !== null && redirected && !redirected.dynamic) {
                    heredocFiles.set(absolute(redirected.value), stdin);
                }

                const stage = stageOf({
                    program,
                    args: rest.map((arg) => arg.value),
                    stdin,
                    specFile: (raw) => heredocFiles.get(absolute(raw)) ?? null,
                });
                analysis.kinds.push(stage.kind);
                analysis.writesUnnamed ||= stage.unnamed;
                analysis.installs ||= stage.installs === true;
                analysis.updatesSnapshots ||= stage.snapshots === true;
                const base = stage.base ? resolve(current, expandHome(stage.base)) : current;
                // An argument keeps its own word; a path read out of a spec or script text is
                // expanded like the shell would, and stays unknown when it cannot be.
                const wordsOf = (raw: string): Word[] => {
                    const own = rest.find((arg) => arg.value === raw);

                    if (own) {
                        return [own];
                    }

                    const values = expandVariables(raw, vars);
                    return values
                        ? values.map((value) => ({ value, dynamic: false }))
                        : [{ value: raw, dynamic: true }];
                };
                const place = (into: string[], raws: readonly string[] | undefined) => {
                    for (const word of (raws ?? []).flatMap(wordsOf)) {
                        addPath(into, word, base);

                        // A write whose target is an expansion (`rm "$f"`) is a write this text cannot name.
                        if (word.dynamic && into !== analysis.hints) {
                            analysis.writesUnnamed = true;
                        }
                    }
                };

                place(analysis.writes, stage.writes);
                place(analysis.dirs, stage.dirs);
                place(analysis.hints, stage.hints);

                // A program that may write anything: the paths it is handed are where a change is most likely its own.
                if (stage.kind === "write" && stage.unnamed) {
                    // The script a runtime runs is the program, not a target: `bun resolve.ts log <note>`.
                    const script = SCRIPT_RUNNERS.has(program)
                        ? rest.find((arg) => !arg.value.startsWith("-"))
                        : undefined;
                    const pathLike = rest.filter(
                        (arg) =>
                            arg !== script &&
                            !arg.dynamic &&
                            !arg.value.startsWith("-") &&
                            /\/|\.[A-Za-z0-9]{1,8}$/.test(arg.value)
                    );
                    place(
                        analysis.hints,
                        pathLike.map((arg) => arg.value)
                    );
                }
            }
        }
    }

    return analysis;
}

/** Whether `path` is one of the named targets, or sits under a named directory. */
export function namedBy(analysis: Pick<CommandAnalysis, "writes" | "dirs">, path: string): boolean {
    return (
        analysis.writes.includes(path) ||
        [...analysis.writes, ...analysis.dirs].some((target) => path === target || path.startsWith(`${target}/`))
    );
}
