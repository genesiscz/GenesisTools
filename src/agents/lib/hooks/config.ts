import { DECISIONS_HOOK_SECTION, type DecisionsHookConfig } from "@app/question/lib/decisions/hook-config";
import { QUESTIONS_HOOK_SECTION, type QuestionsConfig } from "@genesiscz/utils/agents/dialogs/hook-config";
import {
    type HookConfigSection,
    type HookDoctorRow,
    type HookEntryKind,
    type HookInstallOverrides,
    hooksConfigPath,
    readStoredHooksConfig,
} from "@genesiscz/utils/agents/hooks/config-section";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { DiffCategory } from "./diff/classify";
import type { FullDiffMode } from "./diff/full";
import type { DiffThemeName } from "./diff/theme";
import { AGENTS_TALK_HOOK_SECTION, type AgentsTalkConfig } from "./sections/agents-talk";
import { CORE_HOOK_SECTION, defaultLogPath } from "./sections/core";
import type { FillMode, Highlighter, HighlightMode } from "./sections/diff";
import { DIFF_HOOK_SECTION, diffForHarness } from "./sections/diff";
import { GUARD_HOOK_SECTION } from "./sections/guard";
import { MODS_HOOK_SECTION } from "./sections/mods";
import { UNPUSHED_HOOK_SECTION, type UnpushedConfig } from "./sections/unpushed";

export { defaultLogPath } from "./sections/core";
export type { FillMode, Highlighter, HighlightMode } from "./sections/diff";

export type HookOutcome = "allow" | "context" | "warn" | "block";
export type HarnessName = HarnessId;
export const HARNESS_NAMES: readonly HarnessName[] = ACCOUNT_PROVIDER_ALIASES;

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
    return diffForHarness(config.diff, harness);
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
    agentModel: { enabled: boolean; format: "label" | "short" | "version" };
    /**
     * The agents panel rows under the prompt name each subagent's model beside its type
     * (`general-purpose · sonnet-5-5  Reading foo.ts  4s · ↓ 58k tokens`). Claude Code's `subagentStatusLine`
     * setting draws them, so `tools agents hooks install` (and `mods enable agentRow --write`) wires
     * `hook-subagent-line.ts` there while this is on. `format`: the model as `sonnet-5-5` (`label`), `S` (`short`) or
     * `S5.5` (`version`); `effort`: the effort beside it, `S5.5(xhigh)`.
     */
    agentRow: { enabled: boolean; format: "label" | "short" | "version"; effort: boolean };
    /**
     * The Decisions sidebar (`/decisions`, the band's `decisions` chip): every decision of the session from the
     * decision log and its messages, by state, an answer staged per decision and sent in one message, and `jump to`
     * the first ask. `chip`: shown while the session has any decision, only while one waits, or never. `expand`:
     * which rows start open: the waiting ones, all, or none. `history`: the answered, done and closed decisions
     * start folded under one `show N answered` row, or shown. `enter`: Enter in an answer field stages it, and Enter
     * again on the staged, unchanged answer sends every staged answer (`stage-then-send`), or only stages (`stage`).
     */
    decisions: {
        enabled: boolean;
        chip: "any" | "waiting" | "off";
        expand: "waiting" | "all" | "none";
        history: "collapsed" | "shown";
        enter: "stage-then-send" | "stage";
    };
    /**
     * The Inbox sidebar (`/mod-inbox`, the band's `inbox` chip): the forms, messages, answers and todos the session
     * put in the GenesisTools inbox. `chip`: shown while it has any, only while one is unread, or never. `expand`:
     * which entries start open: the unread ones, all, or none.
     */
    inbox: { enabled: boolean; chip: "any" | "unread" | "off"; expand: "unread" | "all" | "none" };
    /** Bare paths, folders, commits and repeated decisions in the main loop's reply become links as it streams. */
    links: { enabled: boolean };
    /**
     * The git band above the prompt: branch, unpushed, dirty, PRs with CI; `/mod-git` switches it per session. One
     * row per checkout the session wrote files or changed git state in, the last first, up to `checkouts`; the
     * session's own folder shows only when it worked there (`cwd: touched`) or first in every session (`always`).
     * The Git sidebar folds each checkout to one line; `expand` says which start open: the first, all, or none.
     * `name` names a row: `repo-folder` gives a linked worktree as `Kalendora/enhancements`, `repo` the main
     * checkout's name alone, `folder` the worktree's folder. `earlier: show` keeps the session's earlier work: the PR
     * of a branch it worked on and switched away from, and the row of a worktree it removed; `hide` shows only what
     * the checkouts have now.
     */
    git: {
        enabled: boolean;
        labels: "full" | "minimal";
        checkouts: number;
        cwd: "touched" | "always";
        expand: "first" | "all" | "none";
        name: "repo-folder" | "repo" | "folder";
        earlier: "show" | "hide";
    };
    /** `[ask]` beside a finished tool row: quotes the row into the prompt. */
    askRow: { enabled: boolean };
    /** The running tool, its time and the working subagents on the spinner line. */
    spinner: { enabled: boolean };
    /**
     * The prompt cache countdown in the band: yellow under `cautionMinutes`, red under `warnMinutes`; `others` adds
     * the other sessions inside the yellow window.
     */
    cacheBand: { enabled: boolean; warnMinutes: number; cautionMinutes: number; others: boolean };
    /**
     * What the session keeps on disk (its /tmp/cc scratch folder, Claude Code's task output, the worktrees it made or
     * holds) and the free disk, every `minutes`; the row opens the Session files sidebar.
     */
    tmpUsage: { enabled: boolean; minutes: number };
    /** One band row per working subagent: model, age, idle time, tool calls; red past `warnMinutes`. */
    agentsBand: { enabled: boolean; warnMinutes: number };
    /**
     * What the classic hooks hand the model: `tokens` shows the estimate as a band chip that opens a sidebar, `dedupe`
     * replaces a context block already given to the same loop since its last compaction with a one-line receipt.
     */
    hooks: { tokens: boolean; dedupe: boolean };
    /** `readings`: routine refreshes go to `mods-log/<feature>.jsonl`, batched by file. */
    log: { readings: boolean };
    /**
     * The sidebars a band row opens: `hints` says in the status bar at a sidebar's foot what the focused button does,
     * `feedback` shows what a press did there (`line`), as a toast (`toast`), or both, and `focus` says when a docked
     * sidebar takes the keys as it opens: when a slash command opened it (`command`), `always`, or `never`.
     */
    sidebar: { hints: boolean; feedback: "line" | "toast" | "both"; focus: "command" | "always" | "never" };
    /**
     * A main-loop reply that ends on what it was about to do while nothing can wake the session: the band shows the
     * sentence with `continue` and `dismiss` (`button`), or continues by itself after `minutes` (`auto`).
     */
    stall: { enabled: boolean; action: "button" | "auto"; minutes: number };
}

/** The keys at the top of `hooks.json`, beside the sections. */
export interface CoreHooksConfig {
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

export interface HooksConfig extends CoreHooksConfig {
    guard: GuardConfig;
    diff: DiffConfig;
    decisions: DecisionsHookConfig;
    questions: QuestionsConfig;
    agentsTalk: AgentsTalkConfig;
    mods: ModsConfig;
    unpushed: UnpushedConfig;
}

/** What `doctor`'s settings rows may show besides each section's own value. */
export interface HookDoctorFacts {
    rules: { builtIn: number; custom: number; off: string; perHarness: string };
    /** Claude Code's own Bash diff, as `doctor` labels it. */
    nativeDiff: string;
    /** Whether `settings.json` holds a Stop entry of ours. */
    stopHookWired: boolean;
}

/** What a section's `set` may need besides the key and value. */
export interface HookSetContext {
    /** The rule ids a `rules.<id>` key may name: the built-in rules, plus the custom ones when the caller loaded them. */
    ruleIds: ReadonlySet<string>;
}

/**
 * Every hook feature, each owning a section of `hooks.json`: its defaults, its merge, its `set` keys, the hook entries
 * it needs wired and its `doctor` rows. `core` is the top-level keys. The order is the order `doctor` prints them in.
 */
export const HOOK_SECTION_NAMES = [
    "guard",
    "diff",
    "questions",
    "agentsTalk",
    "decisions",
    "unpushed",
    "mods",
    "core",
] as const;
export type HookSectionName = (typeof HOOK_SECTION_NAMES)[number];

/** The value each section owns. */
export type HookSectionValues = { [Name in Exclude<HookSectionName, "core">]: HooksConfig[Name] } & {
    core: CoreHooksConfig;
};

export const HOOK_CONFIG_SECTIONS: {
    readonly [Name in HookSectionName]: HookConfigSection<HookSectionValues[Name], HookDoctorFacts, HookSetContext>;
} = {
    guard: GUARD_HOOK_SECTION,
    diff: DIFF_HOOK_SECTION,
    questions: QUESTIONS_HOOK_SECTION,
    agentsTalk: AGENTS_TALK_HOOK_SECTION,
    decisions: DECISIONS_HOOK_SECTION,
    unpushed: UNPUSHED_HOOK_SECTION,
    mods: MODS_HOOK_SECTION,
    core: CORE_HOOK_SECTION,
};

function coreOf(config: HooksConfig): CoreHooksConfig {
    return {
        logPath: config.logPath,
        shadow: config.shadow,
        logCommands: config.logCommands,
        maxLogMB: config.maxLogMB,
    };
}

/** How the config holds each section's value: under its key, or (core) at the top level. */
const SECTION_SLOTS: {
    readonly [Name in HookSectionName]: {
        get(config: HooksConfig): HookSectionValues[Name];
        put(config: HooksConfig, value: HookSectionValues[Name]): HooksConfig;
    };
} = {
    guard: { get: (config) => config.guard, put: (config, guard) => ({ ...config, guard }) },
    diff: { get: (config) => config.diff, put: (config, diff) => ({ ...config, diff }) },
    questions: { get: (config) => config.questions, put: (config, questions) => ({ ...config, questions }) },
    agentsTalk: { get: (config) => config.agentsTalk, put: (config, agentsTalk) => ({ ...config, agentsTalk }) },
    decisions: { get: (config) => config.decisions, put: (config, decisions) => ({ ...config, decisions }) },
    unpushed: { get: (config) => config.unpushed, put: (config, unpushed) => ({ ...config, unpushed }) },
    mods: { get: (config) => config.mods, put: (config, mods) => ({ ...config, mods }) },
    core: { get: coreOf, put: (config, core) => ({ ...config, ...core }) },
};

export function sectionValue<Name extends HookSectionName>(config: HooksConfig, name: Name): HookSectionValues[Name] {
    return SECTION_SLOTS[name].get(config);
}

export function withSectionValue<Name extends HookSectionName>(
    config: HooksConfig,
    name: Name,
    value: HookSectionValues[Name]
): HooksConfig {
    return SECTION_SLOTS[name].put(config, value);
}

/** The hook entries every feature needs, given the config and an install's overrides, in no particular order. */
export function wantedEntryKinds(config: HooksConfig, overrides: HookInstallOverrides): Set<HookEntryKind> {
    const kinds = new Set<HookEntryKind>();

    for (const name of HOOK_SECTION_NAMES) {
        for (const kind of sectionEntries(config, name, overrides)) {
            kinds.add(kind);
        }
    }

    return kinds;
}

function sectionEntries<Name extends HookSectionName>(
    config: HooksConfig,
    name: Name,
    overrides: HookInstallOverrides
): readonly HookEntryKind[] {
    const section: HookConfigSection<HookSectionValues[Name], HookDoctorFacts, HookSetContext> =
        HOOK_CONFIG_SECTIONS[name];
    return section.entries(sectionValue(config, name), overrides);
}

/** Every section's `doctor` rows, in section order. */
export function doctorRows(config: HooksConfig, facts: HookDoctorFacts): HookDoctorRow[] {
    return HOOK_SECTION_NAMES.flatMap((name) => sectionDoctor(config, name, facts));
}

function sectionDoctor<Name extends HookSectionName>(
    config: HooksConfig,
    name: Name,
    facts: HookDoctorFacts
): readonly HookDoctorRow[] {
    const section: HookConfigSection<HookSectionValues[Name], HookDoctorFacts, HookSetContext> =
        HOOK_CONFIG_SECTIONS[name];
    return section.doctor(sectionValue(config, name), facts);
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

/** The shipped configuration, every section's defaults in the order the file lists them. */
export const DEFAULT_HOOKS_CONFIG: HooksConfig = {
    guard: GUARD_HOOK_SECTION.defaults(),
    diff: DIFF_HOOK_SECTION.defaults(),
    decisions: DECISIONS_HOOK_SECTION.defaults(),
    questions: QUESTIONS_HOOK_SECTION.defaults(),
    agentsTalk: AGENTS_TALK_HOOK_SECTION.defaults(),
    mods: MODS_HOOK_SECTION.defaults(),
    unpushed: UNPUSHED_HOOK_SECTION.defaults(),
    ...CORE_HOOK_SECTION.defaults(),
};

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

/** The copy of the shipped defaults a writer stores beside the full settings (see `storedOverrides`). */
/**
 * Synchronous on purpose: three hook entrypoints call this before they read stdin, and
 * the process must not pay for an async config reader. `agentsDataDir()` resolves the same
 * directory `Storage` would, so `GENESIS_TOOLS_HOME` still keeps the suite out of the real home.
 */
export function loadHooksConfig(path = hooksConfigPath()): HooksConfig {
    let stored: Record<string, unknown> | null = null;

    lastLoadError = undefined;
    lastProblems = [];

    // No config file is the normal case, not an error: the defaults below ARE the shipped configuration.
    // `hooks doctor` prints which of the two is in effect.
    const read = readStoredHooksConfig(path);
    lastLoadError = read.error;
    stored = read.stored;

    if (!stored) {
        return { ...DEFAULT_HOOKS_CONFIG, logPath: defaultLogPath() };
    }

    return mergeStoredConfig(stored);
}

/**
 * A stored config merged over the shipped one exactly as the hooks load it. Exported so the parity
 * scripts evaluate the SAME config the hooks would, with no temp file round trip.
 */
export function mergeStoredConfig(stored: Record<string, unknown>): HooksConfig {
    const part = (section: { key: string | null }): unknown => (section.key === null ? stored : stored[section.key]);

    return {
        guard: GUARD_HOOK_SECTION.merge(part(GUARD_HOOK_SECTION), lastProblems),
        diff: DIFF_HOOK_SECTION.merge(part(DIFF_HOOK_SECTION), lastProblems),
        decisions: DECISIONS_HOOK_SECTION.merge(part(DECISIONS_HOOK_SECTION), lastProblems),
        questions: QUESTIONS_HOOK_SECTION.merge(part(QUESTIONS_HOOK_SECTION), lastProblems),
        agentsTalk: AGENTS_TALK_HOOK_SECTION.merge(part(AGENTS_TALK_HOOK_SECTION), lastProblems),
        mods: MODS_HOOK_SECTION.merge(part(MODS_HOOK_SECTION), lastProblems),
        unpushed: UNPUSHED_HOOK_SECTION.merge(part(UNPUSHED_HOOK_SECTION), lastProblems),
        ...CORE_HOOK_SECTION.merge(part(CORE_HOOK_SECTION), lastProblems),
    };
}

/** Whether this run should record the command verbatim in the decision log. */
export function keepsCommand(config: HooksConfig): boolean {
    if (config.logCommands === "always") {
        return true;
    }

    return config.logCommands === "shadow" && config.shadow;
}
