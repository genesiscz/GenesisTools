import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import type { ResumeOptions } from "@genesiscz/utils/agent-sessions/resume-argv";
import type { DialogKeyMap } from "@genesiscz/utils/agents/dialogs/keys";
import type {
    FolderReads,
    HarnessRoots,
    RankedHit,
    ResolvedTranscript,
    TranscriptSource,
} from "@genesiscz/utils/ai/transcripts/resolve";
import type { TitledSession, TitleSearch } from "@genesiscz/utils/ai/transcripts/session-title";
import type { TurnSnapshot, TurnStateInput } from "@genesiscz/utils/ai/transcripts/turn-state-types";
import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";
import type { WorkerCapabilities } from "@genesiscz/utils/worker/capabilities";

/**
 * The contracts of the coding-agent parts whose implementation can live in `@genesiscz/utils`, next to the
 * provider plugin (plan "Plugenize the harnesses", section 2.7, refreshed 2026-10-30). Type-only on purpose: a
 * driver's parts are lazy loaders, and importing this module costs nothing at run time.
 *
 * Each contract is written from the code it wraps, not invented: the turn-state reader returns the existing
 * `TurnSnapshot`. The history reader is not a part: it is `ProviderPlugin.codingAgent`, reached through
 * `resolveHistoryProvider`, the one door to it. A per-harness table whose code lives in
 * a tool (`src/cmux`, `src/question`, `src/ai-spend`, `src/mcp-manager`, `src/hub`, the worker drivers) stays in that
 * tool, keyed by `HarnessId`, because `src/utils/**` never imports `@app/*`.
 */

/**
 * C: where a harness keeps its transcripts, and how a query or an absolute path maps to a session. Synchronous,
 * because `resolveTranscriptsWith` and `resolveCodexNative` are; each locator gets only its own harness's roots
 * (`HarnessRoots`, the caller's injection over `defaultRoots`) and reads only through `FolderReads`, so the batch memo
 * counts every read.
 */
export interface TranscriptLocator {
    /** Where the harness keeps its transcripts on this machine, every home the history reader lists included. */
    defaultRoots(): HarnessRoots;
    /** The roots a transcript path of the harness can sit under, in the order a path is matched against them. */
    pathRoots(roots: HarnessRoots): { root: string; source: TranscriptSource }[];
    /** The session a transcript file of the harness names. */
    sessionOfPath(file: { source: TranscriptSource; stem: string; filePath: string }): ResolvedTranscript;
    /** Every transcript of the harness whose id equals or starts with `query`, with its modification time. */
    find(query: string, roots: HarnessRoots, fs: FolderReads): RankedHit[];
    /** The native transcript a headless worker of the harness writes beside its own log, or null when it writes none. */
    workerNative(worker: ResolvedTranscript, fs: FolderReads): ResolvedTranscript | null;
    /** The transcript roots inside one provider home of the harness (a session's own source home). */
    rootsOfHome(home: string): Partial<HarnessRoots>;
    /** Every session the harness gave a title, read where it keeps titles (`findSessionsByTitle` ranks them). */
    titledSessions(search: TitleSearch): TitledSession[];
}

/** D: transcript lines to the provider-neutral turns every renderer reads. */
export interface TranscriptParser {
    /** The turns of one transcript file (`index` numbers a chain of files, earliest first). */
    fromFile(resolved: ResolvedTranscript, path: string, index: number): Promise<TranscriptTurn[]>;
    /**
     * The turns of some of a transcript's lines (the end of a file too large to parse whole). Claude has its own tail
     * reader too (`lastClaudeAssistantText` in hub/lib/widget/snapshot.ts), and the widget reads every harness here.
     */
    fromLines(resolved: ResolvedTranscript, lines: readonly string[]): TranscriptTurn[];
    /**
     * Tool call id -> its full input as one string, for the calls in `text` (a session file or its tail). A harness
     * whose lines are not read for full inputs returns an empty map, and its calls keep their preview.
     */
    toolInputKeys(text: string): Map<string, string>;
}

/** E: the state of the newest turn, read from a bounded tail of the transcript. */
export interface TurnStateReader {
    read(input: TurnStateInput): TurnSnapshot;
    /** How many tail bytes the reader needs; `TURN_TAIL_BYTES` when absent. */
    readonly tailBytes?: number;
}

/** How a flag takes its value: none, a required next word (or `=value`), or only an `=value`. */
export type FlagArity = "none" | "value" | "optional";

/** What a new interactive session starts with: the account to pin (empty or absent for none), and the first prompt. */
export interface StartOptions {
    readonly account?: string;
    readonly prompt?: string;
}

/** G: the command line that resumes a session. Single source for TS and (P7) the Swift generator. */
export interface LaunchRecipe {
    /** Argv that resumes an interactive TUI session, through `tools <agent>` when an account is pinned. */
    resumeArgv(sessionId: string, options: ResumeOptions): string[];
    /**
     * Argv that starts a new interactive session in a terminal (the hub's "New session" sheet, via `Harness.swift`),
     * with the first prompt when one is given.
     */
    startArgv(options: StartOptions): string[];
    /** Whether `startArgv` pins `options.account`; the hub shows its account field only then. */
    readonly startPinsAccount: boolean;
    /**
     * Whether `tools <agent> cmux open-session` resumes a session into a chosen cmux pane under its own account;
     * otherwise the hub types `resumeArgv` into the pane.
     */
    readonly cmuxOpenSession: boolean;
    /**
     * The flags the agent itself accepts and a resume may carry over from the command that started the tab, read
     * from the agent's own `--help`. Left out on purpose: the model (a session can switch models, so the tab's start
     * flag would pin the wrong one), every resume, continue, fork and session-id flag (the resume sets its own),
     * headless output (`-p`, `--print`, `--output-format`), the directory (the restore types its own `cd`), and help
     * or version.
     */
    readonly resumeFlags: Readonly<Record<string, FlagArity>>;
    /**
     * How the agent's own binary reads a resume target, directly or after a wrapper's `--`: a flag (`--resume`, `-r`),
     * or a `resume` subcommand (Codex); `render` writes that target for a session id.
     */
    readonly resumeSyntax: {
        readonly flags: readonly string[];
        readonly subcommand: boolean;
        render(sessionId: string): string;
    };
}

/** D, F, T: static facts about the shape of a harness's transcript, which readers and renderers branch on. */
export interface TranscriptFacts {
    /**
     * Whether the transcript records a terminal event (a turn's end or error). A Claude session file records none, so
     * a missing one says nothing about its state; for the others a missing one means the turn still runs.
     */
    readonly recordsTerminalEvent: boolean;
    /**
     * Whether the native session file is read by turn through the turn index (`turn-index.ts`), so a reader pages it
     * without parsing the whole file. Only Claude's is (its rows carry the turn structure); Codex and Grok parse once
     * per read and page from memory (`transcriptSnapshot`).
     */
    readonly pagesByTurnIndex: boolean;
    /** Whether the harness writes a session's sub-agents beside it (Claude's `<session>/subagents/`). */
    readonly subagentsOnDisk: boolean;
    /**
     * How coarse the transcript's timestamps are, in ms: 0 when it stamps milliseconds, 1000 when it stamps seconds
     * (Grok), so a wait compares a send time with that much slack.
     */
    readonly timestampResolutionMs: number;
    /** Whether a turn id ends with `:<row uuid>`, so a message anchor finds its turn by the row's uuid (Claude). */
    readonly turnIdsEndWithRowUuid: boolean;
    /**
     * Whether the harness keeps a registry of its running sessions (Claude Code's `~/.claude/sessions`), so a session
     * row's liveness can be read from it instead of guessed.
     */
    readonly keepsLiveRegistry: boolean;
}

/** H: the slash command that ends an interactive session. */
export interface ExitCommand {
    readonly command: string;
}

/** O: whether this process runs inside the harness, and which session it is. */
export interface HostResolver {
    /** The harness's name in `AgentRuntimeContext.agent` (Claude is `claude-code` there). */
    readonly agent: AgentRuntimeContext["agent"];
    /** The environment variable the harness sets to its own session id. */
    readonly sessionEnvKey: string;
    /**
     * The environment variable the harness sets to its own process id (Claude Code's `CLAUDE_PID`), or null. A worker of
     * another harness inherits it from its parent, so a reader trusts it only for this harness's own payload.
     */
    readonly pidEnvKey: string | null;
    detects(env: NodeJS.ProcessEnv): boolean;
    resolve(env: NodeJS.ProcessEnv): Partial<AgentRuntimeContext>;
}

/** N: how to recognise the harness in a process command line. */
export interface ProcessSignature {
    /**
     * Whether a process runs the harness's own CLI: `argv0` is the first word of the command, `name` its basename,
     * `command` the whole space-joined argv (`ps` output). Script installs started through an interpreter
     * (`bash ~/.local/bin/grok`) are matched by the caller through `identity.binary`.
     */
    runsCli(input: { argv0: string; name: string; command: string }): boolean;
    /** For an identified CLI, its index in the whitespace-split command, or null when the boundary is unknown. */
    cliEntryIndex(input: { argv0: string; name: string; command: string }): number | null;
    /**
     * The argv words that make the CLI run one scripted turn without its terminal UI (`claude -p`, `codex exec`): a
     * flag counts anywhere in the command, a subcommand only after the CLI's own word. The plugin's tab-owner check
     * reads them from `lib/Generated/harness-facts.ts`.
     */
    readonly headless: { readonly flags: readonly string[]; readonly subcommands: readonly string[] };
}

/**
 * I: what a hook, the hook config and the change log may assume about the harness that ran them. Plain data in its
 * own module per plugin (`plugins/<plugin>/harness-hooks.ts`), because the guard hook reads it through
 * `harness-hooks.ts`, a door that loads no driver.
 */
export interface HookFacts {
    /** Its diff-log entries are filled from its transcript (`extendFromTranscripts` reads the tool calls there). */
    readonly diffLogFromTranscript: boolean;
    /** Its transcript's earlier tool inputs name the paths a Bash diff attributes (`refreshMentions`). */
    readonly transcriptMentions: boolean;
    /** The GenesisTools mods plugin runs inside it and draws the full diffs itself. */
    readonly modsDrawDiffs: boolean;
    /** Its model may come from `~/.claude/settings.json` when the transcript names none. */
    readonly settingsModel: boolean;
    /**
     * The model its session runs now: the very function its reader carries as `NativeSessionReader.currentModel`
     * (`readers/<harness>-model.ts`), here so a hook or the failure log reads it without loading a reader.
     */
    currentModel(transcriptPath: string): string | null;
    /** Its shell honours a bare zsh glob qualifier such as `(N)`, so the guard allows `zsh-glob-qualifier` there. */
    readonly honoursBareGlobQualifier: boolean;
    /** It renders a hook message with ANSI colour and in full, so the diff hook shows its diffs there. */
    readonly rendersAnsiDiffs: boolean;
    /** Its change-log turn is the id of the prompt row that started it, so a blame line can show the prompt. */
    readonly turnIsPromptId: boolean;
    /** It runs the hook entries of Claude's `settings.json`, so a feature wired there reaches its sessions too. */
    readonly runsClaudeSettingsHooks: boolean;
    /**
     * The SessionStart reminder of how its agents talk to each other while they work (the plugin's
     * `agents-talk-hint.ts` prints it). `tool` names a `tools …` command (`toolCommand`, passed by the generator),
     * because a util names no command of its own.
     */
    agentsTalkHint(tool: (command: string) => string): string;
    /**
     * The SessionStart line may promise that every file the session modifies is tracked (`track-session-files.ts`).
     * Codex shell commands change files no edit hook sees, so only a harness whose edits all pass the hooks says it.
     */
    readonly promisesFileTracking: boolean;
    /** Its transcript marks a compaction with a boundary row, which the plugin's `area-rules.ts` reads. */
    readonly compactBoundaryRows: boolean;
    /**
     * A terminal the user opened without `tools <agent> run` is billed to the account logged in to the session's
     * home (`~/.codex-<name>`), so the account hook reads that home's login. Claude has no home binding.
     */
    readonly homeBindsAccount: boolean;
    /**
     * Its session pin records the auth mode (keychain or token) and the launch `--model` read from the launch env and
     * the process ancestors. The modes and the ancestor walk are Claude Code's; the others get neither, never a guess.
     */
    readonly launchAuthFromAncestor: boolean;
    /**
     * The session journals (pins, cmux records) predate the other harnesses, so a line without `provider` is this
     * harness's, and its own lines omit the field. Exactly one driver sets it (`gen-harness-plugin.ts` refuses
     * otherwise).
     */
    readonly journalOmitsProvider: boolean;
}

/**
 * I: what a hook, the hook config and the change log may assume about the harness that ran them. Plain data in its
 * own module per plugin (`plugins/<plugin>/harness-hooks.ts`), because the guard hook reads it through
 * `harness-hooks.ts`, a door that loads no driver.
 */
export interface HookFacts {
    /** Its diff-log entries are filled from its transcript (`extendFromTranscripts` reads the tool calls there). */
    readonly diffLogFromTranscript: boolean;
    /** Its transcript's earlier tool inputs name the paths a Bash diff attributes (`refreshMentions`). */
    readonly transcriptMentions: boolean;
    /** The GenesisTools mods plugin runs inside it and draws the full diffs itself. */
    readonly modsDrawDiffs: boolean;
    /** Its model may come from `~/.claude/settings.json` when the transcript names none. */
    readonly settingsModel: boolean;
    /** Its shell honours a bare zsh glob qualifier such as `(N)`, so the guard allows `zsh-glob-qualifier` there. */
    readonly honoursBareGlobQualifier: boolean;
    /** It renders a hook message with ANSI colour and in full, so the diff hook shows its diffs there. */
    readonly rendersAnsiDiffs: boolean;
    /** Its change-log turn is the id of the prompt row that started it, so a blame line can show the prompt. */
    readonly turnIsPromptId: boolean;
}

/** Parts that wrap parsers and readers: a driver holds a loader, so reading the driver never loads them. */
export interface LazyPartContracts {
    parse: TranscriptParser;
}

/**
 * Parts that are small pure data or functions (argv builders, flag tables): a driver holds them directly, because
 * their callers are synchronous and a part this small costs nothing to import.
 */
export interface EagerPartContracts {
    launch: LaunchRecipe;
    transcript: TranscriptFacts;
    /** P: what a `tools <agent>` worker of the harness can do; the WorkerDriver that does it lives in the agent's tool. */
    worker: WorkerCapabilities;
    exit: ExitCommand;
    host: HostResolver;
    process: ProcessSignature;
    /**
     * E: the turn state is read by synchronous callers (the dialog guard, `wait`, the live tail), so the reader is
     * held directly; it is pure over parsed records and imports no parser.
     */
    turnState: TurnStateReader;
    /**
     * The keys that answer the harness's question dialog in a terminal pane (`tools claude cmux send`, the inbox), or
     * `supported: false` with the reason a harness has none yet; its answers then go as typed text.
     */
    dialog: DialogKeyMap;
    /**
     * C: synchronous, because `resolveTranscriptsWith` is; a driver holds a `deferredLocator` (`deferred.ts`) that loads
     * its finders on the first call, so the finders cost the hook path nothing.
     */
    locate: TranscriptLocator;
    /** I: the hook facts (`HookFacts`); the hook payload shape stays `HookPayload` in the agents tool. */
    hooks: HookFacts;
}

/** The parts whose contract is written here, by name: every part a driver has. */
export type HarnessPartContracts = LazyPartContracts & EagerPartContracts;
