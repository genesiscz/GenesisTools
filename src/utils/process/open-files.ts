import { existsSync } from "node:fs";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

export interface OpenFileHandle {
    pid: number;
    command: string;
    path: string;
}

/**
 * `"unknown"` is not "nothing is open". It means the question could not be answered — no `lsof`
 * on the box, or `lsof` complained. A caller deciding whether it is safe to move a file must
 * treat it exactly like a positive hit, never like a clear result.
 */
export type OpenFilesResult = OpenFileHandle[] | "unknown";

export interface OpenFilesQuery {
    /** Exact paths. Paths that do not exist are dropped before the call. */
    files?: string[];
    /** Directories walked recursively (`lsof +D`). Missing directories are dropped. */
    directories?: string[];
}

function lsofBinary(): string | undefined {
    return Bun.which("lsof") ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : undefined);
}

/**
 * Which processes hold the given files or directory trees open.
 *
 * Modelled on the inspection in `scripts/history/retire-native-cache.ts`: `lsof` exits 1 when any
 * search argument matched nothing, which is the normal case here, so the exit code alone cannot
 * separate "found nothing" from "failed". Anything on stderr means the answer is not trustworthy
 * and the result degrades to `"unknown"`.
 */
export function openFiles(query: OpenFilesQuery): OpenFilesResult {
    const binary = lsofBinary();

    if (!binary) {
        logger.debug("lsof is unavailable; open-file inspection is unknown");
        return "unknown";
    }

    const files = (query.files ?? []).filter((path) => existsSync(path));
    const directories = (query.directories ?? []).filter((path) => existsSync(path));

    if (files.length === 0 && directories.length === 0) {
        return [];
    }

    const args = ["-Fpcn"];

    for (const directory of directories) {
        args.push("+D", directory);
    }
    if (files.length > 0) {
        args.push("--", ...files);
    }

    const child = Bun.spawnSync([binary, ...args], {
        env: env.getProcessEnv(),
        stdout: "pipe",
        stderr: "pipe",
    });
    const stderr = child.stderr.toString().trim();

    if ((child.exitCode !== 0 && child.exitCode !== 1) || stderr) {
        logger.warn({ exitCode: child.exitCode, stderr }, "lsof did not answer cleanly; treating as unknown");
        return "unknown";
    }

    const handles: OpenFileHandle[] = [];
    let pid: number | undefined;
    let command = "";

    for (const line of child.stdout.toString().split("\n")) {
        const value = line.slice(1);

        if (line.startsWith("p")) {
            pid = Number(value);
            command = "";
        } else if (line.startsWith("c")) {
            command = value;
        } else if (line.startsWith("n") && pid !== undefined && Number.isSafeInteger(pid)) {
            handles.push({ pid, command, path: value });
        }
    }

    return handles;
}
