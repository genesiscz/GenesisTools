import { logger } from "@genesiscz/utils/logger";
import { appendSpoolLines, spoolLine } from "./spool";
import type { Dims } from "./types";

const { log } = logger.scoped("metrics-client");

/** How long recorded lines wait before one append; an exit writes them at once. */
const FLUSH_MS = 1_000;

export interface MetricsRecorder {
    /** Buffers one event for the spool. Never throws and never waits; the line is written within a second. */
    record(project: string, metric: string, value: number, dims?: Dims, context?: unknown): void;
    /** Writes the buffered lines now. */
    flush(): void;
}

/**
 * A recorder that appends to `<metrics>/spool/<writer>-<day>.jsonl`. It does not talk to the service and loads no
 * SQLite: the service drains the spool when it next runs.
 */
export function createMetricsRecorder(options: { writer: string; dir?: string; flushMs?: number }): MetricsRecorder {
    let lines: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hooked = false;

    const flush = (): void => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }

        if (lines.length === 0) {
            return;
        }

        const batch = lines;
        lines = [];

        try {
            appendSpoolLines({ writer: options.writer, lines: batch, ...(options.dir ? { dir: options.dir } : {}) });
        } catch (error) {
            log.debug({ error, writer: options.writer, lines: batch.length }, "metrics lines could not be spooled");
        }
    };

    return {
        record(project, metric, value, dims, context) {
            try {
                lines.push(
                    spoolLine({
                        project,
                        metric,
                        at: Date.now(),
                        value,
                        ...(dims ? { dims } : {}),
                        ...(context === undefined ? {} : { context }),
                    })
                );

                if (!hooked) {
                    hooked = true;
                    process.once("exit", flush);
                }

                if (!timer) {
                    timer = setTimeout(flush, options.flushMs ?? FLUSH_MS);
                    timer.unref?.();
                }
            } catch (error) {
                log.debug({ error, project, metric }, "a metrics event could not be recorded");
            }
        },
        flush,
    };
}

/** The recorder of `tools` processes: `metrics.record("my-tool", "fetch.ms", 120, { host })`. */
export const metrics: MetricsRecorder = createMetricsRecorder({ writer: "tools" });
