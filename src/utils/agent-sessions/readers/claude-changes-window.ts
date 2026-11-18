import { statSync } from "node:fs";
import { basename } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { cpuMeta, profiler } from "@genesiscz/utils/profile";
import type { ChangesWindowRead, ChangesWindowRequest, SessionChangesWindow } from "../types";
import { advanceLines, CHUNK_BYTES, changesCache, type LineFold } from "./changes-window-cache";
import { advanceFrom, type FileFold, merge } from "./claude-changes";
import { advanceClaudeFacts, type FoldedFacts, sessionFacts } from "./claude-changes-facts";
import {
    backupReader,
    emptyParseState,
    finishTranscript,
    type ParseState,
    parseLines,
    subagentFiles,
} from "./claude-changes-parse";
import { canonicalClaudeTranscriptSync } from "./claude-locate";

interface Cache {
    files: Map<string, FoldedFacts>;
    facts?: ReturnType<typeof sessionFacts>;
    main?: FileFold;
    lookbehind?: LineFold<ParseState>;
    agents: Map<string, FileFold>;
}
const windows = changesCache<Cache>("session-changes window folds");
const prof = profiler.scope("session-changes");
const { log } = logger.scoped("session-changes");
const historyMarker = Buffer.from('"file-history-');

function readFacts(cache: Cache, paths: string[]) {
    const current = new Map<string, FoldedFacts>();
    let changed = paths.length !== cache.files.size;
    const previous = cache.files.keys();
    for (const [i, path] of paths.entries()) {
        const kept = cache.files.get(path);
        const mark = kept?.mark;
        const fold = advanceClaudeFacts(path, i === 0, kept);
        current.set(path, fold);
        changed ||= fold.mark !== mark || fold !== kept || path !== previous.next().value;
    }
    cache.files = current;
    if (changed || !cache.facts) {
        cache.facts = sessionFacts(current);
    }
    return cache.facts;
}

function checkedFold(
    path: string,
    agentId: string | null,
    kept: FileFold | undefined,
    start: number,
    facts: FoldedFacts
) {
    const fold = advanceFrom(path, agentId, kept ?? null, start);
    if (!fold || fold.ino !== facts.ino || fold.mark !== facts.mark) {
        throw new Error("transcript changed between facts and window parse");
    }
    return fold;
}

function readWindow(path: string, request: ChangesWindowRequest, cache: Cache): ChangesWindowRead {
    const sessionId = basename(path, ".jsonl");
    const agents = subagentFiles(path);
    const facts = prof.measure(
        "facts",
        () => readFacts(cache, [path, ...agents.map((agent) => agent.path)]),
        prof.enabled ? cpuMeta() : undefined
    );
    const mainFacts = cache.files.get(path);
    if (!mainFacts || facts.ambiguous) {
        return { supported: false, reason: "F6: ambiguous or unavailable transcript facts" };
    }
    const ledger = [...mainFacts.state.ledger.values()];
    const isMainTurn = (id: string) => mainFacts.state.ledger.has(id);
    const indexOf = new Map(ledger.map((entry, i) => [entry.id, i]));
    let index = Math.max(0, ledger.length - request.turns);
    const previous = cache.main ? ledger.findIndex((entry) => entry.offset === cache.main?.start) : -1;
    if (previous >= 0 && ledger.length - previous <= Math.max(4 * request.turns, request.turns + 64)) {
        index = Math.min(index, previous);
    }
    const forced = new Set<string>();
    const coverCall = (id: string) => {
        const call = facts.calls.get(id);
        if (!call) {
            return false;
        }
        if (call.path === path) {
            while (index > 0 && ledger[index].offset > call.offset) {
                index--;
            }
        } else {
            forced.add(call.path);
        }
        return true;
    };
    for (const id of request.cover ?? []) {
        if (!coverCall(id)) {
            return { supported: false, reason: "F7: unknown Claude call" };
        }
    }
    // A main call before the first prompt can produce a trailing turn, even when every prompt is outside the window.
    if (mainFacts.state.unplaced) {
        index = 0;
    }
    let lateResultCovers = 0;
    for (let round = 0; round <= 16; round++) {
        const complete = index === 0;
        const earlierTurns = new Set(ledger.slice(0, index).map((entry) => entry.id));
        const base: SessionChangesWindow = {
            transcriptPath: path,
            earlierTurns,
            editedDirs: facts.editedDirs,
            shellCalls: facts.shellCalls,
            writersOf: facts.writersOf,
            sessionTurns: ledger.length,
            windowTurns: ledger.length - index,
            complete,
            lateResultCovers,
            transcript: { sessionId, calls: [], cwds: facts.cwds, turns: [] },
        };
        if (complete) {
            return { supported: true, window: base };
        }

        const cut = ledger[index];
        const main = prof.measure("window parse", () => checkedFold(path, null, cache.main, cut.offset, mainFacts));
        cache.main = main;
        const opened: Array<{ fold: FileFold; parentToolUseId: string | null }> = [];
        const held = new Set(main.state.calls.keys());
        const unmatched = [...main.unmatched];
        let phantomCapable = 0;
        let missingLauncher = false;
        let bytesParsed = main.consumed - cut.offset;
        let bytesTotal = mainFacts.size;
        const oldIndex = index;
        const oldForced = forced.size;
        for (const file of agents) {
            const agentFacts = cache.files.get(file.path);
            if (!agentFacts) {
                throw new Error("subagent disappeared");
            }
            bytesTotal += agentFacts.size;
            const ids = [...agentFacts.state.promptIds];
            const phantom = agentFacts.state.unplaced || ids.some((id) => !isMainTurn(id));
            phantomCapable += Number(phantom);
            // An explicit turn or a result for a held call takes precedence over a copied file's old mtime.
            if (
                !forced.has(file.path) &&
                !phantom &&
                cut.at !== null &&
                agentFacts.mtime < cut.at - 5000 &&
                ids.every((id) => earlierTurns.has(id)) &&
                ![...agentFacts.state.resultIds].some((id) => held.has(id))
            ) {
                cache.agents.delete(file.path);
                continue;
            }
            const fold = prof.measure("window parse", () =>
                checkedFold(file.path, file.agentId, cache.agents.get(file.path), 0, agentFacts)
            );
            cache.agents.set(file.path, fold);
            bytesParsed += fold.consumed;
            for (const result of fold.unmatched) {
                if (!held.has(result.toolUseId)) {
                    unmatched.push(result);
                }
            }
            if (
                phantom &&
                file.parentToolUseId &&
                !held.has(file.parentToolUseId) &&
                [...fold.state.calls.values()].some((call) => !isMainTurn(call.turnId))
            ) {
                missingLauncher = true;
            }
            for (const id of fold.state.calls.keys()) {
                held.add(id);
            }
            opened.push({ fold, parentToolUseId: file.parentToolUseId });
        }
        for (const result of unmatched) {
            if (result.promptId && earlierTurns.has(result.promptId)) {
                continue;
            }
            if (!held.has(result.toolUseId) && coverCall(result.toolUseId)) {
                lateResultCovers++;
            }
        }
        if (oldIndex !== index || oldForced !== forced.size) {
            continue;
        }
        const state = prof.measure("merge", () => merge(main, opened, isMainTurn));
        for (const id of request.cover ?? []) {
            const turn = state.calls.get(id)?.turnId;
            const earlier = turn === undefined ? undefined : indexOf.get(turn);
            if (earlier !== undefined) {
                index = Math.min(index, earlier);
            }
        }
        if (oldIndex !== index) {
            continue;
        }
        if (missingLauncher) {
            return { supported: false, reason: "F3: phantom subagent with a launching call outside the window" };
        }
        // A moved or copied transcript may have a checkpoint even before the preceding prompt. Its message
        // still identifies it exactly. Widen the backup-only lookbehind to the first such checkpoint.
        let start = ledger[index - 1].offset;
        for (const [message, turn] of state.promptOfMessage) {
            if (!earlierTurns.has(turn)) {
                start = Math.min(start, mainFacts.state.backupOffsets.get(message) ?? start);
            }
        }
        const behind = cache.lookbehind;
        if (
            !behind ||
            behind.start !== start ||
            behind.consumed !== cut.offset ||
            behind.ino !== mainFacts.ino ||
            behind.ctime !== mainFacts.ctime
        ) {
            cache.lookbehind = advanceLines({
                path,
                start,
                until: cut.offset,
                initial: emptyParseState,
                line(state, bytes) {
                    if (bytes.includes(historyMarker)) {
                        parseLines([bytes.toString()], null, state);
                    }
                },
            });
        }
        if (cache.lookbehind?.ctime !== mainFacts.ctime || cache.lookbehind.ino !== mainFacts.ino) {
            throw new Error("transcript changed during checkpoint lookbehind");
        }
        state.backups = [...(cache.lookbehind?.state.backups ?? []), ...state.backups];
        const transcript = finishTranscript(
            sessionId,
            state,
            backupReader(sessionId),
            mainFacts.state.newestBackupTime
        );
        transcript.turns = transcript.turns.filter((turn) => !earlierTurns.has(turn.turnId));
        transcript.cwds = facts.cwds;
        for (const key of cache.agents.keys()) {
            if (!cache.files.has(key)) {
                cache.agents.delete(key);
            }
        }
        log.debug(
            {
                transcriptPath: path,
                windowTurns: base.windowTurns,
                sessionTurns: ledger.length,
                cutOffset: cut.offset,
                bytesParsed: bytesParsed + cut.offset - start,
                bytesTotal,
                subagentsOpened: opened.length,
                subagentsTotal: agents.length,
                forcedOpens: forced.size,
                phantomCapable,
                lateResultCovers,
                skippedTurns: index,
                skippedBytes: cut.offset,
            },
            "Claude changes window"
        );
        return { supported: true, window: { ...base, transcript, lateResultCovers } };
    }
    return { supported: false, reason: "F2: too many Claude cover rounds" };
}

export function claudeChangesWindow(sessionId: string, request: ChangesWindowRequest): ChangesWindowRead | null {
    const path = canonicalClaudeTranscriptSync(sessionId);
    if (!path) {
        return null;
    }
    try {
        if (statSync(path).size < CHUNK_BYTES || path.endsWith(".zst")) {
            windows.delete(path);
            return { supported: false, reason: "F5: small or compressed Claude transcript" };
        }
        return readWindow(
            path,
            request,
            windows.get(path, () => ({ agents: new Map(), files: new Map() }))
        );
    } catch (error) {
        windows.delete(path);
        log.info({ error, transcriptPath: path }, "F6: Claude changes window unavailable");
        return { supported: false, reason: "F6: unstable or unreadable Claude transcript" };
    }
}
