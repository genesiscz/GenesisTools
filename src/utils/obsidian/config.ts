import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { resolveActiveVault } from "./discovery";

export interface ObsidianConfig {
    vaultRoot: string | null;
}

export function obsidianConfigPath(): string {
    return join(homedir(), ".genesis-tools", "obsidian", "config.json");
}

/** Resolution order: unified config → obsidian.json discovery → null. */
export function resolveVaultRoot(path = obsidianConfigPath()): string | null {
    if (existsSync(path)) {
        try {
            const c = SafeJSON.parse(readFileSync(path, "utf8")) as ObsidianConfig;
            if (c.vaultRoot && existsSync(c.vaultRoot)) {
                return c.vaultRoot;
            }
        } catch {
            /* fall through to discovery */
        }
    }

    return resolveActiveVault();
}

export function setVaultRoot(vaultRoot: string, path = obsidianConfigPath()): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SafeJSON.stringify({ vaultRoot }, null, 2));
}
