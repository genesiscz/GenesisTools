/**
 * Where the full GenesisTools checkout is, for plugin code that needs more than the plugin copy:
 * the Claude and Codex caches hold `plugins/genesis-tools` only, so `node_modules` (the TypeScript
 * compiler, for one) lives elsewhere. Grok loads the plugin from the checkout itself.
 *
 * Tried in order, first valid wins:
 *   1. `GENESIS_TOOLS_PATH` / `GENESIS_TOOLS_ROOT` (install.sh exports the first; shells only)
 *   2. `~/.genesis-tools/install.json`, which every `tools` run keeps current
 *      (`src/utils/install-record.ts` writes it; keep the shapes in step)
 *   3. this file's own folders, when the plugin runs from inside the checkout
 *   4. `~/.claude/plugins/known_marketplaces.json`, for a directory marketplace
 *   5. `tools` on PATH
 * Valid means `package.json` names `@genesiscz/tools` and `node_modules/typescript` exists.
 *
 * Standalone by design: imports nothing outside node builtins, Bun and this plugin.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { toolsHome } from "./plugin-config.ts";

export type LocatedVia = "env" | "install-record" | "plugin-folder" | "marketplace" | "path";

export interface GenesisToolsInstall {
    root: string;
    via: LocatedVia;
}

const PACKAGE_NAME = "@genesiscz/tools";

/** A missing or malformed file reads as undefined: absence is the answer, not an error. */
const readJson = (file: string): unknown => {
    if (!existsSync(file)) {
        return undefined;
    }

    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        // A file that does not parse names no checkout; the next candidate is tried.
        return undefined;
    }
};

const field = (value: unknown, key: string): unknown =>
    value !== null && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;

export const isGenesisToolsInstall = (root: string): boolean =>
    field(readJson(join(root, "package.json")), "name") === PACKAGE_NAME &&
    existsSync(join(root, "node_modules", "typescript", "package.json"));

function* candidates(): Generator<{ root: string; via: LocatedVia }> {
    for (const name of ["GENESIS_TOOLS_PATH", "GENESIS_TOOLS_ROOT"]) {
        // lint-rules-ignore: standalone plugin script without access to @genesiscz/utils/env
        const value = process.env[name]?.trim();
        if (value) {
            yield { root: resolve(value), via: "env" };
        }
    }

    const recorded = field(readJson(join(toolsHome(), ".genesis-tools", "install.json")), "checkout");
    if (typeof recorded === "string") {
        yield { root: recorded, via: "install-record" };
    }

    let dir = import.meta.dir;
    for (let depth = 0; depth < 8; depth++) {
        yield { root: dir, via: "plugin-folder" };
        const parent = dirname(dir);
        if (parent === dir) {
            break;
        }

        dir = parent;
    }

    const marketplaces = readJson(join(homedir(), ".claude", "plugins", "known_marketplaces.json"));
    if (marketplaces !== null && typeof marketplaces === "object") {
        for (const entry of Object.values(marketplaces as Record<string, unknown>)) {
            for (const path of [field(field(entry, "source"), "path"), field(entry, "installLocation")]) {
                if (typeof path === "string") {
                    yield { root: path, via: "marketplace" };
                }
            }
        }
    }

    const onPath = Bun.which("tools");
    if (onPath !== null) {
        let real: string | undefined;
        try {
            real = realpathSync(onPath);
        } catch {
            // A dangling `tools` link names no checkout.
        }

        if (real !== undefined) {
            yield { root: dirname(real), via: "path" };
        }
    }
}

/** The first valid candidate, searched afresh. */
export const findGenesisTools = (): GenesisToolsInstall | null => {
    for (const candidate of candidates()) {
        if (isGenesisToolsInstall(candidate.root)) {
            return candidate;
        }
    }

    return null;
};

let located: GenesisToolsInstall | null | undefined;

/** The checkout, or null when none of the five places names a valid one. Cached per process. */
export const locateGenesisTools = (): GenesisToolsInstall | null => {
    if (located === undefined) {
        located = findGenesisTools();
    }

    return located;
};

/** The checkout's own `typescript` module. */
export const requireTypeScript = (install: GenesisToolsInstall): unknown =>
    createRequire(join(install.root, "package.json"))("typescript");
