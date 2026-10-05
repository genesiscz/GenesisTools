import { logger } from "@genesiscz/utils/logger";
import { prof } from "../prof";
import { type LoadOptions, loadEvents } from "./load";
import { SOURCE_IDS, type SourceId, type SpendEvent } from "./types";

export interface LoadJob {
    options: LoadOptions;
}

export type LoadJobResult = { ok: true; events: SpendEvent[] } | { ok: false; error: string };

const WORKER_URL = new URL("./load-worker.ts", import.meta.url);
const WORKER_TIMEOUT_MS = 5 * 60_000;

/** The three native agents each get a thread; every other source shares one. */
function jobGroups(wanted: readonly SourceId[]): SourceId[][] {
    const native = (["claude", "codex", "grok"] as const).filter((id) => wanted.includes(id)).map((id) => [id]);
    const rest = wanted.filter((id) => id !== "claude" && id !== "codex" && id !== "grok");

    return rest.length > 0 ? [...native, rest] : native;
}

export interface ParallelLoadSeams {
    /** Tests only. A module that stands in for `load-worker.ts`. */
    workerUrl?: URL;
    /** Tests only. Replaces the five-minute worker deadline. */
    timeoutMs?: number;
}

function runInWorker(label: string, options: LoadOptions, seams: ParallelLoadSeams): Promise<SpendEvent[]> {
    const timeoutMs = seams.timeoutMs ?? WORKER_TIMEOUT_MS;

    return new Promise<SpendEvent[]>((resolve, reject) => {
        const worker = new Worker(seams.workerUrl ?? WORKER_URL);
        let settled = false;

        const finish = (act: () => void): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            worker.terminate();
            act();
        };

        const timer = setTimeout(() => {
            finish(() => reject(new Error(`${label} load did not finish within ${timeoutMs / 1000}s`)));
        }, timeoutMs);

        worker.onmessage = (event: MessageEvent<LoadJobResult>) => {
            finish(() => (event.data.ok ? resolve(event.data.events) : reject(new Error(event.data.error))));
        };
        worker.onerror = (event) => {
            finish(() => reject(new Error(event.message ?? `${label} load worker failed`)));
        };
        worker.postMessage({ options } satisfies LoadJob);
    });
}

/**
 * `loadEvents` with the source groups read concurrently, one worker each.
 *
 * Measured 2026-10-04 on a 7-day window: Claude 2.9 s, Codex 1.1 s, Grok 0.3 s and the other sources
 * 2.7 s in sequence. A group whose worker fails is read inline instead, so a worker problem costs time,
 * never data. One group, or a single-session lookup, loads inline: a worker would only add its startup.
 *
 * Groups hold disjoint sources and event ids are keyed by source, so no cross-group dedup is needed.
 */
export async function loadEventsParallel(options: LoadOptions, seams: ParallelLoadSeams = {}): Promise<SpendEvent[]> {
    const wanted = options.sources ?? SOURCE_IDS;
    const groups = jobGroups(wanted);

    if (options.sessionId || groups.length < 2) {
        return loadEvents(options);
    }

    const parts = await Promise.all(
        groups.map(async (sources) => {
            const label = sources.length === 1 ? sources[0] : "other-sources";
            const groupOptions: LoadOptions = { ...options, sources };

            try {
                return await prof.measureAsync(`load-group:${label}`, () => runInWorker(label, groupOptions, seams));
            } catch (err) {
                logger.warn({ err, label }, "ai-spend: load worker failed, reading this group inline");

                return prof.measure(`load-group:${label}:inline`, () => loadEvents(groupOptions));
            }
        })
    );

    return parts.flat();
}
