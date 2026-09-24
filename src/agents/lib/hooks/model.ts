import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { hookDiag } from "./log";

export interface ModelInfo {
    model: string | null;
    /** payload: the hook envelope named it (Codex). settings-fallback: Claude's settings.json. */
    source: "payload" | "transcript" | "settings-fallback" | "none";
}

function tryParse(line: string): Record<string, unknown> | null {
    try {
        const parsed = SafeJSON.parse(line, { strict: true });

        return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
        // The tail cut leaves a partial first line, and some lines are not JSON at all, so
        // this fires per line on a normal read. Logging it would drown the decision log;
        // the caller reports the resolved model, which is the outcome that matters.
        return null;
    }
}

/**
 * Last main-loop assistant model in the transcript. Only the TAIL is read: a transcript can
 * be hundreds of MB. Sidechain lines are subagents, harness meta messages carry
 * `<synthetic>`, and an Agent `tool_use` input carries the SUBAGENT's model, so
 * `.message.model` on a non-sidechain assistant line is the only trustworthy source.
 */
export function readModelFromTranscript(transcriptPath: string | undefined, tailBytes = 262_144): string | null {
    if (!transcriptPath) {
        return null;
    }

    let text: string;

    try {
        const size = statSync(transcriptPath).size;
        const fd = openSync(transcriptPath, "r");

        try {
            const length = Math.min(size, tailBytes);
            const buf = Buffer.alloc(length);

            readSync(fd, buf, 0, length, size - length);
            text = buf.toString("utf8");
        } finally {
            closeSync(fd);
        }
    } catch (err) {
        hookDiag("Cannot read the transcript tail", { err, transcriptPath });
        return null;
    }

    const lines = text.split("\n");

    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];

        if (!line?.includes('"assistant"')) {
            continue;
        }

        const entry = tryParse(line);

        if (entry?.type !== "assistant" || entry.isSidechain === true) {
            continue;
        }

        const model = (entry.message as { model?: unknown } | undefined)?.model;

        if (typeof model === "string" && model.length > 0 && !model.startsWith("<")) {
            return model;
        }
    }

    return null;
}

export function readModelFromSettings(path = join(homedir(), ".claude", "settings.json")): string | null {
    try {
        const model = (SafeJSON.parse(readFileSync(path, "utf8")) as { model?: unknown } | null)?.model;

        return typeof model === "string" && model.length > 0 ? model : null;
    } catch (err) {
        hookDiag("No model in settings.json", { err, path });
        return null;
    }
}

/**
 * `settingsFallback` is for Claude payloads only: `~/.claude/settings.json` says nothing
 * about the model a grok session runs, and on 2026-09-16 every grok row was logged as
 * "sonnet" because of it.
 */
export function resolveModel(transcriptPath: string | undefined, { settingsFallback = true } = {}): ModelInfo {
    const fromTranscript = readModelFromTranscript(transcriptPath);

    if (fromTranscript) {
        return { model: fromTranscript, source: "transcript" };
    }

    const fromSettings = settingsFallback ? readModelFromSettings() : null;

    if (fromSettings) {
        return { model: fromSettings, source: "settings-fallback" };
    }

    return { model: null, source: "none" };
}
