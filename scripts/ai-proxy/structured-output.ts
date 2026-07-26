/**
 * Probe: does the ai-proxy deliver schema-shaped output per provider?
 *
 * For each model (args, default: grok-4.5 + sonnet) runs the same tiny task in
 * both schema modes ("response_format" native, "prompt" injected) and reports
 * whether the reply parsed against the expectation, plus the usage the proxy
 * returned AND the last matching record in usage/requests.jsonl (proving the
 * proxy recorded metrics for the call).
 *
 * Usage: bun scripts/ai-proxy/structured-output.ts [model...]
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AiProxyClient, type SchemaMode } from "@genesiscz/utils/ai/proxy/AiProxyClient";
import { SafeJSON } from "@genesiscz/utils/json";

const SCHEMA = {
    name: "fruit_pick",
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["fruit", "confidence", "reason"],
        properties: {
            fruit: { type: "string", enum: ["apple", "banana", "cherry"] },
            confidence: { type: "number", minimum: 0, maximum: 100 },
            reason: { type: "string" },
        },
    },
};

const PROMPT = "Pick the fruit that is a berry botanically-speaking from: apple, banana, cherry.";

function lastUsageRecord(model: string): unknown {
    const path = join(homedir(), ".genesis-tools", "ai-proxy", "usage", "requests.jsonl");
    if (!existsSync(path)) {
        return "NO requests.jsonl";
    }

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const row = SafeJSON.parse(lines[i], { strict: true }) as { proxyModel?: string };
            if (row.proxyModel === model || row.proxyModel?.endsWith(`/${model}`)) {
                return row;
            }
        } catch {
            // skip
        }
    }

    return "NO record for model";
}

const models = process.argv.slice(2).length ? process.argv.slice(2) : ["grok-4.5", "sonnet"];
const client = new AiProxyClient();
let failures = 0;

if (!(await client.health())) {
    console.error("ai-proxy is DOWN (start: tools ai-proxy up)");
    process.exit(1);
}

for (const model of models) {
    for (const mode of ["response_format", "prompt"] as SchemaMode[]) {
        const label = `${model} [${mode}]`;
        try {
            const res = await client.chat({
                model,
                messages: [{ role: "user", content: PROMPT }],
                jsonSchema: SCHEMA,
                schemaMode: mode,
                maxTokens: 2000,
                timeoutMs: 120_000,
            });
            const ok = res.parsed && typeof res.parsed === "object" && (res.parsed as { fruit?: string }).fruit;
            console.log(
                `${ok ? "✅" : "❌"} ${label} ${res.elapsedMs}ms usage=${SafeJSON.stringify(res.usage ?? null)} ` +
                    `parsed=${SafeJSON.stringify(res.parsed ?? null)} parseError=${res.parseError ?? "none"}`
            );

            if (!ok) {
                failures++;
                console.log(`   raw text: ${res.text.slice(0, 200)}`);
            }
        } catch (err) {
            failures++;
            console.log(`💥 ${label} ${err instanceof Error ? err.message.slice(0, 300) : err}`);
        }
    }

    console.log(`   usage record: ${SafeJSON.stringify(lastUsageRecord(model))}`);
}

process.exit(failures ? 1 : 0);
