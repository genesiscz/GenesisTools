import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import {
    batchCommandWithEnvironment,
    batchCwd,
    batchExecutables,
    batchPsInfo,
    type PsRow,
} from "@genesiscz/utils/process/ps";
import type { ClientIdentity, GateClient } from "./types";

/** How many parents to show. Enough to see "pi ← zsh ← cmux", not the whole launchd tree. */
const ANCESTOR_DEPTH = 4;
/** How far up from this process the client pid may sit (shells, the app launcher, bun, the tool). */
const VERIFY_DEPTH = 64;
const COMMAND_DISPLAY_MAX = 200;

/**
 * Binaries that run whatever script they are given: the binary alone says nothing about WHICH
 * program asked, so the script path joins the identity (Pi is `node …/pi/…/cli.js`).
 */
const INTERPRETERS = /^(node|nodejs|bun|deno|python[0-9.]*|ruby|perl|php|sh|bash|zsh|fish)$/;

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

export interface ProcessLookup {
    /** Rows for the asked pids; a pid that is not running is simply absent. */
    psInfo: (pids: number[]) => Map<number, PsRow>;
    cwd: (pids: number[]) => Map<number, string>;
    /** The binary the kernel runs for a pid (lsof `txt`), which argv[0] cannot fake; absent when unreadable. */
    executable: (pids: number[]) => Map<number, string>;
    /** `ps eww`: the command line followed by the process environment as `KEY=value` tokens. */
    environment: (pids: number[]) => Map<number, string>;
}

const systemLookup: ProcessLookup = {
    psInfo: batchPsInfo,
    cwd: batchCwd,
    executable: batchExecutables,
    environment: batchCommandWithEnvironment,
};

/** argv[0] of a `ps ... command=` line: the part before the first space. */
export function executableOf(command: string): string {
    return command.trim().split(/\s+/)[0] ?? "";
}

export function isInterpreter(executable: string): boolean {
    return INTERPRETERS.test(basename(executable));
}

/**
 * The script an interpreter runs: the first argument that is not a flag, made absolute against the
 * process's cwd. Null when there is none or when a relative path cannot be resolved (cwd unknown).
 */
export function scriptOf(command: string, cwd: string | null): string | null {
    const [, ...args] = command.trim().split(/\s+/);
    const script = args.find((arg) => !arg.startsWith("-"));

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
export function codeInjectionSignals(command: string, environmentLine: string | null): string[] {
    const signals: string[] = [];
    const [, ...args] = command.trim().split(/\s+/);

    for (const arg of args) {
        if (!arg.startsWith("-")) {
            break;
        }

        signals.push(`flag ${arg.split("=")[0]}`);
    }

    if (environmentLine) {
        for (const token of environmentLine.split(/\s+/)) {
            const name = token.split("=")[0];

            if (token.includes("=") && CODE_LOADING_ENV.includes(name)) {
                signals.push(`env ${name}`);
            }
        }
    }

    return [...new Set(signals)];
}

/**
 * The grant handle: declared name, the executable's real path and, for an interpreter, the script it
 * runs. A renamed binary, a different binary, or another script under the same interpreter asks again.
 */
export function clientKey(name: string, executable: string | null, script: string | null = null): string {
    return createHash("sha256")
        .update(`${name}\0${executable ?? ""}\0${script ?? ""}`)
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
    const script = interpreter ? scriptOf(self.command, cwd) : null;
    const injected = interpreter ? codeInjectionSignals(self.command, lookup.environment([pid]).get(pid) ?? null) : [];
    const isAncestor = isAncestorPid(pid, lookup, selfPid);
    const identityKnown = realExecutable !== null && (!interpreter || (script !== null && injected.length === 0));
    const verified = isAncestor && identityKnown;

    return {
        name: client.name,
        pid,
        executable,
        script,
        command: truncate(self.command),
        cwd,
        ancestors,
        key: verified ? clientKey(client.name, realExecutable, script) : clientKey(client.name, null),
        isAncestor,
        injected,
        verified,
    };
}
