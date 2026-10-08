import { existsSync } from "node:fs";
import {
    type ChangesOptions,
    diffFields,
    diffsFor,
    excludedOf,
    fileJson,
    isKnownSession,
    persistBlobs,
    selectTurns,
    toolChangesJson,
} from "@app/agents/lib/changes/tool-changes";
import { resolveCachedSessionId, type SessionIdResolution } from "@genesiscz/utils/agent-sessions/cached-title";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { logger, out } from "@genesiscz/utils/logger";
import { lastChangedTurns, loadSessionChanges, mergeTurnFiles } from "@genesiscz/utils/session-changes";
import type { Command } from "commander";
import { type ChangeEvent, lastTurnIds, sessionChangesPath } from "../lib/changes/log";
import { objectsDir } from "../lib/changes/objects";

export const { log } = logger.scoped("agents-changes");

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

            if (options.tools) {
                const toolIds = [...new Set(options.tools.split(",").map((id) => id.trim()))].filter(Boolean);
                const outcome = await toolChangesJson({
                    session,
                    toolIds,
                    file,
                    rows: read.rows,
                    storeBlobs: options.storeBlobs === true,
                });

                if ("error" in outcome) {
                    out.log.error(outcome.error);
                    process.exitCode = 1;
                    return;
                }

                out.result(outcome.result);
                return;
            }

            const changes = loadSessionChanges({ sessionId: session, log: read.rows });

            if (!changes.transcriptPath && !existsSync(file) && !(await isKnownSession(session))) {
                // An empty list would read as "this session changed nothing", for a mistyped id too.
                out.log.error(`No change log and no transcript for session ${session}`);
                process.exitCode = 1;
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
