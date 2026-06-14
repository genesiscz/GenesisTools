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

    let entries: string[];
    try {
        entries = readdirSync(root);
    } catch (err) {
        logger.warn({ err, root }, "ai-spend: failed to read Claude Code projects dir");
        return [];
    }

    const out: string[] = [];
    for (const entry of entries) {
        const dir = join(root, entry);
        try {
            if (!statSync(dir).isDirectory()) {
                continue;
            }
        } catch (err) {
            logger.warn({ err, dir }, "ai-spend: failed to stat project entry");
            continue;
        }

        let files: string[];
        try {
            files = readdirSync(dir);
        } catch (err) {
            logger.warn({ err, dir }, "ai-spend: failed to read project dir");
            continue;
        }

        for (const file of files) {
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
