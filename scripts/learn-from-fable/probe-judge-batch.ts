#!/usr/bin/env bun
/**
 * Reproduce a single judge call with the REAL prompt (built from mined episodes)
 * at a given batch size, so batch-size-dependent hangs/drift are observable in
 * isolation instead of only inside a long filter run.
 *
 *   bun scripts/learn-from-fable/probe-judge-batch.ts <batchSize> [model]
 */
import { readFileSync } from "node:fs";
import { AiProxyClient } from "@genesiscz/utils/ai/proxy/AiProxyClient";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { buildJudgeUser, JUDGE_SYSTEM, parseJudgeArray } from "../../src/learn-from-fable/lib/stages/judge";
import type { Episode } from "../../src/learn-from-fable/lib/stages/types";
import { defaultEpisodesPath } from "./probe-episodes";

const size = Number(process.argv[2] ?? 3);
const model = process.argv[3] ?? "foltyn/claude-sub/claude-sonnet-5";
const path = process.argv[4] ?? defaultEpisodesPath();

const episodes: Episode[] = readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => SafeJSON.parse(line, { strict: true }) as Episode)
    .slice(0, size);

const items = episodes.map((episode) => ({ episode, candidate: episode.referenceAction }));
const user = buildJudgeUser(items);
const maxTokens = Number(process.argv[5] ?? 0) || 1200 + 220 * items.length;

out.println(`batch=${items.length} promptChars=${user.length} maxTokens=${maxTokens} model=${model}`);

const client = new AiProxyClient();
const started = performance.now();

try {
    const result = await client.chatStream({
        model,
        messages: [
            { role: "system", content: JUDGE_SYSTEM },
            { role: "user", content: user },
        ],
        maxTokens,
        timeoutMs: 300_000,
        tags: { session: "probe-judge", stage: "probe", label: `judge-${items.length}x` },
    });

    const wall = (performance.now() - started) / 1000;
    const verdicts = parseJudgeArray(result.text);
    out.println(
        `wall=${wall.toFixed(1)}s replyChars=${result.text.length} parsedVerdicts=${verdicts.size}/${items.length}`
    );
    out.println(`head: ${SafeJSON.stringify(result.text.slice(0, 300))}`);
    out.println(`tail: ${SafeJSON.stringify(result.text.slice(-200))}`);
} catch (err) {
    out.println(`FAILED after ${((performance.now() - started) / 1000).toFixed(1)}s: ${err}`);
}
