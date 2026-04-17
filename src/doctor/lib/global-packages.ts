import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { snapshotFilePath } from "./paths";

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

export interface Snapshot {
    manager: PackageManager;
    packages: string[];
    capturedAt: string;
}

interface NpmDependencyInfo {
    version?: string;
}

interface NpmListObject {
    dependencies?: Record<string, NpmDependencyInfo>;
}

interface YarnLine {
    type?: string;
    data?: string;
}

export function listGlobalPackages(manager: PackageManager): string[] {
    if (manager === "bun") {
        const res = spawnSync("bun", ["pm", "ls", "-g"], { encoding: "utf8" });
        return parseBunList(res.stdout ?? "");
    }

    if (manager === "npm") {
        const res = spawnSync("npm", ["ls", "-g", "--depth=0", "--json"], { encoding: "utf8" });
        return parseNpmJson(res.stdout ?? "");
    }

    if (manager === "pnpm") {
        const res = spawnSync("pnpm", ["ls", "-g", "--depth=0", "--json"], { encoding: "utf8" });
        return parseNpmJson(res.stdout ?? "");
    }

    const res = spawnSync("yarn", ["global", "list", "--json"], { encoding: "utf8" });
    return parseYarnJson(res.stdout ?? "");
}

export function parseBunList(raw: string): string[] {
    const pkgs: string[] = [];

    for (const line of raw.split("\n")) {
        const match = line.match(/^\s*[├└]── (\S+)/);
        if (match) {
            pkgs.push(match[1]);
        }
    }

    return pkgs;
}

export function parseNpmJson(raw: string): string[] {
    try {
        const parsed = SafeJSON.parse(raw) as NpmListObject | NpmListObject[];
        const root = Array.isArray(parsed) ? parsed[0] : parsed;
        const deps = root?.dependencies ?? {};

        return Object.entries(deps).map(([name, info]) => `${name}@${info.version ?? "latest"}`);
    } catch {
        return [];
    }
}

export function parseYarnJson(raw: string): string[] {
    const pkgs: string[] = [];

    for (const line of raw.split("\n")) {
        try {
            const parsed = SafeJSON.parse(line) as YarnLine;

            if (parsed.type === "info" && parsed.data?.startsWith('"')) {
                const nameMatch = parsed.data.match(/^"([^"]+)"/);
                if (nameMatch) {
                    pkgs.push(nameMatch[1]);
                }
            }
        } catch {}
    }

    return pkgs;
}

export async function writeSnapshot(runId: string, snapshot: Snapshot): Promise<void> {
    const path = snapshotFilePath(runId, snapshot.manager);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, SafeJSON.stringify(snapshot, null, 2), "utf8");
}

export async function readSnapshot(runId: string, manager: PackageManager): Promise<Snapshot | null> {
    try {
        const raw = await readFile(snapshotFilePath(runId, manager), "utf8");
        return SafeJSON.parse(raw) as Snapshot;
    } catch {
        return null;
    }
}

export function reinstallCommand(manager: PackageManager, packages: string[]): { cmd: string; args: string[] } {
    if (manager === "bun") {
        return { cmd: "bun", args: ["add", "-g", ...packages] };
    }

    if (manager === "npm") {
        return { cmd: "npm", args: ["install", "-g", ...packages] };
    }

    if (manager === "pnpm") {
        return { cmd: "pnpm", args: ["add", "-g", ...packages] };
    }

    return { cmd: "yarn", args: ["global", "add", ...packages] };
}
