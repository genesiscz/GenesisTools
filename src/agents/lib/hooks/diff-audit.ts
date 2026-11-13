import { dirname, sep } from "node:path";
import { type ChangeLogRow, walkChangeLogs } from "@genesiscz/utils/agents/change-log";
import {
    type AttributionContext,
    attribute,
    FOREIGN_WINDOW_MS,
    isOurs,
    type Rule,
    readOnlyCommand,
    scriptTexts,
    type Writes,
} from "./diff/attribution";
import { commandDirs, namedArguments } from "./diff/command-paths";
import { canonical, loadMentions, type Mentions, mentionsFrom, mentionsOf } from "./diff/mentions";
import type { DiffLogEntry } from "./diff-log";

/**
 * `tools agents hooks diff audit`: every file the diff hook printed or declined, decided again by
 * today's rules (`attribute`) from evidence the hook did not write itself.
 *
 * The evidence, rebuilt for the moment of each call:
 *   - the call's window (the decision log's pre row), and what the log says the command named. A
 *     declined file is also checked against the command's text from the transcript;
 *   - who wrote the file with an Edit or a Write, and when (every session's change log). Rows a
 *     Bash call left are NOT used: the hook wrote them from its own verdict, so they prove nothing
 *     about that verdict;
 *   - which other session began a Bash call in the same root, from the decision log's pre rows.
 *
 * What cannot be rebuilt, so the replay is the more generous side: commands that were still running
 * in another session, the touches ledger, and the times of a session's Reads (its mention index
 * stands in for them, and that index also holds what the session named AFTER the call).
 */

export interface AuditRow {
    at: string;
    session: string;
    toolUseId: string;
    command?: string;
    file: string;
    side: "printed" | "declined";
    /** The rule the log recorded, or `unknown` for a row older than the field. */
    logged: string;
    /** The rule today's order gives with the rebuilt evidence. */
    replayed: Rule;
    ours: boolean;
    /** Another session's Edit or Write of the file inside the call's window. */
    foreign?: { session: string; at: string };
}

interface Write {
    session: string;
    at: number;
}

/** Every Edit and Write of every session, by file, oldest first. */
export function fileToolWrites(rows: Iterable<ChangeLogRow>): Map<string, Write[]> {
    const byFile = new Map<string, Write[]>();

    for (const row of rows) {
        const at = Date.parse(row.ts);

        if (row.source === "bash" || !Number.isFinite(at)) {
            continue;
        }

        const path = canonical(row.path);
        const writes = byFile.get(path);

        if (writes) {
            writes.push({ session: row.session, at });
        } else {
            byFile.set(path, [{ session: row.session, at }]);
        }
    }

    for (const writes of byFile.values()) {
        writes.sort((first, second) => first.at - second.at);
    }

    return byFile;
}

/** The change-log rows of every session whose log was written since `since`. */
export function changeRowsSince(since: number, dir?: string): ChangeLogRow[] {
    return [...walkChangeLogs({ since, ...(dir ? { dir } : {}) })].flatMap((log) => log.rows);
}

function rootOf(file: string, roots: string[]): string {
    const holding = roots
        .filter((root) => file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
        .sort((first, second) => second.length - first.length);

    return holding[0] ?? dirname(file);
}

/** Names the log used before 2026-11-12, as the rule that replaced each. */
const OLD_NAMES: Record<string, string> = { "named folder": "named-folder", mentioned: "own-file", runner: "own-root" };

export function auditDiffLog({
    entries,
    writes,
    mentionsFor = loadMentions,
}: {
    /** Every call of the window, also the ones that printed nothing: their pre rows say who worked where. */
    entries: DiffLogEntry[];
    writes: Map<string, Write[]>;
    mentionsFor?: (session: string) => Mentions;
}): AuditRow[] {
    const rows: AuditRow[] = [];
    const calls = entries
        .filter((entry) => entry.began !== undefined)
        .map((entry) => ({ session: entry.session, began: Date.parse(entry.began ?? ""), roots: entry.roots ?? [] }));
    const indexes = new Map<string, Mentions>();

    for (const entry of entries) {
        const files: Array<{ file: string; side: AuditRow["side"] }> = [
            ...entry.files.map((file) => ({ file, side: "printed" as const })),
            ...entry.others.map((file) => ({ file, side: "declined" as const })),
        ];

        if (files.length === 0) {
            continue;
        }

        const now = Date.parse(entry.at);
        const since = Number.isFinite(Date.parse(entry.began ?? "")) ? Date.parse(entry.began ?? "") : now - 60_000;
        // What the command names, read again from its text. Only a declined file needs it: for a printed file the
        // log's own `named` is the better witness, because the folders the text resolved against may be gone now.
        const fromText =
            entry.command && entry.cwd
                ? [
                      ...mentionsOf({ tool: "Bash", input: { command: entry.command }, cwd: entry.cwd }),
                      ...namedArguments(entry.command, commandDirs(entry.command, entry.cwd)).map(canonical),
                  ]
                : [];
        const loggedRule = (file: string, side: AuditRow["side"]): string => {
            const recorded = (side === "printed" ? entry.attributed : entry.declined)?.[file] ?? "unknown";

            return OLD_NAMES[recorded] ?? recorded;
        };
        const named = mentionsFrom([
            ...fromText,
            ...entry.files.flatMap((file) => {
                const logged = loggedRule(file, "printed");

                return logged === "named" || logged === "writer"
                    ? [file]
                    : logged === "named-folder"
                      ? [dirname(file)]
                      : [];
            }),
        ]);
        const proof: Writes = { mine: new Map(), theirs: new Map() };

        for (const { file } of files) {
            for (const write of writes.get(file) ?? []) {
                if (write.session === entry.session) {
                    // A write of this session inside the window is the harness's own diff, not this call's proof.
                    if (write.at < since) {
                        proof.mine.set(file, write.at);
                    }
                } else if (write.at >= since - FOREIGN_WINDOW_MS && write.at <= now) {
                    proof.theirs.set(file, write);
                }
            }
        }

        const ownRoots = new Map<string, boolean>();
        const context: AttributionContext = {
            session: entry.session,
            since,
            now,
            named,
            mentions: () => {
                const index = indexes.get(entry.session) ?? mentionsFor(entry.session);
                indexes.set(entry.session, index);

                // The log's `mentioned` is a fact of that moment (an earlier input named the exact file); the
                // index on disk may be gone by now. It still loses to another session's later write.
                return {
                    paths: new Set([
                        ...index.paths,
                        ...entry.files.filter((file) => loggedRule(file, "printed") === "own-file"),
                    ]),
                    globs: index.globs,
                };
            },
            readOnly: () => entry.command !== undefined && readOnlyCommand(entry.command),
            others: () => new Map(),
            busyRoots: () => new Set(),
            siblings: () => new Set(),
            writes: () => proof,
            scripts: () => scriptTexts({ paths: named.paths, command: entry.command }),
            ownRoot: (root) => {
                const known = ownRoots.get(root);

                if (known !== undefined) {
                    return known;
                }

                const floor = root.endsWith(sep) ? root : `${root}${sep}`;
                const shared =
                    !root.includes(entry.session) &&
                    (calls.some(
                        (call) =>
                            call.session !== entry.session &&
                            call.began >= since - FOREIGN_WINDOW_MS &&
                            call.began <= now &&
                            call.roots.includes(root)
                    ) ||
                        [...writes].some(
                            ([path, list]) =>
                                path.startsWith(floor) &&
                                list.some(
                                    (write) =>
                                        write.session !== entry.session &&
                                        write.at >= since - FOREIGN_WINDOW_MS &&
                                        write.at <= now
                                )
                        ));

                ownRoots.set(root, !shared);
                return !shared;
            },
        };

        for (const { file, side } of files) {
            const logged = loggedRule(file, side);

            // A file declined before the log kept its rule: what declined it (a command in flight, the ledger,
            // a call of the same session) cannot be rebuilt, so a replay would only guess.
            if (side === "declined" && logged === "unknown") {
                continue;
            }

            // Kept as logged: another call named the file then, and that record is gone now.
            const verdict =
                logged === "other-named"
                    ? { kind: "others" as const, rule: "other-named" as const }
                    : attribute({ file, root: rootOf(file, entry.roots ?? []), context });
            const foreign = proof.theirs.get(file);

            rows.push({
                at: entry.at,
                session: entry.session,
                toolUseId: entry.toolUseId,
                ...(entry.command ? { command: entry.command } : {}),
                file,
                side,
                logged,
                replayed: verdict.rule,
                ours: isOurs(verdict),
                ...(foreign && foreign.at >= since
                    ? { foreign: { session: foreign.session, at: new Date(foreign.at).toISOString() } }
                    : {}),
            });
        }
    }

    return rows;
}

export interface AuditSummary {
    printed: number;
    /** Printed files today's rules would not print: the false blocks. */
    dropped: number;
    declined: number;
    /** Declined files today's rules would print: the misses. */
    recovered: number;
    /** `logged rule -> replayed rule`, with a count, for both sides. */
    moves: Array<{ side: AuditRow["side"]; logged: string; replayed: Rule; files: number }>;
}

export function summarizeAudit(rows: AuditRow[]): AuditSummary {
    const moves = new Map<string, AuditSummary["moves"][number]>();

    for (const row of rows) {
        const key = `${row.side}\t${row.logged}\t${row.replayed}`;
        const move = moves.get(key) ?? { side: row.side, logged: row.logged, replayed: row.replayed, files: 0 };

        move.files += 1;
        moves.set(key, move);
    }

    const printed = rows.filter((row) => row.side === "printed");
    const declined = rows.filter((row) => row.side === "declined");

    return {
        printed: printed.length,
        dropped: printed.filter((row) => !row.ours).length,
        declined: declined.length,
        recovered: declined.filter((row) => row.ours).length,
        moves: [...moves.values()].sort(
            (first, second) => first.side.localeCompare(second.side) || second.files - first.files
        ),
    };
}
