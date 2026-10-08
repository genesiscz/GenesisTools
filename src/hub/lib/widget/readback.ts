import { resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";

export async function readWidgetText({ text, signal }: { text: string; signal: AbortSignal }): Promise<void> {
    const visible = text.replace(/<from(?:Image|Video)>[\s\S]*?<\/from(?:Image|Video)>/g, "").trim();
    if (!visible) {
        return;
    }
    logger.info({ characters: visible.length }, "Widget read-aloud started with the say profile");
    const result = await boundedCommand({
        command: [
            process.execPath,
            resolve(import.meta.dir, "../../../../widget-tools"),
            "say",
            "--app",
            "widget",
            "--wait",
            // A text that starts with "-" (a markdown list) would otherwise be parsed as an option.
            "--",
            visible.slice(0, 32_000),
        ],
        signal,
        timeoutMs: 600_000,
    });
    if (!signal.aborted && (result.error || result.status !== 0)) {
        throw new Error(result.error?.message ?? (result.stderr.trim() || `say exited with status ${result.status}`));
    }
}
