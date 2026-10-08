import { mkdir, mkdtemp, readdir, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
    type ActionRecording,
    type ActionRecordingSnapshot,
    startActionRecording,
} from "@app/chrome-devtools/lib/action-recording";
import { openRecordingBrowser, recordingBrowsers, recordingTabs } from "@app/chrome-devtools/lib/recording-browser";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { BROWSER_DEVTOOLS_PORT } from "@genesiscz/utils/net/ports";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import { type BrowserSession, connectSession } from "./browser";
import { fileEvidence } from "./files";
import { downloadOrigin, parseRecipe, type Recipe, type Step, safeUrl } from "./recipe";
import { type RunEvent, runReceiptSchema, runRecipe } from "./runner";

const commonRecord = {
    port: z.number().int().min(1).max(65535),
    targetId: z.string().min(1),
    downloadDirectory: z.string().min(1),
    destinationDirectory: z.string().min(1),
};
export const commandSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("settings") }).strict(),
    z.object({ op: z.literal("status") }).strict(),
    z.object({ op: z.literal("history"), recipeId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) }).strict(),
    z.object({ op: z.literal("browsers") }).strict(),
    z
        .object({ op: z.literal("open-browser"), browserId: z.string().min(1), url: z.string().url().optional() })
        .strict(),
    z.object({ op: z.literal("tabs"), port: commonRecord.port.optional() }).strict(),
    z
        .object({
            op: z.literal("record-start"),
            ...commonRecord,
            maxSeconds: z.number().int().min(1).max(360).optional(),
        })
        .strict(),
    z.object({ op: z.literal("record-stop"), title: z.string().min(1).max(300) }).strict(),
    z
        .object({
            op: z.literal("run"),
            recipe: z.unknown(),
            inputs: z.record(z.string(), z.string()),
            port: commonRecord.port,
            targetId: commonRecord.targetId,
            approveCheckpoints: z.boolean().optional(),
            waitForCheckpoints: z.boolean().optional(),
        })
        .strict(),
    z.object({ op: z.literal("cancel") }).strict(),
    z.object({ op: z.literal("resume"), runId: z.string(), stepId: z.string() }).strict(),
    z.object({ op: z.literal("validate"), recipe: z.unknown() }).strict(),
    z.object({ op: z.literal("save"), recipe: z.unknown(), file: z.string().min(1) }).strict(),
    z.object({ op: z.literal("open"), file: z.string().min(1) }).strict(),
]);
interface RecordingState {
    controller: AbortController;
    recorder: ActionRecording;
    browser: BrowserSession;
    destinationDirectory: string;
    before: Set<string>;
    timer?: ReturnType<typeof setTimeout>;
}
async function folderFiles(folder: string): Promise<string[]> {
    const entries = await readdir(folder, { withFileTypes: true });
    if (entries.length > 1000) {
        throw new Error("Choose a folder containing at most 1000 entries for recording.");
    }
    return entries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
        .map((entry) => join(folder, entry.name));
}
export function recipeFromRecording(options: {
    snapshot: ActionRecordingSnapshot;
    title: string;
    downloads: { filename: string; url: string; at: number; sha256?: string }[];
    move?: { destination: string; filename: string };
    moveWarning?: string;
}): Recipe {
    const snapshot = options.snapshot;
    const downloadOrigins = new Set<string>();
    const initialOrigin = safeUrl(snapshot.initialUrl).origin;
    let url = snapshot.initialUrl;
    const evidence = (eventId: string, at: number, detail: string) => ({ eventId, at, url, detail });
    const steps: Step[] = [
        {
            id: "start",
            title: "Open demonstrated page",
            enabled: true,
            kind: "navigate",
            url,
            evidence: evidence("initial-document", Date.now(), "Initial recorded document"),
        },
    ];
    const used = new Set<string>();
    for (const action of snapshot.actions) {
        if (action.excluded) {
            continue;
        }
        if (action.kind === "navigate" && action.url) {
            url = action.url;
            try {
                safeUrl(url);
            } catch (error) {
                logger.debug({ error }, "Recording contains an unsupported navigation URL");
                steps.push({
                    id: action.id,
                    title: "Unsupported navigation",
                    enabled: true,
                    kind: "unsupported",
                    reason: "This recorded navigation URL cannot be replayed. Repair this step explicitly.",
                    evidence: evidence(action.id, action.at, "Observed unsupported main-frame navigation"),
                });
                continue;
            }

            steps.push({
                id: action.id,
                title: "Navigate to recorded page",
                enabled: true,
                kind: "navigate",
                url,
                evidence: evidence(action.id, action.at, "Observed main-frame navigation"),
            });
            continue;
        }
        if (!action.locator) {
            steps.push({
                id: action.id,
                title: "Unsupported target",
                enabled: true,
                kind: "unsupported",
                reason: "Recorded action has no unique semantic target.",
                evidence: evidence(action.id, action.at, "Target unavailable"),
            });
            continue;
        }
        url = action.sourceUrl ?? url;
        try {
            safeUrl(url);
        } catch (error) {
            logger.debug({ error }, "Recording contains an action on an unsupported page");
            steps.push({
                id: action.id,
                title: "Unsupported page action",
                enabled: true,
                kind: "unsupported",
                reason: "This action was observed on an unsupported page URL. Repair it explicitly.",
                evidence: {
                    ...evidence(action.id, action.at, "Browser event on an unsupported page"),
                    recordedValue: action.value,
                    recordedLocator: action.locator,
                },
            });
            continue;
        }
        const base = {
            id: action.id,
            title: `${action.kind} ${action.locator.name ?? action.locator.value}`,
            enabled: true,
            evidence: {
                ...evidence(action.id, action.at, "Browser event with a unique locator"),
                recordedValue: action.value,
                recordedLocator: action.locator,
            },
            locator: action.locator,
            pageUrl: url,
        };
        const next = snapshot.actions.find((entry) => entry.at > action.at && !entry.excluded);
        const onlyClick = snapshot.actions.filter((entry) => entry.kind === "click" && !entry.excluded).length === 1;
        const download =
            action.kind === "click" && onlyClick
                ? options.downloads.find(
                      (entry) => !used.has(entry.filename) && entry.at >= action.at && (!next || entry.at <= next.at)
                  )
                : undefined;
        if (download) {
            used.add(download.filename);
            try {
                downloadOrigins.add(downloadOrigin(download.url));
            } catch (error) {
                logger.debug({ error }, "Recording contains an unsupported download origin");
                steps.push({
                    id: action.id,
                    title: "Unsupported download",
                    enabled: true,
                    kind: "unsupported",
                    reason: "This download has no supported replay origin. Repair it explicitly.",
                    evidence: { ...base.evidence, recordedFilename: download.filename, sha256: download.sha256 },
                });
                continue;
            }

            steps.push({
                ...base,
                title: "Download report",
                kind: "download",
                filename: download.filename,
                evidence: { ...base.evidence, recordedFilename: download.filename, sha256: download.sha256 },
                contains: [],
            });
        } else if (action.kind === "click") {
            steps.push({ ...base, kind: "click" });
        } else if (action.kind === "fill" || action.kind === "select") {
            steps.push({ ...base, kind: action.kind, value: action.value ?? "" });
        } else if (action.kind === "press") {
            const key = z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space"]).safeParse(action.value);
            if (key.success) {
                steps.push({ ...base, kind: "press", value: key.data });
            } else {
                steps.push({
                    id: action.id,
                    title: "Unsupported key",
                    enabled: true,
                    kind: "unsupported",
                    evidence: base.evidence,
                    reason: "This key has no supported deterministic replay.",
                });
            }
        }
    }
    if (used.size !== options.downloads.length) {
        steps.push({
            id: "download-review",
            title: "Choose the download trigger",
            kind: "unsupported",
            enabled: true,
            evidence: evidence(
                "download-trigger-review",
                Date.now(),
                "Download could not be bound to one observed click"
            ),
            reason: "Multiple clicks or a changed page make the download trigger uncertain. Review the source actions and explicitly author the download step.",
        });
    }
    if (options.move) {
        steps.push({
            id: "move",
            title: "Rename and move downloaded report",
            kind: "move",
            enabled: true,
            destination: options.move.destination,
            filename: options.move.filename,
            contains: [],
            evidence: evidence(
                "file-content-match",
                Date.now(),
                "New destination file SHA-256 matched the completed download"
            ),
        });
    }
    for (const warning of snapshot.evidence.filter((entry) => entry.kind === "warning" && !entry.excluded)) {
        steps.push({
            id: `warning-${warning.id}`,
            title: "Recording needs review",
            kind: "unsupported",
            enabled: true,
            evidence: evidence(warning.id, warning.at, warning.text),
            reason: warning.text,
        });
    }
    if (options.moveWarning) {
        steps.push({
            id: "file-review",
            title: "File move needs review",
            kind: "unsupported",
            enabled: true,
            evidence: evidence("file-observation", Date.now(), options.moveWarning),
            reason: options.moveWarning,
        });
    }
    return parseRecipe({
        version: 1,
        id: crypto.randomUUID(),
        title: options.title,
        createdAt: new Date().toISOString(),
        allowedOrigins: [
            ...new Set([
                initialOrigin,
                ...steps.flatMap((step) => (step.kind === "navigate" ? [safeUrl(step.url).origin] : [])),
                ...downloadOrigins,
            ]),
        ],
        parameters: [],
        steps,
    });
}
export class ShowOnceService {
    private recording?: RecordingState;
    private runController?: AbortController;
    private checkpointWait?: { runId: string; stepId: string; resolve: () => void };
    private starting = false;
    private startingController?: AbortController;
    private runFinished?: Promise<void>;
    private finishRun?: () => void;
    constructor(private onEvent: (event: unknown) => void = () => {}) {}
    async dispatch(raw: unknown, signal?: AbortSignal): Promise<unknown> {
        const command = commandSchema.parse(raw);
        if (command.op === "settings") {
            return { browserPort: BROWSER_DEVTOOLS_PORT };
        }
        if (command.op === "status") {
            const pending = this.checkpointWait;
            return {
                recording: Boolean(this.recording),
                running: Boolean(this.runController),
                starting: this.starting,
                checkpoint: pending ? { runId: pending.runId, stepId: pending.stepId } : null,
            };
        }
        if (command.op === "history") {
            const directory = toolDataDir("show-once", "history", command.recipeId);
            let files: string[];
            try {
                files = await readdir(directory);
            } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                    return [];
                }
                throw error;
            }
            const history = [];
            for (const name of files
                .filter((name) => name.endsWith(".json"))
                .sort()
                .reverse()
                .slice(0, 15)) {
                try {
                    const file = Bun.file(join(directory, name));
                    if (file.size > 2_000_000) {
                        throw new Error("Run receipt exceeds its size limit.");
                    }
                    history.push(runReceiptSchema.parse(SafeJSON.parse(await file.text(), { strict: true })));
                } catch (error) {
                    logger.warn({ error, recipeId: command.recipeId }, "Could not read a retained run receipt");
                }
            }
            return history;
        }
        if (command.op === "browsers") {
            return recordingBrowsers();
        }
        if (command.op === "open-browser") {
            if (this.recording || this.runController || this.starting) {
                throw new Error("Stop the active operation before opening a recording browser.");
            }
            this.starting = true;
            const controller = new AbortController();
            this.startingController = controller;
            const cancel = () => controller.abort(signal?.reason);
            signal?.addEventListener("abort", cancel, { once: true });
            if (signal?.aborted) {
                cancel();
            }
            try {
                return await openRecordingBrowser({
                    browserId: command.browserId,
                    url: command.url,
                    signal: controller.signal,
                });
            } finally {
                signal?.removeEventListener("abort", cancel);
                this.starting = false;
                this.startingController = undefined;
            }
        }
        if (command.op === "tabs") {
            return recordingTabs({ port: command.port, signal });
        }
        if (command.op === "validate") {
            return parseRecipe(command.recipe);
        }
        if (command.op === "open") {
            const file = Bun.file(command.file);
            if (file.size > 2_000_000) {
                throw new Error("Recipe exceeds the 2 MB import limit.");
            }
            return parseRecipe(SafeJSON.parse(await file.text(), { strict: true }));
        }
        if (command.op === "save") {
            const recipe = parseRecipe(command.recipe);
            const temporary = `${command.file}.${crypto.randomUUID()}.partial`;
            const serialized = SafeJSON.stringify(recipe, null, 2);
            if (Buffer.byteLength(serialized, "utf8") > 2_000_000) {
                throw new Error("Recipe exceeds the 2 MB portable document limit.");
            }
            await Bun.write(temporary, serialized);
            await rename(temporary, command.file);
            logger.info({ recipeId: recipe.id }, "Show Once recipe saved");
            return { file: command.file };
        }
        if (command.op === "cancel") {
            this.runController?.abort();
            this.startingController?.abort();
            if (this.recording) {
                const state = this.recording;
                this.recording = undefined;
                this.starting = true;
                state.controller.abort();
                clearTimeout(state.timer);
                try {
                    await this.releaseRecordingResources({ recorder: state.recorder, browser: state.browser });
                } finally {
                    this.starting = false;
                }
            }
            return { cancelled: true };
        }
        if (command.op === "resume") {
            const pending = this.checkpointWait;
            if (!pending || pending.runId !== command.runId || pending.stepId !== command.stepId) {
                throw new Error("This checkpoint is stale or belongs to another run.");
            }
            pending.resolve();
            return { acknowledged: true };
        }
        if (command.op === "record-start") {
            if (this.recording || this.runController || this.starting) {
                throw new Error("Stop the active operation before recording.");
            }
            this.starting = true;
            const controller = new AbortController();
            const cancelSetup = () => controller.abort(signal?.reason);
            signal?.addEventListener("abort", cancelSetup, { once: true });
            if (signal?.aborted) {
                cancelSetup();
            }
            this.startingController = controller;
            let browser: BrowserSession | undefined;
            let recorder: ActionRecording | undefined;
            try {
                const directory = await realpath(command.downloadDirectory);
                const destinationDirectory = await realpath(command.destinationDirectory);
                if (directory === destinationDirectory) {
                    throw new Error("Choose separate download and destination folders.");
                }
                const before = new Set(await folderFiles(destinationDirectory));
                browser = await connectSession({
                    port: command.port,
                    targetId: command.targetId,
                    directory,
                    signal: controller.signal,
                });
                browser.onDownload = (download) => this.onEvent({ type: "download", download });
                const recordingSeconds = command.maxSeconds ?? 300;
                recorder = await startActionRecording({
                    port: command.port,
                    targetId: command.targetId,
                    signal: controller.signal,
                    maxSeconds: recordingSeconds,
                    onUpdate: (snapshot) => this.onEvent({ type: "recording", snapshot }),
                });
                const recordingDeadline = Date.now() + recordingSeconds * 1000;
                await browser.configureDownloads({ named: false, signal: controller.signal, recordingAdmitted: true });
                controller.signal.throwIfAborted();
                const state: RecordingState = { controller, recorder, browser, destinationDirectory, before };
                this.recording = state;
                state.timer = setTimeout(
                    () => {
                        void this.expireRecording(state).catch((error) =>
                            logger.warn({ error }, "Show Once recording expiry cleanup failed")
                        );
                    },
                    Math.max(0, recordingDeadline - Date.now())
                );
                logger.info({ targetId: command.targetId }, "Show Once recording started");
                return { recording: true };
            } catch (error) {
                controller.abort();
                try {
                    await this.releaseRecordingResources({ recorder, browser });
                } catch (cleanupError) {
                    logger.warn({ error: cleanupError }, "Show Once recording setup cleanup failed");
                }
                throw error;
            } finally {
                signal?.removeEventListener("abort", cancelSetup);
                this.starting = false;
                this.startingController = undefined;
            }
        }
        if (command.op === "record-stop") {
            const state = this.recording;
            if (!state) {
                throw new Error("Recording is not active.");
            }
            this.recording = undefined;
            this.starting = true;
            clearTimeout(state.timer);
            this.startingController = state.controller;
            try {
                const snapshot = await state.recorder.stop();
                const downloads = await state.browser.capturedDownloads();
                const newFiles = (await folderFiles(state.destinationDirectory)).filter(
                    (file) => !state.before.has(file)
                );
                const matches: string[] = [];
                for (const file of newFiles) {
                    state.controller.signal.throwIfAborted();
                    const evidence = await fileEvidence(file);
                    if (downloads.some((download) => download.sha256 === evidence.sha256)) {
                        matches.push(file);
                    }
                }
                const move =
                    downloads.length === 1 && matches.length === 1
                        ? {
                              destination: state.destinationDirectory,
                              filename: matches[0].slice(state.destinationDirectory.length + 1),
                          }
                        : undefined;
                const moveWarning =
                    downloads.length > 0 && !move
                        ? "A single completed download and one new matching destination file are required. Add an explicit move after reviewing the evidence."
                        : undefined;
                const recipe = recipeFromRecording({ snapshot, title: command.title, downloads, move, moveWarning });
                logger.info(
                    { steps: recipe.steps.length, downloads: downloads.length, matches: matches.length },
                    "Show Once recording stopped"
                );
                return { recipe, recording: snapshot, downloads, matches };
            } finally {
                state.controller.abort();
                await state.browser.close();
                this.starting = false;
                this.startingController = undefined;
            }
        }
        if (command.op === "run") {
            if (this.recording || this.runController || this.starting) {
                throw new Error("Stop the active operation before replay.");
            }
            const recipe = parseRecipe(command.recipe);
            const controller = new AbortController();
            this.runController = controller;
            this.runFinished = new Promise((resolveRun) => {
                this.finishRun = resolveRun;
            });
            const runSignal = signal
                ? AbortSignal.any([signal, controller.signal, AbortSignal.timeout(300000)])
                : AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
            try {
                const root = toolDataDir("show-once", "runs");
                await mkdir(root, { recursive: true });
                const downloadDirectory = await realpath(await mkdtemp(join(root, "run-")));
                const receipt = await runRecipe({
                    recipe,
                    inputs: command.inputs,
                    port: command.port,
                    targetId: command.targetId,
                    downloadDirectory,
                    signal: runSignal,
                    onEvent: (event) => this.onEvent({ type: "progress", event }),
                    checkpoint: command.approveCheckpoints
                        ? async () => {}
                        : command.waitForCheckpoints === false
                          ? undefined
                          : (event) => this.waitCheckpoint(event, runSignal),
                });
                const historyDirectory = toolDataDir("show-once", "history", recipe.id);
                await mkdir(historyDirectory, { recursive: true });
                receipt.receiptFile = join(historyDirectory, `${Date.now()}-${receipt.runId}.json`);
                try {
                    await Bun.write(receipt.receiptFile, SafeJSON.stringify(receipt, null, 2));
                } catch (error) {
                    logger.warn({ error, recipeId: recipe.id }, "Replay outcome could not be retained");
                    throw new Error(
                        `Replay ended with ${receipt.status}, but its receipt could not be saved. Actions may already have executed; inspect output files before another run.`,
                        { cause: error }
                    );
                }
                return receipt;
            } finally {
                this.runController = undefined;
                this.checkpointWait = undefined;
                this.finishRun?.();
                this.finishRun = undefined;
            }
        }
        throw new Error("Unsupported command.");
    }
    private async releaseRecordingResources(options: {
        recorder?: ActionRecording;
        browser?: BrowserSession;
    }): Promise<void> {
        const results = await Promise.allSettled([
            Promise.resolve().then(() => options.recorder?.stop()),
            Promise.resolve().then(() => options.browser?.close()),
        ]);
        let failure: unknown;
        let failed = false;
        for (const result of results) {
            if (result.status === "rejected") {
                if (!failed) {
                    failure = result.reason;
                    failed = true;
                } else {
                    logger.warn({ error: result.reason }, "Additional Show Once recording cleanup failed");
                }
            }
        }

        if (failed) {
            throw failure;
        }
    }

    private async expireRecording(state: RecordingState): Promise<void> {
        if (this.recording !== state) {
            return;
        }

        this.recording = undefined;
        this.starting = true;
        state.controller.abort();
        try {
            await this.releaseRecordingResources({ recorder: state.recorder, browser: state.browser });
        } finally {
            this.starting = false;
            this.onEvent({
                type: "recording-ended",
                reason: "Recording reached its time limit and was cancelled.",
            });
        }
    }

    private waitCheckpoint(event: RunEvent, signal: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            const done = () => {
                signal.removeEventListener("abort", abort);
                this.checkpointWait = undefined;
                resolve();
            };
            const abort = () => {
                this.checkpointWait = undefined;
                reject(new Error("Checkpoint cancelled."));
            };
            this.checkpointWait = { runId: event.runId, stepId: event.stepId, resolve: done };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
                abort();
            }
        });
    }
    async close(): Promise<void> {
        await this.dispatch({ op: "cancel" });
        await this.runFinished;
    }
}
export async function serveBridge(): Promise<void> {
    let closing = false;
    const send = (value: unknown) => {
        if (!closing) {
            out.print(`${SafeJSON.stringify(value, { strict: true })}\n`);
        }
    };
    const service = new ShowOnceService((event) => send({ event }));
    const lines = createInterface({ input: process.stdin });
    const stop = () => {
        closing = true;
        lines.close();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    lines.once("close", () => {
        closing = true;
    });
    lines.on("line", (line) => {
        if (line.length > 2_000_000) {
            send({ error: "Bridge request exceeds limit." });
            return;
        }
        let id: string | undefined;
        void (async () => {
            try {
                const envelope = z
                    .object({ id: z.string(), command: z.unknown() })
                    .strict()
                    .parse(SafeJSON.parse(line, { strict: true }));
                id = envelope.id;
                const result = await service.dispatch(envelope.command);
                send({ id, result });
            } catch (error) {
                send({ id, error: error instanceof Error ? error.message : "Bridge request failed." });
            }
        })();
    });
    await new Promise<void>((resolve) => lines.once("close", resolve));
    try {
        await service.close();
    } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
    }
}
