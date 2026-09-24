import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import {
    batchCommandWithEnvironment,
    batchCwd,
    batchExecutables,
    batchPsInfo,
    type PsRow,
} from "@genesiscz/utils/process/ps";
import type { ClientIdentity, GateClient } from "./types";

const { log } = logger.scoped("ai-gate");

/** How many parents to show. Enough to see "pi ← zsh ← cmux", not the whole launchd tree. */
const ANCESTOR_DEPTH = 4;
/** How far up from this process the client pid may sit (shells, the app launcher, bun, the tool). */
const VERIFY_DEPTH = 64;
const COMMAND_DISPLAY_MAX = 200;

/**
 * Binaries that run whatever script they are given: the binary alone says nothing about WHICH
 * program asked, so the script path joins the identity (Pi is `node …/pi/…/cli.js`). Matched on the
 * basename without case: macOS framework Python runs as `…/Python.app/Contents/MacOS/Python`, and a
 * miss here would key every script of that interpreter on the binary alone.
 */
const INTERPRETERS =
    /^(node|nodejs|bun|deno|python[0-9.]*|pypy[0-9.]*|ruby[0-9.]*|perl[0-9.]*|php[0-9.]*|lua[0-9.]*|luajit|tclsh[0-9.]*|wish|osascript|java|pwsh|sh|bash|zsh|fish|dash|ksh|mksh|tcsh|csh)$/i;

/** Runners that take a subcommand before the script: `bun run pi.ts`, `deno run -A pi.ts`. */
const SUBCOMMAND_RUNNERS = /^(bun|deno)$/i;

/**
 * bun and deno subcommands whose next word is NOT a script file (a package, tests, inline code, a
 * task name). Without this `bun x anything` and `bun test` would all share the script `<cwd>/x`.
 */
const NON_SCRIPT_SUBCOMMANDS = new Set([
    "a",
    "add",
    "audit",
    "bench",
    "build",
    "c",
    "check",
    "compile",
    "create",
    "doc",
    "eval",
    "exec",
    "fmt",
    "i",
    "info",
    "init",
    "install",
    "link",
    "lint",
    "outdated",
    "patch",
    "pm",
    "publish",
    "remove",
    "repl",
    "rm",
    "task",
    "test",
    "uninstall",
    "unlink",
    "update",
    "upgrade",
    "why",
    "x",
]);

/**
 * Environment variables that make an interpreter or the loader run code the command line does
 * not show (`NODE_OPTIONS=--require=…`, `PYTHONSTARTUP`, `LD_PRELOAD`, …). A process carrying
 * one may be running Pi's script plus something else, so it is never remembered.
 */
const CODE_LOADING_ENV = [
    "NODE_OPTIONS",
    "NODE_PATH",
    "BUN_OPTIONS",
    "BUN_INSPECT_PRELOAD",
    "DENO_AUTH_TOKENS",
    "PYTHONSTARTUP",
    "PYTHONPATH",
    "PYTHONHOME",
    "RUBYOPT",
    "RUBYLIB",
    "PERL5OPT",
    "PERL5LIB",
    "PERLLIB",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "BASH_ENV",
    "ZDOTDIR",
    "ENV",
];

/** The subset the dynamic loader itself honours, so it can inject code into ANY binary. */
const LOADER_ENV = [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
];

export interface ProcessLookup {
    /** Rows for the asked pids; a pid that is not running is simply absent. */
    psInfo: (pids: number[]) => Map<number, PsRow>;
    cwd: (pids: number[]) => Map<number, string>;
    /** The binary the kernel runs for a pid (lsof `txt`), which argv[0] cannot fake; absent when unreadable. */
    executable: (pids: number[]) => Map<number, string>;
    /** `ps eww`: the command line followed by the process environment as `KEY=value` tokens. */
    environment: (pids: number[]) => Map<number, string>;
    /** A stamp per readable file (see `fileStamps`); a path that cannot be stat'ed is absent. */
    fileStamps: (paths: string[]) => Map<string, string>;
}

/**
 * `inode:ctime:size` per file. A binary or script swapped in by rename gets a new inode, and one
 * rewritten in place moves its ctime, which an unprivileged process cannot set back (unlike mtime).
 * So a remembered grant stops matching the moment the approved file is replaced.
 */
export function fileStamps(paths: string[]): Map<string, string> {
    const stamps = new Map<string, string>();

    for (const path of paths) {
        try {
            const stat = statSync(path);
            stamps.set(path, `${stat.ino}:${stat.ctimeMs}:${stat.size}`);
        } catch (error) {
            log.debug({ path, error }, "gate: cannot stamp client file; the client stays unverified");
        }
    }

    return stamps;
}

const systemLookup: ProcessLookup = {
    psInfo: batchPsInfo,
    cwd: batchCwd,
    executable: batchExecutables,
    environment: batchCommandWithEnvironment,
    fileStamps,
};

/** argv[0] of a `ps ... command=` line: the part before the first space. */
export function executableOf(command: string): string {
    return command.trim().split(/\s+/)[0] ?? "";
}

export function isInterpreter(executable: string): boolean {
    return INTERPRETERS.test(basename(executable));
}

/**
 * The arguments that lead up to and name the script: everything after argv[0], minus bun's or deno's
 * `run` (flags on either side of it are kept). Null for a bun/deno subcommand that runs no script
 * file. `executable` decides whether the runner rules apply; the caller passes the kernel's path,
 * because argv[0] is whatever the process chose to call itself.
 */
function scriptArgs(command: string, executable: string): string[] | null {
    const [, ...args] = command.trim().split(/\s+/);

    if (!SUBCOMMAND_RUNNERS.test(basename(executable))) {
        return args;
    }

    const index = args.findIndex((arg) => !arg.startsWith("-"));
    const word = index === -1 ? undefined : args[index];

    if (word === "run") {
        return [...args.slice(0, index), ...args.slice(index + 1)];
    }

    return word !== undefined && NON_SCRIPT_SUBCOMMANDS.has(word) ? null : args;
}

/**
 * The script an interpreter runs: the first argument that is not a flag (after bun's or deno's
 * `run`), made absolute against the process's cwd. Null when there is none, when the runner's
 * subcommand runs no script file, or when a relative path cannot be resolved (cwd unknown).
 */
export function scriptOf(
    command: string,
    cwd: string | null,
    executable: string = executableOf(command)
): string | null {
    const script = scriptArgs(command, executable)?.find((arg) => !arg.startsWith("-"));

    if (!script) {
        return null;
    }

    if (isAbsolute(script)) {
        return script;
    }

    return cwd ? resolve(cwd, script) : null;
}

/**
 * Ways the process could be running code its script path does not name: interpreter flags before
 * the script (`--require=…`, `-r x`, `--eval=…`, `--import=…`, `--preload …`, `-c …`: any flag,
 * because the set that loads code differs per interpreter and version) and code-loading
 * environment variables. Empty means the script path is the whole program.
 */
export function codeInjectionSignals(
    command: string,
    environmentLine: string | null,
    executable: string = executableOf(command)
): string[] {
    const signals: string[] = [];

    for (const arg of scriptArgs(command, executable) ?? []) {
        if (!arg.startsWith("-")) {
            break;
        }

        signals.push(`flag ${arg.split("=")[0]}`);
    }

    signals.push(...environmentSignals(environmentLine, CODE_LOADING_ENV));

    return [...new Set(signals)];
}

/**
 * `env <NAME>` for every variable of `names` set in a `ps eww` line. A native client is checked
 * against `LOADER_ENV` only: the dynamic loader honours those for any binary without hardened
 * runtime, while `NODE_OPTIONS` or `PYTHONPATH` in a compiled program's environment load nothing.
 */
export function environmentSignals(environmentLine: string | null, names: readonly string[] = LOADER_ENV): string[] {
    const signals: string[] = [];

    for (const token of environmentLine?.split(/\s+/) ?? []) {
        const name = token.split("=")[0];

        if (token.includes("=") && names.includes(name)) {
            signals.push(`env ${name}`);
        }
    }

    return [...new Set(signals)];
}

/**
 * The grant handle: declared name, the executable's real path and, for an interpreter, the script it
 * runs, plus the stamps of those files. A renamed binary, a different binary, another script under
 * the same interpreter, or the same path with its file replaced asks again.
 */
export function clientKey(
    name: string,
    executable: string | null,
    script: string | null = null,
    fingerprint: string | null = null
): string {
    return createHash("sha256")
        .update(`${name}\0${executable ?? ""}\0${script ?? ""}\0${fingerprint ?? ""}`)
        .digest("hex")
        .slice(0, 24);
}

/**
 * Is `pid` an ancestor of `selfPid`? The gate door is spawned by the client (`tools ai gate request`
 * from Pi), so the real client is always above it in the process tree; a bystander that names
 * another app's pid is not. launchd (pid 1) and the kernel are never accepted: everything descends
 * from them, so they would verify any caller.
 */
export function isAncestorPid(pid: number, lookup: ProcessLookup, selfPid: number): boolean {
    if (pid <= 1 || pid === selfPid) {
        return false;
    }

    let current = selfPid;

    for (let depth = 0; depth < VERIFY_DEPTH; depth++) {
        const row = lookup.psInfo([current]).get(current);

        if (!row || row.ppid <= 1) {
            return false;
        }

        if (row.ppid === pid) {
            return true;
        }

        current = row.ppid;
    }

    return false;
}

function truncate(value: string): string {
    return value.length > COMMAND_DISPLAY_MAX ? `${value.slice(0, COMMAND_DISPLAY_MAX)}…` : value;
}

function unidentified(client: GateClient, pid: number | null): ClientIdentity {
    return {
        name: client.name,
        pid,
        executable: null,
        script: null,
        command: null,
        cwd: null,
        ancestors: [],
        key: clientKey(client.name, null),
        isAncestor: false,
        injected: [],
        verified: false,
    };
}

/**
 * What the gate can say about the asking process, for the approval window.
 *
 * The declared name is the client's claim; pid, executable, cwd and the parent chain are what
 * `ps` and `lsof` report, so a window always shows both. A pid that is not running yields nulls
 * rather than an error: the window then says so.
 *
 * `isAncestor`: the pid is running and sits above this process (`selfPid`) in the process tree, so
 * it really spawned the gate door. A running pid that is NOT an ancestor is a bystander's claim.
 *
 * `verified`: `isAncestor`, plus an identity strong enough to remember. That needs the binary the
 * kernel runs (lsof, never argv[0], which a caller can set to anything) and, for an interpreter, the
 * script path (otherwise every node program would share Pi's grant) with no flag before it and no
 * code-loading environment (`node --require=evil.js cli.js` runs Pi's script and more). Without
 * that the identity is still shown, still an ancestor, and may be approved once, but never
 * remembered.
 *
 * Limit: the script path comes from `ps`, which reads the process's own argument memory, and a
 * process running as this user can rewrite that. The key's file stamps catch a replaced executable
 * or script, but not an edited dependency (a module the script imports). So the key tells programs
 * apart for the approval window and the grant file; it is not a defence against code already
 * running as the user. The Touch ID approval and the grant's expiry are that boundary.
 */
export function describeClient(
    client: GateClient,
    lookup: ProcessLookup = systemLookup,
    selfPid: number = process.pid
): ClientIdentity {
    const pid = client.pid ?? null;

    if (pid === null) {
        return unidentified(client, null);
    }

    const self = lookup.psInfo([pid]).get(pid);

    if (!self) {
        return unidentified(client, pid);
    }

    const ancestors: ClientIdentity["ancestors"] = [];
    let parent = self.ppid;

    for (let depth = 0; depth < ANCESTOR_DEPTH && parent > 1; depth++) {
        const row = lookup.psInfo([parent]).get(parent);

        if (!row) {
            break;
        }

        ancestors.push({ pid: row.pid, command: truncate(row.command) });
        parent = row.ppid;
    }

    const cwd = lookup.cwd([pid]).get(pid) ?? null;
    const realExecutable = lookup.executable([pid]).get(pid) ?? null;
    const executable = realExecutable ?? executableOf(self.command);
    const interpreter = realExecutable !== null && isInterpreter(realExecutable);
    const script = interpreter ? scriptOf(self.command, cwd, realExecutable) : null;
    const environmentLine = realExecutable !== null ? (lookup.environment([pid]).get(pid) ?? null) : null;
    // Interpreters: any flag before the script plus every code-loading variable. Native binaries:
    // the loader variables, which inject a library into a compiled client just as well.
    const injected = interpreter
        ? codeInjectionSignals(self.command, environmentLine, realExecutable)
        : environmentSignals(environmentLine);
    const isAncestor = isAncestorPid(pid, lookup, selfPid);
    // The files that make up the program; the key carries their stamps, so replacing one in place
    // (same path, new content) asks again instead of inheriting the old approval.
    const identifyingFiles = [realExecutable, script].filter((path): path is string => path !== null);
    const stamps = lookup.fileStamps(identifyingFiles);
    const fingerprint = identifyingFiles.every((path) => stamps.has(path))
        ? identifyingFiles.map((path) => stamps.get(path)).join("\0")
        : null;
    // No environment row (ps could not read it) means the injection check never ran, and an
    // unchecked environment is not a clean one: fail closed, allow once at most. The same goes for
    // a file that cannot be stamped.
    const identityKnown =
        realExecutable !== null &&
        environmentLine !== null &&
        fingerprint !== null &&
        injected.length === 0 &&
        (!interpreter || script !== null);
    const verified = isAncestor && identityKnown;

    return {
        name: client.name,
        pid,
        executable,
        script,
        command: truncate(self.command),
        cwd,
        ancestors,
        key: verified ? clientKey(client.name, realExecutable, script, fingerprint) : clientKey(client.name, null),
        isAncestor,
        injected,
        verified,
    };
}
