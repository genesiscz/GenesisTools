/**
 * Commands that get the vault key with no approval window when an agent starts them (Martin, DECISION 57 c,
 * 2026-11-10: "No window at all for agent-started commands on a list (warmup, usage), with a log line and a
 * notification each time"). GenesisTools.app reads this file (src/macos/GenesisTools/Sources/Host/VaultAutoAllow.swift)
 * on every vault request; this side only writes it. A missing file means VAULT_AUTO_ALLOW_DEFAULTS, and the Swift side
 * holds the same defaults: change both together.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject, SafeJSON } from "@genesiscz/utils/json";
import { isMissingFileError } from "@genesiscz/utils/storage/atomic-file";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
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
}

export const VAULT_AUTO_ALLOW_DEFAULTS: VaultAutoAllowSettings = {
    version: 1,
    enabled: true,
    notify: true,
    commands: ["claude warmup", "claude usage", "ai warmup", "ai usage"],
    agentApps: ["Grok Bot"],
};

/** `~/.genesis-tools/ai/gate/vault-auto-allow.json`, beside the vault grants. */
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
 * One key of the file, read the way the app's decoder reads it (`decodeIfPresent`): absent or null takes the default,
 * a value of another type throws, because the app turns the whole feature off for such a file.
 */
function settingsField<T>(
    value: Record<string, unknown>,
    key: keyof VaultAutoAllowSettings,
    accepts: (field: unknown) => field is T,
    fallback: T,
    path: string
): T {
    const field = value[key];
    if (field === undefined || field === null) {
        return fallback;
    }

    if (!accepts(field)) {
        throw new Error(
            `${path}: "${key}" has the wrong type; the app turns auto-allow off until the file is fixed or removed`
        );
    }

    return field;
}

const isBoolean = (field: unknown): field is boolean => typeof field === "boolean";

/**
 * The settings on disk, a missing key taking its default. A file the app cannot decode (not JSON, not an object, or a
 * key of the wrong type) throws with its path: the app turns the feature off for such a file, so the CLI must not show
 * the defaults as if they applied, and must not write over it. A plain read: showing the settings never writes a file.
 */
export function loadVaultAutoAllow(path = vaultAutoAllowPath()): VaultAutoAllowSettings {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (err) {
        if (isMissingFileError(err)) {
            return { ...VAULT_AUTO_ALLOW_DEFAULTS };
        }

        throw err;
    }

    let value: unknown;
    try {
        value = SafeJSON.parse(text, { strict: true });
    } catch {
        value = undefined;
    }

    if (!isJsonObject(value)) {
        throw new Error(
            `${path} is not a JSON object; the app turns auto-allow off until the file is fixed or removed`
        );
    }

    return {
        version: 1,
        enabled: settingsField(value, "enabled", isBoolean, VAULT_AUTO_ALLOW_DEFAULTS.enabled, path),
        notify: settingsField(value, "notify", isBoolean, VAULT_AUTO_ALLOW_DEFAULTS.notify, path),
        commands: settingsField(value, "commands", isStringArray, [...VAULT_AUTO_ALLOW_DEFAULTS.commands], path),
        agentApps: settingsField(value, "agentApps", isStringArray, [...VAULT_AUTO_ALLOW_DEFAULTS.agentApps], path),
    };
}

/** Writes the settings atomically, private to the user. Callers that change one key use `updateVaultAutoAllow`. */
export function saveVaultAutoAllow(settings: VaultAutoAllowSettings, path = vaultAutoAllowPath()): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${SafeJSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Loads, applies `change`, saves, and returns the saved settings, all under the file's lock: two commands at once (a
 * `disable` and a `notify off`) each see the other's write, so neither puts back what the other changed. A file that
 * does not load throws before anything is written.
 */
export async function updateVaultAutoAllow(
    change: (settings: VaultAutoAllowSettings) => VaultAutoAllowSettings,
    path = vaultAutoAllowPath()
): Promise<VaultAutoAllowSettings> {
    mkdirSync(dirname(path), { recursive: true });
    return withFileLock(
        `${path}.lock`,
        async () => {
            const next = change(loadVaultAutoAllow(path));
            saveVaultAutoAllow(next, path);
            return next;
        },
        10_000
    );
}
