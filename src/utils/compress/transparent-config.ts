import { homedir } from "node:os";
import { defaultNativeHome, nativeSessionRootsForHome } from "@genesiscz/utils/providers/session-paths";
import { Storage } from "@genesiscz/utils/storage";
import type { Mirror } from "./transparent";

export interface TransparentConfig {
    defaults: { olderThan: string; minKb: number; exts: string[] };
    harnesses: Record<string, { roots: string[]; mirrors?: Mirror[] }>;
}

function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

/** Missing old config receives the previous command's defaults in memory, never a diagnostic write. */
export function migrateTransparentConfig(raw: unknown, userHome = homedir()): TransparentConfig {
    const compress = object(object(object(raw).du).compress);
    const defaults = object(compress.defaults);
    const claudeHome = defaultNativeHome("claude", userHome);
    const harnesses: TransparentConfig["harnesses"] = {
        // Existing Claude default only. Five lsof samples are recorded in the benchmark;
        // held files are excluded on every run. Other roots require writer evidence first.
        claude: {
            roots: nativeSessionRootsForHome("claude", claudeHome),
            mirrors: [{ from: claudeHome, to: `${claudeHome}.bkp` }],
        },
    };
    for (const [name, input] of Object.entries(object(compress.harnesses))) {
        const value = object(input);
        if (!Array.isArray(value.roots) || !value.roots.every((root) => typeof root === "string")) {
            throw new Error(`du.compress.harnesses.${name}.roots must be an array of paths`);
        }

        const mirrors: Mirror[] = [];
        if (value.mirrors !== undefined) {
            if (!Array.isArray(value.mirrors)) {
                throw new Error(`du.compress.harnesses.${name}.mirrors must be an array`);
            }

            for (const item of value.mirrors) {
                const mirror = object(item);
                if (typeof mirror.from !== "string" || typeof mirror.to !== "string") {
                    throw new Error(`du.compress.harnesses.${name}.mirrors requires from/to paths`);
                }

                mirrors.push({ from: mirror.from, to: mirror.to });
            }
        }

        harnesses[name] = { roots: value.roots, mirrors };
    }

    if (defaults.olderThan !== undefined && typeof defaults.olderThan !== "string") {
        throw new Error("du.compress.defaults.olderThan must be a duration string");
    }

    if (
        defaults.minKb !== undefined &&
        (typeof defaults.minKb !== "number" || !Number.isFinite(defaults.minKb) || defaults.minKb < 0)
    ) {
        throw new Error("du.compress.defaults.minKb must be nonnegative");
    }

    if (
        defaults.exts !== undefined &&
        (!Array.isArray(defaults.exts) || !defaults.exts.every((ext) => typeof ext === "string"))
    ) {
        throw new Error("du.compress.defaults.exts must be extensions");
    }

    return {
        defaults: {
            olderThan: typeof defaults.olderThan === "string" ? defaults.olderThan : "3d",
            minKb: typeof defaults.minKb === "number" ? defaults.minKb : 64,
            exts: Array.isArray(defaults.exts) ? defaults.exts : ["jsonl", "json", "txt", "log", "md"],
        },
        harnesses,
    };
}

export async function loadTransparentConfig(): Promise<TransparentConfig> {
    return migrateTransparentConfig(await new Storage("GenesisTools").getConfig());
}
