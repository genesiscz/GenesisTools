import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { VaultEntry } from "@app/dev-dashboard/lib/obsidian/types";

const EXCLUDED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

function assertInsideVault(vaultRoot: string, relativePath: string): string {
    const root = resolve(vaultRoot);
    const full = resolve(root, relativePath);

    if (full !== root && !full.startsWith(`${root}/`)) {
        throw new Error(`Path escapes vault: ${relativePath}`);
    }

    return full;
}

export async function listVault(vaultRoot: string): Promise<VaultEntry[]> {
    async function walk(dir: string): Promise<VaultEntry[]> {
        const items = await readdir(dir, { withFileTypes: true });
        const entries: VaultEntry[] = [];

        for (const item of items) {
            if (item.name.startsWith(".") || EXCLUDED_DIRS.has(item.name)) {
                continue;
            }

            const full = join(dir, item.name);
            const rel = relative(vaultRoot, full);

            if (item.isDirectory()) {
                entries.push({ name: item.name, relativePath: rel, isDirectory: true, children: await walk(full) });
            } else if (item.isFile() && item.name.endsWith(".md")) {
                entries.push({ name: item.name, relativePath: rel, isDirectory: false });
            }
        }

        entries.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) {
                return a.isDirectory ? -1 : 1;
            }

            return a.name.localeCompare(b.name);
        });

        return entries;
    }

    return walk(vaultRoot);
}

export async function readNote(vaultRoot: string, relativePath: string): Promise<string> {
    const full = assertInsideVault(vaultRoot, relativePath);
    const stats = await stat(full);

    if (!stats.isFile()) {
        throw new Error(`Not a file: ${relativePath}`);
    }

    return readFile(full, "utf8");
}
