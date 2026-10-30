import { logger } from "@genesiscz/utils/logger";
import { resolveHistoryProvider } from "./provider";
import type { BackwardRead, ForwardRead, ReadBackwardOptions, ReadForwardOptions, TurnBoundary } from "./types";

/**
 * A session's newest entries, from the transcript a hook names (`transcript_path`), through its provider's reader
 * (`NativeSessionReader.readBackward`): the door a hook or a tool uses to read a conversation from its end. `kind` is
 * the harness (`claude`, `codex`, `grok`) or a provider id; the provider finds the session source for the file.
 */
export async function readSessionBackward({
    kind,
    transcriptPath,
    ...options
}: ReadBackwardOptions & { kind: string; transcriptPath: string }): Promise<BackwardRead> {
    const { reader } = resolveHistoryProvider(kind);
    const found = await reader.discover(reader.roots(), { filePaths: [transcriptPath], signal: options.signal });
    const source =
        found.sources.find(
            (candidate) => candidate.filePath === transcriptPath || candidate.dataPaths.includes(transcriptPath)
        ) ?? found.sources[0];

    if (!source) {
        return {
            entries: [],
            found: false,
            issues: [
                ...found.issues,
                { path: transcriptPath, message: `No ${kind} session source for this transcript` },
            ],
        };
    }

    return reader.readBackward(source, options);
}

/** The provider's normalized identity and optional timestamp of the prompt that opened the current turn. */
export async function readSessionTurnBoundary({
    kind,
    transcriptPath,
    ...options
}: Omit<ReadBackwardOptions, "until"> & { kind: string; transcriptPath: string }): Promise<TurnBoundary | null> {
    const { reader } = resolveHistoryProvider(kind);
    const found = await reader.discover(reader.roots(), { filePaths: [transcriptPath], signal: options.signal });
    const source = found.sources.find(
        (candidate) => candidate.filePath === transcriptPath || candidate.dataPaths.includes(transcriptPath)
    );

    for (const issue of found.issues) {
        logger.warn(issue, "Turn boundary discovery issue");
    }

    if (!source) {
        logger.warn({ path: transcriptPath, kind }, "No session source for turn boundary");
        return null;
    }

    return reader.readTurnBoundary(source, options);
}

/**
 * The session each transcript continued in (`NativeSessionReader.continuedIn`), keyed by transcript path; a transcript
 * that was not continued, or that no source owns, is absent. One discovery serves every path, so a listing that reads
 * many tails pays for it once.
 */
export async function readSessionsContinuedIn({
    kind,
    transcriptPaths,
    signal,
}: {
    kind: string;
    transcriptPaths: readonly string[];
    signal?: AbortSignal;
}): Promise<Map<string, string>> {
    const successors = new Map<string, string>();

    if (transcriptPaths.length === 0) {
        return successors;
    }

    const { reader } = resolveHistoryProvider(kind);
    const found = await reader.discover(reader.roots(), { filePaths: [...transcriptPaths], signal });

    for (const issue of found.issues) {
        logger.debug(issue, "Continued-in discovery issue");
    }

    for (const path of transcriptPaths) {
        const source = found.sources.find(
            (candidate) => candidate.filePath === path || candidate.dataPaths.includes(path)
        );

        if (!source) {
            logger.debug({ path, kind }, "No session source to read a continued-in pointer from");
            continue;
        }

        const successor = await reader.continuedIn(source);

        if (successor) {
            successors.set(path, successor);
        }
    }

    return successors;
}

/** Where following a session's continued-in pointers ended: the live id, and every id on the way, oldest first. */
export interface SessionContinuation {
    liveId: string;
    chain: string[];
}

/** A conversation is handed on a few times at most; a longer chain is a loop in the data, not a conversation. */
const MAX_CONTINUATION_HOPS = 16;

/**
 * Follows a session through the sessions it continued in to the one that goes on (Claude Code's ← key or
 * `/background` hand a conversation to a new id). `successorOf` answers one hop; a pointer back to an id already on
 * the chain, or a chain past the hop limit, stops at the last new id and logs it.
 */
export async function followSessionContinuations(
    sessionId: string,
    successorOf: (sessionId: string) => Promise<string | undefined>
): Promise<SessionContinuation> {
    const chain = [sessionId];

    for (let hop = 0; hop < MAX_CONTINUATION_HOPS; hop++) {
        const current = chain[chain.length - 1];
        const next = await successorOf(current);

        if (!next) {
            return { liveId: current, chain };
        }

        if (chain.includes(next)) {
            logger.warn({ sessionId, chain, next }, "Continued-in pointers form a loop; stopping at the last new id");
            return { liveId: current, chain };
        }

        chain.push(next);
    }

    logger.warn({ sessionId, chain, maxHops: MAX_CONTINUATION_HOPS }, "Continued-in chain stopped at its hop limit");
    return { liveId: chain[chain.length - 1], chain };
}

/**
 * A session's rows from a byte offset to its end, through its provider's reader (`NativeSessionReader.readForward`):
 * the door an incremental scan uses, so it reads only what was appended since its last `endOffset`.
 */
export async function readSessionForward({
    kind,
    transcriptPath,
    ...options
}: ReadForwardOptions & { kind: string; transcriptPath: string }): Promise<ForwardRead> {
    const { reader } = resolveHistoryProvider(kind);
    const found = await reader.discover(reader.roots(), { filePaths: [transcriptPath], signal: options.signal });
    const source =
        found.sources.find(
            (candidate) => candidate.filePath === transcriptPath || candidate.dataPaths.includes(transcriptPath)
        ) ?? found.sources[0];

    if (!source) {
        const message = `No ${kind} session source for this transcript`;
        logger.warn({ path: transcriptPath, kind, issues: found.issues }, message);
        return { rows: [], file: null, endOffset: 0, issues: [...found.issues, { path: transcriptPath, message }] };
    }

    return reader.readForward(source, options);
}
