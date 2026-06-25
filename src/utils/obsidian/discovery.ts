import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { env as appEnv } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";

const log = logger.child({ component: "obsidian:discovery" });

export interface ObsidianVault {
    id: string;
    path: string;
    ts: number;
    open: boolean;
}

/** obsidian.json candidate paths, research-confirmed. OBSIDIAN_CONFIG_DIR wins. */
export function configCandidates(env: NodeJS.ProcessEnv): string[] {
    const home = env.HOME ?? homedir();
    const out: string[] = [];
    if (env.OBSIDIAN_CONFIG_DIR) {
        out.push(join(env.OBSIDIAN_CONFIG_DIR, "obsidian.json"));
    }

    if (process.platform === "darwin") {
        out.push(join(home, "Library/Application Support/obsidian/obsidian.json"));
    } else if (process.platform === "win32") {
        out.push(join(env.APPDATA ?? join(home, "AppData/Roaming"), "obsidian/obsidian.json"));
    } else {
        const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
        out.push(join(xdg, "obsidian/obsidian.json"));
        out.push(join(home, ".var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json"));
        out.push(join(home, "snap/obsidian/current/.config/obsidian/obsidian.json"));
    }

    return out;
}

export function discoverVaults(env: NodeJS.ProcessEnv = appEnv.getProcessEnv()): ObsidianVault[] {
    for (const candidate of configCandidates(env)) {
        if (!existsSync(candidate)) {
            continue;
        }

        try {
            const parsed = SafeJSON.parse(readFileSync(candidate, "utf8")) as {
                vaults?: Record<string, { path: string; ts?: number; open?: boolean }>;
            };
            const vaults = Object.entries(parsed.vaults ?? {})
                .map(([id, v]) => ({ id, path: v.path, ts: v.ts ?? 0, open: v.open === true }))
                .filter((v) => v.path && existsSync(v.path));
            if (vaults.length > 0) {
                return vaults;
            }
        } catch (err) {
            log.warn({ err, candidate }, "unparseable obsidian.json");
        }
    }

    return [];
}

export function resolveActiveVault(env: NodeJS.ProcessEnv = appEnv.getProcessEnv()): string | null {
    const vaults = discoverVaults(env);
    if (vaults.length === 0) {
        return null;
    }

    const open = vaults.find((v) => v.open);
    if (open) {
        return open.path;
    }

    return [...vaults].sort((a, b) => b.ts - a.ts)[0].path;
}
