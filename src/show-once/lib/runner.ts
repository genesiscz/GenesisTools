import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { type BrowserSession, connectSession, Refusal } from "./browser";
import { fileEvidence, moveVerified } from "./files";
import { expand, parseRecipe, type Recipe, resolvedInputs, safeUrl } from "./recipe";

export interface RunEvent {
    runId: string;
    stepId: string;
    status: "running" | "dispatched" | "verified" | "refused" | "uncertain" | "checkpoint" | "skipped";
    message: string;
    at: string;
}
export interface RunReceipt {
    recipeSha256: string;
    receiptFile?: string;
    runId: string;
    recipeId: string;
    status: "completed" | "failed" | "cancelled";
    events: RunEvent[];
    files: { path: string; size: number; sha256: string }[];
}
export const runReceiptSchema = z
    .object({
        runId: z.string(),
        recipeId: z.string(),
        recipeSha256: z.string().regex(/^[a-f0-9]{64}$/),
        receiptFile: z.string().optional(),
        status: z.enum(["completed", "failed", "cancelled"]),
        events: z
            .array(
                z
                    .object({
                        runId: z.string(),
                        stepId: z.string(),
                        status: z.enum([
                            "running",
                            "dispatched",
                            "verified",
                            "refused",
                            "uncertain",
                            "checkpoint",
                            "skipped",
                        ]),
                        message: z.string(),
                        at: z.string(),
                    })
                    .strict()
            )
            .max(2000),
        files: z
            .array(
                z.object({ path: z.string(), size: z.number(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
            )
            .max(200),
    })
    .strict();
export async function runRecipe(options: {
    recipe: Recipe;
    inputs: Record<string, string>;
    port: number;
    targetId: string;
    downloadDirectory: string;
    signal?: AbortSignal;
    onEvent?: (event: RunEvent) => void;
    checkpoint?: (event: RunEvent) => Promise<void>;
    connect?: typeof connectSession;
}): Promise<RunReceipt> {
    const recipe = parseRecipe(options.recipe);
    const inputs = resolvedInputs(recipe, options.inputs);
    const receipt: RunReceipt = {
        recipeSha256: new Bun.CryptoHasher("sha256").update(SafeJSON.stringify(recipe, { strict: true })).digest("hex"),
        runId: crypto.randomUUID(),
        recipeId: recipe.id,
        status: "completed",
        events: [],
        files: [],
    };
    const emit = (stepId: string, status: RunEvent["status"], message: string) => {
        const event: RunEvent = { runId: receipt.runId, stepId, status, message, at: new Date().toISOString() };
        receipt.events.push(event);
        options.onEvent?.(event);
        return event;
    };
    let browser: BrowserSession | undefined;
    let lastDownload: string | undefined;
    let current = recipe.steps[0].id;
    let dispatched = false;
    try {
        options.signal?.throwIfAborted();
        const unsupported = recipe.steps.find((step) => step.enabled && step.kind === "unsupported");
        if (unsupported?.kind === "unsupported") {
            current = unsupported.id;
            throw new Refusal(unsupported.reason);
        }
        browser = await (options.connect ?? connectSession)({
            port: options.port,
            targetId: options.targetId,
            directory: options.downloadDirectory,
            signal: options.signal,
        });
        await browser.configureDownloads({ signal: options.signal });
        for (const step of recipe.steps) {
            current = step.id;
            dispatched = false;
            options.signal?.throwIfAborted();
            if (!step.enabled) {
                emit(current, "skipped", "Disabled by the workflow author.");
                continue;
            }
            emit(current, "running", step.title);
            const dispatch = () => {
                dispatched = true;
                emit(current, "dispatched", "Action delivery started; it will not retry automatically.");
            };
            if (step.kind === "unsupported") {
                throw new Refusal(step.reason);
            }
            if (step.kind === "checkpoint") {
                const event = emit(current, "checkpoint", expand(step.message, inputs));
                if (!options.checkpoint) {
                    throw new Refusal("Checkpoint requires explicit acknowledgement.");
                }
                await options.checkpoint(event);
                emit(current, "verified", "User acknowledged this checkpoint.");
                continue;
            }
            if (step.kind === "move") {
                if (!lastDownload) {
                    throw new Refusal("No verified download is available for this move.");
                }
                const file = await moveVerified({
                    source: lastDownload,
                    destination: expand(step.destination, inputs),
                    filename: expand(step.filename, inputs),
                    contains: step.contains.map((value) => expand(value, inputs)),
                    signal: options.signal,
                    onDispatch: dispatch,
                });
                receipt.files = receipt.files.filter((entry) => entry.path !== lastDownload);
                receipt.files.push(file);
                lastDownload = file.path;
                emit(current, "verified", `File moved and SHA-256 readback matched: ${file.path}`);
                continue;
            }
            const url = expand(step.kind === "navigate" ? step.url : step.pageUrl, inputs);
            if (!recipe.allowedOrigins.includes(safeUrl(url).origin)) {
                throw new Refusal("URL origin is outside the recipe's allowed origins.");
            }
            if (step.kind === "navigate") {
                dispatch();
                await browser.navigate({ url, signal: options.signal });
                emit(current, "verified", "Current document URL and DOMContentLoaded loader matched.");
                continue;
            }
            const downloadOffset = browser.downloads.length;
            const value = "value" in step ? expand(step.value, inputs) : undefined;
            const secret = recipe.parameters.some(
                (parameter) => parameter.secret && "value" in step && step.value === `{{${parameter.name}}}`
            );
            const result = await browser.action({
                locator: step.locator,
                kind: step.kind === "download" ? "click" : step.kind,
                value,
                expectedUrl: url,
                secret,
                signal: options.signal,
                onDispatch: dispatch,
            });
            if (step.kind === "download") {
                const download = await browser.waitDownload({
                    after: downloadOffset,
                    filename: expand(step.filename, inputs),
                    timeoutMs: 20000,
                    signal: options.signal,
                });
                safeUrl(download.url);
                if (!recipe.allowedOrigins.includes(new URL(download.url).origin)) {
                    throw new Error("Downloaded URL is outside allowed origins.");
                }
                const file = await fileEvidence(
                    download.path,
                    step.contains.map((entry) => expand(entry, inputs))
                );
                lastDownload = file.path;
                receipt.files.push(file);
                emit(
                    current,
                    "verified",
                    step.contains.length > 0
                        ? `Completed download; ${step.contains.length} required content checks passed: ${download.filename}`
                        : `Completed download and SHA-256 captured. No content rule configured: ${download.filename}`
                );
            } else {
                emit(current, step.kind === "fill" || step.kind === "select" ? "verified" : "dispatched", result);
            }
        }
    } catch (error) {
        receipt.status = options.signal?.aborted ? "cancelled" : "failed";
        emit(
            current,
            dispatched ? "uncertain" : "refused",
            error instanceof Error ? error.message : "Workflow failed."
        );
        logger.warn(
            { recipeId: recipe.id, status: receipt.status, stepId: current, dispatched },
            "Show Once run stopped"
        );
    } finally {
        await browser?.close();
    }
    return receipt;
}
