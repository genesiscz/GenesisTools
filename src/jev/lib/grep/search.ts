import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEvaluator, type Evaluator as ServiceEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { z } from "zod";
import { createGrepCache } from "./cache";
import { createGrepEvaluator, grepModelFor } from "./evaluator";
import type { FilesystemPolicy } from "./filesystem";
import { retrieve } from "./retrieve";
import { EvaluationFailure, type RetrievalResult, toJson } from "./types";

const { log } = logger.scoped("jev-grep");

/** `meta.label` on every grep call in the usage ledger, so `tools ai-spend jev` can split grep out. */
export const GREP_USAGE_LABEL = "grep";

/** Everything one search needs, whichever door it came through. */
export interface GrepSearchOptions {
    query: string;
    root: string;
    policy: FilesystemPolicy;
    noCache: boolean;
    concurrency?: number;
    /** 0 means unlimited, matching upstream `DEFAULT_MAX_SOURCE_BYTES`. Only the text packet uses it. */
    maxSourceBytes: number;
    /**
     * Jev calls to plan for. The doors default to `DEFAULT_GREP_BUDGET`; 0 or absent runs upstream's
     * exhaustive loop, which the upstream comparison uses.
     */
    budget?: number;
    /** Hard stops for measured runs. Reaching either ends the walk with a `request-limit` issue. */
    limits?: { maxRequests?: number; maxCostUsd?: number };
}

/** What `tools jev grep` plans for by default: about 100 calls, about $0.04 on a large repository. */
export const DEFAULT_GREP_BUDGET = 100;
/**
 * A budgeted run may overshoot its plan by the last round of a stage; this is the hard stop above it.
 * Retries and a large final wave fit under it; a runaway does not.
 */
const BUDGET_HARD_CAP = 1.3;

export type GrepSetupFailure = "usage" | "credentials" | "authentication";

/**
 * A failure before any evidence exists. The CLI prints one stderr line and exits 1; HTTP answers
 * 400 for `usage` and 401 otherwise. An incomplete or interrupted search is never one of these.
 */
export class GrepSetupError extends Error {
    readonly kind: GrepSetupFailure;

    constructor(kind: GrepSetupFailure, message: string) {
        super(message);
        this.name = "GrepSetupError";
        this.kind = kind;
    }
}

/** The MCP input, and the HTTP body with `root` made required. */
export const grepInputSchema = z
    .object({
        query: z.string().trim().min(1).max(4000).describe("The behavior to find, as a question"),
        root: z.string().min(1).optional().describe("Directory to search; defaults to the server's working directory"),
        hidden: z.boolean().optional().describe("Include dot paths"),
        noIgnore: z.boolean().optional().describe("Do not apply .gitignore or .ignore"),
        includeDependencies: z.boolean().optional().describe("Include node_modules, dist, build and similar"),
        includeSensitive: z.boolean().optional().describe("Include credential filenames such as .env and *.pem"),
        noCache: z.boolean().optional().describe("Skip answer-cache reads and writes"),
        concurrency: z.number().int().positive().optional().describe("In-flight Jev requests (default 32)"),
        maxSourceBytes: z.number().int().nonnegative().optional().describe("Source bytes printed; 0 is unlimited"),
        budget: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe("Jev calls to plan for (default 100); 0 runs upstream's exhaustive loop"),
    })
    .strict();

export type GrepInput = z.infer<typeof grepInputSchema>;

export function grepOptionsFromInput(input: GrepInput, defaultRoot: string): GrepSearchOptions {
    const policy: FilesystemPolicy = {};
    if (input.hidden) {
        policy.hidden = true;
    }

    if (input.noIgnore) {
        policy.noIgnore = true;
    }

    if (input.includeDependencies) {
        policy.includeDependencies = true;
    }

    if (input.includeSensitive) {
        policy.includeSensitive = true;
    }

    return {
        query: input.query,
        root: input.root ?? defaultRoot,
        policy,
        noCache: input.noCache ?? false,
        ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
        maxSourceBytes: input.maxSourceBytes ?? 0,
        budget: input.budget ?? DEFAULT_GREP_BUDGET,
    };
}

/** `~/.genesis-tools/jev/grep-cache/`. Never the arena's `~/.genesis-tools/jev/cache/`. */
export function grepCacheDirectory(): string {
    return join(new Storage("jev").getBaseDir(), "grep-cache");
}

/** Never listed or uploaded, under any flag: a search of `$HOME` must not send the jev config. */
export function grepProtectedPaths(cacheDirectory = grepCacheDirectory()): string[] {
    return [new Storage("jev").getConfigPath(), cacheDirectory];
}

async function assertDirectory(root: string): Promise<void> {
    try {
        if ((await stat(root)).isDirectory()) {
            return;
        }
    } catch (error) {
        log.debug({ root, error }, "Grep root is not readable");
    }

    throw new GrepSetupError("usage", `Search root is not a directory: ${root}`);
}

/**
 * One search: the answer cache, the grep evaluator around the shared transport, the protected
 * paths, then `retrieve`. `evaluate` is injected by tests and by the MCP server's lazy evaluator;
 * otherwise the credential is read here, after the arguments were validated.
 */
export async function searchRepository({
    options,
    provider,
    signal,
    evaluate,
    cacheDirectory = grepCacheDirectory(),
}: {
    options: GrepSearchOptions;
    provider: EvaluationProviderId;
    signal: AbortSignal;
    evaluate?: ServiceEvaluator;
    cacheDirectory?: string;
}): Promise<RetrievalResult> {
    const root = resolve(options.root);
    await assertDirectory(root);
    const model = grepModelFor(provider);
    let transport = evaluate;
    if (!transport) {
        try {
            transport = await createEvaluator({ provider, signal, model, usageLabel: GREP_USAGE_LABEL });
        } catch (error) {
            log.debug({ provider, error }, "Jev grep has no usable credential");
            throw new GrepSetupError("credentials", error instanceof Error ? error.message : String(error));
        }
    }

    const cache = createGrepCache({ directory: cacheDirectory, enabled: !options.noCache });
    const evaluator = createGrepEvaluator({
        evaluate: transport,
        provider,
        model,
        signal,
        cache,
        policyVersion: toJson(options.policy),
        concurrency: options.concurrency,
        requestLimit:
            options.limits?.maxRequests ?? (options.budget ? Math.ceil(options.budget * BUDGET_HARD_CAP) : undefined),
        maxCostUsd: options.limits?.maxCostUsd,
    });
    log.info(
        { root, provider, model, policy: options.policy, cache: cache.enabled, concurrency: options.concurrency },
        "Jev grep search started"
    );
    try {
        return await retrieve(
            {
                root,
                query: options.query,
                policy: options.policy,
                signal,
                protectedPaths: grepProtectedPaths(cacheDirectory),
                ...(options.budget ? { budget: options.budget } : {}),
            },
            evaluator
        );
    } catch (error) {
        if (error instanceof EvaluationFailure && error.kind === "authentication") {
            throw new GrepSetupError("authentication", error.message);
        }

        throw error;
    }
}
