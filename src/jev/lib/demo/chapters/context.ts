import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { FixtureScript } from "../fixture-evaluator";

export const DEMO_NAMES = ["listen", "voice", "watch", "route", "compact", "observe", "verify", "loop"] as const;
export type DemoName = (typeof DEMO_NAMES)[number];

export interface DemoEvent {
    atMs: number;
    kind: string;
    detail?: string;
}

export interface ChapterContext {
    /**
     * Builds the evaluator for this chapter from the chapter's own scripted table. The reel owns
     * the factory, so no chapter can reach `createEvaluator()` and spend money, and a test can
     * hand every chapter a throwing evaluator to prove each one really asks Jev.
     */
    evaluator(script: FixtureScript): Evaluator;
    signal?: AbortSignal;
    /** Injected clock, so a test gets deterministic `atMs` values and no wall-clock wait. */
    now: () => number;
}

export interface ChapterOutcome {
    /**
     * The chapter checked its own result against what the fixture scripts. This is the ONLY
     * thing that can make a chapter green: `ok` is derived from it, never asserted by the chapter.
     */
    readback: boolean;
    reason: string;
    events: DemoEvent[];
    /** The lib function's own return value, written to `<dir>/<chapter>.json`. */
    result: unknown;
}

export type Chapter = (context: ChapterContext) => Promise<ChapterOutcome>;

export interface EventLog {
    add(kind: string, detail?: string): void;
    events(): DemoEvent[];
}

export function createEventLog(now: () => number): EventLog {
    const startedAt = now();
    const events: DemoEvent[] = [];
    return {
        add(kind, detail) {
            events.push({ atMs: Math.max(0, now() - startedAt), kind, ...(detail === undefined ? {} : { detail }) });
        },
        events: () => events,
    };
}

export function mismatch(expected: string, actual: string): string {
    return `expected ${expected}, got ${actual}`;
}
