import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { genesisToolsDir, toolDataDir } from "@genesiscz/utils/storage/root";
import type { DiffCategory } from "./diff/classify";
import { FULL_DIFF_MODES, type FullDiffMode } from "./diff/full";
import { DIFF_THEMES, type DiffThemeName } from "./diff/theme";

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
     * `maxMessageChars` then decides how much of each DIFF is shown. So raising this trades
     * depth per file for breadth: at 15 a wide sweep is fully listed, and each file shows a
     * few lines rather than thirty.
     */
    maxFiles: number;
    maxLinesPerFile: number;
    /**
     * A file with more added plus removed lines than this prints its header and counts only, and
     * the message links its full diff. A regenerated ledger printed 30 lines of +12,459 -6,099
     * churn that nobody reads (2026-10-14: 20 such blocks in a day).
     */
    maxBlockLines: number;
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
    /**
     * Syntax colour, through `bat`. `256` (default): 256-colour codes, about half the characters of
     * truecolor after compaction; the colours are the nearest of the 256-colour palette, which a
     * terminal theme that remaps that palette can shift. `truecolor`: `bat`'s exact theme colours,
     * so fewer lines fit the 10,000-character message. `none`: no syntax colour; rows keep their
     * bands and markers. Every mode drops escape codes that change nothing (`compactColour`), which
     * loses no colour, so there is no raw mode.
     */
    highlight: HighlightMode;
    /**
     * What paints the syntax colour. `hljs` (default): highlight.js in process, in Claude Code's own dark
     * palette (`diff/syntax.ts`): 7.4 ms to load once, then 0.3 ms a call. `bat`: one `bat` process per
     * syntax in a message (24.8 ms median) in `bat`'s own theme. A file type `syntax.ts` does not know, and
     * every light theme, fall back to `bat`.
     */
    highlighter: Highlighter;
    /**
     * How far a changed row's band reaches. `block` (default): the widest row of the file, so a pane
     * made narrower after the message was printed wraps only the rows that are long anyway. `terminal`:
     * the pane's width, like Claude Code's own diff; a hook message is fixed text, so once the pane gets
     * narrower every row wraps into an empty band row. `none`: the band ends with the text.
     */
    fill: FillMode;
    /**
     * The most columns a `block` fill pads a row to, the gutter included; 0 lifts the limit. Without it
     * one long changed line widened every row of the file to the pane, and a hook message is fixed text:
     * once the pane was narrower than when the message was drawn, every padded row wrapped into an empty
     * band row (2026-10-15 11:54: rows of 106 columns, shown in a pane of 76). A row longer than this is
     * not padded and its band ends with the text.
     */
    fillMax: number;
    /**
     * How a block looks; see `diff/theme.ts`. `claude` copies Claude Code's own Bash diff in the
     * theme Claude Code is set to, so the hook can replace that diff (`bashEditDiffEnabled: false`)
     * without a change of look. `classic` is the original look.
     */
    theme: DiffThemeName;
    /**
     * How wide a changed row's band is, in columns. `auto` reads the terminal the harness draws
     * in, less `BAND_MARGIN`; `0` ends the band at the text. Padding costs message bytes, so it is
     * bought only after every changed line fits.
     */
    columns: number | "auto";
    /**
     * Where a message whose lines were cut points for the rest: `genesis` (a Genesis viewer link),
     * `path` (the file), `off`. The file is `~/.genesis-tools/agents/hook-diffs/<call>.md`, kept a week.
     */
    fullDiff: FullDiffMode;
    standDownWhenNative: boolean;
    /**
     * The hook replaces Claude Code's own Bash diff once `shadow` is off: `install --write` then
     * sets `bashEditDiffEnabled: false` in `~/.claude/settings.json`, and `doctor` warns while it
     * is on. While `shadow` is on the hook prints nothing, so the native diff stays. Claude Code's
     * diff has no attribution and shows other sessions' edits; see `native-diff.ts`.
     */
    replaceNative: boolean;
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
     * Whether a named file in a temp folder outside every git work tree is printed: a session's
     * PR body, repro script or scratch JSON. Off: 146 such blocks in a day (2026-10-14), none of
     * them the work itself.
     */
    showTempScratch: boolean;
    /**
     * Print one file change at most ONCE across every session on the machine. Sessions share
     * repositories, and a file another session writes during this command's window is newer
     * than this command's stamp, so without this every session prints every session's edits.
     */
    dedupeAcrossSessions: boolean;
    /**
     * What happens to a changed file this session did not cause: another session's edit in a
     * shared repository, or anything a read-only command could not have written. It is never
     * diffed. `line` names such files in one short line under the diff; `hidden` drops them.
     * See `diff/attribution.ts` for how a change is attributed.
     */
    othersSummary: "line" | "hidden";
    /**
     * The most characters (UTF-16 units, escape codes included) ONE message may carry.
     *
     * 🛑 Claude Code's own ceiling: `systemMessage.length <= 1e4` (`gce`, `aTs = 1e4` in the 2.1.296
     * binary, read 2026-10-14); a longer message is replaced by `Output too large` and a preview.
     * It counts `.length`, not bytes, so `Č` is one unit here although it is two UTF-8 bytes. The
     * budget used to be 9,000 BYTES, an inference from 206 measured messages (largest whole 9,814,
     * smallest cut about 10,138) that matched the real rule only by luck.
     *
     * `maxFiles` and `maxLinesPerFile` cannot prevent this on their own, because a coloured line
     * costs far more than its visible width.
     */
    maxMessageChars: number;
    /**
     * How many lines of the call's command head its message, dim, each cut to 80 characters; 0 shows
     * none. Claude Code folds a finished call into "ran N shell commands" and leaves only the hook
     * message under the fold, so without them nothing says which command changed the files.
     */
    commandLines: number;
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
    /**
     * Your own rule modules, loaded beside the built-in ones: files, or folders whose top-level
     * `.ts`/`.js` files are each one module (`*.test.*` and names starting with `_` or `.` are
     * skipped). `~/` expands; a relative path resolves against the home folder. Each module
     * exports `rules` (or a default export): an array of `ShellRule` from
     * `@genesiscz/utils/shell/rules/types`. A module that fails to load, or a rule that throws, is
     * skipped and logged; it never blocks a command.
     */
    customRules: string[];
}

/**
 * Whether the decision log keeps the command verbatim. It is what makes a shadow run
 * replayable against the guard this port replaces, and it is also a plaintext sink for
 * anything a command carries inline (`export API_KEY=…`, `curl -H "Authorization: …"`). So
 * the default records it only while `shadow` is on, which is exactly when the replay is
 * needed and before anyone relies on the log long-term.
 */
export type LogCommandsPolicy = "shadow" | "always" | "never";

export type DecisionStopHook = "off" | "warn" | "block";

/**
 * The decision hub's optional hooks. Everything ships OFF, and `tools agents hooks install` only
 * wires the Stop and UserPromptSubmit entries once one of them is turned on here.
 */
export interface DecisionsHookConfig {
    /**
     * A final reply that asks `❓ DECISION N` without posting it through question_post: `warn`
     * tells the user, `block` sends the agent back to post it, at most `maxBlocksPerSession`
     * times per session, then it only warns (the loop guard).
     */
    stopHook: DecisionStopHook;
    maxBlocksPerSession: number;
    harnesses: HarnessName[];
    /** Safety net: store an unposted `❓ DECISION N` block as an open decision under its number. */
    harvest: boolean;
    /** UserPromptSubmit: hand answered, undelivered decisions to the session's next prompt. */
    injectAnswers: boolean;
    /**
     * A blocking decision still waiting this long raises one notification per threshold. Read by
     * `tools question stale --notify`, which `tools question stale --install` runs every 5 minutes.
     */
    staleness: { warnAfterMinutes: number; alarmAfterMinutes: number; notify: boolean };
}

/** The genesis-tools plugin's SessionStart reminder about the agents-talk skill. */
export interface AgentsTalkConfig {
    hint: boolean;
}

/**
 * The Claude Code mods of the `genesis-tools-mods` plugin (`tools agents hooks mods install`), one object per
 * feature (`mods.<feature>.<field>`). The plugin reads this section of the hooks file itself, so a change here
 * needs no reinstall. It keeps the same shape and defaults in its own `hooks/shared.ts` (`ModsSettings`), since it
 * runs outside this repository; `mods-plugin.test.ts` holds the two equal.
 */
export interface ModsConfig {
    diff: {
        /**
         * Draw the whole diff of a call whose hook message was cut, with Claude Code's own diff element,
         * under the call's row. Reads `hook-diffs/<call>.md`, so it needs `diff.fullDiff` not `off`.
         */
        fullDiff: boolean;
        /**
         * Start the diff of a call that runs `git pull`, `merge`, `rebase`, `checkout`, `switch`, `reset`,
         * `cherry-pick`, `revert`, `am` or `stash pop|apply` hidden behind one `show diff from git pull` button:
         * those diffs are other people's work arriving, often hundreds of lines.
         */
        collapseGitSync: boolean;
    };
    /**
     * Compact an idle Claude session `minutes` after its last turn, before the 1-hour prompt cache expires, when
     * the engine's own idle compaction did not (it gives up at its first refused gate, such as a rate-limit
     * warning). Skips a context under `minTokens`. `minutes` is 1 to 59: after the engine's own try at 54
     * minutes, before the cache expires at 60.
     */
    idleCompact: { enabled: boolean; minutes: number; minTokens: number };
    /** A subagent's model in front of its description: `sonnet · Pair one` (`label`) or `(S) Pair one` (`short`). */
    agentModel: { enabled: boolean; format: "label" | "short" };
    /** `/decisions`: the open decisions of the session in a pane, an answer staged per decision, sent in one message. */
    decisions: { enabled: boolean };
    /** Bare paths, folders, commits and repeated decisions in the main loop's reply become links as it streams. */
    links: { enabled: boolean };
    /**
     * The git band above the prompt: branch, unpushed, dirty, PRs with CI; `/mod-git` switches it per session. One
     * row per checkout the session wrote files or changed git state in, the last first, up to `checkouts`; the
     * session's own folder shows only when it worked there (`cwd: touched`) or first in every session (`always`).
     */
    git: { enabled: boolean; labels: "full" | "minimal"; checkouts: number; cwd: "touched" | "always" };
    /** `[ask]` beside a finished tool row: quotes the row into the prompt. */
    askRow: { enabled: boolean };
    /** The running tool, its time and the working subagents on the spinner line. */
    spinner: { enabled: boolean };
    /**
     * The prompt cache countdown in the band: yellow under `cautionMinutes`, red under `warnMinutes`; `others` adds
     * the other sessions inside the yellow window.
     */
    cacheBand: { enabled: boolean; warnMinutes: number; cautionMinutes: number; others: boolean };
    /** The size of the session's /tmp/cc scratch folder and the free disk, every `minutes`. */
    tmpUsage: { enabled: boolean; minutes: number };
    /** One band row per working subagent: model, age, idle time, tool calls; red past `warnMinutes`. */
    agentsBand: { enabled: boolean; warnMinutes: number };
    /**
     * What the classic hooks hand the model: `tokens` shows the estimate as a band chip that opens a sidebar, `dedupe`
     * replaces a context block already given to the same loop since its last compaction with a one-line receipt.
     */
    hooks: { tokens: boolean; dedupe: boolean };
}

/**
 * The Stop-phase reminder about commits that are not pushed yet. It fires for a branch with an
 * upstream when MORE than `maxCommits` commits are unpushed, or when the oldest unpushed commit
 * is older than `maxAgeMinutes`, whichever comes first. One reminder per repository per
 * `remindEveryMinutes`, across every session on the machine. It never pushes.
 */
export interface UnpushedConfig {
    enabled: boolean;
    maxCommits: number;
    maxAgeMinutes: number;
    remindEveryMinutes: number;
}

export interface HooksConfig {
    guard: GuardConfig;
    diff: DiffConfig;
    decisions: DecisionsHookConfig;
    agentsTalk: AgentsTalkConfig;
    mods: ModsConfig;
    unpushed: UnpushedConfig;
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
 * `~/.genesis-tools/agents`, the same directory `new Storage("agents")` resolves.
 *
 * 🛑 Deliberately NOT `Storage`: three hook entrypoints run on every Bash call, and `Storage`
 * still costs about 10 ms to import (the logger); `toolDataDir` imports only `env`.
 */
export function agentsDataDir(): string {
    return toolDataDir("agents");
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
    return genesisToolsDir("logs", "agents-hooks.jsonl");
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
        customRules: [],
    },
    diff: {
        enabled: true,
        maxFiles: 15,
        maxLinesPerFile: 30,
        maxBlockLines: 400,
        contextLines: 3,
        maxRoots: 4,
        untrackedExpansionCap: 200,
        maxCaptureFiles: 400,
        maxCaptureMB: 8,
        maxCaptureFileMB: 0.256,
        highlight: "256",
        highlighter: "hljs",
        fill: "block",
        fillMax: 72,
        theme: "claude",
        columns: "auto",
        fullDiff: "genesis",
        standDownWhenNative: true,
        replaceNative: true,
        watchNamedPaths: true,
        maxNamedPaths: 8,
        maxNamedPathMB: 2,
        namedPathsShowCreated: false,
        showTempScratch: false,
        dedupeAcrossSessions: true,
        othersSummary: "line",
        maxMessageChars: 9_900,
        commandLines: 3,
        categories: { source: true, formatting: true, log: false, generated: false },
        harnesses: {
            // 🛑 OFF for Grok, because Grok cannot show a diff. Observed 2026-09-22 on a real
            // PostToolUse message: it prints the escape sequences as literal text (`[1mUpdated`
            // with the ESC byte eaten), and it cuts the message after about 200 characters,
            // ending `-impo… [+7768 chars]`. So one file HEADER already overflows it, and no
            // setting of `maxMessageChars` or `highlight` makes 200 characters a diff. The
            // capture is skipped too, so a Grok session pays nothing for a render it cannot
            // have. Claude and Codex both render it correctly and are unaffected.
            grok: { enabled: false },
        },
    },
    decisions: {
        stopHook: "off",
        maxBlocksPerSession: 2,
        harnesses: ["claude", "codex", "grok"],
        harvest: false,
        injectAnswers: false,
        staleness: { warnAfterMinutes: 30, alarmAfterMinutes: 120, notify: true },
    },
    agentsTalk: { hint: true },
    // Every mod past the full diff and the idle compaction starts off: `tools agents hooks mods enable <name> --write`.
    mods: {
        diff: { fullDiff: true, collapseGitSync: true },
        idleCompact: { enabled: true, minutes: 56, minTokens: 200_000 },
        agentModel: { enabled: false, format: "label" },
        decisions: { enabled: false },
        links: { enabled: false },
        git: { enabled: false, labels: "full", checkouts: 3, cwd: "touched" },
        askRow: { enabled: false },
        spinner: { enabled: false },
        cacheBand: { enabled: false, warnMinutes: 10, cautionMinutes: 20, others: true },
        tmpUsage: { enabled: false, minutes: 5 },
        agentsBand: { enabled: false, warnMinutes: 60 },
        hooks: { tokens: false, dedupe: false },
    },
    unpushed: { enabled: true, maxCommits: 3, maxAgeMinutes: 60, remindEveryMinutes: 30 },
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

/** A list of paths: anything but an array of strings falls back, and is reported. */
function pathListOr(field: string, value: unknown, fallback: string[]): string[] {
    if (value === undefined) {
        return fallback;
    }

    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        return value.filter((item) => item.trim().length > 0);
    }

    lastProblems.push(
        `${field} is ${SafeJSON.stringify(value)}, not a list of paths; using ${SafeJSON.stringify(fallback)}`
    );

    return fallback;
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
        maxBlockLines: countOr({
            field: "diff.maxBlockLines",
            value: stored?.maxBlockLines,
            fallback: base.maxBlockLines,
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
        highlight: highlightOr(stored?.highlight, base.highlight),
        highlighter: HIGHLIGHTERS.find((name) => name === stored?.highlighter) ?? base.highlighter,
        fill: FILL_MODES.find((mode) => mode === stored?.fill) ?? base.fill,
        fillMax: countOr({ field: "diff.fillMax", value: stored?.fillMax, fallback: base.fillMax, min: 0 }),
        commandLines: countOr({
            field: "diff.commandLines",
            value: stored?.commandLines,
            fallback: base.commandLines,
            min: 0,
        }),
        theme: themeOr(stored?.theme, base.theme),
        columns: columnsOr(stored?.columns, base.columns),
        fullDiff: FULL_DIFF_MODES.find((mode) => mode === stored?.fullDiff) ?? base.fullDiff,
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
        showTempScratch: boolOr(stored?.showTempScratch, base.showTempScratch),
        dedupeAcrossSessions: boolOr(stored?.dedupeAcrossSessions, base.dedupeAcrossSessions),
        replaceNative: boolOr(stored?.replaceNative, base.replaceNative),
        othersSummary: othersSummaryOr(stored?.othersSummary, base.othersSummary),
        maxMessageChars: countOr({
            field: "diff.maxMessageChars",
            value: stored?.maxMessageChars,
            fallback: base.maxMessageChars,
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

export const HIGHLIGHTERS = ["hljs", "bat"] as const;
export type Highlighter = (typeof HIGHLIGHTERS)[number];

export const FILL_MODES = ["block", "terminal", "none"] as const;
export type FillMode = (typeof FILL_MODES)[number];

export const HIGHLIGHT_MODES = ["256", "truecolor", "none"] as const;
export type HighlightMode = (typeof HIGHLIGHT_MODES)[number];

/** A stored highlight mode; `bat`, the old name of the only colour mode, reads as `truecolor`. */
export function highlightOr(value: unknown, fallback: HighlightMode): HighlightMode {
    if (value === "bat") {
        return "truecolor";
    }

    return HIGHLIGHT_MODES.find((mode) => mode === value) ?? fallback;
}

export function themeOr(value: unknown, fallback: DiffThemeName): DiffThemeName {
    return DIFF_THEMES.find((theme) => theme === value) ?? fallback;
}

/** `auto`, or a whole number of columns (0 = no fill); anything else falls back. */
export function columnsOr(value: unknown, fallback: DiffConfig["columns"]): DiffConfig["columns"] {
    return value === "auto" || isCount(value, 0) ? value : fallback;
}

export const OTHERS_SUMMARIES: readonly DiffConfig["othersSummary"][] = ["line", "hidden"];

function othersSummaryOr(value: unknown, fallback: DiffConfig["othersSummary"]): DiffConfig["othersSummary"] {
    return OTHERS_SUMMARIES.find((mode) => mode === value) ?? fallback;
}

const LOG_COMMANDS_POLICIES: readonly LogCommandsPolicy[] = ["shadow", "always", "never"];

function logCommandsOr(value: unknown, fallback: LogCommandsPolicy): LogCommandsPolicy {
    return LOG_COMMANDS_POLICIES.find((policy) => policy === value) ?? fallback;
}

/**
 * The config at `path` for a WRITER to build on. A file that exists but cannot be read (bad
 * JSON, no permission) throws instead of falling back to the defaults: `config set` and the
 * rule picker would otherwise replace the user's whole hand-edited file with the defaults
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
    "maxBlockLines",
    "maxRoots",
    "untrackedExpansionCap",
    "maxCaptureFiles",
    "maxNamedPaths",
    "maxMessageChars",
] as const;

const OVERRIDE_MEGABYTES = ["maxCaptureMB", "maxCaptureFileMB", "maxNamedPathMB"] as const;

const OVERRIDE_BOOLEANS = [
    "enabled",
    "standDownWhenNative",
    "watchNamedPaths",
    "namedPathsShowCreated",
    "showTempScratch",
    "dedupeAcrossSessions",
    "replaceNative",
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

    const fill = FILL_MODES.find((mode) => mode === stored.fill);

    if (fill) {
        checked.fill = fill;
    }

    const highlight: unknown = stored.highlight;

    if (highlight === "bat" || HIGHLIGHT_MODES.some((mode) => mode === highlight)) {
        checked.highlight = highlightOr(highlight, "256");
    }

    if (stored.othersSummary === "line" || stored.othersSummary === "hidden") {
        checked.othersSummary = stored.othersSummary;
    }

    if (DIFF_THEMES.some((theme) => theme === stored.theme)) {
        checked.theme = stored.theme;
    }

    if (stored.columns === "auto" || isCount(stored.columns, 0)) {
        checked.columns = stored.columns;
    }

    if (FULL_DIFF_MODES.some((mode) => mode === stored.fullDiff)) {
        checked.fullDiff = stored.fullDiff;
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

/** The copy of the shipped defaults a writer stores beside the full settings (see `storedOverrides`). */
export const SHIPPED_DEFAULTS_KEY = "_shippedDefaults";
/** The installer's record of what it wired, kept in the same file; not a setting. */
export const INSTALLED_KEY = "installed";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The parts of `value` that differ from `fallback`, or `undefined` when nothing does.
 *
 * 🛑 Only overrides may take effect. `applySetting` works on the fully resolved config, so a file
 * read verbatim froze every default it listed: observed 2026-09-22, one `diff.maxFiles` change
 * pinned ten unrelated settings, and a later default would never have reached that machine again.
 *
 * An array is compared whole. These are small literal lists, and a per-element merge would
 * make "the user cleared this list" indistinguishable from "the user did not touch it".
 */
export function changedOnly(value: unknown, fallback: unknown): unknown {
    if (Array.isArray(value) || Array.isArray(fallback)) {
        return SafeJSON.stringify(value) === SafeJSON.stringify(fallback) ? undefined : value;
    }

    if (isPlainRecord(value) && isPlainRecord(fallback)) {
        const out: Record<string, unknown> = {};

        for (const [inner, held] of Object.entries(value)) {
            const diff = changedOnly(held, fallback[inner]);

            if (diff !== undefined) {
                out[inner] = diff;
            }
        }

        return Object.keys(out).length > 0 ? out : undefined;
    }

    return value === fallback ? undefined : value;
}

/**
 * The user's overrides inside a stored `hooks.json`. Writers store EVERY setting, so the file
 * shows each knob, plus `_shippedDefaults`, the defaults at write time. A value counts as an
 * override only when it differs from that copy, so a default that changes later still reaches
 * every setting the user never touched. A file without the copy (hand-written, or older) is
 * all overrides, as before.
 */
export function storedOverrides(raw: unknown): Record<string, unknown> {
    if (!isPlainRecord(raw)) {
        return {};
    }

    const { [SHIPPED_DEFAULTS_KEY]: shipped, [INSTALLED_KEY]: _installed, ...settings } = raw;

    if (!isPlainRecord(shipped)) {
        return settings;
    }

    const overrides = changedOnly(settings, shipped);
    return isPlainRecord(overrides) ? overrides : {};
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
        stored = storedOverrides(SafeJSON.parse(readFileSync(path, "utf8"))) as StoredHooksConfig;
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
            customRules: pathListOr("guard.customRules", guard?.customRules, base.customRules),
        },
        diff: mergeDiff(stored.diff),
        decisions: mergeDecisions(stored.decisions),
        agentsTalk: { hint: boolOr(stored.agentsTalk?.hint, DEFAULT_HOOKS_CONFIG.agentsTalk.hint) },
        mods: mergeMods(stored.mods),
        unpushed: mergeUnpushed(stored.unpushed),
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

const STOP_HOOK_MODES: readonly DecisionStopHook[] = ["off", "warn", "block"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function partOf(value: unknown): Record<string, unknown> {
    return isPlainObject(value) ? value : {};
}

/**
 * Field by field, like `diff`: a stored value of the wrong type falls back to the default. The flat keys of before
 * 2026-10-23 (`mods.fullDiff`, `mods.collapseGitSync`, `mods.idleCompact` as a boolean, `mods.idleCompactMinutes`,
 * `mods.idleCompactMinTokens`) still count where the object leaves a field out; the next write stores the objects.
 */
export function mergeMods(stored: unknown): ModsConfig {
    const base = DEFAULT_HOOKS_CONFIG.mods;
    const held = partOf(stored);
    const diff = partOf(held.diff);
    const idle = partOf(held.idleCompact);
    const legacyIdle = typeof held.idleCompact === "boolean" ? held.idleCompact : undefined;
    const model = partOf(held.agentModel);
    const cache = partOf(held.cacheBand);
    const tmp = partOf(held.tmpUsage);
    const agents = partOf(held.agentsBand);
    const hooks = partOf(held.hooks);
    const enabled = (key: string, fallback: boolean) => boolOr(partOf(held[key]).enabled, fallback);
    const git = partOf(held.git);
    const minutes = countOr({
        field: "mods.idleCompact.minutes",
        value: idle.minutes ?? held.idleCompactMinutes,
        fallback: base.idleCompact.minutes,
    });

    return {
        diff: {
            fullDiff: boolOr(diff.fullDiff, boolOr(held.fullDiff, base.diff.fullDiff)),
            collapseGitSync: boolOr(diff.collapseGitSync, boolOr(held.collapseGitSync, base.diff.collapseGitSync)),
        },
        idleCompact: {
            enabled: boolOr(idle.enabled, legacyIdle ?? base.idleCompact.enabled),
            // The mod reads the file itself and drops 60 or more the same way.
            minutes: minutes < 60 ? minutes : base.idleCompact.minutes,
            minTokens: countOr({
                field: "mods.idleCompact.minTokens",
                value: idle.minTokens ?? held.idleCompactMinTokens,
                fallback: base.idleCompact.minTokens,
                min: 0,
            }),
        },
        agentModel: {
            enabled: boolOr(model.enabled, base.agentModel.enabled),
            format: model.format === "short" || model.format === "label" ? model.format : base.agentModel.format,
        },
        decisions: { enabled: enabled("decisions", base.decisions.enabled) },
        links: { enabled: enabled("links", base.links.enabled) },
        git: {
            enabled: enabled("git", base.git.enabled),
            labels: git.labels === "full" || git.labels === "minimal" ? git.labels : base.git.labels,
            checkouts: minutesOr("mods.git.checkouts", git.checkouts, base.git.checkouts, 6),
            cwd: git.cwd === "touched" || git.cwd === "always" ? git.cwd : base.git.cwd,
        },
        askRow: { enabled: enabled("askRow", base.askRow.enabled) },
        spinner: { enabled: enabled("spinner", base.spinner.enabled) },
        cacheBand: {
            enabled: boolOr(cache.enabled, base.cacheBand.enabled),
            warnMinutes: minutesOr("mods.cacheBand.warnMinutes", cache.warnMinutes, base.cacheBand.warnMinutes, 59),
            cautionMinutes: minutesOr(
                "mods.cacheBand.cautionMinutes",
                cache.cautionMinutes,
                base.cacheBand.cautionMinutes,
                59
            ),
            others: boolOr(cache.others, base.cacheBand.others),
        },
        tmpUsage: {
            enabled: boolOr(tmp.enabled, base.tmpUsage.enabled),
            minutes: minutesOr("mods.tmpUsage.minutes", tmp.minutes, base.tmpUsage.minutes, 120),
        },
        agentsBand: {
            enabled: boolOr(agents.enabled, base.agentsBand.enabled),
            warnMinutes: minutesOr(
                "mods.agentsBand.warnMinutes",
                agents.warnMinutes,
                base.agentsBand.warnMinutes,
                24 * 60
            ),
        },
        hooks: { tokens: boolOr(hooks.tokens, base.hooks.tokens), dedupe: boolOr(hooks.dedupe, base.hooks.dedupe) },
    };
}

/** A whole number of minutes from 1 to `max`, as the plugin reads it; else the default. */
function minutesOr(field: string, value: unknown, fallback: number, max: number): number {
    const minutes = countOr({ field, value, fallback });

    return minutes <= max ? minutes : fallback;
}

function mergeUnpushed(stored: Partial<UnpushedConfig> | undefined): UnpushedConfig {
    const base = DEFAULT_HOOKS_CONFIG.unpushed;

    return {
        enabled: boolOr(stored?.enabled, base.enabled),
        maxCommits: countOr({
            field: "unpushed.maxCommits",
            value: stored?.maxCommits,
            fallback: base.maxCommits,
            min: 0,
        }),
        maxAgeMinutes: countOr({
            field: "unpushed.maxAgeMinutes",
            value: stored?.maxAgeMinutes,
            fallback: base.maxAgeMinutes,
        }),
        remindEveryMinutes: countOr({
            field: "unpushed.remindEveryMinutes",
            value: stored?.remindEveryMinutes,
            fallback: base.remindEveryMinutes,
            min: 0,
        }),
    };
}

function mergeDecisions(stored: Partial<DecisionsHookConfig> | undefined): DecisionsHookConfig {
    const base = DEFAULT_HOOKS_CONFIG.decisions;
    const staleness = stored?.staleness;
    const harnesses = Array.isArray(stored?.harnesses)
        ? stored.harnesses.filter((name): name is HarnessName => HARNESS_NAMES.includes(name))
        : base.harnesses;

    return {
        stopHook: STOP_HOOK_MODES.includes(stored?.stopHook as DecisionStopHook)
            ? (stored?.stopHook as DecisionStopHook)
            : base.stopHook,
        maxBlocksPerSession: countOr({
            field: "decisions.maxBlocksPerSession",
            value: stored?.maxBlocksPerSession,
            fallback: base.maxBlocksPerSession,
            min: 0,
        }),
        harnesses,
        harvest: boolOr(stored?.harvest, base.harvest),
        injectAnswers: boolOr(stored?.injectAnswers, base.injectAnswers),
        staleness: {
            warnAfterMinutes: countOr({
                field: "decisions.staleness.warnAfterMinutes",
                value: staleness?.warnAfterMinutes,
                fallback: base.staleness.warnAfterMinutes,
            }),
            alarmAfterMinutes: countOr({
                field: "decisions.staleness.alarmAfterMinutes",
                value: staleness?.alarmAfterMinutes,
                fallback: base.staleness.alarmAfterMinutes,
            }),
            notify: boolOr(staleness?.notify, base.staleness.notify),
        },
    };
}

/** Whether the decision hub needs its Stop and UserPromptSubmit hooks wired at all. */
export function decisionHooksWanted(config: HooksConfig): boolean {
    return config.decisions.stopHook !== "off" || config.decisions.harvest || config.decisions.injectAnswers;
}

/** Whether this run should record the command verbatim in the decision log. */
export function keepsCommand(config: HooksConfig): boolean {
    if (config.logCommands === "always") {
        return true;
    }

    return config.logCommands === "shadow" && config.shadow;
}
