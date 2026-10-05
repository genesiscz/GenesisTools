import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { hookDiag } from "../log";
import type { NamedChange } from "./named";

/**
 * Files a writer that keeps its own before-copies reported writing during this call.
 *
 * fable-replace is the writer today. A sweep's paths sit in a heredoc spec (`@@ $V/a.md`) or behind
 * variables, which the named-path pass refuses by design, so a sweep that edited a vault note left no
 * diff at all (col-309257 session, 2026-10-01). But every run appends one line to its journal with the
 * backup folder, and that folder's manifest names each file and the copy taken BEFORE the write. Those
 * copies are exact before-states, so the change is diffed and logged like a named path.
 *
 * Only runs inside this call's window, and only this session's: a journal line carries the session id
 * (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`); a line without one is accepted only when the hook
 * itself has no session id.
 */

/** The journal's tail that is read: far more than one call writes. */
const TAIL_BYTES = 256 * 1024;
const WRITTEN = new Set(["ok", "written", "verify-failed", "verify-unknown", "stale-prose", "partial"]);
const MANIFEST = "fable-replace-manifest.json";

interface JournalLine {
    ts?: string;
    kind?: string;
    outcome?: string;
    session?: string;
    backupDir?: string;
}

interface ManifestEntry {
    original?: string;
    stored?: string | null;
}

/** As fable-replace's `journalHome()`: its override, else the tools home, else the user's home. */
export function fableReplaceJournal(): string {
    const override = env.tools.getFableReplaceHome();
    if (override) {
        return join(override, ".genesis-tools", "fable-replace", "journal.jsonl");
    }

    return toolDataDir("fable-replace", "journal.jsonl");
}

function tail(path: string): string {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = openSync(path, "r");

    try {
        const buffer = Buffer.alloc(size - start);
        readSync(fd, buffer, 0, buffer.length, start);
        const text = buffer.toString("utf8");
        // A tail that starts mid-line drops that partial first line.
        return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
        closeSync(fd);
    }
}

export function writerChanges({
    since,
    now,
    sessionId,
    journal = fableReplaceJournal(),
}: {
    since: number;
    now: number;
    sessionId: string | undefined;
    journal?: string;
}): NamedChange[] {
    if (!existsSync(journal)) {
        return [];
    }

    const changes = new Map<string, NamedChange>();

    try {
        for (const line of tail(journal).split("\n")) {
            if (!line.trim()) {
                continue;
            }

            let entry: JournalLine;

            try {
                entry = SafeJSON.parse(line, { strict: true }) as JournalLine;
            } catch (err) {
                // One torn line (a write cut short) must not hide the runs around it.
                hookDiag("Skipped an unreadable fable-replace journal line", { err });
                continue;
            }

            const at = entry.ts ? Date.parse(entry.ts) : Number.NaN;

            // `ts` is when the run started, which for a run of this call lies inside its window. `since`
            // is the millisecond the pre phase finished, so a run that started before it is an earlier call's.
            if (Number.isNaN(at) || at < since || at > now + 1000) {
                continue;
            }

            if (entry.kind !== "run" || !entry.outcome || !WRITTEN.has(entry.outcome) || !entry.backupDir) {
                continue;
            }

            // A run that names no session (another harness, an older CLI copy, a script) cannot be shown
            // to belong to this one, and concurrent sessions would each claim it.
            if (sessionId && entry.session !== sessionId) {
                continue;
            }

            const manifestPath = join(entry.backupDir, MANIFEST);

            if (!existsSync(manifestPath)) {
                continue;
            }

            let manifest: { entries?: ManifestEntry[] };

            try {
                manifest = SafeJSON.parse(readFileSync(manifestPath, "utf8"), { strict: true }) as {
                    entries?: ManifestEntry[];
                };
            } catch (err) {
                hookDiag("Skipped an unreadable fable-replace manifest", { err, manifestPath });
                continue;
            }

            for (const item of manifest.entries ?? []) {
                if (!item.original || changes.has(item.original)) {
                    continue;
                }

                changes.set(item.original, {
                    path: item.original,
                    // The first run's copy is the state before this call; a later run's copy is not.
                    before: item.stored ? join(entry.backupDir, item.stored) : null,
                    deleted: !existsSync(item.original),
                });
            }
        }
    } catch (err) {
        hookDiag("Could not read the fable-replace journal for this call", { err, journal });
    }

    return [...changes.values()];
}
