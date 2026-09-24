import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

export type HookOutcome = "allow" | "context" | "warn" | "block";
export type HarnessName = "claude" | "codex" | "grok";
export const HARNESS_NAMES: readonly HarnessName[] = ["claude", "codex", "grok"];

export interface DiffConfig {
    enabled: boolean;
    maxFiles: number;
    maxLinesPerFile: number;
    contextLines: number;
    maxRoots: number;
    untrackedExpansionCap: number;
    maxCaptureFiles: number;
    maxCaptureBytes: number;
    highlight: "bat" | "none";
    standDownWhenNative: boolean;
}

export interface GuardConfig {
    enabled: boolean;
    default: Record<string, HookOutcome>;
    harnesses: Partial<Record<HarnessName, Record<string, HookOutcome>>>;
    models: Record<string, Record<string, HookOutcome>>;
    longCommand: { lines: number; chars: number };
    /** Context notes shown per rule per session before the rule goes quiet. */
    contextCapPerSession: number;
}

/**
 * Whether the decision log keeps the command verbatim. It is what makes a shadow run
 * replayable against the guard this port replaces, and it is also a plaintext sink for
 * anything a command carries inline (`export API_KEY=…`, `curl -H "Authorization: …"`). So
 * the default records it only while `shadow` is on, which is exactly when the replay is
 * needed and before anyone relies on the log long-term.
 */
export type LogCommandsPolicy = "shadow" | "always" | "never";

export interface HooksConfig {
    guard: GuardConfig;
    diff: DiffConfig;
    logPath: string;
    /**
     * Log the decision, emit nothing. It lets the new hooks run beside the old ones on real
     * traffic with zero user-visible change and zero double-deny. It ships ON: merging this
     * branch changes nothing until `shadow` is set false.
     */
    shadow: boolean;
    logCommands: LogCommandsPolicy;
    /**
     * Rotate the decision log once it passes this many bytes. Append-only with no cap grows
     * forever, and while `logCommands` is `"shadow"` it accumulates every command verbatim.
     * One generation is kept (`<log>.1`), so the ceiling is twice this.
     */
    maxLogBytes: number;
}

/**
 * `~/.genesis-tools/agents`, the same directory `new Storage("agents")` resolves, including
 * the `GENESIS_TOOLS_HOME` override that keeps the suite out of the real home.
 *
 * 🛑 Deliberately NOT `Storage`: importing it costs 16.2 ms (measured 2026-09-20) because it
 * pulls the pino logger, and three hook entrypoints pay that on every Bash call.
 */
export function agentsDataDir(): string {
    return join(env.tools.getHome(), ".genesis-tools", "agents");
}

export function hooksConfigPath(): string {
    return join(agentsDataDir(), "hooks.json");
}

/**
 * Why the last `loadHooksConfig()` fell back to the defaults. `undefined` after a successful
 * read. A missing file is the normal case, so this is not an error channel; `hooks doctor`
 * shows it when a file is present but unreadable.
 */
let lastLoadError: unknown;

export function lastConfigLoadError(): unknown {
    return lastLoadError;
}

export function defaultLogPath(): string {
    return join(env.tools.getHome(), ".genesis-tools", "logs", "agents-hooks.jsonl");
}

/**
 * `longCommand` at 30 lines / 2500 chars: at or above either size a `misread` block
 * becomes a warn, because re-running a long script over one line costs more than
 * reading the note. `destructive` rules always block regardless of length.
 *
 * The zsh glob qualifier only misfires under Claude Code, which sets
 * NO_BARE_GLOB_QUAL; Codex's and Grok's own zsh honour `(N)`, so they allow it.
 */
export const DEFAULT_HOOKS_CONFIG: HooksConfig = {
    guard: {
        enabled: true,
        default: {},
        harnesses: {
            codex: { "zsh-glob-qualifier": "allow" },
            grok: { "zsh-glob-qualifier": "allow" },
        },
        models: {},
        longCommand: { lines: 30, chars: 2500 },
        contextCapPerSession: 3,
    },
    diff: {
        enabled: true,
        maxFiles: 3,
        maxLinesPerFile: 30,
        contextLines: 3,
        maxRoots: 4,
        untrackedExpansionCap: 200,
        maxCaptureFiles: 400,
        maxCaptureBytes: 8_000_000,
        highlight: "bat",
        standDownWhenNative: true,
    },
    logPath: defaultLogPath(),
    shadow: true,
    logCommands: "shadow",
    maxLogBytes: 16_000_000,
};

/**
 * Every number in this config is a count: files, lines, bytes, notes. So it must be a whole
 * number, and at least 1 unless zero means something (`contextLines: 0` is `git diff -U0`, a
 * `contextCapPerSession` of 0 shows no context notes). `-1`, `2.5` and `NaN` used to pass: a
 * negative `maxLogBytes` rotated the log on every record.
 */
export function isCount(value: unknown, min: number): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= min;
}

/** A hand-edited value outside its count domain (or not a number at all) falls back to the default. */
function countOr(value: unknown, fallback: number, min = 1): number {
    return isCount(value, min) ? value : fallback;
}

/** Each harness's rules merged over the shipped ones for that harness. */
function mergeHarnesses(
    base: GuardConfig["harnesses"],
    stored: GuardConfig["harnesses"] | undefined
): GuardConfig["harnesses"] {
    const merged: GuardConfig["harnesses"] = { ...base };

    for (const harness of HARNESS_NAMES) {
        const rules = stored?.[harness];

        if (rules) {
            merged[harness] = { ...base[harness], ...rules };
        }
    }

    return merged;
}

function boolOr(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

/**
 * Every field checked on its own. A hand-edited `"maxFiles": "3"` or `"enabled": "false"` used
 * to flow straight through a spread: the string compared oddly against numbers, and the
 * non-empty string `"false"` read as on.
 */
function mergeDiff(stored: Partial<DiffConfig> | undefined): DiffConfig {
    const base = DEFAULT_HOOKS_CONFIG.diff;

    return {
        enabled: boolOr(stored?.enabled, base.enabled),
        maxFiles: countOr(stored?.maxFiles, base.maxFiles),
        maxLinesPerFile: countOr(stored?.maxLinesPerFile, base.maxLinesPerFile),
        contextLines: countOr(stored?.contextLines, base.contextLines, 0),
        maxRoots: countOr(stored?.maxRoots, base.maxRoots),
        untrackedExpansionCap: countOr(stored?.untrackedExpansionCap, base.untrackedExpansionCap),
        maxCaptureFiles: countOr(stored?.maxCaptureFiles, base.maxCaptureFiles),
        maxCaptureBytes: countOr(stored?.maxCaptureBytes, base.maxCaptureBytes),
        highlight: stored?.highlight === "bat" || stored?.highlight === "none" ? stored.highlight : base.highlight,
        standDownWhenNative: boolOr(stored?.standDownWhenNative, base.standDownWhenNative),
    };
}

const LOG_COMMANDS_POLICIES: readonly LogCommandsPolicy[] = ["shadow", "always", "never"];

function logCommandsOr(value: unknown, fallback: LogCommandsPolicy): LogCommandsPolicy {
    return LOG_COMMANDS_POLICIES.find((policy) => policy === value) ?? fallback;
}

/**
 * The config at `path` for a WRITER to build on. A file that exists but cannot be read (bad
 * JSON, no permission) throws instead of falling back to the defaults: `config set` and
 * `config import` would otherwise replace the user's whole hand-edited file with the defaults
 * plus one change. A missing file is the normal first write and proceeds.
 */
export function loadHooksConfigForWrite(path = hooksConfigPath()): HooksConfig {
    const config = loadHooksConfig(path);
    const err = lastLoadError;
    const missing = err instanceof Error && "code" in err && err.code === "ENOENT";

    if (err !== undefined && !missing) {
        throw new Error(
            `refusing to write ${path}: it exists but could not be read (${err instanceof Error ? err.message : String(err)}). Fix or move it first.`
        );
    }

    return config;
}

/**
 * Synchronous on purpose: three hook entrypoints call this before they read stdin, and
 * the process must not pay for an async config reader. `agentsDataDir()` resolves the same
 * directory `Storage` would, so `GENESIS_TOOLS_HOME` still keeps the suite out of the real home.
 */
export function loadHooksConfig(path = hooksConfigPath()): HooksConfig {
    let stored: Partial<HooksConfig> | null = null;

    lastLoadError = undefined;

    try {
        stored = SafeJSON.parse(readFileSync(path, "utf8")) as Partial<HooksConfig>;
    } catch (err) {
        // No config file is the normal case, not an error: the defaults below ARE the
        // shipped configuration. `hooks doctor` prints which of the two is in effect.
        lastLoadError = err;
    }

    if (!stored) {
        return { ...DEFAULT_HOOKS_CONFIG, logPath: defaultLogPath() };
    }

    return mergeStoredConfig(stored);
}

/**
 * A stored config merged over the shipped one exactly as the hooks load it. Exported so the parity
 * scripts evaluate the SAME config the hooks would, with no temp file round trip.
 */
export function mergeStoredConfig(stored: Partial<HooksConfig>): HooksConfig {
    const base = DEFAULT_HOOKS_CONFIG.guard;
    const guard = stored.guard;

    return {
        guard: {
            enabled: boolOr(guard?.enabled, base.enabled),
            // The rule maps are merged per KEY, not replaced. A shallow spread let a hand-edited
            // `hooks.json` that sets only `harnesses.claude` drop the shipped codex and grok
            // `zsh-glob-qualifier: allow`, so both harnesses started refusing a valid `(N)`.
            default: { ...base.default, ...guard?.default },
            harnesses: mergeHarnesses(base.harnesses, guard?.harnesses),
            models: { ...base.models, ...guard?.models },
            // `longCommand` is merged FIELD BY FIELD. A shallow spread let a hand-edited
            // `hooks.json` that sets only `guard.longCommand.lines` blank `chars`, and
            // `chars >= undefined` is always false, so the character threshold silently
            // stopped working. A value that is not a finite number is dropped the same way.
            longCommand: {
                lines: countOr(guard?.longCommand?.lines, base.longCommand.lines),
                chars: countOr(guard?.longCommand?.chars, base.longCommand.chars),
            },
            contextCapPerSession: countOr(guard?.contextCapPerSession, base.contextCapPerSession, 0),
        },
        diff: mergeDiff(stored.diff),
        shadow: boolOr(stored.shadow, DEFAULT_HOOKS_CONFIG.shadow),
        logCommands: logCommandsOr(stored.logCommands, DEFAULT_HOOKS_CONFIG.logCommands),
        maxLogBytes: countOr(stored.maxLogBytes, DEFAULT_HOOKS_CONFIG.maxLogBytes),
        logPath: typeof stored.logPath === "string" && stored.logPath.length > 0 ? stored.logPath : defaultLogPath(),
    };
}

/** Whether this run should record the command verbatim in the decision log. */
export function keepsCommand(config: HooksConfig): boolean {
    if (config.logCommands === "always") {
        return true;
    }

    return config.logCommands === "shadow" && config.shadow;
}
