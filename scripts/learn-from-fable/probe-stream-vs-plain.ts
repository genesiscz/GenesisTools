#!/usr/bin/env bun
/**
 * A/B the two client paths on a realistic (large) judge-sized prompt: streamed
 * vs non-streamed, per model. Streaming was adopted for observability; this
 * proves whether it changed latency or output on each provider.
 *
 *   bun scripts/learn-from-fable/probe-stream-vs-plain.ts [model...]
 */
import { AiProxyClient } from "@genesiscz/utils/ai/proxy/AiProxyClient";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

const MODELS = process.argv.slice(2);
const models = MODELS.length ? MODELS : ["martin/claude-sub/claude-sonnet-5", "martin/grok/grok-4.5"];

// ~8k chars of filler + a task with an unambiguous, checkable answer.
const filler = Array.from({ length: 120 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join(
    "\n"
);
const system = "You output ONLY strict JSON. No prose, no code fences.";
const user = `${filler}\n\nReturn a JSON array with exactly 3 objects, each {"id": <int>, "ok": true}.`;

const client = new AiProxyClient();

for (const model of models) {
    for (const mode of ["plain", "stream"] as const) {
        const started = performance.now();
        try {
            const result =
                mode === "plain"
                    ? await client.chat({
                          model,
                          messages: [
                              { role: "system", content: system },
                              { role: "user", content: user },
                          ],
                          maxTokens: 500,
                          timeoutMs: 180_000,
                      })
                    : await client.chatStream({
                          model,
                          messages: [
                              { role: "system", content: system },
                              { role: "user", content: user },
                          ],
                          maxTokens: 500,
                          timeoutMs: 180_000,
                      });

            const wall = (performance.now() - started) / 1000;
            out.println(
                `${model.padEnd(38)} ${mode.padEnd(6)} wall=${wall.toFixed(1)}s ` +
                    `chars=${result.text.length} out=${result.usage?.completionTokens ?? "?"} ` +
                    `head=${SafeJSON.stringify(result.text.slice(0, 60))}`
            );
        } catch (err) {
            const wall = (performance.now() - started) / 1000;
            out.println(`${model.padEnd(38)} ${mode.padEnd(6)} FAILED after ${wall.toFixed(1)}s: ${err}`);
        }
    }
}
