import { join } from "node:path";
import { createEvaluator, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { loadCatalogue } from "../../lib/route/cache";
import { routeUtterance } from "../../lib/route/router";
import type { JevMcpRegistry } from "../registry";

const { log } = logger.scoped("jev-route");

export const jevRouteInput = z
    .object({
        utterance: z.string().trim().min(1).max(4000).describe("What the caller wants a GenesisTools command to do"),
        src: z.string().optional().describe("Tools source directory; defaults to this checkout"),
        refresh: z.boolean().optional().describe("Rebuild the catalogue cache before routing"),
    })
    .strict();

export interface JevRouteDeps {
    /** Injected in tests; production builds one evaluator per call. */
    evaluate?: Evaluator;
    provider?: EvaluationProviderId;
    srcDir?: string;
}

function defaultSrcDir(): string {
    return join(import.meta.dir, "..", "..", "..");
}

/**
 * Register `jev_route`. It returns the same `RouteDecision` the CLI prints and NEVER executes
 * anything: the host decides whether to run the argv it gets back.
 */
export function registerJevRouteTool(registry: JevMcpRegistry, deps: JevRouteDeps = {}): void {
    registry.add({
        name: "jev_route",
        description:
            "Choose the GenesisTools command that satisfies an utterance and return its argv with each bound token traced to a span of the utterance. Read-only: it never runs the command.",
        inputSchema: jevRouteInput,
        readOnly: true,
        run: async (raw, context) => {
            const input = jevRouteInput.parse(raw);
            const srcDir = input.src ?? deps.srcDir ?? defaultSrcDir();
            log.info({ srcDir, refresh: Boolean(input.refresh) }, "jev_route called over MCP");
            const loaded = await loadCatalogue({ srcDir, refresh: input.refresh });
            const evaluate = deps.evaluate ?? (await createEvaluator({ provider: deps.provider ?? "vercel" }));
            const decision = await routeUtterance({
                utterance: input.utterance,
                catalogue: loaded.catalogue,
                evaluate,
                ...(context.signal ? { signal: context.signal } : {}),
            });
            log.info(
                { command: decision.command, status: decision.status, p: decision.p },
                "jev_route answered without executing"
            );
            return { ...decision, executed: false };
        },
    });
}
