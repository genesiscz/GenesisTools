import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { JobRegistry, type ProgressEvent } from "@genesiscz/utils/jobs";
import {
    type EditFrame,
    type EditJob,
    type EditResult,
    type EditSheet,
    RecordingEditor,
} from "@genesiscz/utils/recording-editor/editor";
import {
    type EditPlanInput,
    type EditSource,
    type EditStep,
    EXPORT_FORMATS,
    editPlanSchema,
    GRID_LABELS,
    timeSchema,
} from "@genesiscz/utils/recording-editor/plan";
import { loadSource, locateSource } from "@genesiscz/utils/recording-editor/source";
import { z } from "zod";
import { ReplToolset, type ToolsetContext } from "../toolset";

const windowSchema = { from: timeSchema.optional(), to: timeSchema.optional() };
const framesOptionsSchema = z
    .object({
        ...windowSchema,
        fps: z.number().min(0.05).max(30).optional(),
        changeOnly: z.boolean().optional(),
        threshold: z.number().min(0).max(100).optional(),
        displays: z.array(z.number().int()).optional(),
    })
    .strict();
const gridOptionsSchema = framesOptionsSchema.extend({
    /** A FrameSet from clip.frames(); its steps are reused through their receipts. */
    frames: z.custom<FrameSet>().optional(),
    cols: z.number().int().min(1).max(8).optional(),
    rows: z.number().int().min(1).max(8).optional(),
    perImage: z.number().int().min(1).max(32).optional(),
    labels: z.enum(GRID_LABELS).optional(),
    maxWidth: z.number().int().min(256).max(8192).optional(),
});

/** Frames from clip.frames(): the kept ones, and the plan steps that made them. */
export interface FrameSet {
    frames: EditFrame[];
    total: number;
    outputDir: string;
}

const stepsOf = new WeakMap<object, EditStep[]>();

const jobDoc =
    'a Job: await it (or job.done) for the result, job.on("progress", e => …) for ProgressEvents, job.cancel()';

const clipMethods = [
    defineMethod({
        name: "info",
        params: z.object({}),
        result: z.unknown(),
        resultName: "{ kind, path, durationUs, frames?, displays? }",
        doc: "What the source is.",
        effect: "read",
    }),
    defineMethod({
        name: "frames",
        params: framesOptionsSchema,
        result: z.unknown(),
        resultName: "Job<FrameSet>",
        doc: `Frames at fps, or change-only frames above threshold percent; ${jobDoc}.`,
        effect: "reversible",
    }),
    defineMethod({
        name: "grid",
        params: gridOptionsSchema,
        result: z.unknown(),
        resultName: "Job<{ sheets, paths }> & { show() }",
        doc: "Contact sheets of cols × rows frames with time labels; .show() returns them as images.",
        effect: "reversible",
    }),
    defineMethod({
        name: "trim",
        params: z.object(windowSchema).strict(),
        result: z.unknown(),
        resultName: "Job<Clip>",
        doc: "A new clip of the range (a new file; the input is never written).",
        effect: "reversible",
    }),
    defineMethod({
        name: "speed",
        params: z.object({ factor: z.number().min(0.25).max(16) }),
        positional: ["factor"],
        result: z.unknown(),
        resultName: "Job<Clip>",
        doc: "A new clip played factor times faster.",
        effect: "reversible",
    }),
    defineMethod({
        name: "export",
        params: z.object({ format: z.enum(EXPORT_FORMATS), output: z.string().optional() }).strict(),
        result: z.unknown(),
        resultName: "Job<{ path, format }>",
        doc: "The clip as mp4, gif or webm; an output equal to an input is refused.",
        effect: "reversible",
    }),
];

export const editorApi = defineApi({
    id: "editor",
    global: "editor",
    title: "Recording editor",
    summary:
        "Cut recordings and videos into frames, change-only frames, image grids, trims, speed changes and exports.",
    methods: [
        defineMethod({
            name: "open",
            params: z.object({ source: z.string() }),
            positional: ["source"],
            result: z.unknown(),
            resultName: "Clip",
            doc: "A recording id (library or meeting) or a video or frames-folder path.",
            effect: "read",
        }),
        defineMethod({
            name: "run",
            params: editPlanSchema,
            result: z.unknown(),
            resultName: "Job<EditResult>",
            doc: "Runs a whole EditPlan.",
            effect: "reversible",
        }),
        defineMethod({
            name: "jobs",
            params: z.object({}),
            result: z.unknown(),
            resultName: "JobInfo[]",
            doc: "The jobs of this worker.",
            effect: "read",
        }),
    ],
    handles: [
        { name: "Clip", summary: "One source plus the trims and speed changes made to it.", methods: clipMethods },
    ],
    notes: ['Times are seconds or "mm:ss". A rerun of the same steps on the same source skips the finished steps.'],
});

/** A job the REPL can await directly. */
export class ReplJob<T> implements PromiseLike<T> {
    readonly done: Promise<T>;

    constructor(
        private readonly edit: EditJob,
        map: (result: EditResult) => T | Promise<T>
    ) {
        this.done = edit.done.then(map);
    }

    get id(): string {
        return this.edit.id;
    }

    get events(): ProgressEvent[] {
        return this.edit.events;
    }

    on(event: "progress", listener: (event: ProgressEvent) => void): () => void {
        return this.edit.on(event, listener);
    }

    cancel(): void {
        this.edit.cancel();
    }

    // biome-ignore lint/suspicious/noThenProperty: a job is awaited directly in the REPL.
    then<A = T, B = never>(
        onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
        onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
    ): Promise<A | B> {
        return this.done.then(onFulfilled, onRejected);
    }
}

export class GridJob extends ReplJob<{ sheets: EditSheet[]; paths: string[] }> {
    constructor(
        edit: EditJob,
        private readonly showImage: ToolsetContext["show"]
    ) {
        super(edit, (result) => ({ sheets: result.sheets, paths: result.sheets.map((sheet) => sheet.path) }));
    }

    /** Waits for the sheets and returns each to the model as an image. */
    async show(): Promise<string[]> {
        const { paths } = await this.done;

        for (const path of paths) {
            await this.showImage(path);
        }

        return paths;
    }
}

function windowStep(options: { from?: z.infer<typeof timeSchema>; to?: z.infer<typeof timeSchema> }): EditStep[] {
    return options.from !== undefined || options.to !== undefined
        ? [{ kind: "range", from: options.from, to: options.to }]
        : [];
}

/** One source plus the steps that changed it (trims, speed). */
export class Clip {
    constructor(
        private readonly editor: RecordingEditor,
        private readonly ctx: ToolsetContext,
        readonly source: EditSource,
        private readonly prefix: EditStep[] = []
    ) {}

    private start(steps: EditStep[]): EditJob {
        const plan: EditPlanInput = { source: this.source, steps: [...this.prefix, ...steps] };
        return this.editor.run(plan);
    }

    async info() {
        const loaded = await loadSource(locateSource(this.source));
        return loaded.kind === "video"
            ? {
                  kind: loaded.kind,
                  path: loaded.path,
                  durationUs: loaded.info.durationUs,
                  width: loaded.info.displayWidth,
                  height: loaded.info.displayHeight,
              }
            : {
                  kind: loaded.kind,
                  path: loaded.path,
                  durationUs: loaded.durationUs,
                  frames: loaded.frames.length,
                  displays: loaded.displays,
              };
    }

    private framesSteps(input: z.input<typeof framesOptionsSchema>): EditStep[] {
        const { from, to, ...frames } = framesOptionsSchema.parse(input);
        return [...windowStep({ from, to }), { kind: "frames", ...frames }];
    }

    frames(input: z.input<typeof framesOptionsSchema> = {}): ReplJob<FrameSet> {
        const steps = this.framesSteps(input);
        return new ReplJob(this.start(steps), (result) => {
            const set: FrameSet = { frames: result.kept, total: result.frames.length, outputDir: result.outputDir };
            stepsOf.set(set, steps);
            return set;
        });
    }

    grid(input: z.input<typeof gridOptionsSchema> = {}): GridJob {
        const { frames, cols, rows, perImage, labels, maxWidth, ...rest } = gridOptionsSchema.parse(input);
        const base = frames ? stepsOf.get(frames) : undefined;

        if (frames && !base) {
            throw new Error("grid({ frames }) takes the FrameSet that clip.frames() of this clip resolved to");
        }

        const steps: EditStep[] = [
            ...(base ?? this.framesSteps(rest)),
            { kind: "grid", cols, rows, perImage, labels: labels ?? "time", maxWidth },
        ];
        return new GridJob(this.start(steps), this.ctx.show);
    }

    private derived(step: EditStep): ReplJob<Clip> {
        return new ReplJob(
            this.start([step]),
            () => new Clip(this.editor, this.ctx, this.source, [...this.prefix, step])
        );
    }

    trim(input: { from?: z.infer<typeof timeSchema>; to?: z.infer<typeof timeSchema> }): ReplJob<Clip> {
        return this.derived({ kind: "trim", ...input });
    }

    speed(factor: number): ReplJob<Clip> {
        return this.derived({ kind: "speed", factor });
    }

    export(input: {
        format: (typeof EXPORT_FORMATS)[number];
        output?: string;
    }): ReplJob<{ path: string; format: string }> {
        return new ReplJob(this.start([{ kind: "export", ...input }]), (result) => {
            const last = result.exports.at(-1);

            if (!last) {
                throw new Error("The export wrote nothing");
            }

            return last;
        });
    }
}

/** A recording id, or a path when it is absolute or names something on disk. */
export function sourceOf(value: string): EditSource {
    return isAbsolute(value) || existsSync(value) ? { file: value } : { recording: value };
}

/** The REPL's `editor` global. */
export class EditorToolset extends ReplToolset {
    readonly api = editorApi;
    private readonly jobs = new JobRegistry();
    private readonly editor = new RecordingEditor({ registry: this.jobs });

    async bootstrap(ctx: ToolsetContext): Promise<Record<string, unknown>> {
        const editor = {
            open: (source: string) => {
                const clip = new Clip(this.editor, ctx, sourceOf(source));
                locateSource(clip.source);
                return clip;
            },
            run: (plan: EditPlanInput) => new ReplJob(this.editor.run(plan), (result) => result),
            jobs: () => this.jobs.list(),
        };
        return { editor };
    }

    override async dispose(): Promise<void> {
        for (const info of this.jobs.list()) {
            if (info.state === "running") {
                this.jobs.get(info.id)?.cancel();
            }
        }
    }
}
