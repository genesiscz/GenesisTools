import { resolve } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { logger } from "@genesiscz/utils/logger";
import { buildInstance, type InstanceRequest, instanceIdFor } from "../lib/instances";
import { defaultBinDir } from "../lib/launchers";
import { defaultBackupDir, defaultSettingsPath, type InstanceUpsert } from "../lib/settings-file";

const { log } = logger.scoped("t3");

/** The write-path overrides every settings command takes. */
export interface PathFlags {
    settings?: string;
    backupDir?: string;
    binDir?: string;
}

export interface ResolvedPaths {
    settingsPath: string;
    backupDir: string;
    binDir: string;
}

export function resolvePaths(flags: PathFlags): ResolvedPaths {
    return {
        settingsPath: flags.settings ? resolve(flags.settings) : defaultSettingsPath(),
        backupDir: flags.backupDir ? resolve(flags.backupDir) : defaultBackupDir(),
        binDir: flags.binDir ? resolve(flags.binDir) : defaultBinDir(),
    };
}

/** The flags a fix command must repeat so it targets the same files. */
export function pathFlagsOf(flags: PathFlags): string[] {
    return [
        ...(flags.settings ? ["--settings", flags.settings] : []),
        ...(flags.binDir ? ["--bin-dir", flags.binDir] : []),
    ];
}

/** The GenesisTools AI accounts, read without migrations or writes. */
export async function loadAccounts(): Promise<AccountEntry[]> {
    const store = await AiConfigStore.readOnly();
    const accounts = store.accounts();
    log.debug({ count: accounts.length }, "AI accounts read (read-only)");

    return accounts;
}

export function parseAlias(value: string): HarnessId | null {
    return ACCOUNT_PROVIDER_ALIASES.find((alias) => alias === value) ?? null;
}

export function upsertFor(request: InstanceRequest): InstanceUpsert {
    return {
        id: instanceIdFor(request.alias, request.account),
        account: request.account,
        build: (existing) => buildInstance(existing, request),
    };
}

export const STEER_MODES = ["next", "off"] as const;
export type SteerMode = (typeof STEER_MODES)[number];

export function isSteerMode(value: string): value is SteerMode {
    return (STEER_MODES as readonly string[]).includes(value);
}
