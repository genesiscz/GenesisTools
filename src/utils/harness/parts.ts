import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import type { NativeSessionReader } from "@genesiscz/utils/agent-sessions/types";
import type { TurnQuestionCall, TurnSnapshot, TurnStateInput } from "@genesiscz/utils/ai/transcripts/turn-state";
import type { SliceOptions, TranscriptEnvelope, TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";

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
    toTurns(lines: readonly string[], options?: SliceOptions): Promise<TranscriptTurn[]>;
    envelope?(lines: readonly string[]): TranscriptEnvelope;
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

/** G: the command lines that start and resume a session. Single source for TS and the Swift generator. */
export interface LaunchRecipe {
    runArgv(input: { account?: string; model?: string; prompt?: string }): string[];
    resumeArgv(input: { sessionId: string; account?: string }): string[];
    /** The longest prompt the harness accepts on its command line, in bytes. */
    readonly promptLimitBytes: number;
}

/** H: the slash command that ends an interactive session. */
export interface ExitCommand {
    readonly command: string;
}

/** O: whether this process runs inside the harness, and which session it is. */
export interface HostResolver {
    /** The environment variable the harness sets to its own session id. */
    readonly sessionEnvKey: string;
    detects(env: NodeJS.ProcessEnv): boolean;
    resolve(env: NodeJS.ProcessEnv): Partial<AgentRuntimeContext>;
}

/** N: how to recognise the harness in a process command line. */
export interface ProcessSignature {
    matches(command: string): boolean;
    sessionIdFromCommand?(command: string): string | null;
}

/**
 * The parts whose contract is written here, by name. `types.ts` adds the parts whose contract is not written yet
 * (`PendingContractPart`), so a driver can only declare those pending.
 */
export interface HarnessPartContracts {
    locate: TranscriptLocator;
    parse: TranscriptParser;
    turnState: TurnStateReader;
    questions: QuestionSignalReader;
    launch: LaunchRecipe;
    exit: ExitCommand;
    host: HostResolver;
    process: ProcessSignature;
    history: NativeSessionReader;
}
