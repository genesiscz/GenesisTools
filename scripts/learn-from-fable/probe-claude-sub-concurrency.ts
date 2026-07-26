/**
 * Are claude-sub's silent stalls caused by CONCURRENCY, or independent of it?
 *
 * The filter runs ~18 calls in flight against one subscription account and about
 * a quarter of them never emit a byte. If that is a concurrency ceiling, running
 * wider makes it worse and running narrower fixes it; if the stall rate is flat
 * across widths, it is upstream flakiness and the answer is retries, not tuning.
 *
 * Usage: bun scripts/learn-from-fable/probe-claude-sub-concurrency.ts [model]
 */
import { AiProxyClient } from "@genesiscz/utils/ai/proxy/AiProxyClient";

const model = process.argv[2] ?? "olivia/claude-sub/claude-sonnet-5";
const WIDTHS = (process.argv[3] ?? "4,12").split(",").map(Number);
const CALLS_PER_WIDTH = 12;
const BUDGET_MS = 45_000;

const client = new AiProxyClient();

interface Outcome {
    ok: boolean;
    ms: number;
    chars: number;
}

async function one(width: number, index: number): Promise<Outcome> {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("budget")), BUDGET_MS);
    try {
        const r = await client.chatStream({
            model,
            // varied so nothing is served from a cache
            messages: [{ role: "user", content: `In one short sentence, why does step ${index} of a build matter?` }],
            maxTokens: 120,
            timeoutMs: BUDGET_MS,
            signal: controller.signal,
            tags: { session: "probe-cc", stage: "probe", label: `w${width}-${index}` },
        });
        const chars = r.text.trim().length;
        return { ok: chars > 0, ms: Math.round(performance.now() - started), chars };
    } catch {
        return { ok: false, ms: Math.round(performance.now() - started), chars: 0 };
    } finally {
        clearTimeout(timer);
    }
}

for (const width of WIDTHS) {
    const started = performance.now();
    const results: Outcome[] = [];
    let next = 0;
    const workers = Array.from({ length: width }, async () => {
        while (next < CALLS_PER_WIDTH) {
            const index = next++;
            results.push(await one(width, index));
        }
    });
    await Promise.all(workers);

    const ok = results.filter((r) => r.ok);
    const dead = results.filter((r) => !r.ok);
    const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
    const median = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
    process.stdout.write(
        `width=${String(width).padStart(2)}  ok=${ok.length}/${results.length}  ` +
            `silent=${dead.length}  medianOk=${median}ms  wall=${Math.round(performance.now() - started)}ms\n`
    );
}

process.exit(0);
