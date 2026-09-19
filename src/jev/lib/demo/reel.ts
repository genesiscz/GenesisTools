import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { CHAPTERS } from "./chapters";
import { type ChapterContext, DEMO_NAMES, type DemoEvent, type DemoName } from "./chapters/context";
import { createFixtureEvaluator } from "./fixture-evaluator";

const prof = profiler.scope("jev-observe");
const { log } = logger.scoped("jev-demo");

export { DEMO_NAMES, type DemoEvent, type DemoName } from "./chapters/context";

export interface DemoTrace {
    demo: DemoName;
    startedAt: string;
    events: DemoEvent[];
    readback: boolean;
    ok: boolean;
    reason: string;
    /** Jev requests the chapter spent, all of them answered by the fixture evaluator. */
    requests: number;
    /** Written when `--dir` is given. */
    artifact?: string;
}

export interface ReelResult {
    startedAt: string;
    chapters: DemoTrace[];
    failed: number;
    ok: boolean;
    dir?: string;
    record?: string;
}

export interface RunDemoOptions {
    /**
     * Replaces the fixture evaluator factory. Only a test passes this: handing every chapter an
     * evaluator that throws is the negative control proving each chapter really asks Jev.
     */
    evaluator?: ChapterContext["evaluator"];
    now?: () => number;
    signal?: AbortSignal;
    /** Written when given: one `<chapter>.json` per chapter. */
    dir?: string;
}

export function isDemoName(name: string): name is DemoName {
    return (DEMO_NAMES as readonly string[]).includes(name);
}

export function parseDemoName(name: string): DemoName {
    if (!isDemoName(name)) {
        throw new Error(`Unknown demo '${name}'. Valid: ${DEMO_NAMES.join("|")}`);
    }

    return name;
}

/**
 * Runs ONE chapter's real lib function with the fixture evaluator.
 *
 * `ok` is derived from the chapter's own readback and can never be asserted by the chapter, which
 * is what PR #411 did for six of its eight names (B37) and PR #410 did for `loop` (B38). A chapter
 * that throws, or whose readback fails, is red.
 */
export async function runDemo(name: string, options: RunDemoOptions = {}): Promise<DemoTrace> {
    const demo = parseDemoName(name);
    const now = options.now ?? (() => Date.now());
    const startedAt = new Date(now()).toISOString();
    let requests = 0;
    const fixtureEvaluator: ChapterContext["evaluator"] = (script) => {
        const fixture = createFixtureEvaluator(script);
        return async (call) => {
            const answer = await fixture.evaluate(call);
            requests = fixture.calls();
            return answer;
        };
    };
    const context: ChapterContext = {
        evaluator: options.evaluator ?? fixtureEvaluator,
        now,
        ...(options.signal ? { signal: options.signal } : {}),
    };
    const startedMs = now();
    log.info({ demo }, "demo chapter starting");
    try {
        const outcome = await prof.measureAsync(`demo:${demo}`, () => CHAPTERS[demo](context));
        const trace: DemoTrace = {
            demo,
            startedAt,
            events: outcome.events,
            readback: outcome.readback,
            ok: outcome.readback,
            reason: outcome.reason,
            requests,
        };
        log.info({ demo, ok: trace.ok, requests, ms: now() - startedMs }, "demo chapter finished");
        return options.dir ? await writeArtifact(options.dir, trace, outcome.result) : trace;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ demo, error, ms: now() - startedMs }, "demo chapter failed");
        const trace: DemoTrace = {
            demo,
            startedAt,
            events: [{ atMs: Math.max(0, now() - startedMs), kind: "error", detail: message }],
            readback: false,
            ok: false,
            reason: message,
            requests,
        };
        return options.dir ? await writeArtifact(options.dir, trace, { error: message }) : trace;
    }
}

async function writeArtifact(dir: string, trace: DemoTrace, result: unknown): Promise<DemoTrace> {
    const artifact = join(dir, `${trace.demo}.json`);
    await mkdir(dir, { recursive: true });
    await Bun.write(artifact, `${SafeJSON.stringify({ ...trace, artifact, result }, null, 2)}\n`);
    log.debug({ artifact }, "demo chapter artifact written");
    return { ...trace, artifact };
}

/** Every chapter, in order, plus `reel.json` with the summary when `--dir` is given. */
export async function runReel(options: RunDemoOptions = {}): Promise<ReelResult> {
    const now = options.now ?? (() => Date.now());
    const startedAt = new Date(now()).toISOString();
    const chapters: DemoTrace[] = [];
    for (const name of DEMO_NAMES) {
        chapters.push(await runDemo(name, options));
    }

    const failed = chapters.filter((chapter) => !chapter.ok).length;
    const result: ReelResult = {
        startedAt,
        chapters,
        failed,
        ok: failed === 0,
        ...(options.dir ? { dir: options.dir } : {}),
    };
    log.info({ chapters: chapters.length, failed }, "demo reel finished");
    return result;
}

export async function writeReelSummary(dir: string, result: ReelResult): Promise<string> {
    const path = join(dir, "reel.json");
    await mkdir(dir, { recursive: true });
    await Bun.write(path, `${SafeJSON.stringify(result, null, 2)}\n`);
    log.info({ path, failed: result.failed }, "demo reel summary written");
    return path;
}

export function refuseUserMail(app?: string, force?: boolean): void {
    if (app === "Mail" && !force) {
        throw new Error("Demo refuses --app Mail without --i-mean-it. Use the AppKit fixture.");
    }
}
