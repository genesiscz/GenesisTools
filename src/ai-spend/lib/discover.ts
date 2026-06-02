import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@app/logger";
import { parseTranscriptLine } from "./parse";
import type { UsageEvent } from "./types";

/** All *.jsonl files under <homeDir>/.claude/projects (one level of project dirs). */
export function findTranscriptFiles(homeDir: string): string[] {
    const root = join(homeDir, ".claude", "projects");
    if (!existsSync(root)) {
        logger.debug({ root }, "ai-spend: no Claude Code projects dir");
        return [];
    }

    const out: string[] = [];
    for (const entry of readdirSync(root)) {
        const dir = join(root, entry);
        if (!statSync(dir).isDirectory()) {
            continue;
        }

        for (const file of readdirSync(dir)) {
            if (file.endsWith(".jsonl")) {
                out.push(join(dir, file));
            }
        }
    }

    logger.debug({ count: out.length }, "ai-spend: discovered transcript files");
    return out;
}

export function readEvents(files: string[]): UsageEvent[] {
    const events: UsageEvent[] = [];
    for (const file of files) {
        let content: string;
        try {
            content = readFileSync(file, "utf-8");
        } catch (err) {
            logger.warn({ err, file }, "ai-spend: failed to read transcript");
            continue;
        }

        for (const line of content.split("\n")) {
            const ev = parseTranscriptLine(line);
            if (ev) {
                events.push(ev);
            }
        }
    }

    return events;
}
