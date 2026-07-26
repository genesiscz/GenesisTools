#!/usr/bin/env bun
/**
 * Concurrency probe: fires N identical streamed prompts at the proxy at the same
 * instant and reports time-to-first-token, total time, token counts, and finish
 * reason per call — so serialization, queueing, or hidden tool turns show up.
 *
 *   bun scripts/learn-from-fable/probe-parallel-grok.ts [n] [model]
 */
import { loadLocalProxyConfig } from "@genesiscz/utils/ai/proxy/AiProxyClient";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";

const N = Number(process.argv[2] ?? 20);
const MODEL = process.argv[3] ?? "martin/grok/grok-4.5";
const local = loadLocalProxyConfig();
const BASE = process.env.AI_PROXY_URL ?? local.baseUrl;
const AUTH: Record<string, string> = local.apiKey ? { authorization: `Bearer ${local.apiKey}` } : {};
const PROMPT = "What is the meaning of life? Answer in exactly two sentences.";

interface Sample {
    i: number;
    ttftMs?: number;
    totalMs: number;
    chunks: number;
    chars: number;
    finish?: string;
    toolCalls: number;
    error?: string;
}

async function one(i: number, startedAt: number): Promise<Sample> {
    const t0 = performance.now();
    let ttftMs: number | undefined;
    let chunks = 0;
    let chars = 0;
    let finish: string | undefined;
    let toolCalls = 0;

    try {
        const res = await fetch(`${BASE.replace(/\/v1\/?$/, "")}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", ...AUTH },
            body: SafeJSON.stringify({
                model: MODEL,
                messages: [{ role: "user", content: PROMPT }],
                max_tokens: 200,
                stream: true,
            }),
        });

        if (!res.ok || !res.body) {
            return { i, totalMs: performance.now() - t0, chunks, chars, toolCalls, error: `HTTP ${res.status}` };
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            const text = decoder.decode(value, { stream: true });
            for (const line of text.split("\n")) {
                if (!line.startsWith("data: ") || line.includes("[DONE]")) {
                    continue;
                }

                let payload: {
                    choices?: { delta?: { content?: string; tool_calls?: unknown[] }; finish_reason?: string }[];
                };
                try {
                    payload = SafeJSON.parse(line.slice(6), { strict: true }) as typeof payload;
                } catch {
                    continue;
                }

                const choice = payload.choices?.[0];
                const delta = choice?.delta?.content ?? "";
                if (delta) {
                    ttftMs ??= performance.now() - t0;
                    chunks++;
                    chars += delta.length;
                }

                if (choice?.delta?.tool_calls?.length) {
                    toolCalls += choice.delta.tool_calls.length;
                }

                if (choice?.finish_reason) {
                    finish = choice.finish_reason;
                }
            }
        }

        return { i, ttftMs, totalMs: performance.now() - t0, chunks, chars, finish, toolCalls };
    } catch (err) {
        return { i, totalMs: performance.now() - t0, chunks, chars, toolCalls, error: String(err) };
    } finally {
        void startedAt;
    }
}

const p = profiler.scope("parallel");
out.println(`firing ${N} concurrent streamed calls at ${MODEL} via ${BASE}`);

const wallStart = performance.now();
const samples = await p.measureAsync("all", () => Promise.all(Array.from({ length: N }, (_, i) => one(i, wallStart))));
const wall = performance.now() - wallStart;

const ok = samples.filter((s) => !s.error);
const ttfts = ok
    .map((s) => s.ttftMs ?? Number.NaN)
    .filter((x) => !Number.isNaN(x))
    .sort((a, b) => a - b);
const totals = ok.map((s) => s.totalMs).sort((a, b) => a - b);
const pick = (xs: number[], q: number) =>
    xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * q))] : Number.NaN;
const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

for (const sample of samples.sort((a, b) => a.totalMs - b.totalMs)) {
    out.println(
        `#${String(sample.i).padStart(2)} ttft=${sample.ttftMs ? s(sample.ttftMs) : "—"} total=${s(sample.totalMs)} ` +
            `chunks=${String(sample.chunks).padStart(4)} chars=${String(sample.chars).padStart(5)} ` +
            `finish=${sample.finish ?? "—"} tools=${sample.toolCalls}${sample.error ? ` ERROR ${sample.error}` : ""}`
    );
}

out.println(
    `\nwall=${s(wall)} ok=${ok.length}/${N} · ttft p50=${s(pick(ttfts, 0.5))} p95=${s(pick(ttfts, 0.95))} ` +
        `· total p50=${s(pick(totals, 0.5))} p95=${s(pick(totals, 0.95))} ` +
        `· serial-sum=${s(totals.reduce((a, b) => a + b, 0))}`
);
p.summary("parallel probe");
