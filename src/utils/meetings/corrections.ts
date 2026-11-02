import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";

const { log } = logger.scoped("meetings-corrections");

/** A correction a person confirmed. `dictionary suggest` proposes a fix seen twice. */
const correctionSchema = z.object({
    at: z.string(),
    meeting: z.string(),
    project: z.string().optional(),
    kind: z.enum(["term", "join"]),
    heard: z.string(),
    fixed: z.string(),
    item: z.string(),
});
export type Correction = z.infer<typeof correctionSchema>;

export function correctionsPath(): string {
    return join(toolDataDir("meetings"), "corrections.jsonl");
}

/** Appends one line per confirmed correction. One short line per write, so concurrent writers do not interleave. */
export function appendCorrections(corrections: Correction[]): void {
    if (corrections.length === 0) {
        return;
    }

    const path = correctionsPath();

    if (!existsSync(dirname(path))) {
        mkdirSync(dirname(path), { recursive: true });
    }

    appendFileSync(path, corrections.map((entry) => `${SafeJSON.stringify(entry)}\n`).join(""));
    log.debug({ path, count: corrections.length }, "corrections recorded");
}

export function readCorrections(): Correction[] {
    const path = correctionsPath();

    if (!existsSync(path)) {
        return [];
    }

    return Array.from(readLinesSync(path))
        .filter((line) => line.trim())
        .flatMap((line) => {
            try {
                return [correctionSchema.parse(SafeJSON.parse(line, { strict: true }))];
            } catch (err) {
                log.warn({ err, path }, "corrections line does not parse; skipped");
                return [];
            }
        });
}
