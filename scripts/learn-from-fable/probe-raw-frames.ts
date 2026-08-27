#!/usr/bin/env bun
/**
 * Dump SSE frames with arrival timestamps for the real judge payload, bypassing
 * the client's accumulation logic. Answers the question a hang can't otherwise
 * answer: is upstream silent, or is it sending frames we fail to interpret?
 *
 *   bun scripts/learn-from-fable/probe-raw-frames.ts <batchSize> [model] [seconds]
 */
import { readFileSync } from "node:fs";
import { loadLocalProxyConfig } from "@genesiscz/utils/ai/proxy/AiProxyClient";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { buildJudgeUser, JUDGE_SYSTEM } from "../../src/learn-from-fable/lib/stages/judge";
import type { Episode } from "../../src/learn-from-fable/lib/stages/types";
import { defaultEpisodesPath } from "./probe-episodes";

const size = Number(process.argv[2] ?? 3);
const model = process.argv[3] ?? "martin/claude-sub/claude-sonnet-5";
const limitSecs = Number(process.argv[4] ?? 90);
const path = process.argv[5] ?? defaultEpisodesPath();

const episodes: Episode[] = readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => SafeJSON.parse(line, { strict: true }) as Episode)
    .slice(0, size);

const user = buildJudgeUser(episodes.map((episode) => ({ episode, candidate: episode.referenceAction })));
const local = loadLocalProxyConfig();
const base = local.baseUrl.replace(/\/v1\/?$/, "");

out.println(`POST ${base}/v1/chat/completions model=${model} batch=${size} chars=${user.length}`);

const started = performance.now();
const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
        "content-type": "application/json",
        ...(local.apiKey ? { authorization: `Bearer ${local.apiKey}` } : {}),
    },
    body: SafeJSON.stringify({
        model,
        messages: [
            { role: "system", content: JUDGE_SYSTEM },
            { role: "user", content: user },
        ],
        max_tokens: 1860,
        stream: true,
    }),
    signal: AbortSignal.timeout(limitSecs * 1000),
});

out.println(`headers after ${((performance.now() - started) / 1000).toFixed(2)}s status=${res.status}`);

const reader = res.body?.getReader();
const decoder = new TextDecoder();
let frames = 0;
let lastAt = performance.now();

if (reader) {
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            const at = (performance.now() - started) / 1000;
            const gap = (performance.now() - lastAt) / 1000;
            lastAt = performance.now();
            const text = decoder.decode(value, { stream: true });
            frames++;

            if (frames <= 25 || frames % 25 === 0) {
                out.println(`t=${at.toFixed(2)}s (+${gap.toFixed(2)}s) ${SafeJSON.stringify(text.slice(0, 160))}`);
            }
        }
    } catch (err) {
        out.println(`stream ended after ${((performance.now() - started) / 1000).toFixed(1)}s: ${err}`);
    }
}

out.println(`frames=${frames} total=${((performance.now() - started) / 1000).toFixed(1)}s`);
