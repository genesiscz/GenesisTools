#!/usr/bin/env bun
/**
 * Latency probe for the mine stage: runs the SAME real extractor prompt through
 * several proxy models / reasoning efforts and reports client-observed time next
 * to the proxy's own accounting, so proxy overhead is separable from upstream time.
 *
 *   PROFILE=probe bun scripts/learn-from-fable/probe-extractor-latency.ts
 */
import { AiProxyClient } from "@genesiscz/utils/ai/proxy/AiProxyClient";
import { out } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { EXTRACT_SCHEMA, EXTRACT_SYSTEM } from "../../src/learn-from-fable/lib/stages/mine";
import { condenseForExtraction, loadTurns } from "../../src/learn-from-fable/lib/transcript";

const SESSION =
    process.argv[2] ??
    `${process.env.HOME}/.claude/projects/-Users-Martin-Tresors-Projects-GenesisTools/8a4faba3-dcfd-4622-83b4-b56c7eac2451.jsonl`;

interface Probe {
    label: string;
    model: string;
    reasoningEffort?: "low" | "medium" | "high";
    maxTokens?: number;
}

const PROBES: Probe[] = [
    { label: "warmup-tiny", model: "martin/grok/grok-4-fast", maxTokens: 16 },
    { label: "grok-4.5 default", model: "martin/grok/grok-4.5" },
    { label: "grok-4.5 low-effort", model: "martin/grok/grok-4.5", reasoningEffort: "low" },
    { label: "grok-4-fast", model: "martin/grok/grok-4-fast" },
    { label: "grok-4.3", model: "martin/grok/grok-4.3" },
    { label: "sonnet-5", model: "martin/claude-sub/claude-sonnet-5" },
];

const p = profiler.scope("probe");
const client = new AiProxyClient();

const turns = await p.measureAsync("loadTurns", () => loadTurns(SESSION));
const windows = p.measure("condense", () => condenseForExtraction(turns));
const window = windows[Math.floor(windows.length / 2)] ?? "";
const user = `## FABLE-SPEC principles\n(no spec yet — bootstrap run)\n\n## Transcript turns\n${window}`;

out.println(`session turns=${turns.length} windows=${windows.length} probeWindowChars=${window.length}`);

for (const probe of PROBES) {
    const isWarmup = probe.label.startsWith("warmup");
    const started = performance.now();

    try {
        const result = await client.chat({
            model: probe.model,
            messages: [
                { role: "system", content: isWarmup ? "reply with ok" : EXTRACT_SYSTEM },
                { role: "user", content: isWarmup ? "ok" : user },
            ],
            maxTokens: probe.maxTokens ?? 3000,
            timeoutMs: 300_000,
            jsonSchema: isWarmup ? undefined : EXTRACT_SCHEMA,
            schemaMode: isWarmup ? undefined : "prompt",
            reasoningEffort: probe.reasoningEffort,
        });

        const wall = performance.now() - started;
        p.start(probe.label)();
        out.println(
            `${probe.label.padEnd(20)} wall=${(wall / 1000).toFixed(1)}s ` +
                `proxy=${(result.elapsedMs / 1000).toFixed(1)}s ` +
                `overhead=${((wall - result.elapsedMs) / 1000).toFixed(2)}s ` +
                `in=${result.usage?.prompt_tokens ?? "?"} out=${result.usage?.completion_tokens ?? "?"} ` +
                `parsed=${result.parsed ? "yes" : `no (${result.parseError ?? "-"})`}`
        );
    } catch (err) {
        out.println(
            `${probe.label.padEnd(20)} FAILED after ${((performance.now() - started) / 1000).toFixed(1)}s: ${err}`
        );
    }
}

p.summary("extractor probes");
