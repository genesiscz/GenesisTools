import { readFileSync } from "node:fs";
import { harnessHooks } from "@genesiscz/utils/ai/providers/harness-hooks";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { nativeHomePath } from "@genesiscz/utils/providers/session-paths";
import { hookDiag } from "./log";

export interface ModelInfo {
    model: string | null;
    /** payload: the hook envelope named it (Codex). settings-fallback: Claude's settings.json. */
    source: "payload" | "transcript" | "settings-fallback" | "none";
}

export function readModelFromSettings(path = nativeHomePath("claude", "settings.json")): string | null {
    try {
        const model = (SafeJSON.parse(readFileSync(path, "utf8")) as { model?: unknown } | null)?.model;

        return typeof model === "string" && model.length > 0 ? model : null;
    } catch (err) {
        hookDiag("No model in settings.json", { err, path });
        return null;
    }
}

/**
 * The model of the session that ran the hook: its harness's `currentModel` read from the transcript (a bounded
 * tail; Grok's `summary.json`), then `~/.claude/settings.json` where the harness's hook facts allow it
 * (`settingsModel`). That file says nothing about the model a grok session runs, and on 2026-09-16 every grok row was
 * logged as "sonnet" because of it.
 */
export function resolveModel(harness: HarnessId, transcriptPath: string | undefined): ModelInfo {
    const facts = harnessHooks(harness);
    const fromTranscript = transcriptPath ? facts.currentModel(transcriptPath) : null;

    if (fromTranscript) {
        return { model: fromTranscript, source: "transcript" };
    }

    const fromSettings = facts.settingsModel ? readModelFromSettings() : null;

    if (fromSettings) {
        return { model: fromSettings, source: "settings-fallback" };
    }

    return { model: null, source: "none" };
}
