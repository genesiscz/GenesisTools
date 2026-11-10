/**
 * Commands that get the vault key with no approval window when an agent starts them (Martin, DECISION 57 c,
 * 2026-11-10: "No window at all for agent-started commands on a list (warmup, usage), with a log line and a
 * notification each time"). GenesisTools.app reads this file (src/macos/GenesisTools/Sources/Host/VaultAutoAllow.swift)
 * on every vault request; this side only writes it. A missing file means VAULT_AUTO_ALLOW_DEFAULTS, and the Swift side
 * holds the same defaults: change both together.
 *
 * The file also lists GenesisTools' own background programs (`daemons`, decision 61 b of 2026-11-10: "A built-in list
 * of GenesisTools' own daemons of the installed checkout gets the key with no window, with an audit line and a
 * notification"). A daemon passes whoever starts it, when bun runs that script of the checkout the app was built from.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { isJsonObject, readJsonFileForUpdateSync } from "@genesiscz/utils/storage/atomic-file";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { gateDir } from "./grants";

export interface VaultAutoAllowSettings {
    version: 1;
    enabled: boolean;
    /** A notification for every auto-allow; the audit line is written either way. */
    notify: boolean;
    /** `<tool> <subcommand>` as typed after `tools`: "claude warmup". */
    commands: string[];
    /**
     * Apps whose child processes count as an agent's, besides a Claude Code session and a Claude, Codex or Grok CLI
     * process. Matched on the process name ("Grok Bot" also matches its "Grok Bot Helper").
     */
    agentApps: string[];
    /** GenesisTools' own background programs, each as its script's path from the checkout's root ("src/codex/daemon.ts"). */
    daemons: string[];
    /** Hours between two notifications for one daemon (it reads the key about once a minute); 0 is one for every pass. */
    daemonNotifyHours: number;
}

export const VAULT_AUTO_ALLOW_DEFAULTS: VaultAutoAllowSettings = {
    version: 1,
    enabled: true,
    notify: true,
    commands: ["claude warmup", "claude usage", "ai warmup", "ai usage"],
    agentApps: ["Grok Bot"],
    daemons: ["src/ai/commands/usage/poll-daemon.ts", "src/codex/daemon.ts"],
    daemonNotifyHours: 24,
};

export function vaultAutoAllowPath(): string {
    return join(gateDir(), "vault-auto-allow.json");
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** `["claude", "warmup"]` → "claude warmup": the words of a command, single-spaced. */
export function autoAllowCommand(words: readonly string[]): string {
    return words
        .flatMap((word) => word.trim().split(/\s+/))
        .filter(Boolean)
        .join(" ");
}

/**
 * A daemon's entry as the app compares it: its script's path from the checkout's root, under `src/`. A path that
 * leaves the checkout, or names no script under `src/`, throws: the app would never match it.
 */
export function autoAllowDaemon(script: string): string {
    const entry = script.trim().replace(/^\.\//, "");

    if (!entry.startsWith("src/") || entry.split("/").includes("..") || !/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) {
        throw new Error(`"${script}" is not a script path from the checkout's root; write it like src/codex/daemon.ts`);
    }

    return entry;
}

/**
 * The settings on disk, a missing key taking its default. A file that is not a JSON object throws with its path: the
 * app turns the feature off for such a file, so the CLI must not show the defaults as if they applied.
 */
export function loadVaultAutoAllow(path = vaultAutoAllowPath()): VaultAutoAllowSettings {
    const read = readJsonFileForUpdateSync<Record<string, unknown>>(path, { accepts: isJsonObject });
    if (read.state === "missing") {
        return { ...VAULT_AUTO_ALLOW_DEFAULTS };
    }

    if (read.state !== "ok") {
        throw new Error(`${path} is not a JSON object; the vault window asks for every command until it is fixed`);
    }

    const value = read.value;
    return {
        version: 1,
        enabled: typeof value.enabled === "boolean" ? value.enabled : VAULT_AUTO_ALLOW_DEFAULTS.enabled,
        notify: typeof value.notify === "boolean" ? value.notify : VAULT_AUTO_ALLOW_DEFAULTS.notify,
        commands: isStringArray(value.commands) ? value.commands : [...VAULT_AUTO_ALLOW_DEFAULTS.commands],
        agentApps: isStringArray(value.agentApps) ? value.agentApps : [...VAULT_AUTO_ALLOW_DEFAULTS.agentApps],
        daemons: isStringArray(value.daemons) ? value.daemons : [...VAULT_AUTO_ALLOW_DEFAULTS.daemons],
        daemonNotifyHours:
            typeof value.daemonNotifyHours === "number" && Number.isFinite(value.daemonNotifyHours)
                ? Math.max(0, value.daemonNotifyHours)
                : VAULT_AUTO_ALLOW_DEFAULTS.daemonNotifyHours,
    };
}

export function saveVaultAutoAllow(settings: VaultAutoAllowSettings, path = vaultAutoAllowPath()): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${SafeJSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/** Loads, applies `change`, saves, and returns the saved settings. */
export function updateVaultAutoAllow(
    change: (settings: VaultAutoAllowSettings) => VaultAutoAllowSettings,
    path = vaultAutoAllowPath()
): VaultAutoAllowSettings {
    const next = change(loadVaultAutoAllow(path));
    saveVaultAutoAllow(next, path);
    return next;
}
