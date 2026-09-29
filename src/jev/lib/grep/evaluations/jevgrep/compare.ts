import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveApiKey } from "@genesiscz/utils/ai/evaluation/auth";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { JEV_USAGE_APP } from "@genesiscz/utils/ai/evaluation/spend";
import { recordUsage } from "@genesiscz/utils/ai/usage";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GREP_TYPESAFE_MODEL } from "../../evaluator";
import { renderResult } from "../../render";
import { grepProtectedPaths, searchRepository } from "../../search";
import type { IssueCount } from "../../types";
import type { ComparisonCase } from "./cases";

const { log } = logger.scoped("jev-grep-eval");

/** Ledger labels, so `tools jev spend` shows what the comparison itself cost. */
export const UPSTREAM_USAGE_LABEL = "grep eval upstream";
export const PORT_USAGE_LABEL = "grep eval port";

export type Implementation = "upstream" | "port";

export interface RunOptions {
    testCase: ComparisonCase;
    /** Absolute root of this checkout; `testCase.root` resolves against it. */
    repoRoot: string;
    /** 1 makes both request sequences deterministic, so equivalent code stops at the same request. */
    concurrency: number;
}

export interface FileSummary {
    path: string;
    score: number;
    priority?: number;
    roles: string[];
    /** Printed excerpt ranges, `start-end`. */
    excerpts: string[];
    leads: number;
}

export interface RunReport {
    implementation: Implementation;
    status: string;
    wallMs: number;
    requests: number;
    inputTokens: number;
    costUsd: number;
    issues: IssueCount[];
    providerFailure?: string;
    files: FileSummary[];
    /** SHA-256 of the packet from the first file bullet on; the header lines differ by design. */
    bodySha256: string;
    bodyBytes: number;
    /** `true` when the dollar budget stopped the run (upstream only; the port reports `request-limit`). */
    stoppedByCost: boolean;
}

/** The slice of an upstream `FileEvidence` the comparison reads. */
interface UpstreamFile {
    path: string;
    score: number;
    priority?: number;
    roles: string[];
    leads: unknown[];
    excerpts: Array<{ range: { startLine: number; endLine: number } }>;
    presentationExcerpts?: Array<{ range: { startLine: number; endLine: number } }>;
}

interface UpstreamResult {
    status: string;
    files: UpstreamFile[];
    issues: IssueCount[];
    providerFailure?: string;
    counts: { requests: number };
}

interface UpstreamEvaluator {
    readonly requests: number;
}

interface UpstreamCore {
    retrieve(
        input: { root: string; query: string; policy: object; signal: AbortSignal; protectedPaths: string[] },
        evaluator: UpstreamEvaluator
    ): Promise<UpstreamResult>;
    createEvaluator(options: {
        provider: "typesafe";
        apiKey: string;
        signal: AbortSignal;
        fetch: typeof fetch;
        requestLimit: number;
        concurrency: number;
    }): UpstreamEvaluator;
}

interface UpstreamRender {
    renderResult(result: UpstreamResult, maxSourceBytes?: number): string;
}

function hasFunctions(value: unknown, names: string[]): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        names.every((name) => name in value && typeof Reflect.get(value, name) === "function")
    );
}

/** Upstream is plain TypeScript at a runtime path: presence is checked, signatures are pinned by the commit. */
function isUpstreamCore(value: unknown): value is UpstreamCore {
    return hasFunctions(value, ["retrieve", "createEvaluator"]);
}

function isUpstreamRender(value: unknown): value is UpstreamRender {
    return hasFunctions(value, ["renderResult"]);
}

/**
 * The upstream checkout is a runtime path (`../_Playgrounds/jevgrep` by default), so its modules can
 * only be loaded with a dynamic import. Its dependencies must be installed there first:
 * `bun install --ignore-scripts`.
 */
async function loadUpstream(checkout: string): Promise<{ core: UpstreamCore; render: UpstreamRender }> {
    const core: unknown = await import(join(checkout, "packages/core/src/index.ts"));
    const render: unknown = await import(join(checkout, "apps/cli/src/render.ts"));
    if (!isUpstreamCore(core) || !isUpstreamRender(render)) {
        throw new Error(
            `${checkout} does not look like a dzhng/jevgrep checkout (no retrieve/createEvaluator/renderResult).`
        );
    }

    return { core, render };
}

function packetBody(packet: string): { bodySha256: string; bodyBytes: number } {
    const start = packet.search(/^- "/m);
    const body = start === -1 ? packet.slice(packet.indexOf("End file list.")) : packet.slice(start);
    return { bodySha256: createHash("sha256").update(body).digest("hex"), bodyBytes: Buffer.byteLength(body) };
}

function summarizeFiles(files: UpstreamFile[]): FileSummary[] {
    return files.map((file) => ({
        path: file.path,
        score: file.score,
        ...(file.priority === undefined ? {} : { priority: file.priority }),
        roles: [...file.roles].sort(),
        excerpts: (file.presentationExcerpts ?? file.excerpts).map(
            (excerpt) => `${excerpt.range.startLine}-${excerpt.range.endLine}`
        ),
        leads: file.leads.length,
    }));
}

function usageTokens(value: unknown): { input: number; output: number } {
    const usage = value && typeof value === "object" && "usage" in value ? value.usage : undefined;
    const read = (key: string) => {
        const found = usage && typeof usage === "object" ? Reflect.get(usage, key) : undefined;
        return typeof found === "number" ? found : 0;
    };
    return { input: read("input_tokens"), output: read("output_tokens") };
}

/**
 * Upstream's own loop and client, with this checkout's key handed in memory (no second credential
 * file). Every response is booked in the usage ledger, and the dollar budget aborts the run.
 */
export async function runUpstream(options: RunOptions & { checkout: string }): Promise<RunReport> {
    const { core, render } = await loadUpstream(options.checkout);
    const controller = new AbortController();
    const spent = { inputTokens: 0, costUsd: 0 };
    let stoppedByCost = false;
    const metered = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await fetch(input, init);
            if (!response.ok) {
                return response;
            }

            const tokens = usageTokens(await response.clone().json());
            const body: unknown =
                typeof init?.body === "string" ? SafeJSON.parse(init.body, { strict: true }) : undefined;
            const model =
                body && typeof body === "object" && "model" in body ? String(body.model) : GREP_TYPESAFE_MODEL;
            const booked = await recordUsage({
                app: JEV_USAGE_APP,
                accountId: "jev:typesafe",
                provider: "jev-typesafe",
                modelId: model,
                inputTokens: tokens.input,
                outputTokens: tokens.output,
                meta: { label: UPSTREAM_USAGE_LABEL },
            });
            spent.inputTokens += tokens.input;
            spent.costUsd += booked.costUsd ?? 0;
            if (spent.costUsd >= options.testCase.maxCostUsd && !controller.signal.aborted) {
                stoppedByCost = true;
                controller.abort();
            }

            return response;
        },
        { preconnect: fetch.preconnect }
    );
    const evaluator = core.createEvaluator({
        provider: "typesafe",
        apiKey: await resolveApiKey("typesafe"),
        signal: controller.signal,
        fetch: metered,
        requestLimit: options.testCase.maxRequests,
        concurrency: options.concurrency,
    });
    const started = performance.now();
    const result = await core.retrieve(
        {
            root: join(options.repoRoot, options.testCase.root),
            query: options.testCase.query,
            policy: {},
            signal: controller.signal,
            protectedPaths: grepProtectedPaths(),
        },
        evaluator
    );
    const wallMs = Math.round(performance.now() - started);
    return {
        implementation: "upstream",
        status: result.status,
        wallMs,
        requests: evaluator.requests,
        inputTokens: spent.inputTokens,
        costUsd: spent.costUsd,
        issues: result.issues,
        ...(result.providerFailure ? { providerFailure: result.providerFailure } : {}),
        files: summarizeFiles(result.files),
        ...packetBody(render.renderResult(result)),
        stoppedByCost,
    };
}

/** This port through `searchRepository`, the function all three doors call. Cache off, budget on. */
export async function runPort(options: RunOptions): Promise<RunReport> {
    const controller = new AbortController();
    const evaluate = await createEvaluator({
        provider: "typesafe",
        signal: controller.signal,
        model: GREP_TYPESAFE_MODEL,
        usageLabel: PORT_USAGE_LABEL,
    });
    const started = performance.now();
    const result = await searchRepository({
        options: {
            query: options.testCase.query,
            root: join(options.repoRoot, options.testCase.root),
            policy: {},
            noCache: true,
            concurrency: options.concurrency,
            maxSourceBytes: 0,
            // Upstream's exhaustive loop: this harness measures parity, not the budgeted mode.
            budget: 0,
            limits: { maxRequests: options.testCase.maxRequests, maxCostUsd: options.testCase.maxCostUsd },
        },
        provider: "typesafe",
        signal: controller.signal,
        evaluate,
    });
    const wallMs = Math.round(performance.now() - started);
    return {
        implementation: "port",
        status: result.status,
        wallMs,
        requests: result.counts.requests,
        inputTokens: result.counts.inputTokens ?? 0,
        costUsd: result.counts.costUsd ?? 0,
        issues: result.issues,
        ...(result.providerFailure ? { providerFailure: result.providerFailure } : {}),
        files: summarizeFiles(result.files),
        ...packetBody(renderResult(result)),
        stoppedByCost: false,
    };
}

export interface Comparison {
    sameStatus: boolean;
    sameFiles: boolean;
    sameRanking: boolean;
    sameBody: boolean;
    /** |A ∩ B| / |A ∪ B| of the returned paths. */
    jaccard: number;
    onlyUpstream: string[];
    onlyPort: string[];
    /** Largest absolute score difference over the shared paths. */
    maxScoreDelta: number;
    roleMismatches: string[];
    excerptMismatches: string[];
    requestsDeltaPct: number;
    costDeltaPct: number;
    wallDeltaPct: number;
}

function deltaPct(upstream: number, port: number): number {
    return upstream === 0 ? (port === 0 ? 0 : 100) : Math.round(((port - upstream) / upstream) * 1000) / 10;
}

export function compareRuns(upstream: RunReport, port: RunReport): Comparison {
    const upstreamFiles = new Map(upstream.files.map((file) => [file.path, file]));
    const portFiles = new Map(port.files.map((file) => [file.path, file]));
    const shared = [...upstreamFiles.keys()].filter((path) => portFiles.has(path));
    const union = new Set([...upstreamFiles.keys(), ...portFiles.keys()]);
    const pairs = shared.map((path) => [upstreamFiles.get(path)!, portFiles.get(path)!] as const);
    return {
        sameStatus: upstream.status === port.status,
        sameFiles: shared.length === union.size,
        sameRanking:
            upstream.files.map((file) => file.path).join("\n") === port.files.map((file) => file.path).join("\n"),
        sameBody: upstream.bodySha256 === port.bodySha256,
        jaccard: union.size === 0 ? 1 : Math.round((shared.length / union.size) * 1000) / 1000,
        onlyUpstream: [...upstreamFiles.keys()].filter((path) => !portFiles.has(path)),
        onlyPort: [...portFiles.keys()].filter((path) => !upstreamFiles.has(path)),
        maxScoreDelta: Math.max(0, ...pairs.map(([a, b]) => Math.abs(a.score - b.score))),
        roleMismatches: pairs.filter(([a, b]) => a.roles.join() !== b.roles.join()).map(([a]) => a.path),
        excerptMismatches: pairs.filter(([a, b]) => a.excerpts.join() !== b.excerpts.join()).map(([a]) => a.path),
        requestsDeltaPct: deltaPct(upstream.requests, port.requests),
        costDeltaPct: deltaPct(upstream.costUsd, port.costUsd),
        wallDeltaPct: deltaPct(upstream.wallMs, port.wallMs),
    };
}

export async function runComparison(options: RunOptions & { checkout: string }) {
    log.info({ case: options.testCase.id, concurrency: options.concurrency }, "Jev grep comparison started");
    const upstream = await runUpstream(options);
    const port = await runPort(options);
    const comparison = compareRuns(upstream, port);
    log.info({ case: options.testCase.id, comparison }, "Jev grep comparison finished");
    return { testCase: options.testCase, concurrency: options.concurrency, upstream, port, comparison };
}
