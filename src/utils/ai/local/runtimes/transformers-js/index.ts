import { env } from "@genesiscz/utils/env";
import { formatBytes } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";
import { ensureHuggingFaceTransformers } from "../../../ensure-hf";
import { suppressConsoleWarnings } from "../../../suppress-warnings";
import type { HfDownloadProgress, OnProgress } from "../../../types";
import { resolveDevice } from "../../device";
import { getWhisperDtype, isFp16Incompatible, markFp16Incompatible } from "./dtype";

export { getWhisperDtype, isFp16Incompatible, markFp16Incompatible } from "./dtype";

export type PipelineInstance = {
    (input: unknown, options?: Record<string, unknown>): Promise<unknown>;
    dispose(): Promise<void>;
    tokenizer: unknown;
};

/** The `pipeline()` call itself, injectable so the failure paths are testable without ONNX. */
export type PipelineLoader = (
    task: string,
    model: string,
    options: Record<string, unknown>
) => Promise<PipelineInstance>;

export interface TransformersJsRuntimeOptions {
    loader?: PipelineLoader;
    /** Skips the `ensurePackage` prompt; tests supply their own loader. */
    ensureInstalled?: () => Promise<boolean>;
    resolveDeviceFn?: () => Promise<string>;
    promptForToken?: (model: string) => Promise<string | null>;
}

/**
 * Resolve the execution provider transformers.js will actually accept.
 *
 * transformers.js's onnxruntime-node binding only registers "cpu" on macOS
 * (see node_modules/@huggingface/transformers/src/backends/onnx.js — case 'darwin'
 * pushes nothing before the cpu push). CoreML is reachable through darwinkit
 * for the AICoreMLProvider, but not through transformers.js. Force cpu here
 * to avoid "Unsupported device: 'coreml'" from transformers.js.
 */
export async function resolvePipelineDevice(): Promise<string> {
    const { device: rawDevice } = await resolveDevice();

    return process.platform === "darwin" && rawDevice === "coreml" ? "cpu" : rawDevice;
}

async function defaultLoader(task: string, model: string, options: Record<string, unknown>): Promise<PipelineInstance> {
    const { pipeline } = await import("@huggingface/transformers");

    return (await pipeline(task as Parameters<typeof pipeline>[0], model, options)) as unknown as PipelineInstance;
}

/**
 * Owns every transformers.js pipeline in the process: one cache keyed by
 * `task:model`, one in-flight promise per key so concurrent callers share a
 * load, and the two error-recovery paths (gated model → token prompt,
 * fp16 ONNX crash → lowered graph optimization).
 */
export class TransformersJsRuntime {
    readonly id = "transformers-js" as const;

    private pipelines = new Map<string, PipelineInstance>();
    private pendingPipelines = new Map<string, Promise<PipelineInstance>>();
    private readonly loader: PipelineLoader;
    private readonly ensureInstalled: () => Promise<boolean>;
    private readonly resolveDeviceFn: () => Promise<string>;
    private readonly promptForToken: (model: string) => Promise<string | null>;

    constructor(options: TransformersJsRuntimeOptions = {}) {
        this.loader = options.loader ?? defaultLoader;
        this.ensureInstalled = options.ensureInstalled ?? ensureHuggingFaceTransformers;
        this.resolveDeviceFn = options.resolveDeviceFn ?? resolvePipelineDevice;
        this.promptForToken = options.promptForToken ?? promptForHfToken;
    }

    async getPipeline(task: string, model: string, onProgress?: OnProgress): Promise<PipelineInstance> {
        const key = `${task}:${model}`;
        const existing = this.pipelines.get(key);

        if (existing) {
            return existing;
        }

        const pending = this.pendingPipelines.get(key);

        if (pending) {
            return pending;
        }

        const load = this.loadPipeline(key, task, model, onProgress);
        this.pendingPipelines.set(key, load);

        try {
            return await load;
        } finally {
            this.pendingPipelines.delete(key);
        }
    }

    private async loadPipeline(
        key: string,
        task: string,
        model: string,
        onProgress?: OnProgress
    ): Promise<PipelineInstance> {
        const installed = await this.ensureInstalled();

        if (!installed) {
            throw new Error("HuggingFace Transformers not available — install was declined or failed");
        }

        await ensureHfToken();

        const device = await this.resolveDeviceFn();

        // Build pipeline options once — reused by retry paths
        const pipelineOpts = (extraSessionOpts?: Record<string, unknown>) => ({
            device,
            dtype: task === "automatic-speech-recognition" ? getWhisperDtype(model) : ("q4" as const),
            ...(isFp16Incompatible(model) || extraSessionOpts
                ? {
                      session_options: {
                          ...(isFp16Incompatible(model) ? { graphOptimizationLevel: "extended" } : {}),
                          ...extraSessionOpts,
                      },
                  }
                : {}),
            progress_callback: onProgress
                ? (info: HfDownloadProgress) => {
                      if (info.status === "progress" && info.loaded != null && info.total) {
                          const pct = Math.round((info.loaded / info.total) * 100);
                          const file = info.file?.split("/").pop() ?? "";
                          const size = `${formatBytes(info.loaded)}/${formatBytes(info.total)}`;
                          onProgress({
                              phase: "download",
                              percent: pct,
                              message: `Downloading ${file}... ${pct}% (${size})`,
                          });
                      } else if (info.status === "ready") {
                          onProgress({ phase: "load", percent: 100, message: "Model loaded" });
                      }
                  }
                : undefined,
        });

        const load = (opts?: Record<string, unknown>) => this.loader(task, model, pipelineOpts(opts));

        const restoreWarnings = suppressConsoleWarnings({
            patterns: ["Unable to determine content-length"],
        });

        try {
            const pipe = await load();
            restoreWarnings();
            this.pipelines.set(key, pipe);
            return pipe;
        } catch (err) {
            restoreWarnings();
            const msg = err instanceof Error ? err.message : String(err);

            // Gated model — prompt for HF token if not configured
            if (msg.includes("Unauthorized") || msg.includes("Access denied") || msg.includes("401")) {
                const token = await this.promptForToken(model);

                if (token) {
                    const retryPipe = await load();
                    this.pipelines.set(key, retryPipe);
                    return retryPipe;
                }

                throw new Error(
                    `Model "${model}" requires a HuggingFace token. Run: tools ai config → Hugging Face token`
                );
            }

            // ONNX Runtime CPU bug: fp16 models crash with InsertedPrecisionFreeCast
            // on certain architectures. Auto-retry with lowered graph optimization.
            if (msg.includes("InsertedPrecisionFreeCast") && !isFp16Incompatible(model)) {
                logger.warn(
                    `[getPipeline] fp16 ONNX RT crash for "${model}". Retrying with graphOptimizationLevel=extended.`
                );
                markFp16Incompatible(model);

                const retryPipe = await load({ graphOptimizationLevel: "extended" });
                this.pipelines.set(key, retryPipe);
                return retryPipe;
            }

            if (msg.includes("Protobuf parsing failed") || msg.includes("Load model")) {
                await clearCorruptedCache(model);

                throw new Error(
                    `Model "${model}" cache is corrupted. Deleted cached files — retry to re-download.\n` +
                        `Original error: ${msg}`
                );
            }

            throw err;
        }
    }

    dispose(): void {
        for (const pipe of this.pipelines.values()) {
            pipe.dispose().catch((err) => logger.debug({ err }, "[cleanup] best-effort resource cleanup failed"));
        }

        this.pipelines.clear();
    }
}

async function clearCorruptedCache(model: string): Promise<void> {
    const { env: hfEnv } = await import("@huggingface/transformers");
    const cacheDir = hfEnv.cacheDir;

    if (!cacheDir) {
        return;
    }

    const { rmSync } = await import("node:fs");

    // transformers.js uses <cacheDir>/<org>/<model>/ (direct path)
    const directCacheDir = `${cacheDir}/${model}`;
    // HF hub uses <cacheDir>/models--<org>--<model>/ (flattened)
    const hubCacheDir = `${cacheDir}/models--${model.replace(/\//g, "--")}`;

    for (const dir of [directCacheDir, hubCacheDir]) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch (err) {
            logger.debug({ err, dir }, "[transformers-js] cache cleanup failed");
        }
    }
}

/**
 * Ensure env.hf.getKey() is set from AIConfig.
 * @huggingface/transformers reads env.hf.getKey() in its fetch wrapper (hub.js).
 */
async function ensureHfToken(): Promise<void> {
    if (env.hf.getKey()) {
        return;
    }

    const { AIConfig } = await import("../../../AIConfig");
    const config = await AIConfig.load();
    const token = config.getHfToken() ?? env.hf.getKey();

    if (token) {
        env.testing.set("HUGGINGFACE_TOKEN", token);
        env.testing.set("HF_TOKEN", token);
    }
}

/**
 * Prompt the user for a HuggingFace token when a gated model returns Unauthorized.
 * Opens the token page in the browser, saves the token to AIConfig, and sets env.hf.getKey().
 */
async function promptForHfToken(model: string): Promise<string | null> {
    const { isInteractive } = await import("@genesiscz/utils/cli");

    if (!isInteractive()) {
        return null;
    }

    const p = await import("@clack/prompts");
    const pc = (await import("picocolors")).default;
    const HF_TOKEN_URL = "https://huggingface.co/settings/tokens/new?tokenType=fineGrained";

    p.log.warn(
        `Model "${model}" is gated and requires a HuggingFace access token.\n\n` +
            `Create a Fine-grained token at:\n` +
            `  ${pc.cyan(HF_TOKEN_URL)}\n\n` +
            `Required permissions:\n` +
            `  ${pc.bold("Repositories")}  → Read access to contents of all repos under your personal namespace\n` +
            `  ${pc.bold("Inference")}     → Make calls to the serverless Inference API`
    );

    const openBrowser = await p.confirm({
        message: "Open HuggingFace token page in browser?",
        initialValue: true,
    });

    if (!p.isCancel(openBrowser) && openBrowser) {
        const { Browser } = await import("@genesiscz/utils/browser");
        await Browser.open(HF_TOKEN_URL);
    }

    const token = await p.text({
        message: "Paste your HuggingFace token:",
        placeholder: "hf_...",
        validate: (val) => {
            if (!val?.trim()) {
                return "Token is required";
            }

            if (!val.startsWith("hf_")) {
                return "HuggingFace tokens start with hf_";
            }
        },
    });

    if (p.isCancel(token)) {
        return null;
    }

    const tokenStr = (token as string).trim();

    // Save to AIConfig as a huggingface account
    const { AIConfig } = await import("../../../AIConfig");
    const config = await AIConfig.load();
    await config.setHfToken(tokenStr);

    // Set for current session — @huggingface/transformers reads HF_TOKEN in hub.js
    env.testing.set("HUGGINGFACE_TOKEN", tokenStr);
    env.testing.set("HF_TOKEN", tokenStr);

    p.log.success("HuggingFace token saved to AI config.");
    return tokenStr;
}
