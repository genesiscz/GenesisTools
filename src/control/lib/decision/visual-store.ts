import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createEvaluator, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { TemporaryArtifacts } from "@genesiscz/utils/fs/temporary-artifacts";
import { OperationBudget } from "@genesiscz/utils/operation-budget";
import { z } from "zod";
import { NativeVisualDriver, resolveVisualTarget, type VisualDriver, type VisualObservation } from "./visual";

export const visualCaptureRequest = z
    .object({
        app: z.string().trim().min(1).max(300),
        windowId: z.number().int().positive().optional(),
        windowIndex: z.number().int().nonnegative().optional(),
        scope: z.enum(["window", "chrome"]).default("window"),
        crop: z
            .string()
            .regex(/^\d+,\d+,\d+,\d+$/)
            .optional(),
        width: z.number().int().min(64).max(8192).optional(),
    })
    .strict()
    .refine((value) => value.windowId === undefined || value.windowIndex === undefined, "Choose window ID or index.");

type Entry = {
    observation: VisualObservation;
    driver: VisualDriver;
    created: number;
    used: boolean;
    file: string;
    busy: boolean;
};
export class VisualCaptureStore {
    private readonly entries = new Map<string, Entry>();
    private readonly artifacts = new TemporaryArtifacts({ prefix: "jev-visual", maxFiles: 6 });
    private pending = 0;
    /**
     * One evaluator per provider for the life of the store, not one per `choose()`.
     *
     * `createEvaluator` resolves a credential out of the secret store. This store is a
     * long-lived singleton on the API server, so creating one per choice re-paid that
     * resolution on every visual decision the server ever made.
     */
    private readonly evaluators = new Map<EvaluationProviderId, Promise<Evaluator>>();
    private expiry?: ReturnType<typeof setTimeout>;
    private closed = false;
    constructor(
        private readonly factory: (
            options: z.output<typeof visualCaptureRequest> & { path: string }
        ) => VisualDriver = (options) => new NativeVisualDriver({ ...options, background: true })
    ) {}
    private scheduleCleanup() {
        clearTimeout(this.expiry);
        const oldest = [...this.entries.values()]
            .filter((entry) => !entry.busy)
            .sort((a, b) => a.created - b.created)[0];
        if (!oldest || this.closed) {
            return;
        }
        this.expiry = setTimeout(
            () => {
                this.prune();
                this.scheduleCleanup();
            },
            Math.max(1, oldest.created + 120000 - Date.now())
        );
        this.expiry.unref();
    }
    private prune() {
        for (const [id, entry] of this.entries) {
            if (!entry.busy && Date.now() - entry.created >= 120000) {
                this.entries.delete(id);
                this.artifacts.release(entry.file);
            }
        }
    }
    private evaluator(provider: EvaluationProviderId): Promise<Evaluator> {
        const existing = this.evaluators.get(provider);

        if (existing) {
            return existing;
        }

        const created = createEvaluator({ provider });
        this.evaluators.set(provider, created);
        return created;
    }

    private entry(id: string): Entry {
        this.prune();
        const entry = this.entries.get(z.string().uuid().parse(id));
        if (!entry) {
            throw new Error("Capture expired or was replaced. Capture the window again.");
        }
        return entry;
    }
    async capture(input: unknown, signal: AbortSignal) {
        if (this.closed) {
            throw new Error("Capture store is closed.");
        }
        const options = visualCaptureRequest.parse(input);
        this.prune();
        if (this.pending >= 2) {
            throw new Error("Two captures are already pending.");
        }
        while (this.entries.size >= 4) {
            const oldest = [...this.entries].find(([, value]) => !value.busy);
            if (!oldest) {
                throw new Error("Captures are busy; wait for a pending operation.");
            }
            this.entries.delete(oldest[0]);
            this.artifacts.release(oldest[1].file);
        }
        const file = this.artifacts.allocate("png");
        const driver = this.factory({ ...options, path: file });
        this.pending++;
        try {
            const observation = await driver.observe({ signal, timeoutMs: 15000 });
            signal.throwIfAborted();
            if (this.closed) {
                throw new Error("Capture store closed during observation.");
            }
            if (observation.screenshot.path !== file) {
                throw new Error("Capture did not use its owned artifact path.");
            }
            const id = randomUUID();
            const entry: Entry = { observation, driver, file, created: Date.now(), used: false, busy: false };
            while (this.entries.size >= 4) {
                const oldest = [...this.entries].find(([, value]) => !value.busy);
                if (!oldest) {
                    throw new Error("Captures are busy; capture again when one finishes.");
                }
                this.entries.delete(oldest[0]);
                this.artifacts.release(oldest[1].file);
            }
            this.entries.set(id, entry);
            return {
                id,
                app: observation.app,
                window: observation.window,
                width: observation.screenshot.width,
                height: observation.screenshot.height,
                regions: observation.perception.regions,
                imageUrl: `/api/jev/control/visual/image?id=${id}`,
                created: entry.created,
                actionExpiresAt: observation.perception.capture.created * 1000 + 30000,
                method: observation.perception.method,
                transform: observation.perception.capture.transform,
            };
        } catch (error) {
            this.artifacts.release(file);
            throw error;
        } finally {
            this.pending--;
            this.scheduleCleanup();
        }
    }
    async image(id: string) {
        const entry = this.entry(id);
        if (Bun.file(entry.file).size > 32 * 1024 * 1024) {
            throw new Error("Capture exceeds the 32 MiB image budget.");
        }
        const data = await readFile(entry.file);
        if (createHash("sha256").update(data).digest("hex") !== entry.observation.perception.capture.pngHash) {
            throw new Error("Capture image changed.");
        }
        return data;
    }
    async choose(input: unknown, options: { provider: EvaluationProviderId; signal: AbortSignal }) {
        const request = z
            .object({
                id: z.string().uuid(),
                intent: z.string().min(1).max(4000),
                chooser: z.enum(["exact", "jev", "auto"]).default("exact"),
            })
            .strict()
            .parse(input);
        const entry = this.entry(request.id);
        if (entry.used || entry.busy) {
            throw new Error("Capture was consumed or is busy; capture again.");
        }
        if (Date.now() > entry.observation.perception.capture.created * 1000 + 30000) {
            throw new Error("Action evidence expired after 30 seconds. Capture again before choosing.");
        }
        entry.busy = true;
        const budget = new OperationBudget({ timeoutMs: 15000, maxRequests: 1, maxActions: 0, signal: options.signal });
        try {
            const choice = await resolveVisualTarget({
                observation: entry.observation,
                intent: request.intent,
                chooser: request.chooser,
                signal: budget.signal,
                evaluate:
                    request.chooser === "exact"
                        ? undefined
                        : async (call) => {
                              budget.take("request");
                              const evaluate = await this.evaluator(options.provider);
                              return evaluate({ ...call, timeoutMs: budget.remaining(), signal: budget.signal });
                          },
            });
            return { id: request.id, ...choice, metrics: budget.snapshot() };
        } finally {
            entry.busy = false;
            this.scheduleCleanup();
        }
    }
    async click(input: unknown, signal: AbortSignal) {
        const request = z
            .object({ id: z.string().uuid(), regionId: z.string().min(1).max(100) })
            .strict()
            .parse(input);
        const entry = this.entry(request.id);
        if (entry.used || entry.busy) {
            throw new Error("Capture was consumed or is busy; capture again.");
        }
        if (Date.now() > entry.observation.perception.capture.created * 1000 + 30000) {
            throw new Error("Action evidence expired after 30 seconds. Capture again.");
        }
        if (!entry.observation.perception.regions.some((region) => region.id === request.regionId)) {
            throw new Error("Choose one observed region.");
        }
        entry.used = true;
        entry.busy = true;
        try {
            const result = await entry.driver.click({
                observation: entry.observation,
                regionId: request.regionId,
                signal,
                timeoutMs: 10000,
            });
            return { id: request.id, action: result, verification: { status: "unverified" }, consumed: true };
        } finally {
            entry.busy = false;
            this.scheduleCleanup();
        }
    }
    dispose() {
        this.closed = true;
        clearTimeout(this.expiry);
        this.entries.clear();
        this.artifacts.dispose();
    }
}
export type StoredVisualCapture = Awaited<ReturnType<VisualCaptureStore["capture"]>>;
export type StoredVisualChoice = Awaited<ReturnType<VisualCaptureStore["choose"]>>;
