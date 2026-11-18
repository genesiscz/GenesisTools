import { readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, isMissingFileError } from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import type { FoldedFacts } from "./claude-changes-facts";

const strings = z.array(z.string());
const time = z.number().nullable();
const position = z.number().int().nonnegative();
const ledger = z.object({ id: z.string(), offset: position, at: time });
const call = ledger.extend({
    kind: z.enum(["file", "shell"]),
    dir: z.string().nullable(),
    writes: strings,
    scripts: strings,
    hasCommand: z.boolean(),
    wildcard: z.boolean(),
});
const numbers = z.array(z.tuple([z.string(), z.number()]));
const file = z.object({
    ino: position,
    consumed: position,
    mark: z.string(),
    facts: z.object({
        ledger: z.array(ledger),
        calls: z.array(call),
        promptIds: strings,
        cwds: strings,
        errorIds: strings,
        resultIds: strings,
        finishedTurns: z.array(z.tuple([z.string(), z.string().nullable()])),
        newestBackupTime: numbers,
        backupOffsets: numbers,
        cursor: z.string().nullable(),
        unplaced: z.boolean(),
        duplicateIds: z.boolean(),
    }),
});

const cachePath = (session: string) => toolDataDir("agents", "changes-facts", "claude", `${session}.json`);
const disk = z.object({ version: z.literal(1), files: z.record(z.string(), file) });

/** These are only candidates: advanceClaudeFacts checks each inode and consumed prefix before using its state. */
export function loadClaudeFacts(session: string): Map<string, FoldedFacts> {
    try {
        const saved = disk.parse(SafeJSON.parse(readFileSync(cachePath(session), "utf8"), { strict: true }));
        return new Map(
            Object.entries(saved.files).map(([path, { ino, consumed, mark, facts }]) => [
                path,
                {
                    ino,
                    consumed,
                    mark,
                    start: 0,
                    size: consumed,
                    mtime: 0,
                    ctime: 0,
                    state: {
                        ...facts,
                        ledger: new Map(facts.ledger.map((entry) => [entry.id, entry])),
                        calls: new Map(facts.calls.map((entry) => [entry.id, entry])),
                        promptIds: new Set(facts.promptIds),
                        cwds: new Set(facts.cwds),
                        errorIds: new Set(facts.errorIds),
                        resultIds: new Set(facts.resultIds),
                        finishedTurns: new Map(facts.finishedTurns),
                        newestBackupTime: new Map(facts.newestBackupTime),
                        backupOffsets: new Map(facts.backupOffsets),
                    },
                },
            ])
        );
    } catch (error) {
        if (!isMissingFileError(error)) {
            logger.debug({ error, session }, "rebuilding unreadable Claude changes facts");
        }
        return new Map();
    }
}

export function saveClaudeFacts(session: string, folds: ReadonlyMap<string, FoldedFacts>): void {
    const files = Object.fromEntries(
        Array.from(folds, ([path, { ino, consumed, mark, state }]) => [
            path,
            {
                ino,
                consumed,
                mark,
                facts: {
                    ...state,
                    ledger: [...state.ledger.values()],
                    calls: [...state.calls.values()],
                    promptIds: [...state.promptIds],
                    cwds: [...state.cwds],
                    errorIds: [...state.errorIds],
                    resultIds: [...state.resultIds],
                    finishedTurns: [...state.finishedTurns],
                    newestBackupTime: [...state.newestBackupTime],
                    backupOffsets: [...state.backupOffsets],
                },
            },
        ])
    );
    try {
        atomicWriteFileSync(cachePath(session), SafeJSON.stringify({ version: 1, files }, { strict: true }), {
            mode: 0o600,
        });
    } catch (error) {
        logger.debug({ error, session }, "could not save Claude changes facts");
    }
}
