import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { DiffCategory } from "./diff/classify";

export type HookOutcome = "allow" | "context" | "warn" | "block";
export type HarnessName = "claude" | "codex" | "grok";
export const HARNESS_NAMES: readonly HarnessName[] = ["claude", "codex", "grok"];

/**
 * A configured MB figure in bytes. Decimal, because these caps are read against file sizes
 * people quote in MB, not against memory pages.
 *
 * The config says MB rather than bytes so a ceiling is legible at a glance: `8` instead of
 * `8_000_000`, which is the shape a misplaced zero hides in.
 */
export function megabytes(mb: number): number {
    return Math.round(mb * 1_000_000);
}

export interface DiffConfig {
    enabled: boolean;
    /**
     * How many changed files one message may name. Every file that fits gets its header, and
     * `maxMessageBytes` then decides how much of each DIFF is shown. So raising this trades
     * depth per file for breadth: at 15 a wide sweep is fully listed, and each file shows a
     * few lines rather than thirty.
     */
    maxFiles: number;
    maxLinesPerFile: number;
    contextLines: number;
    maxRoots: number;
    untrackedExpansionCap: number;
    maxCaptureFiles: number;
    maxCaptureMB: number;
    /**
     * Per-ENTRY ceiling, checked before the total. A file bigger than this is left out on its
     * own merits: the render shows at most `maxLinesPerFile` lines of it, so copying megabytes
     * to produce thirty lines buys nothing. Measured on a 65-entry tree of 43.7 MB, a 0.256 MB
     * ceiling keeps 58 entries in 1.8 MB.
     */
    maxCaptureFileMB: number;
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
    maxNamedPathMB: number;
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
     * The most bytes ONE message may carry, escape codes included.
     *
     * 🛑 The harness has its own ceiling, and breaching it loses the TAIL silently. Measured
     * 2026-09-21 across 206 PostToolUse messages in one session: the largest shown whole was
     * 9814 bytes, the smallest replaced by `Output too large (9.9KB)` was about 10138, and 13
     * of the 206 (6%) were cut. A cut message keeps the FIRST file and drops the last, which
     * is usually the one the command was about: one call rendered `parity.ts` and `proofs.ts`,
     * and only `parity.ts` survived.
     *
     * `maxFiles` and `maxLinesPerFile` cannot prevent this on their own, because a bat-coloured
     * line costs about 175 bytes rather than its visible width.
     */
    maxMessageBytes: number;
    /**
     * Which KINDS of change are printed. `source` is anything that is not one of the others.
     *
     * `log` and `generated` ship OFF: a jest run redirected into `/tmp/z1.log` and truncated
     * by the next run rendered as 27 lines of stack trace nobody asked for. `formatting`
     * ships ON, because its detection is a heuristic and a wrongly-labelled change should
     * still be seen; turn it off once a formatter is noisy in your loop.
     */
    categories: Record<DiffCategory, boolean>;
    /**
     * Per-harness overrides, applied over everything above once the harness is known.
     *
     * A diff is only worth rendering where the harness will actually SHOW it, and that is a
     * property of the harness, not of the repository or the command.
     */
    harnesses: Partial<Record<HarnessName, DiffOverrides>>;
}

/** What one harness may override. Anything absent falls through to the shared `diff` block. */
export type DiffOverrides = Partial<Omit<DiffConfig, "categories" | "harnesses">> & {
    categories?: Partial<Record<DiffCategory, boolean>>;
};

/**
 * The diff settings in force for one harness.
 *
 * `categories` merges field by field for the same reason the stored config does: an override
 * that turns one kind on must not blank the other three.
 */
export function diffFor(config: HooksConfig, harness: HarnessName | undefined): DiffConfig {
    const override = harness ? config.diff.harnesses[harness] : undefined;

    if (!override) {
        return config.diff;
    }

    return {
        ...config.diff,
        ...override,
        categories: { ...config.diff.categories, ...override.categories },
    };
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
    maxLogMB: number;
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

let lastProblems: string[] = [];

/** Fields of the stored config that were ignored because their value had the wrong type. */
export function lastConfigProblems(): string[] {
    return lastProblems;
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
        maxFiles: 15,
        maxLinesPerFile: 30,
        contextLines: 3,
        maxRoots: 4,
        untrackedExpansionCap: 200,
        maxCaptureFiles: 400,
        maxCaptureMB: 8,
        maxCaptureFileMB: 0.256,
        highlight: "bat",
        standDownWhenNative: true,
        watchNamedPaths: true,
        maxNamedPaths: 8,
        maxNamedPathMB: 2,
        namedPathsShowCreated: false,
        dedupeAcrossSessions: true,
        maxMessageBytes: 9_000,
        categories: { source: true, formatting: true, log: false, generated: false },
        harnesses: {
            // 🛑 OFF for Grok, because Grok cannot show a diff. Observed 2026-09-22 on a real
            // PostToolUse message: it prints the escape sequences as literal text (`[1mUpdated`
            // with the ESC byte eaten), and it cuts the message after about 200 characters,
            // ending `-impo… [+7768 chars]`. So one file HEADER already overflows it, and no
            // setting of `maxMessageBytes` or `highlight` makes 200 characters a diff. The
            // capture is skipped too, so a Grok session pays nothing for a render it cannot
            // have. Claude and Codex both render it correctly and are unaffected.
            grok: { enabled: false },
        },
    },
    logPath: defaultLogPath(),
    // 🛑 `shadow: true` AND `logCommands: "shadow"` together mean `keepsCommand()` is true out
    // of the box, so EVERY Bash command this machine runs through a hook is written verbatim
    // to `logPath`. That is the point of shadow mode — the old and new guards cannot be
    // compared on real traffic without the command text — but it is a local file holding
    // whatever was typed, secrets included. It is capped at `maxLogMB` with one generation
    // kept, and it stops accumulating commands as soon as either of these two is changed.
    // Setting `logCommands: "never"` keeps shadow mode and drops the command text.
    shadow: true,
    logCommands: "shadow",
    maxLogMB: 16,
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

interface CheckedNumber {
    /** Where the value sits in `hooks.json`, for the problem `hooks doctor` prints. */
    field: string;
    value: unknown;
    fallback: number;
}

/**
 * A stored value that was present but rejected. `hooks doctor` prints these, so a hand-edited
 * `"maxFiles": "15"` is named instead of silently turning into the default. An absent field is
 * not a problem.
 */
function reportRejected({ field, value, fallback }: CheckedNumber, expected: string): void {
    if (value !== undefined) {
        lastProblems.push(`${field} is ${SafeJSON.stringify(value)}, not ${expected}; using ${fallback}`);
    }
}

/** A hand-edited value outside its count domain (or not a number at all) falls back to the default. */
function countOr(checked: CheckedNumber & { min?: number }): number {
    const min = checked.min ?? 1;

    if (isCount(checked.value, min)) {
        return checked.value;
    }

    reportRejected(checked, `a whole number of at least ${min}`);

    return checked.fallback;
}

/**
 * An MB cap is a size, not a count: `0.256` is a valid per-file ceiling, so the whole-number
 * check of `isCount` would reject the shipped default. It must still be a positive finite number,
 * because `0` or a negative cap would leave nothing to capture or log.
 */
export function isMegabytes(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function megabytesOr(checked: CheckedNumber): number {
    if (isMegabytes(checked.value)) {
        return checked.value;
    }

    reportRejected(checked, "a positive number");

    return checked.fallback;
}

/**
 * The byte-denominated caps an older `hooks.json` may still carry. They were renamed to MB,
 * and reading only the new names silently dropped a stored cap back to the default, which for
 * `maxLogBytes` meant keeping MORE verbatim commands on disk than the user had allowed.
 */
interface LegacyByteCaps {
    maxLogBytes?: unknown;
    diff?: { maxCaptureBytes?: unknown };
}

/** What `hooks.json` may hold: any subset of the config, plus the pre-rename byte caps. */
type StoredHooksConfig = Partial<HooksConfig> & LegacyByteCaps;

function legacyMB(bytes: unknown): number | undefined {
    return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes / 1_000_000 : undefined;
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
function mergeDiff(stored: StoredHooksConfig["diff"]): DiffConfig {
    const base = DEFAULT_HOOKS_CONFIG.diff;

    return {
        enabled: boolOr(stored?.enabled, base.enabled),
        maxFiles: countOr({ field: "diff.maxFiles", value: stored?.maxFiles, fallback: base.maxFiles }),
        maxLinesPerFile: countOr({
            field: "diff.maxLinesPerFile",
            value: stored?.maxLinesPerFile,
            fallback: base.maxLinesPerFile,
        }),
        contextLines: countOr({
            field: "diff.contextLines",
            value: stored?.contextLines,
            fallback: base.contextLines,
            min: 0,
        }),
        maxRoots: countOr({ field: "diff.maxRoots", value: stored?.maxRoots, fallback: base.maxRoots }),
        untrackedExpansionCap: countOr({
            field: "diff.untrackedExpansionCap",
            value: stored?.untrackedExpansionCap,
            fallback: base.untrackedExpansionCap,
        }),
        maxCaptureFiles: countOr({
            field: "diff.maxCaptureFiles",
            value: stored?.maxCaptureFiles,
            fallback: base.maxCaptureFiles,
        }),
        maxCaptureMB: megabytesOr({
            field: "diff.maxCaptureMB",
            value: stored?.maxCaptureMB,
            fallback: legacyMB(stored?.maxCaptureBytes) ?? base.maxCaptureMB,
        }),
        maxCaptureFileMB: megabytesOr({
            field: "diff.maxCaptureFileMB",
            value: stored?.maxCaptureFileMB,
            fallback: base.maxCaptureFileMB,
        }),
        highlight: stored?.highlight === "bat" || stored?.highlight === "none" ? stored.highlight : base.highlight,
        standDownWhenNative: boolOr(stored?.standDownWhenNative, base.standDownWhenNative),
        watchNamedPaths: boolOr(stored?.watchNamedPaths, base.watchNamedPaths),
        maxNamedPaths: countOr({
            field: "diff.maxNamedPaths",
            value: stored?.maxNamedPaths,
            fallback: base.maxNamedPaths,
        }),
        maxNamedPathMB: megabytesOr({
            field: "diff.maxNamedPathMB",
            value: stored?.maxNamedPathMB,
            fallback: base.maxNamedPathMB,
        }),
        namedPathsShowCreated: boolOr(stored?.namedPathsShowCreated, base.namedPathsShowCreated),
        dedupeAcrossSessions: boolOr(stored?.dedupeAcrossSessions, base.dedupeAcrossSessions),
        maxMessageBytes: countOr({
            field: "diff.maxMessageBytes",
            value: stored?.maxMessageBytes,
            fallback: base.maxMessageBytes,
        }),
        // Merged FIELD BY FIELD for the same reason `longCommand` is: a hand-edited `hooks.json`
        // that turns one category on would otherwise blank every other one, and `undefined`
        // reads as "hidden".
        categories: {
            source: boolOr(stored?.categories?.source, base.categories.source),
            formatting: boolOr(stored?.categories?.formatting, base.categories.formatting),
            log: boolOr(stored?.categories?.log, base.categories.log),
            generated: boolOr(stored?.categories?.generated, base.categories.generated),
        },
        // Same field-by-field reason, one level deeper: a stored override for Codex must not
        // delete the shipped Grok one, which is what turns the diff off there.
        harnesses: mergedHarnesses(stored?.harnesses),
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

/** One entry per harness, each merged over the shipped one rather than replacing it. */
function mergedHarnesses(
    stored: Partial<Record<HarnessName, DiffOverrides>> | undefined
): Partial<Record<HarnessName, DiffOverrides>> {
    const merged: Partial<Record<HarnessName, DiffOverrides>> = { ...DEFAULT_HOOKS_CONFIG.diff.harnesses };

    for (const harness of HARNESS_NAMES) {
        const override = stored?.[harness];

        if (typeof override === "object" && override !== null) {
            merged[harness] = { ...merged[harness], ...checkedOverride(override, `diff.harnesses.${harness}`) };
        }
    }

    return merged;
}

const OVERRIDE_COUNTS = [
    "maxFiles",
    "maxLinesPerFile",
    "maxRoots",
    "untrackedExpansionCap",
    "maxCaptureFiles",
    "maxNamedPaths",
    "maxMessageBytes",
] as const;

const OVERRIDE_MEGABYTES = ["maxCaptureMB", "maxCaptureFileMB", "maxNamedPathMB"] as const;

const OVERRIDE_BOOLEANS = [
    "enabled",
    "standDownWhenNative",
    "watchNamedPaths",
    "namedPathsShowCreated",
    "dedupeAcrossSessions",
] as const;

/**
 * The fields of one stored harness override that have the right type. A spread let a hand-edited
 * `"enabled": "true"` through, and the non-empty string read as on, which is the defect
 * `mergeDiff` closes for the shared block. A field of the wrong type is dropped, so it falls
 * through to the shared value. A dropped number is reported, so `hooks doctor` names it.
 */
function checkedOverride(stored: DiffOverrides, path: string): DiffOverrides {
    const checked: DiffOverrides = {};

    // The same range checks `mergeDiff` applies to the shared block: a count is a whole number
    // of at least 1 (context lines may be 0), and an MB cap is a positive number.
    for (const key of OVERRIDE_COUNTS) {
        const value: unknown = stored[key];

        if (isCount(value, 1)) {
            checked[key] = value;
        } else if (value !== undefined) {
            lastProblems.push(
                `${path}.${key} is ${SafeJSON.stringify(value)}, not a whole number of at least 1; ignoring it`
            );
        }
    }

    const contextLines: unknown = stored.contextLines;

    if (isCount(contextLines, 0)) {
        checked.contextLines = contextLines;
    } else if (contextLines !== undefined) {
        lastProblems.push(
            `${path}.contextLines is ${SafeJSON.stringify(contextLines)}, not a whole number of at least 0; ignoring it`
        );
    }

    for (const key of OVERRIDE_MEGABYTES) {
        const value: unknown = stored[key];

        if (isMegabytes(value)) {
            checked[key] = value;
        } else if (value !== undefined) {
            lastProblems.push(`${path}.${key} is ${SafeJSON.stringify(value)}, not a positive number; ignoring it`);
        }
    }

    for (const key of OVERRIDE_BOOLEANS) {
        const value: unknown = stored[key];

        if (typeof value === "boolean") {
            checked[key] = value;
        }
    }

    if (stored.highlight === "bat" || stored.highlight === "none") {
        checked.highlight = stored.highlight;
    }

    const categories: Partial<Record<DiffCategory, boolean>> = {};

    for (const category of ["source", "formatting", "log", "generated"] as const) {
        const value: unknown = stored.categories?.[category];

        if (typeof value === "boolean") {
            categories[category] = value;
        }
    }

    if (Object.keys(categories).length > 0) {
        checked.categories = categories;
    }

    return checked;
}

/**
 * Synchronous on purpose: three hook entrypoints call this before they read stdin, and
 * the process must not pay for an async config reader. `agentsDataDir()` resolves the same
 * directory `Storage` would, so `GENESIS_TOOLS_HOME` still keeps the suite out of the real home.
 */
export function loadHooksConfig(path = hooksConfigPath()): HooksConfig {
    let stored: StoredHooksConfig | null = null;

    lastLoadError = undefined;
    lastProblems = [];

    try {
        stored = SafeJSON.parse(readFileSync(path, "utf8")) as StoredHooksConfig;
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
export function mergeStoredConfig(stored: StoredHooksConfig): HooksConfig {
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
                lines: countOr({
                    field: "guard.longCommand.lines",
                    value: guard?.longCommand?.lines,
                    fallback: base.longCommand.lines,
                }),
                chars: countOr({
                    field: "guard.longCommand.chars",
                    value: guard?.longCommand?.chars,
                    fallback: base.longCommand.chars,
                }),
            },
            contextCapPerSession: countOr({
                field: "guard.contextCapPerSession",
                value: guard?.contextCapPerSession,
                fallback: base.contextCapPerSession,
                min: 0,
            }),
        },
        diff: mergeDiff(stored.diff),
        shadow: boolOr(stored.shadow, DEFAULT_HOOKS_CONFIG.shadow),
        logCommands: logCommandsOr(stored.logCommands, DEFAULT_HOOKS_CONFIG.logCommands),
        maxLogMB: megabytesOr({
            field: "maxLogMB",
            value: stored.maxLogMB,
            fallback: legacyMB(stored.maxLogBytes) ?? DEFAULT_HOOKS_CONFIG.maxLogMB,
        }),
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
