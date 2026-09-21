import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { DiffCategory } from "./diff/classify";

export type HookOutcome = "allow" | "context" | "warn" | "block";
export type HarnessName = "claude" | "codex" | "grok";

export interface DiffConfig {
    enabled: boolean;
    maxFiles: number;
    maxLinesPerFile: number;
    contextLines: number;
    maxRoots: number;
    untrackedExpansionCap: number;
    maxCaptureFiles: number;
    maxCaptureBytes: number;
    /**
     * Per-ENTRY ceiling, checked before the total. A file bigger than this is left out on its
     * own merits: the render shows at most `maxLinesPerFile` lines of it, so copying megabytes
     * to produce thirty lines buys nothing. Measured on a 65-entry tree of 43.7 MB, a 256 KB
     * ceiling keeps 58 entries in 1.8 MB.
     */
    maxCaptureFileBytes: number;
    highlight: "bat" | "none";
    standDownWhenNative: boolean;
    /**
     * Also watch files the command NAMES as a path, not only those inside a git root it
     * works in. It is what makes an edit to a vault note, a `~/.claude` memory file or any
     * other path outside the cwd repository visible at all. Costs one `stat` per path-shaped
     * token and one copy per existing file; no extra git process in either phase.
     */
    watchNamedPaths: boolean;
    maxNamedPaths: number;
    maxNamedPathBytes: number;
    /**
     * Whether a file the command CREATED, and that is known only because the command named
     * it, is printed. Off, because that file is almost always scratch: measured 2026-09-21,
     * two consecutive calls each wrote a report into the system temp directory and each got
     * a 30-line block of a file the command had just described in its own output. A file
     * created INSIDE a git root is unaffected; this covers only named paths.
     */
    namedPathsShowCreated: boolean;
    /**
     * Print one file change at most ONCE across every session on the machine. Sessions share
     * repositories, and a file another session writes during this command's window is newer
     * than this command's stamp, so without this every session prints every session's edits.
     */
    dedupeAcrossSessions: boolean;
    /**
     * Which KINDS of change are printed. `source` is anything that is not one of the others.
     *
     * `log` and `generated` ship OFF: a jest run redirected into `/tmp/z1.log` and truncated
     * by the next run rendered as 27 lines of stack trace nobody asked for. `formatting`
     * ships ON, because its detection is a heuristic and a wrongly-labelled change should
     * still be seen; turn it off once a formatter is noisy in your loop.
     */
    categories: Record<DiffCategory, boolean>;
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
        maxCaptureFileBytes: 256_000,
        highlight: "bat",
        standDownWhenNative: true,
        watchNamedPaths: true,
        maxNamedPaths: 8,
        maxNamedPathBytes: 2_000_000,
        namedPathsShowCreated: false,
        dedupeAcrossSessions: true,
        categories: { source: true, formatting: true, log: false, generated: false },
    },
    logPath: defaultLogPath(),
    shadow: true,
    logCommands: "shadow",
    maxLogBytes: 16_000_000,
};

/**
 * Synchronous on purpose: three hook entrypoints call this before they read stdin, and
 * the process must not pay for an async config reader. `agentsDataDir()` resolves the same
 * directory `Storage` would, so `GENESIS_TOOLS_HOME` still keeps the suite out of the real home.
 */
export function loadHooksConfig(): HooksConfig {
    const path = hooksConfigPath();
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

    return {
        guard: {
            ...DEFAULT_HOOKS_CONFIG.guard,
            ...stored.guard,
            // `longCommand` is merged FIELD BY FIELD. A shallow spread let a hand-edited
            // `hooks.json` that sets only `guard.longCommand.lines` blank `chars`, and
            // `chars >= undefined` is always false, so the character threshold silently
            // stopped working.
            longCommand: { ...DEFAULT_HOOKS_CONFIG.guard.longCommand, ...stored.guard?.longCommand },
        },
        diff: {
            ...DEFAULT_HOOKS_CONFIG.diff,
            ...stored.diff,
            // Merged FIELD BY FIELD for the same reason `longCommand` is: a hand-edited
            // `hooks.json` that turns one category on would otherwise blank every other one,
            // and `undefined` reads as "hidden".
            categories: { ...DEFAULT_HOOKS_CONFIG.diff.categories, ...stored.diff?.categories },
        },
        shadow: stored.shadow ?? DEFAULT_HOOKS_CONFIG.shadow,
        logCommands: stored.logCommands ?? DEFAULT_HOOKS_CONFIG.logCommands,
        maxLogBytes: stored.maxLogBytes ?? DEFAULT_HOOKS_CONFIG.maxLogBytes,
        logPath: stored.logPath ?? defaultLogPath(),
    };
}

/** Whether this run should record the command verbatim in the decision log. */
export function keepsCommand(config: HooksConfig): boolean {
    if (config.logCommands === "always") {
        return true;
    }

    return config.logCommands === "shadow" && config.shadow;
}
