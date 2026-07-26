/**
 * How big a prompt can claude-sub actually answer through the proxy?
 *
 * opus-5 answers 2k-token consolidate votes fine, stalls on ~6k-token judge
 * prompts, and produced ZERO bytes in 600s on the 38k-token spec prompt. If the
 * ceiling is real and low, the spec stage cannot run on claude-sub at any useful
 * batch size and the recommendation has to say so.
 *
 * Usage: bun scripts/learn-from-fable/probe-prompt-size-ceiling.ts [model]
 */
import { AiProxyClient } from "@genesiscz/utils/ai/proxy/AiProxyClient";

const model = process.argv[2] ?? "olivia/claude-sub/claude-opus-5";
/** Approximate prompt sizes in tokens (4 chars ~ 1 token). */
const SIZES = [2_000, 6_000, 12_000, 24_000];
const BUDGET_MS = 180_000;

const client = new AiProxyClient();

// Filler that reads like the real thing: numbered principle-ish lines.
function fillerOfTokens(tokens: number): string {
    const line =
        "1. [unvetted] Verify the premise before accepting the bug frame\n   why: because the report is a claim\n";
    return line.repeat(Math.ceil((tokens * 4) / line.length));
}

for (const tokens of SIZES) {
    const started = performance.now();
    try {
        const r = await client.chatStream({
            model,
            messages: [
                { role: "system", content: "You summarise lists of engineering principles." },
                {
                    role: "user",
                    content: `Reply with ONE sentence naming the single most common theme below.\n\n${fillerOfTokens(tokens)}`,
                },
            ],
            maxTokens: 200,
            timeoutMs: BUDGET_MS,
            tags: { session: "probe-size", stage: "probe", label: `${tokens}tok` },
        });
        const chars = r.text.trim().length;
        process.stdout.write(
            `~${String(tokens).padStart(6)} tok prompt -> ${chars > 0 ? "OK" : "EMPTY"} ` +
                `${chars} chars in ${Math.round((performance.now() - started) / 1000)}s\n`
        );
    } catch (err) {
        process.stdout.write(
            `~${String(tokens).padStart(6)} tok prompt -> FAILED after ` +
                `${Math.round((performance.now() - started) / 1000)}s: ${err instanceof Error ? err.message : String(err)}\n`
        );
    }
}

process.exit(0);
