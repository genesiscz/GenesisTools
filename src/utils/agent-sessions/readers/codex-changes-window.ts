import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { logger } from "@genesiscz/utils/logger";
import type { ChangesWindowRead, ChangesWindowRequest, WindowWriter } from "../types";
import { advanceLines, CHUNK_BYTES, changesCache, type LineFold } from "./changes-window-cache";
import { parseCodexRollout, visitRolloutLine } from "./codex-changes";
import { findCodexRollout } from "./codex-locate";

interface LedgerEntry {
    id: string;
    offset: number;
    cwd: string | null;
}
function emptyFacts() {
    return {
        ledger: new Map<string, LedgerEntry>(),
        cwds: new Set<string>(),
        cwd: null as string | null,
        dirs: new Set<string>(),
        writers: new Map<string, WindowWriter[]>(),
        offsets: new Map<string, number>(),
        firstChange: new Map<string, number>(),
    };
}
interface Cache {
    facts?: LineFold<ReturnType<typeof emptyFacts>>;
    lines?: LineFold<string[]>;
}
const windows = changesCache<Cache>("session-changes codex windows");
const markers = ["\\u", '"task_started"', '"turn_context"', '"FileChange"'].map((s) => Buffer.from(s));

export function codexChangesWindow(sessionId: string, request: ChangesWindowRequest): ChangesWindowRead | null {
    const path = findCodexRollout(sessionId);
    if (!path) {
        return null;
    }
    try {
        if (path.endsWith(".zst")) {
            windows.delete(path);
            return { supported: false, reason: "F6: compressed rollout has no raw line offsets" };
        }
        if (statSync(path).size < CHUNK_BYTES) {
            windows.delete(path);
            return { supported: false, reason: "F5: small rollout" };
        }
        const cache = windows.get(path, () => ({}));
        const identity = fileIdentity(path);
        cache.facts = advanceLines({
            path,
            kept: cache.facts,
            initial: emptyFacts,
            line(facts, bytes, offset) {
                if (!markers.some((marker) => bytes.includes(marker))) {
                    return;
                }
                visitRolloutLine(bytes.toString(), facts.cwd, {
                    turn(id) {
                        if (!facts.ledger.has(id)) {
                            facts.ledger.set(id, { id, offset, cwd: facts.cwd });
                        }
                    },
                    context(cwd) {
                        facts.cwd = cwd;
                        facts.cwds.add(cwd);
                    },
                    change(change) {
                        facts.dirs.add(dirname(change.path));
                        facts.offsets.set(change.callId, Math.min(offset, facts.offsets.get(change.callId) ?? offset));
                        facts.firstChange.set(
                            change.turnId,
                            Math.min(offset, facts.firstChange.get(change.turnId) ?? offset)
                        );
                        const path = resolve(change.path);
                        const writers = facts.writers.get(path) ?? [];
                        writers.push({ callId: change.callId, at: change.at, wildcard: false });
                        facts.writers.set(path, writers);
                    },
                    prompt() {},
                });
            },
        });
        const facts = cache.facts.state;
        const ledger = [...facts.ledger.values()];
        let index = Math.max(0, ledger.length - request.turns);
        let start = ledger[index]?.offset ?? 0;
        for (const call of request.cover ?? []) {
            const offset = facts.offsets.get(call);
            if (offset === undefined) {
                return { supported: false, reason: "F7: unknown rollout call" };
            }
            start = Math.min(start, offset);
        }
        // Hold changes with a trailing turn id, even an item recorded before its turn started.
        let previousStart: number;
        do {
            previousStart = start;
            while (index > 0 && ledger[index].offset > start) {
                index--;
            }
            start = ledger[index]?.offset ?? 0;
            for (const [id, offset] of facts.firstChange) {
                if ((facts.ledger.get(id)?.offset ?? Infinity) >= start) {
                    start = Math.min(start, offset);
                }
            }
        } while (index > 0 && start < previousStart);
        const cut = ledger[index];
        const earlierTurns = new Set(ledger.slice(0, index).map((entry) => entry.id));
        const complete = index === 0;
        if (!complete) {
            cache.lines = advanceLines({
                path,
                start: cut.offset,
                kept: cache.lines,
                initial: (): string[] => [],
                line(lines, bytes) {
                    if (markers.some((marker) => bytes.includes(marker))) {
                        lines.push(bytes.toString());
                    }
                },
            });
            if (
                cache.facts.ino !== cache.lines.ino ||
                cache.facts.mark !== cache.lines.mark ||
                cache.facts.size !== cache.lines.size
            ) {
                throw new Error("rollout changed between facts and window");
            }
        }
        const transcript = parseCodexRollout(
            sessionId,
            complete ? [] : (cache.lines?.state ?? []),
            undefined,
            cut?.cwd
        );
        transcript.turns = transcript.turns.filter((turn) => !earlierTurns.has(turn.turnId));
        transcript.cwds = [...facts.cwds];
        logger.debug(
            { transcriptPath: path, cutOffset: cut?.offset ?? 0, skippedTurns: index, bytesTotal: cache.facts.size },
            "rollout changes window"
        );
        return {
            supported: true,
            window: {
                transcriptPath: path,
                unchanged: () =>
                    findCodexRollout(sessionId) === path && isDeepStrictEqual(fileIdentity(path), identity),
                transcript,
                earlierTurns,
                editedDirs: [...facts.dirs],
                shellCalls: new Set(),
                writersOf: (path) => facts.writers.get(path) ?? [],
                complete,
                windowTurns: ledger.length - index,
                sessionTurns: ledger.length,
            },
        };
    } catch (error) {
        windows.delete(path);
        logger.info({ error, transcriptPath: path }, "F6: rollout window unavailable");
        return { supported: false, reason: "F6: unstable or unreadable rollout" };
    }
}
