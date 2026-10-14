import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GENESIS_APP_NAME, genesisAppDir } from "@genesiscz/utils/macos/genesis-app";
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

const PS_LINE = /^\s*(\d+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

/**
 * The GenesisTools processes in `ps -Ao pid=,lstart=,args=`. Every build keeps the installed path as its program
 * argument, so a moved build is found by its executable's inode (`txtInodesByPid`), never by this text.
 */
export function genesisAppProcesses(psStdout: string, launcherPath: string): AppProcess[] {
    return psStdout.split("\n").flatMap((line): AppProcess[] => {
        const match = PS_LINE.exec(line);

        if (!match || (match[3] !== launcherPath && !match[3].startsWith(`${launcherPath} `))) {
            return [];
        }

        const rest = match[3].slice(launcherPath.length).trim();
        const [program, ...args] = rest.split(" ");
        const command = !program ? "(window)" : program.startsWith("-") ? rest : [basename(program), ...args].join(" ");
        return [{ pid: Number(match[1]), started: new Date(match[2]), command }];
    });
}

/** `lsof -a -d txt -Fpi -n -p <pids>`: a `p<pid>` line, then one `i<inode>` line per mapped file of that process. */
export function txtInodesByPid(lsofStdout: string): Map<number, Set<number>> {
    const byPid = new Map<number, Set<number>>();
    let current: Set<number> | undefined;

    for (const line of lsofStdout.split("\n")) {
        if (line.startsWith("p")) {
            current = new Set();
            byPid.set(Number(line.slice(1)), current);
        } else if (line.startsWith("i") && current) {
            const inode = Number(line.slice(1));

            if (Number.isInteger(inode)) {
                current.add(inode);
            }
        }
    }

    return byPid;
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
        const rest = entry.command.slice(launcherPath.length).trim();
        const [program, ...args] = rest.split(" ");
        const command = !program ? "(window)" : program.startsWith("-") ? rest : [basename(program), ...args].join(" ");
        return [{ pid: entry.pid, started: new Date(entry.startMs), command }];
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
