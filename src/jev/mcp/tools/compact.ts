import { type CompactResult, compactSession, parseCompactSource } from "@genesiscz/utils/ai/compact";
import { createEvaluator, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const log = logger.child({ component: "jev:mcp:compact" });

export const JEV_COMPACT_DESCRIPTION = [
    "Shrink an agent transcript by keeping, truncating or dropping TOOL RESULTS only.",
    "User and assistant text is never rewritten. A drop never orphans a tool_result.",
    "Accepts generic JSONL, Anthropic-block JSONL, a JSON array, or a native Claude/Codex/Grok",
    "transcript file (source claude|codex|grok). Output is always generic JSONL.",
].join(" ");

export const jevCompactInputSchema = z.object({
    text: z.string().min(1).optional().describe("The transcript itself. Either this or `file` is required."),
    file: z.string().min(1).optional().describe("Path to the transcript. Required for a native source."),
    source: z.enum(["auto", "jsonl", "claude", "codex", "grok"]).optional().describe("Defaults to auto-detection."),
    keep: z.number().min(0).max(1).optional().describe("Target share of the input to keep. Default 0.5."),
    pin: z.number().int().min(0).optional().describe("Trailing messages protected from a drop. Default 6."),
    maxResult: z.number().int().min(1).optional().describe("Head characters kept on a truncated result. Default 800."),
    threshold: z.number().min(0).max(1).optional().describe("Minimum reduction to accept. Default 0.25."),
    llm: z.boolean().optional().describe("Let Jev replace the per-call verdicts. Costs one request per 20 calls."),
    summaries: z.boolean().optional().describe("With llm: summarize truncated results behind a faithfulness gate."),
});

export type JevCompactArgs = z.infer<typeof jevCompactInputSchema>;

export async function handleJevCompact(
    args: JevCompactArgs,
    signal?: AbortSignal,
    evaluate?: Evaluator
): Promise<CompactResult> {
    const parsed = jevCompactInputSchema.parse(args);
    if (!parsed.text && !parsed.file) {
        throw new Error("jev_compact needs either `text` or `file`.");
    }

    const text = parsed.text ?? (await Bun.file(parsed.file ?? "").text());
    log.info({ file: parsed.file, chars: text.length, llm: parsed.llm === true }, "jev_compact called");
    return compactSession({
        text,
        filePath: parsed.file,
        source: parseCompactSource(parsed.source),
        keep: parsed.keep,
        pin: parsed.pin,
        maxResult: parsed.maxResult,
        threshold: parsed.threshold,
        llm: parsed.llm,
        summaries: parsed.summaries,
        evaluate: parsed.llm ? (evaluate ?? (await createEvaluator({}))) : undefined,
        signal,
    });
}

/**
 * Registered by `src/jev/mcp/server.ts` (owned by the route package). The descriptor carries no
 * logic: the handler calls the same `compactSession` the CLI calls, so the MCP door and the CLI
 * door can never answer the same question differently.
 */
export const jevCompactTool = {
    name: "jev_compact",
    description: JEV_COMPACT_DESCRIPTION,
} as const;
