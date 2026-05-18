import logger from "@app/logger";
import type { QuestionConfig } from "../config";
import type { QaEntry } from "../types";
import { type Sink, SinkError, type SinkResult } from "./types";

const log = logger.child({ component: "question:fanout" });
const REGISTRY: Sink[] = [];

export function registerSink(sink: Sink): void {
    if (!REGISTRY.some((s) => s.name === sink.name)) {
        REGISTRY.push(sink);
    }
}

function timeout(ms: number): { promise: Promise<never>; clear: () => void } {
    let id: ReturnType<typeof setTimeout>;
    const promise = new Promise<never>((_, rej) => {
        id = setTimeout(() => rej(new Error(`sink timeout after ${ms}ms`)), ms);
    });
    return { promise, clear: () => clearTimeout(id) };
}

export async function runFanOut(
    entry: QaEntry,
    config: QuestionConfig,
    sinks: Sink[] = REGISTRY,
    timeoutMs = 2000
): Promise<SinkResult[]> {
    const enabled = sinks.filter((s) => {
        try {
            return s.isEnabled(config);
        } catch (err) {
            // Fault-isolate a broken isEnabled (it must not block other sinks),
            // but surface it — a swallowed error is a hidden misconfig (t20).
            log.warn({ sink: s.name, err }, "sink isEnabled() threw — treating as disabled");
            return false;
        }
    });
    return Promise.all(
        enabled.map(async (s): Promise<SinkResult> => {
            const t = timeout(timeoutMs);
            try {
                await Promise.race([Promise.resolve(s.emit(entry, config)), t.promise]);
                return { name: s.name, ok: true };
            } catch (err) {
                const remedy = err instanceof SinkError ? err.remedy : undefined;
                const error = err instanceof Error ? err.message : String(err);
                log.warn({ sink: s.name, error, remedy }, "sink failed (isolated, surfaced)");
                return { name: s.name, ok: false, error, remedy };
            } finally {
                t.clear(); // cancel the timer on the happy path so it can't keep the loop alive (t3)
            }
        })
    );
}
