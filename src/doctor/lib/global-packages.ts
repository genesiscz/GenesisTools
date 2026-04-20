import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { snapshotFilePath } from "./paths";
import { run } from "./run";

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

export async function listGlobalPackages(manager: PackageManager): Promise<string[]> {
    if (manager === "bun") {
        const res = await run("bun", ["pm", "ls", "-g"]);
        return parseBunList(res.stdout ?? "");
    }

    if (manager === "npm") {
        const res = await run("npm", ["ls", "-g", "--depth=0", "--json"]);
        return parseNpmJson(res.stdout ?? "");
    }

    if (manager === "pnpm") {
        const res = await run("pnpm", ["ls", "-g", "--depth=0", "--json"]);
        return parseNpmJson(res.stdout ?? "");
    }

    const res = await run("yarn", ["global", "list", "--json"]);
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
        const parsed = SafeJSON.parse(raw, { strict: true }) as NpmListObject | NpmListObject[];
        const root = Array.isArray(parsed) ? parsed[0] : parsed;
        const deps = root?.dependencies ?? {};

        return Object.entries(deps)
            .filter(
                (entry): entry is [string, NpmDependencyInfo & { version: string }] =>
                    typeof entry[1].version === "string" && entry[1].version.length > 0
            )
            .map(([name, info]) => `${name}@${info.version}`);
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
