import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import type { ResumeOptions } from "@genesiscz/utils/agent-sessions/resume-argv";
import type { NativeSessionReader } from "@genesiscz/utils/agent-sessions/types";
import type { ResolvedTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import type { TurnQuestionCall, TurnSnapshot, TurnStateInput } from "@genesiscz/utils/ai/transcripts/turn-state";
import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";
import type { WorkerCapabilities } from "@genesiscz/utils/worker/capabilities";

/**
 * The contracts of the coding-agent parts whose implementation can live in `@genesiscz/utils`, next to the
 * provider plugin (plan "Plugenize the harnesses", section 2.7, refreshed 2026-10-30). Type-only on purpose: a
 * driver's parts are lazy loaders, and importing this module costs nothing at run time.
 *
 * Each contract is written from the code it will wrap, not invented: the turn-state reader returns the existing
 * `TurnSnapshot`, the question reader the existing `TurnQuestionCall`, and the history part is the existing
 * `NativeSessionReader`. A part whose implementation lives in a tool (`src/cmux`, `src/question`, `src/ai-spend`,
 * `src/mcp-manager`, `src/hub`, the worker drivers) has its contract in that tool, because `src/utils/**` never
 * imports `@app/*`; the driver then names the tool owner (`toolOwned`, `types.ts`).
 */

/** C: where a harness keeps its transcripts, and how a path or an id prefix maps to a session. */
export interface TranscriptLocator {
    /** The default native roots, honouring the harness's own home override. */
    roots(): string[];
    /** The session id a transcript path names, or null when the path is not this harness's transcript. */
    idFromPath(path: string): string | null;
    /** Sessions whose id equals or starts with `query`, newest first. */
    find(query: string, roots?: readonly string[]): Promise<LocatedTranscript[]>;
    /** Roots of the transcripts `tools <agent> run --worker` writes, when the harness has workers. */
    workerRoots?(): string[];
}

export interface LocatedTranscript {
    sessionId: string;
    filePath: string;
    /** Sibling files that belong to the same session (Grok's `events.jsonl`, Claude subagent files). */
    extraFiles?: string[];
}

/** D: transcript lines to the provider-neutral turns every renderer reads. */
export interface TranscriptParser {
    /** The turns of one transcript file (`index` numbers a chain of files, earliest first). */
    fromFile(resolved: ResolvedTranscript, path: string, index: number): Promise<TranscriptTurn[]>;
    /**
     * The turns of some of a transcript's lines (the end of a file too large to parse whole). Claude has its own tail
     * reader (`lastClaudeAssistantText` in hub/lib/widget/snapshot.ts) and gets no turns here.
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

/** The structural question signals: a question tool, a plan approval, a permission prompt. */
export interface QuestionSignalReader {
    /** Every question the tail leaves open, each with the tool call id hooks, inbox and widget agree on. */
    open(input: TurnStateInput): TurnQuestionCall[];
}

/** How a flag takes its value: none, a required next word (or `=value`), or only an `=value`. */
export type FlagArity = "none" | "value" | "optional";

/** G: the command line that resumes a session. Single source for TS and (P7) the Swift generator. */
export interface LaunchRecipe {
    /** Argv that resumes an interactive TUI session, through `tools <agent>` when an account is pinned. */
    resumeArgv(sessionId: string, options: ResumeOptions): string[];
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
     * The second log the turn state needs beside a transcript, or null for none: Grok writes its permission prompts
     * to `events.jsonl` in the session folder; Claude's go to its `Notification` hook and Codex persists none.
     */
    eventLog(transcriptPath: string): string | null;
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
}

/** Parts that wrap parsers and readers: a driver holds a loader, so reading the driver never loads them. */
export interface LazyPartContracts {
    locate: TranscriptLocator;
    parse: TranscriptParser;
    questions: QuestionSignalReader;
    history: NativeSessionReader;
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
}

/**
 * The parts whose contract is written here, by name. `types.ts` adds the parts whose contract is not written yet
 * (`PendingContractPart`), so a driver can only declare those pending.
 */
export type HarnessPartContracts = LazyPartContracts & EagerPartContracts;
