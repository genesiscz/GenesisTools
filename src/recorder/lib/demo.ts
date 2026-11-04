import { execTool } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import type { EditOp } from "@genesiscz/utils/recording-editor/project";
import { z } from "zod";

const { log } = logger.scoped("recorder-demo");

/**
 * How a demo becomes a finished movie: which waits are cut, how much of each step's edges stays, and the captions.
 * Every value has a default, so `{ steps }` alone gives a demo.
 */
export const demoEditSchema = z
    .object({
        /** Cut the time between one step's end and the next step's start (the agent thinking, a page loading). */
        cutWaits: z.boolean().default(true),
        /** A wait shorter than this stays. */
        minWaitSeconds: z.number().min(0).max(60).default(0.8),
        /** Kept at both ends of a cut wait, so a step never starts or ends on a jump. */
        keepSeconds: z.number().min(0).max(5).default(0.3),
        /** Kept before the first step and after the last one. */
        leadSeconds: z.number().min(0).max(10).default(0.5),
        tailSeconds: z.number().min(0).max(10).default(1),
        /**
         * Cut the waiting inside each step: still and silent stretches (idle.ts) while its code runs (a page that
         * loads, the agent thinking). A step's hold, where its result stays on screen, is never cut.
         */
        cutIdle: z.boolean().default(true),
        idleMinSeconds: z.number().min(0.5).max(600).default(1),
        /** One caption per step, its text the step's caption, shown while the step plays. */
        captions: z.boolean().default(true),
        captionPosition: z.enum(["bottom", "top"]).default("bottom"),
        /** A caption stays at least this long, even for a quick step. */
        captionMinSeconds: z.number().min(0.5).max(30).default(1.8),
        /** Mark each step in the recording, so markers() and the editor's timeline list them. */
        markers: z.boolean().default(true),
    })
    .strict();
export type DemoEditOptions = z.infer<typeof demoEditSchema>;

/**
 * One step as it ran, in movie (source) ms: its start, the end of its code (`runEndMs`), and the end of its hold, the
 * time its result stayed on screen (`endMs`).
 */
export interface DemoStepTiming {
    caption: string;
    startMs: number;
    runEndMs: number;
    endMs: number;
}

/** `ranges` without the parts inside `keep`; both are [from, to] in ms. Pure. */
export function subtractRanges(
    ranges: ReadonlyArray<readonly [number, number]>,
    keep: ReadonlyArray<readonly [number, number]>
): Array<[number, number]> {
    let pieces: Array<[number, number]> = ranges.map(([from, to]) => [from, to]);

    for (const [keepFrom, keepTo] of keep) {
        pieces = pieces.flatMap(([from, to]): Array<[number, number]> => {
            if (keepTo <= from || keepFrom >= to) {
                return [[from, to]];
            }

            return [
                ...(from < keepFrom ? [[from, keepFrom] as [number, number]] : []),
                ...(keepTo < to ? [[keepTo, to] as [number, number]] : []),
            ];
        });
    }

    return pieces;
}

/**
 * The edit ops that turn a raw demo recording into the finished demo: the waits around and between the steps cut,
 * idle stretches inside them removed, and a caption per step. Pure; times are SOURCE seconds.
 */
export function demoEditOps(options: {
    steps: readonly DemoStepTiming[];
    durationMs: number;
    /** The movie's still and silent stretches (idle.ts), in ms; without them only the waits around steps are cut. */
    idleMs?: ReadonlyArray<readonly [number, number]>;
    edit?: z.input<typeof demoEditSchema>;
}): EditOp[] {
    const edit = demoEditSchema.parse(options.edit ?? {});
    const steps = [...options.steps].sort((a, b) => a.startMs - b.startMs);
    const ops: EditOp[] = [];
    const seconds = (ms: number) => Math.round(ms) / 1000;
    const duration = options.durationMs;

    if (steps.length === 0 || duration <= 0) {
        return ops;
    }

    const cut = (fromMs: number, toMs: number, minMs: number) => {
        const from = Math.max(0, fromMs);
        const to = Math.min(duration, toMs);

        if (to - from >= minMs && to - from > 0) {
            ops.push({ op: "cut", from: seconds(from), to: seconds(to) });
        }
    };

    if (edit.cutIdle && options.idleMs?.length) {
        const keepMs = edit.keepSeconds * 1000;
        // A step's first moments and its hold stay; so does the time around every step's edges.
        const kept = steps.flatMap(
            (step): Array<[number, number]> => [
                [step.startMs - keepMs, step.startMs + keepMs],
                [step.runEndMs - keepMs, step.endMs + keepMs],
            ]
        );
        const inside = options.idleMs.flatMap(
            ([from, to]): Array<[number, number]> =>
                steps.flatMap((step): Array<[number, number]> => {
                    const start = Math.max(from, step.startMs);
                    const end = Math.min(to, step.runEndMs);
                    return end > start ? [[start, end]] : [];
                })
        );

        for (const [from, to] of subtractRanges(inside, kept)) {
            cut(from, to, edit.idleMinSeconds * 1000);
        }
    }

    if (edit.cutWaits) {
        const first = steps[0];
        const last = steps[steps.length - 1];
        const minMs = edit.minWaitSeconds * 1000;
        cut(0, first.startMs - edit.leadSeconds * 1000, minMs);

        for (let index = 1; index < steps.length; index++) {
            const previousEnd = Math.max(...steps.slice(0, index).map((step) => step.endMs));
            cut(previousEnd + edit.keepSeconds * 1000, steps[index].startMs - edit.keepSeconds * 1000, minMs);
        }

        cut(last.endMs + edit.tailSeconds * 1000, duration, minMs);
    }

    if (edit.captions) {
        for (const [index, step] of steps.entries()) {
            const text = step.caption.trim().slice(0, 200);

            if (!text) {
                continue;
            }

            const nextStart = steps[index + 1]?.startMs ?? duration;
            const end = Math.min(
                duration,
                Math.max(step.endMs, step.startMs + edit.captionMinSeconds * 1000),
                Math.max(nextStart, step.endMs)
            );

            if (end - step.startMs < 100) {
                continue;
            }

            ops.push({
                op: "text",
                from: seconds(step.startMs),
                to: seconds(end),
                text,
                y: edit.captionPosition === "bottom" ? 0.88 : 0.1,
            });
        }
    }

    return ops;
}

/** A step an agent runs: what it says on screen and the code that does it. */
export interface DemoStep {
    caption: string;
    run?: () => unknown;
    /** Seconds the result stays on screen after the step (kept in the movie). */
    holdSeconds?: number;
}

/** The recording a demo drives: a mark for each step, its stop, the edit and the export. */
export interface DemoSession {
    mark(label: string): Promise<{ atMs: number }>;
    /** Stops and waits for the finished movie; the recording's folder. */
    stop(): Promise<string>;
}

export interface DemoDriver {
    start(): Promise<DemoSession>;
    /** The movie's length in ms (source time). */
    durationMs(folder: string): Promise<number>;
    /** Its still and silent stretches of at least `minMs`, in ms (idle.ts `findIdle`). */
    idleMs(folder: string, minMs: number): Promise<Array<[number, number]>>;
    edit(folder: string, ops: EditOp[]): Promise<void>;
    exportMovie?(folder: string): Promise<{ path: string; outputSeconds?: number }>;
    sleep(ms: number): Promise<void>;
    now(): number;
}

export interface DemoResult {
    folder: string;
    steps: DemoStepTiming[];
    /** The steps that threw, with the message; the demo goes on with the next step. */
    failed: Array<{ caption: string; error: string }>;
    ops: number;
    sourceSeconds: number;
    exported?: { path: string; outputSeconds?: number };
}

/**
 * Records a demo: starts the recording, runs each step between a mark at its start and the hold after it, stops, and
 * edits the movie with `demoEditOps` (the waits cut, a caption per step), then exports when the driver can. A step
 * that throws is noted and the next one runs; the recording always stops.
 */
export async function runDemo(options: {
    steps: readonly DemoStep[];
    driver: DemoDriver;
    edit?: z.input<typeof demoEditSchema>;
    /** Seconds to wait after the recording started, before the first step (the controls settle). */
    settleSeconds?: number;
    /** False keeps the edited recording without an export. */
    export?: boolean;
    /** Seconds a step's result stays on screen when the step names none. */
    holdSeconds?: number;
}): Promise<DemoResult> {
    if (options.steps.length === 0) {
        throw new Error("a demo needs at least one step: { caption, run }");
    }

    const edit = demoEditSchema.parse(options.edit ?? {});
    const { driver } = options;
    const session = await driver.start();
    const steps: DemoStepTiming[] = [];
    const failed: DemoResult["failed"] = [];
    let folder: string | undefined;

    try {
        await driver.sleep((options.settleSeconds ?? 0.6) * 1000);

        for (const step of options.steps) {
            const wallStart = driver.now();
            const atMs = edit.markers ? (await session.mark(step.caption.slice(0, 80))).atMs : undefined;
            const startMs = atMs ?? 0;

            try {
                await step.run?.();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log.warn({ caption: step.caption, error: message }, "demo step failed; the demo goes on");
                failed.push({ caption: step.caption, error: message });
            }

            const runEndMs = startMs + (driver.now() - wallStart);
            await driver.sleep((step.holdSeconds ?? options.holdSeconds ?? 1) * 1000);
            steps.push({ caption: step.caption, startMs, runEndMs, endMs: startMs + (driver.now() - wallStart) });
        }
    } finally {
        folder = await session.stop();
    }

    const durationMs = await driver.durationMs(folder);
    const idleMs = edit.cutIdle ? await driver.idleMs(folder, edit.idleMinSeconds * 1000) : undefined;
    const ops = demoEditOps({ steps, durationMs, idleMs, edit: options.edit });

    if (ops.length > 0) {
        await driver.edit(folder, ops);
    }

    log.info({ folder, steps: steps.length, failed: failed.length, ops: ops.length, durationMs }, "demo recorded");
    const exported = options.export !== false && driver.exportMovie ? await driver.exportMovie(folder) : undefined;
    return {
        folder,
        steps,
        failed,
        ops: ops.length,
        sourceSeconds: Math.round(durationMs) / 1000,
        ...(exported ? { exported } : {}),
    };
}

/**
 * The JSON door's steps (`tools recorder demo <script.json>`): each runs a `tools` command, a shell line, or just
 * waits, so a demo can be written without the REPL.
 */
export const demoScriptStepSchema = z
    .object({
        caption: z.string().trim().min(1).max(200),
        /** A `tools` command's words, e.g. ["control", "click", "--app", "Safari", "--title", "Reload"]. */
        tools: z.array(z.string()).min(1).optional(),
        /** A shell line (zsh -c). */
        shell: z.string().min(1).optional(),
        /** Seconds to wait as the step (a page that plays by itself). */
        wait: z.number().min(0).max(600).optional(),
        holdSeconds: z.number().min(0).max(60).optional(),
    })
    .strict();

export const demoScriptSchema = z
    .object({
        title: z.string().optional(),
        record: z
            .object({
                audio: z.array(z.enum(["system", "mic"])).optional(),
                display: z.number().int().min(0).optional(),
                app: z.string().optional(),
                window: z.array(z.number().int()).optional(),
                fps: z.number().min(1).max(120).optional(),
                camera: z.boolean().optional(),
                /** false: no floating controls and no red border (they never show in the movie either way). */
                controls: z.boolean().optional(),
                indicator: z.boolean().optional(),
            })
            .strict()
            .default({}),
        edit: demoEditSchema.partial().optional(),
        settleSeconds: z.number().min(0).max(30).optional(),
        holdSeconds: z.number().min(0).max(60).optional(),
        export: z.boolean().optional(),
        steps: z.array(demoScriptStepSchema).min(1),
    })
    .strict();
export type DemoScript = z.infer<typeof demoScriptSchema>;

/** The longest a script step's command may run before the demo gives up on it and goes on. */
const SCRIPT_STEP_TIMEOUT_MS = 5 * 60_000;

/** The steps of a JSON script, each running its `tools` command, its shell line, then its wait. */
export function scriptSteps(script: DemoScript): DemoStep[] {
    return script.steps.map((step) => ({
        caption: step.caption,
        holdSeconds: step.holdSeconds,
        run: async () => {
            if (step.tools) {
                const result = await execTool(step.tools, { timeout: SCRIPT_STEP_TIMEOUT_MS });

                if (!result.success) {
                    throw new Error(
                        `tools ${step.tools.join(" ")} exited ${result.exitCode}: ${result.stderr.trim().slice(-300)}`
                    );
                }
            }

            if (step.shell) {
                const proc = Bun.spawn(["/bin/zsh", "-c", step.shell], { stdout: "ignore", stderr: "pipe" });
                const timer = setTimeout(() => proc.kill(), SCRIPT_STEP_TIMEOUT_MS);
                const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
                clearTimeout(timer);

                if (code !== 0) {
                    throw new Error(`the shell line exited ${code}: ${stderr.trim().slice(-300)}`);
                }
            }

            if (step.wait) {
                await Bun.sleep(step.wait * 1000);
            }
        },
    }));
}
