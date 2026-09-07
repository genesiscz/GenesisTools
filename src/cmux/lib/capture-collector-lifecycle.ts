import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { parseJSON } from "@genesiscz/utils/json";
import { z } from "zod";

const ownerSchema = z.object({ pid: z.number().int().positive(), ownerToken: z.string().uuid() });

export interface ScreenCollectorStatus {
    enabled: boolean;
    running: boolean;
    ownerMatches: boolean;
    pid?: number;
    runtimeFile?: string;
}

function readOptional(path: string): string | undefined {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined;
        }

        throw error;
    }
}

export function screenCollectorStatus(root: string): ScreenCollectorStatus {
    const marker = join(root, "screens.enabled");
    const token = readOptional(marker)?.trim();
    const enabled = token !== undefined;
    const pidText = readOptional(join(root, "screens.pid.json"));
    if (!pidText) {
        return { enabled, running: false, ownerMatches: false };
    }

    const owner = ownerSchema.safeParse(parseJSON<object>(pidText));
    if (!owner.success) {
        return { enabled, running: false, ownerMatches: false };
    }

    const processInfo = spawnSync("/bin/ps", ["-p", String(owner.data.pid), "-o", "command="], { encoding: "utf8" });
    const running =
        processInfo.status === 0 &&
        processInfo.stdout.includes("capture-watch-") &&
        processInfo.stdout.includes(root) &&
        processInfo.stdout.includes(owner.data.ownerToken);
    const ownerMatches = token === owner.data.ownerToken;
    return {
        enabled,
        running,
        ownerMatches,
        pid: running ? owner.data.pid : undefined,
        runtimeFile: running ? processInfo.stdout.match(/capture-watch-[a-f0-9]{16}\.js/)?.[0] : undefined,
    };
}

export function disableScreenCollector(root: string): boolean {
    const marker = join(root, "screens.enabled");
    if (!existsSync(marker)) {
        return false;
    }

    unlinkSync(marker);
    return true;
}

export async function enableScreenCollector(input: {
    root: string;
    runtimePath: string;
    bunPath: string;
}): Promise<boolean> {
    let current = screenCollectorStatus(input.root);
    for (let attempt = 0; attempt < 3 && current.enabled && current.ownerMatches && !current.running; attempt++) {
        await Bun.sleep(25);
        current = screenCollectorStatus(input.root);
    }
    if (
        current.enabled &&
        current.running &&
        current.ownerMatches &&
        current.runtimeFile === basename(input.runtimePath)
    ) {
        return false;
    }

    mkdirSync(input.root, { recursive: true, mode: 0o700 });
    const marker = join(input.root, "screens.enabled");
    const ownerToken = randomUUID();
    const nextMarker = `${marker}.${ownerToken}.tmp`;
    writeFileSync(nextMarker, ownerToken, { flag: "wx", mode: 0o600 });
    renameSync(nextMarker, marker);
    const logFd = openSync(join(input.root, "screens-process.log"), "a", 0o600);
    let startError: Error | undefined;
    try {
        const child = spawn(
            input.bunPath,
            [input.runtimePath, "--control-dir", input.root, "--owner-token", ownerToken],
            {
                detached: true,
                stdio: ["ignore", logFd, logFd],
                env: {
                    ...env.getProcessEnv(),

                    GENESIS_TOOLS_HOME: dirname(dirname(input.root)),
                },
            }
        );
        child.once("error", (error) => {
            startError = error;
        });
        child.unref();
    } finally {
        closeSync(logFd);
    }

    for (let attempt = 0; attempt < 80; attempt++) {
        if (startError) {
            throw startError;
        }

        const status = screenCollectorStatus(input.root);
        if (status.running && status.ownerMatches) {
            return true;
        }

        await Bun.sleep(25);
    }

    throw new Error(`cmux screen collector did not start; inspect ${join(input.root, "screens-process.log")}`);
}
