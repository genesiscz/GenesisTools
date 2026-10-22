#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { out } from "@genesiscz/utils/logger";

const root = resolve(moduleDir(import.meta), "../../..");

const cacheDirs = [
    resolve(root, "node_modules/.vite"),
    resolve(root, "src/clarity/ui/node_modules/.vite"),
    resolve(root, "src/Internal/commands/reas/ui/node_modules/.vite"),
];

let cleared = 0;

for (const dir of cacheDirs) {
    if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        out.println(`Cleared: ${dir}`);
        cleared++;
    }
}

if (cleared === 0) {
    out.println("No .vite cache dirs found — already clean.");
} else {
    out.println(`Done. Cleared ${cleared} cache dir(s). Restart your dev server.`);
}
