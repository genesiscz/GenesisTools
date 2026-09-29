import { existsSync } from "node:fs";
import { resolveCachedSessionId, type SessionIdResolution } from "@genesiscz/utils/agent-sessions/cached-title";
import { resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { logger, out } from "@genesiscz/utils/logger";
import {
    type ComputedSessionChanges,
    type ExcludedFile,
    lastChangedTurns,
    loadSessionChanges,
    mergeTurnFiles,
    storeBlobs,
    type TurnChanges,
    type TurnFile,
} from "@genesiscz/utils/session-changes";
import type { Command } from "commander";
import { type FileDiff, fileDiff, readBlobs } from "../lib/changes/diff";
import { type ChangeEvent, lastTurnIds, sessionChangesPath } from "../lib/changes/log";
import { gitObjectSink, objectsDir } from "../lib/changes/objects";

const { log } = logger.scoped("agents-changes");

interface ChangesOptions {
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

export interface RawLogFile {
    path: string;
    beforeOid: string | null;
    afterOid: string | null;
    source: ChangeEvent["source"];
    skipped: ChangeEvent["skipped"] | null;
    /** Why the first before-state was not stored; null when it was (or the row predates the per-side fields). */
    beforeSkipped: ChangeEvent["beforeSkipped"] | null;
    /** Why the last after-state was not stored. */
    afterSkipped: ChangeEvent["afterSkipped"] | null;
    /** Every call that changed the path, in log order. Rows from before 2026-09-24 carry none. */
    toolUseIds: string[];
}

/** `before -> after`, each side its oid, `-` for none, or the reason it was not stored. */
export function rawTransition(file: RawLogFile): string {
    if (file.skipped && !file.beforeSkipped && !file.afterSkipped) {
        // A row from before the per-side fields: it does not say which side was skipped.
        return file.skipped;
    }

    return `${file.beforeSkipped ?? file.beforeOid ?? "-"} -> ${file.afterSkipped ?? file.afterOid ?? "-"}`;
}

/** A row from before the per-side fields says that a side was skipped, not which one. */
function legacySkipped(row: ChangeEvent): ChangeEvent["skipped"] | undefined {
    return row.beforeSkipped || row.afterSkipped ? undefined : row.skipped;
}

/** The change log as recorded: every row, each path from its first before-state to its last after-state. */
export function rawLogFiles(rows: readonly ChangeEvent[]): RawLogFile[] {
    const byPath = new Map<string, { first: ChangeEvent; last: ChangeEvent; toolUseIds: Set<string> }>();

    for (const row of rows) {
        const existing = byPath.get(row.path);

        if (!existing) {
            byPath.set(row.path, { first: row, last: row, toolUseIds: new Set(row.toolUseId ? [row.toolUseId] : []) });
            continue;
        }

        existing.last = row;

        if (row.toolUseId) {
            existing.toolUseIds.add(row.toolUseId);
        }
    }

    return [...byPath.values()].map(({ first, last, toolUseIds }) => ({
        path: first.path,
        beforeOid: first.beforeOid,
        afterOid: last.afterOid,
        source: last.source,
        skipped: last.afterSkipped ?? first.beforeSkipped ?? legacySkipped(last) ?? null,
        beforeSkipped: first.beforeSkipped ?? null,
        afterSkipped: last.afterSkipped ?? null,
        toolUseIds: [...toolUseIds],
    }));
}

function rawAction(session: string, file: string, rows: ChangeEvent[], options: ChangesOptions, count?: number): void {
    const turns = count === undefined ? null : lastTurnIds(rows, count);
    let selected = turns ? rows.filter((row) => turns.includes(row.turn)) : rows;

    if (options.turn) {
        selected = selected.filter((row) => row.turn === options.turn);
    }

    if (options.tool) {
        selected = selected.filter((row) => row.toolUseId === options.tool);
    }

    const files = rawLogFiles(selected);
    const diffs = options.tool || options.diff ? diffsFor(files) : null;

    if (options.json) {
        out.result({
            session,
            turn: options.turn ?? (turns?.length === 1 ? turns[0] : null),
            turns: turns ?? (options.turn ? [options.turn] : null),
            files: files.map((row) => ({ ...row, ...(diffs ? diffFields(diffs.get(row.path)) : {}) })),
            log: file,
            objects: objectsDir(),
        });
        return;
    }

    out.println(file);

    for (const row of files) {
        out.println(`${row.path}  ${row.source}  ${rawTransition(row)}`);
        const diff = diffs?.get(row.path);

        if (diff?.diff) {
            out.println(diff.diff);
        }
    }
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

/** What happened to the file. An unknown state (`undefined`) is neither a creation nor a deletion. */
export function changeStatus(file: Pick<TurnFile, "beforeOid" | "afterOid">): "added" | "deleted" | "modified" {
    if (file.beforeOid === null) {
        return "added";
    }

    return file.afterOid === null ? "deleted" : "modified";
}

/** The turns' excluded files that are not kept; with `tool`, only the ones that call excluded. */
function excludedOf(turns: readonly TurnChanges[], kept: readonly TurnFile[], tool?: string): ExcludedFile[] {
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

/**
 * Store the blobs the output names, so a reader can `git cat-file` every before-state it lists.
 * Only on `--store-blobs`: `changes` is an inspection, and an inspection writes nothing by default.
 */
function persistBlobs(files: readonly TurnFile[], blobs: Map<string, Buffer>): void {
    const sink = gitObjectSink(undefined, (line) => log.debug(line));

    try {
        storeBlobs(files, blobs, (list) => sink.hashAll?.(list) ?? list.map((bytes) => sink.hash(bytes)));
    } catch (error) {
        // Without the blobs a reader shows "before-state not in the change log"; the list itself stays right.
        log.warn({ error }, "could not store transcript blobs in the change-log object store");
    }
}

/**
 * A session some harness has a transcript of. A Grok session has none this command reads, and
 * without a change log it truly changed nothing recorded: that is an empty answer, not an error.
 */
async function isKnownSession(session: string): Promise<boolean> {
    try {
        await resolveTranscript(session);
        return true;
    } catch (error) {
        log.debug({ error, session }, "no transcript of this session anywhere");
        return false;
    }
}

/** One file of the JSON output. `span` (how many calls the before/after pair covers) only for one call's files. */
function fileJson(item: TurnFile, diffs: Map<string, FileDiff> | null, oneCall: boolean): Record<string, unknown> {
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

/** `diff` is the unified text, or null with `diffSkipped` saying why; `added`/`removed` count its lines. */
function diffFields(diff: FileDiff | undefined): Record<string, unknown> {
    if (!diff) {
        return { diff: null, diffSkipped: "missing-blob" };
    }

    return diff.diff === null
        ? { diff: null, diffSkipped: diff.reason }
        : { diff: diff.diff, added: diff.added, removed: diff.removed };
}

/**
 * The session argument as the change log and the transcript readers need it: a full id. A leading
 * part of one is completed from the history index, like `ai-spend session --id`; before this,
 * `agents changes 7399934a --json` answered an empty list with `transcript: null` and exit 0, which
 * read as "this session changed nothing". An ambiguous prefix is refused with the candidates.
 */
export function resolveSessionArgument(
    session: string,
    resolve: (id: string) => SessionIdResolution = (id) => resolveCachedSessionId({ id })
): { id: string; note?: string } | { error: string } {
    const found = resolve(session);

    if (found.kind === "unique") {
        return { id: found.sessionId, note: `${session} is session ${found.sessionId}` };
    }

    if (found.kind === "ambiguous") {
        const lines = found.candidates.map((row) =>
            `  ${row.sessionId}  ${row.providerId ?? ""}  ${row.title ?? ""}`.trimEnd()
        );
        return { error: [`${session} matches more than one session. Pass more of the id:`, ...lines].join("\n") };
    }

    return { id: session };
}

export function registerChangesCommand(program: Command): void {
    program
        .command("changes")
        .description(
            "Show the files one agent session changed, per turn: file-tool edits from the transcript plus shell changes from the change log, with automatic changes (checkouts, builds, tests, logs, caches) excluded"
        )
        .argument("<session>")
        .option("--turn <id>")
        .option("--last-turn", "Limit to the last turn that changed a file")
        .option("--last-turns <n>", "Limit to the last <n> turns that changed a file (the hub's Last N turns)")
        .option("--raw", "Show the change log as recorded: no transcript, no exclusions")
        .option("--tool <id>", "Only the files one tool call changed, each with its unified diff")
        .option(
            "--tools <ids>",
            "Several tool calls at once (comma-separated), as JSON { tools: [{ toolUseId, files, excluded }] }: the session is read once for all of them"
        )
        .option("--diff", "Add a unified diff to every file (per-file budget; always on with --tool)")
        .option(
            "--store-blobs",
            "Also write the transcript's before and after blobs into the change-log object store, so `git --git-dir <objects>` can read every oid listed. Without it the command writes nothing."
        )
        .option("--json")
        .action(async (sessionArgument: string, options: ChangesOptions) => {
            const resolved = resolveSessionArgument(sessionArgument);

            if ("error" in resolved) {
                out.log.error(resolved.error);
                process.exitCode = 1;
                return;
            }

            if (resolved.note) {
                out.log.info(resolved.note);
            }

            const session = resolved.id;

            if (options.tool && options.tools) {
                // `--tools` used to win silently, so `--tool` was ignored without a word.
                out.log.error("--tool and --tools cannot be combined: pass the one id inside --tools");
                process.exitCode = 1;
                return;
            }

            if (options.raw && options.tools) {
                // `--raw` printed the whole log in its own shape, with no `tools` key for the caller to read.
                out.log.error("--raw takes one call (--tool), not --tools");
                process.exitCode = 1;
                return;
            }

            let file: string;

            try {
                file = sessionChangesPath(session);
            } catch (error) {
                out.log.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
                return;
            }

            const read = readJsonlRows<ChangeEvent>(file);

            if (read.skipped > 0) {
                out.log.warn(`Skipped ${read.skipped} unreadable line(s) in ${file}`);
            }

            const lastTurns = options.lastTurns === undefined ? undefined : Number(options.lastTurns);

            if (lastTurns !== undefined && (!Number.isInteger(lastTurns) || lastTurns < 1)) {
                out.log.error(`--last-turns takes a whole number of at least 1, got ${options.lastTurns}`);
                process.exitCode = 1;
                return;
            }

            const count = options.turn ? undefined : (lastTurns ?? (options.lastTurn ? 1 : undefined));

            if (options.raw) {
                rawAction(session, file, read.rows, options, count);
                return;
            }

            const changes = loadSessionChanges({ sessionId: session, log: read.rows });

            if (!changes.transcriptPath && !existsSync(file) && !(await isKnownSession(session))) {
                // An empty list would read as "this session changed nothing", for a mistyped id too.
                out.log.error(`No change log and no transcript for session ${session}`);
                process.exitCode = 1;
                return;
            }

            if (options.tools) {
                // The hub asks for every tool row on screen in one run: a large session costs about
                // 0.7 s to read, and one process per row read it once per row (11 at a time).
                const ids = [...new Set(options.tools.split(",").map((id) => id.trim()))].filter(Boolean);
                const perTool = ids.map((tool) => ({ tool, ...toolCallFiles(changes, tool) }));

                if (options.storeBlobs) {
                    persistBlobs(
                        perTool.flatMap((entry) => entry.files),
                        changes.blobs
                    );
                }

                log.debug({ session, tools: ids.length }, "session changes for several tool calls");
                out.result({
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
                });
                return;
            }

            const recent = count === undefined ? [] : lastChangedTurns(changes, count);
            const selected = selectTurns(recent, changes.turns, options, count);
            const merged = selected ? mergeTurnFiles(selected) : changes.files;
            // One call's files. When several calls of a turn changed a file, its before and after span
            // all of them (the log keeps one pair per turn), and `span` says how many calls that is.
            const files = options.tool ? merged.filter((item) => item.toolUseIds.includes(options.tool ?? "")) : merged;
            const excluded = excludedOf(selected ?? changes.turns, files, options.tool);

            if (options.storeBlobs) {
                persistBlobs(files, changes.blobs);
            }

            const diffs = options.tool || options.diff ? diffsFor(files, changes.blobs) : null;
            log.debug(
                {
                    session,
                    turns: selected?.length ?? changes.turns.length,
                    files: files.length,
                    excluded: excluded.length,
                },
                "session changes"
            );

            if (options.json) {
                out.result({
                    session,
                    turn: options.turn ?? (selected?.length === 1 ? selected[0]?.turnId : null) ?? null,
                    turns: selected ? selected.map((turn) => turn.turnId) : null,
                    files: files.map((item) => fileJson(item, diffs, Boolean(options.tool))),
                    excluded: excluded.map((item) => ({ path: item.path, reason: item.reason, via: item.via })),
                    log: file,
                    objects: objectsDir(),
                    transcript: changes.transcriptPath,
                });
                return;
            }

            out.println(changes.transcriptPath ?? `${file} (no transcript found)`);

            for (const item of files) {
                out.println(
                    `${item.path}  ${item.via}  ${item.confidence}  ${item.skipped ?? `${item.beforeOid ?? "-"} -> ${item.afterOid ?? "-"}`}`
                );
                const diff = diffs?.get(item.path);

                if (diff?.diff) {
                    out.println(diff.diff);
                }
            }

            if (excluded.length > 0) {
                out.println(`excluded: ${excluded.length}`);

                for (const item of excluded) {
                    out.println(`  ${item.path}  ${item.reason}`);
                }
            }
        });
}
