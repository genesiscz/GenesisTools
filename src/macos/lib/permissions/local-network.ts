import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { isGenesisToolsBinary } from "@genesiscz/utils/genesis-tools/app-binary";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GENESIS_APP_NAME, genesisAppDir } from "@genesiscz/utils/macos/genesis-app";
import { readProcessCwd } from "@genesiscz/utils/process/cwd";
import { executableInode } from "@genesiscz/utils/process/process-files";
import { listProcesses } from "@genesiscz/utils/process/processes";
import { retiredRootFor } from "./app";

/**
 * Local Network privacy for GenesisTools.app. macOS asks the first time a process reaches a device on the local
 * network, and every process `tools` starts runs under the app, so the prompt names GenesisTools. The answers live in
 * nehelper's rule store, which the app reads (`GenesisTools --local-network-rules`, GenesisKit LocalNetworkPrivacy).
 *
 * An executable outside the installed bundle gets an answer of its own, keyed by its path. A rebuild moves the running
 * bundle to `retired.noindex/<ms>/`, so a process still running that old build asks once more on its first LAN access
 * (2026-10-12 22:00: intelephense in a Claude session whose launcher ran the 17:55 build).
 */

/** One answer macOS keeps for GenesisTools. */
export interface LocalNetworkRule {
    /** The executable the answer is for; absent for the installed app's own answer. */
    path?: string;
    allowed: boolean;
}

export interface LocalNetworkRules {
    /** false: the app could not read the rule store, so no answer below is known */
    readable: boolean;
    rules: LocalNetworkRule[];
}

/** `asks`: macOS asks on the next LAN access. `unknown`: the rule store was not read. */
export type LocalNetworkAnswer = "allowed" | "denied" | "asks" | "unknown";

export function parseLocalNetworkRules(stdout: string): LocalNetworkRules | null {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(stdout.trim(), { strict: true });
    } catch (error) {
        logger.debug({ error, stdout: stdout.slice(0, 200) }, "local network: rules output is not JSON");
        return null;
    }

    if (typeof parsed !== "object" || parsed === null || !("readable" in parsed) || !("rules" in parsed)) {
        return null;
    }

    const { readable, rules } = parsed;

    if (typeof readable !== "boolean" || !Array.isArray(rules)) {
        return null;
    }

    return {
        readable,
        rules: rules.flatMap((rule: unknown): LocalNetworkRule[] => {
            if (
                typeof rule !== "object" ||
                rule === null ||
                !("allowed" in rule) ||
                typeof rule.allowed !== "boolean"
            ) {
                return [];
            }

            const path = "path" in rule && typeof rule.path === "string" ? rule.path : undefined;
            return [{ path, allowed: rule.allowed }];
        }),
    };
}

/** What macOS answered for `path` (absent: the installed app). */
export function localNetworkAnswer(rules: LocalNetworkRules | null, path?: string): LocalNetworkAnswer {
    if (!rules?.readable) {
        return "unknown";
    }

    const matching = rules.rules.filter((rule) => rule.path === path);

    if (matching.length === 0) {
        return "asks";
    }

    return matching.some((rule) => rule.allowed) ? "allowed" : "denied";
}

/** The answers, from the installed app's `--local-network-rules` face; null when it does not answer. */
export function readLocalNetworkRules(launcherPath: string): LocalNetworkRules | null {
    const proc = Bun.spawnSync([launcherPath, "--local-network-rules"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
    });
    const stdout = new TextDecoder().decode(proc.stdout);

    if (proc.exitCode !== 0) {
        logger.debug(
            { launcherPath, exitCode: proc.exitCode, stderr: new TextDecoder().decode(proc.stderr).slice(0, 300) },
            "local network: rules face failed"
        );
        return null;
    }

    return parseLocalNetworkRules(stdout);
}

export interface AppProcess {
    pid: number;
    started: Date;
    /** what the process runs: the face flags, or the program the launcher started */
    command: string;
}

export interface OldBuild {
    /** the retired bundle, `retired.noindex/<ms>/GenesisTools.app` */
    bundle: string;
    /** when a rebuild moved it aside */
    retiredAt: Date;
    processes: AppProcess[];
    localNetwork: LocalNetworkAnswer;
}

export interface RetiredBinary {
    bundle: string;
    binary: string;
    retiredAt: Date;
    inode: number;
}

/** The retired bundles whose binary a GenesisTools process still executes, oldest retirement first. */
export function groupOldBuilds({
    processes,
    inodesByPid,
    retired,
    rules,
}: {
    processes: AppProcess[];
    inodesByPid: Map<number, Set<number>>;
    retired: RetiredBinary[];
    rules: LocalNetworkRules | null;
}): OldBuild[] {
    return retired
        .map((copy) => ({
            bundle: copy.bundle,
            retiredAt: copy.retiredAt,
            processes: processes
                .filter((appProcess) => inodesByPid.get(appProcess.pid)?.has(copy.inode))
                .sort((a, b) => a.started.getTime() - b.started.getTime()),
            localNetwork: localNetworkAnswer(rules, copy.binary),
        }))
        .filter((build) => build.processes.length > 0)
        .sort((a, b) => a.retiredAt.getTime() - b.retiredAt.getTime());
}

function retiredBinaries(): RetiredBinary[] {
    const root = retiredRootFor(genesisAppDir());

    if (!existsSync(root)) {
        return [];
    }

    return readdirSync(root).flatMap((entry): RetiredBinary[] => {
        const bundle = join(root, entry, `${GENESIS_APP_NAME}.app`);
        const binary = join(bundle, "Contents", "MacOS", GENESIS_APP_NAME);

        if (!Number.isFinite(Number(entry)) || !existsSync(binary)) {
            return [];
        }

        return [{ bundle, binary, retiredAt: new Date(Number(entry)), inode: statSync(binary).ino }];
    });
}

/** What a launcher command line runs: the face flags, or the program with its arguments. */
function launcherProgram(launcherPath: string, command: string): string {
    const rest = command.slice(launcherPath.length).trim();
    const [program, ...args] = rest.split(" ");
    return !program ? "(window)" : program.startsWith("-") ? rest : [basename(program), ...args].join(" ");
}

/** One Local Network prompt macOS raised for GenesisTools, from nehelper's log. */
export interface LocalNetworkPrompt {
    /** local time as the log prints it, `2026-10-21 22:16:06` */
    at: string;
    /** the responsible process: the launcher whose tree reached the network */
    pid: number;
    /** the GenesisTools binary it runs; a path under `retired.noindex/` is an old build */
    executable: string;
}

const PROMPT_LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\.\d+ .*Found new path (.+) for PID (\d+), allowing a new prompt/;

/**
 * The dialog itself cannot name the program: its text is the fixed `NSLocalNetworkUsageDescription`. nehelper logs
 * the responsible pid and its executable one line before it prompts (2026-10-21 22:16:06: pid 97417, a Claude session
 * launcher on the build a rebuild had retired twelve minutes before).
 */
export function parseLocalNetworkPrompts(logText: string): LocalNetworkPrompt[] {
    return logText.split("\n").flatMap((line): LocalNetworkPrompt[] => {
        const match = PROMPT_LINE.exec(line);
        return match && isGenesisToolsBinary(match[2])
            ? [{ at: match[1], pid: Number(match[3]), executable: match[2] }]
            : [];
    });
}

/** Prompts in the last `since` (a `log show --last` value: `30m`, `2h`, `1d`); null when `log show` fails (logged). */
export function readLocalNetworkPrompts(since: string): LocalNetworkPrompt[] | null {
    const proc = Bun.spawnSync(
        [
            "/usr/bin/log",
            "show",
            "--last",
            since,
            "--style",
            "compact",
            "--info",
            "--predicate",
            'process == "nehelper" AND eventMessage CONTAINS "allowing a new prompt"',
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 120_000 }
    );
    return promptsFromLogShow({ since, exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr });
}

/**
 * The prompts in a `log show` run's output. A failed run (a bad `--since`, the timeout) is null, never an empty list:
 * "no prompt" is an answer the caller prints, and a failure is not one.
 */
export function promptsFromLogShow({
    since,
    exitCode,
    stdout,
    stderr,
}: {
    since: string;
    exitCode: number | null;
    stdout: Uint8Array;
    stderr: Uint8Array;
}): LocalNetworkPrompt[] | null {
    if (exitCode !== 0) {
        logger.warn(
            { since, exitCode, stderr: new TextDecoder().decode(stderr).slice(0, 300) },
            "local network: log show failed"
        );
        return null;
    }

    return parseLocalNetworkPrompts(new TextDecoder().decode(stdout));
}

/** What the prompting process was, while it still runs. */
export interface PromptProcess {
    started: Date;
    /** the program the launcher runs (`gt-cc …` is a Claude session) */
    command: string;
    cwd: string | null;
    children: string[];
}

/** Every `tools` program carries the same `--preload <file>` pairs, which hide what it runs. */
export function withoutPreloads(command: string): string {
    return command.replace(/ --preload \S+/g, "");
}

/** The live process behind each prompt pid; a pid that has exited is absent. */
export function describePromptProcesses(launcherPath: string, pids: number[]): Map<number, PromptProcess> {
    if (pids.length === 0) {
        return new Map();
    }

    const wanted = new Set(pids);
    const entries = listProcesses();
    const described = new Map<number, PromptProcess>();
    for (const entry of entries) {
        if (!wanted.has(entry.pid) || entry.startMs === null || !entry.command) {
            continue;
        }

        const command = withoutPreloads(
            entry.command.startsWith(launcherPath) ? launcherProgram(launcherPath, entry.command) : entry.command
        );
        const children = entries
            .filter((child) => child.ppid === entry.pid && child.command)
            .map((child) => withoutPreloads(child.command ?? child.name));
        described.set(entry.pid, {
            started: new Date(entry.startMs),
            command,
            cwd: readProcessCwd(entry.pid),
            children,
        });
    }

    return described;
}

/**
 * The live process behind `prompt`, or null when its pid now belongs to a process that started after the prompt (the
 * prompting one exited and the pid was reused). The log time drops its fraction, so the prompt fell inside
 * `[at, at + 1 s)`, and a process that asked started before `at + 1 s`.
 */
export function promptProcess(
    prompt: Pick<LocalNetworkPrompt, "at" | "pid">,
    live: Map<number, PromptProcess>
): PromptProcess | null {
    const process = live.get(prompt.pid);
    const promptMs = new Date(prompt.at.replace(" ", "T")).getTime();

    if (!process || (Number.isFinite(promptMs) && process.started.getTime() >= promptMs + 1000)) {
        return null;
    }

    return process;
}

/**
 * Old builds a running process still executes: one `ps`, then one `lsof` over the GenesisTools processes only.
 * Empty when nothing runs an old build, or when either listing fails (logged).
 */
export function oldBuildsInUse(launcherPath: string, rules: LocalNetworkRules | null): OldBuild[] {
    const retired = retiredBinaries();

    if (retired.length === 0) {
        return [];
    }

    const processes = listProcesses().flatMap((entry): AppProcess[] => {
        if (
            entry.startMs === null ||
            !entry.command ||
            (entry.command !== launcherPath && !entry.command.startsWith(`${launcherPath} `))
        ) {
            return [];
        }
        return [
            { pid: entry.pid, started: new Date(entry.startMs), command: launcherProgram(launcherPath, entry.command) },
        ];
    });
    const inodesByPid = new Map<number, Set<number>>();
    for (const entry of processes) {
        const inode = executableInode(entry.pid);
        if (inode !== null) {
            inodesByPid.set(entry.pid, new Set([inode]));
        }
    }
    return groupOldBuilds({ processes, inodesByPid, retired, rules });
}
