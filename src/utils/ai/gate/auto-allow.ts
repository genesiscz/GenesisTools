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
 * A command entry as the app matches it: exactly `<tool> <subcommand>`, because the app compares the tool and the first
 * argument that is no flag, and nothing after it. Any other entry throws: it would be saved and never match.
 */
export function autoAllowCommandEntry(words: readonly string[]): string {
    const command = autoAllowCommand(words);
    const parts = command.split(" ");
    if (parts.length !== 2 || parts.some((part) => part.startsWith("-"))) {
        throw new Error(
            `"${command}" is not <tool> <subcommand>; the app matches a tool and its first argument only, so "claude warmup" covers every call of that subcommand, whatever follows it`
        );
    }

    return command;
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

/** A deep copy of the defaults, so a change made in place never reaches VAULT_AUTO_ALLOW_DEFAULTS. */
function defaultSettings(): VaultAutoAllowSettings {
    return structuredClone(VAULT_AUTO_ALLOW_DEFAULTS);
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

const isFiniteNumber = (field: unknown): field is number => typeof field === "number" && Number.isFinite(field);

/**
 * The settings on disk, a missing key taking its default. A file the app cannot decode (not JSON, not an object, or a
 * key of the wrong type) throws with its path: the app turns the feature off for such a file, so the CLI must not show
 * the defaults as if they applied, and must not write over it. A plain read: showing the settings never writes a file.
 * A missing file hands out arrays of its own, so a change made in place never reaches VAULT_AUTO_ALLOW_DEFAULTS.
 */
export function loadVaultAutoAllow(path = vaultAutoAllowPath()): VaultAutoAllowSettings {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (err) {
        if (isMissingFileError(err)) {
            return defaultSettings();
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

    const defaults = defaultSettings();

    return {
        version: 1,
        enabled: settingsField(value, "enabled", isBoolean, defaults.enabled, path),
        notify: settingsField(value, "notify", isBoolean, defaults.notify, path),
        commands: settingsField(value, "commands", isStringArray, defaults.commands, path),
        agentApps: settingsField(value, "agentApps", isStringArray, defaults.agentApps, path),
        daemons: settingsField(value, "daemons", isStringArray, defaults.daemons, path),
        daemonNotifyHours: Math.max(
            0,
            settingsField(value, "daemonNotifyHours", isFiniteNumber, defaults.daemonNotifyHours, path)
        ),
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
