import { existsSync } from "node:fs";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { logger } from "@genesiscz/utils/logger";
import {
    type ComputedSessionChanges,
    type ExcludedFile,
    loadSessionChanges,
    mergeTurnFiles,
    storeBlobs,
    type TurnChanges,
    type TurnFile,
} from "@genesiscz/utils/session-changes";
import { type FileDiff, fileDiff, readBlobs } from "./diff";
import type { ChangeEvent } from "./log";
import { gitObjectSink, objectsDir } from "./objects";

const { log } = logger.scoped("agents-changes");

/** `diff` is the unified text, or null with `diffSkipped` saying why; `added`/`removed` count its lines. */
export function diffFields(diff: FileDiff | undefined): Record<string, unknown> {
    if (!diff) {
        return { diff: null, diffSkipped: "missing-blob" };
    }

    return diff.diff === null
        ? { diff: null, diffSkipped: diff.reason }
        : { diff: diff.diff, added: diff.added, removed: diff.removed };
}

/** What happened to the file. An unknown state (`undefined`) is neither a creation nor a deletion. */
export function changeStatus(file: Pick<TurnFile, "beforeOid" | "afterOid">): "added" | "deleted" | "modified" {
    if (file.beforeOid === null) {
        return "added";
    }

    return file.afterOid === null ? "deleted" : "modified";
}

/** One file of the JSON output. `span` (how many calls the before/after pair covers) only for one call's files. */
export function fileJson(
    item: TurnFile,
    diffs: Map<string, FileDiff> | null,
    oneCall: boolean
): Record<string, unknown> {
    return {
        path: item.path,
        beforeOid: item.beforeOid ?? null,
        afterOid: item.afterOid ?? null,
        status: changeStatus(item),
        source: item.via === "notebook" ? "edit" : item.via,
        skipped: item.skipped ?? null,
        via: item.via,
        confidence: item.confidence,
        toolUseIds: item.toolUseIds,
        ...(oneCall ? { span: item.toolUseIds.length } : {}),
        ...(item.agentIds ? { agentIds: item.agentIds } : {}),
        ...(diffs ? diffFields(diffs.get(item.path)) : {}),
    };
}

/**
 * A session some harness has a transcript of. A Grok session has none this command reads, and
 * without a change log it truly changed nothing recorded: that is an empty answer, not an error.
 */
export async function isKnownSession(session: string): Promise<boolean> {
    try {
        await resolveTranscript(session);
        return true;
    } catch (error) {
        log.debug({ error, session }, "no transcript of this session anywhere");
        return false;
    }
}

/**
 * Store the blobs the output names, so a reader can `git cat-file` every before-state it lists.
 * Only on `--store-blobs`: `changes` is an inspection, and an inspection writes nothing by default.
 */
export function persistBlobs(files: readonly TurnFile[], blobs: Map<string, Buffer>): void {
    const sink = gitObjectSink(undefined, (line) => log.debug(line));

    try {
        storeBlobs(files, blobs, (list) => sink.hashAll?.(list) ?? list.map((bytes) => sink.hash(bytes)));
    } catch (error) {
        // Without the blobs a reader shows "before-state not in the change log"; the list itself stays right.
        log.warn({ error }, "could not store transcript blobs in the change-log object store");
    }
}

/**
 * A unified diff per file, from the blobs the transcript produced or the change-log object store.
 * An oid that is `undefined` means the state is unknown; `null` means no file (created or deleted).
 */
export function diffsFor(
    files: ReadonlyArray<Pick<TurnFile, "path" | "beforeOid" | "afterOid"> & { skipped?: string | null }>,
    blobs: Map<string, Buffer> = new Map()
): Map<string, FileDiff> {
    const oids = files.flatMap((file) => [file.beforeOid, file.afterOid]).filter((oid): oid is string => Boolean(oid));
    const stored = readBlobs(oids.filter((oid) => !blobs.has(oid)));
    const bytes = (oid: string | null | undefined): Buffer | null | undefined =>
        oid === null ? null : oid === undefined ? undefined : (blobs.get(oid) ?? stored.get(oid));

    return new Map(
        files.map((file) => [
            file.path,
            file.skipped === "binary" || file.skipped === "large"
                ? { diff: null, reason: "binary" as const }
                : fileDiff({ path: file.path, before: bytes(file.beforeOid), after: bytes(file.afterOid) }),
        ])
    );
}

/** The turns' excluded files that are not kept; with `tool`, only the ones that call excluded. */
export function excludedOf(turns: readonly TurnChanges[], kept: readonly TurnFile[], tool?: string): ExcludedFile[] {
    const keptPaths = new Set(kept.map((file) => file.path));
    const byPath = new Map<string, ExcludedFile>();

    for (const turn of turns) {
        for (const item of turn.excluded) {
            if (tool !== undefined && !item.toolUseIds.includes(tool)) {
                continue;
            }

            if (!keptPaths.has(item.path) && !byPath.has(item.path)) {
                byPath.set(item.path, item);
            }
        }
    }

    return [...byPath.values()];
}

export function selectTurns(
    turns: TurnChanges[],
    all: TurnChanges[],
    options: ChangesOptions,
    count?: number
): TurnChanges[] | null {
    if (options.turn) {
        return all.filter((turn) => turn.turnId === options.turn);
    }

    if (count === undefined && options.tool) {
        // One call belongs to one turn: merging the whole session would span other turns' edits.
        const tool = options.tool;
        return all.filter((turn) => [...turn.files, ...turn.excluded].some((file) => file.toolUseIds.includes(tool)));
    }

    return count === undefined ? null : turns;
}

/**
 * The files one tool call changed, from a session that is already loaded: the turn that holds the
 * call, merged, then only the paths the call touched. `--tool` and `--tools` both use it.
 */
export function toolCallFiles(
    changes: Pick<ComputedSessionChanges, "turns" | "files">,
    tool: string
): { files: TurnFile[]; excluded: ExcludedFile[] } {
    const selected = selectTurns([], changes.turns, { tool });
    const merged = selected ? mergeTurnFiles(selected) : changes.files;
    const files = merged.filter((item) => item.toolUseIds.includes(tool));
    return { files, excluded: excludedOf(selected ?? changes.turns, files, tool) };
}

export interface ChangesOptions {
    turn?: string;
    lastTurn?: boolean;
    lastTurns?: string;
    json?: boolean;
    raw?: boolean;
    tool?: string;
    tools?: string;
    diff?: boolean;
    storeBlobs?: boolean;
}

/**
 * What `tools agents changes <session> --tools <ids> --json` prints, from the session's change log: the CLI and
 * the hub server's door share it so their output is the same bytes. Only those calls' turns are computed: the hub
 * asks for each new call of a live session, and the whole session cost 2.5 s per ask on a 200 MB transcript.
 */
export async function toolChangesJson(input: {
    session: string;
    toolIds: readonly string[];
    /** The change log path and its rows, read by the caller (`sessionChangesPath`, `readJsonlRows`). */
    file: string;
    rows: ChangeEvent[];
    storeBlobs: boolean;
}): Promise<{ result: Record<string, unknown> } | { error: string }> {
    const { session, toolIds, file } = input;
    const changes = loadSessionChanges({ sessionId: session, log: input.rows, onlyTools: [...toolIds] });

    if (!changes.transcriptPath && !existsSync(file) && !(await isKnownSession(session))) {
        // An empty list would read as "this session changed nothing", for a mistyped id too.
        return { error: `No change log and no transcript for session ${session}` };
    }

    // The hub asks for every tool row on screen in one run: a large session costs about 0.7 s to read, and
    // one process per row read it once per row (11 at a time).
    const perTool = toolIds.map((tool) => ({ tool, ...toolCallFiles(changes, tool) }));

    if (input.storeBlobs) {
        persistBlobs(
            perTool.flatMap((entry) => entry.files),
            changes.blobs
        );
    }

    log.debug({ session, tools: toolIds.length }, "session changes for several tool calls");
    return {
        result: {
            session,
            tools: perTool.map(({ tool, files, excluded }) => {
                const diffs = diffsFor(files, changes.blobs);
                return {
                    toolUseId: tool,
                    files: files.map((item) => fileJson(item, diffs, true)),
                    excluded: excluded.map((item) => ({ path: item.path, reason: item.reason, via: item.via })),
                };
            }),
            log: file,
            objects: objectsDir(),
            transcript: changes.transcriptPath,
        },
    };
}
