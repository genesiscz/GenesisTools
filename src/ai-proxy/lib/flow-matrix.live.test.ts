import { describe, expect, it } from "bun:test";
import { loadConfigFresh } from "@app/ai-proxy/lib/config";
import { buildLocalBaseUrl } from "@app/ai-proxy/lib/public-url";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * The baseline that keeps `docs/ai-proxy/FlowMatrix.md` honest.
 *
 * One trivial prompt through every inbound door, against every enabled account,
 * so a translator change that breaks one provider/door pair is caught by name
 * rather than by a user noticing weeks later.
 *
 * LIVE: it spends real upstream calls and needs `tools ai-proxy up` running, so
 * it is gated. Run it after touching anything under `lib/translators/`:
 *
 *   RUN_LIVE_SMOKE=1 bun run test src/ai-proxy/lib/flow-matrix.live.test.ts
 */

const maybe = env.test.shouldRunLiveSmoke() ? describe : describe.skip;

/** Small, deterministic, and cheap on every provider. */
const PROMPT = "Think about what is 2+2= and give me only the result";

/** Doors that carry a chat turn. /v1/models and the audio/realtime doors are out of scope. */
type Door = "chat" | "responses" | "messages";

interface Expectation {
    /** providerSlug this case exercises. */
    slug: string;
    door: Door;
    /**
     * `"answers"` — must return 200 and contain the answer.
     * `"declines"` — must fail LOUDLY; the upstream has no such API and the
     * proxy says so rather than faking one.
     */
    outcome: "answers" | "declines";
    /**
     * Required for `"declines"`: the exact status the proxy documents. Asserting
     * only `!ok` let an unrelated 404 or a 500 crash pass as a clean refusal.
     */
    status?: number;
}

const EXPECTED: Expectation[] = [
    { slug: "grok", door: "chat", outcome: "answers" },
    { slug: "grok", door: "responses", outcome: "answers" },
    { slug: "grok", door: "messages", outcome: "answers" },
    { slug: "xai", door: "chat", outcome: "answers" },
    { slug: "xai", door: "responses", outcome: "answers" },
    { slug: "xai", door: "messages", outcome: "answers" },
    { slug: "claude-sub", door: "chat", outcome: "answers" },
    // anthropic-subscription has no Responses upstream, by design.
    { slug: "claude-sub", door: "responses", outcome: "declines", status: 400 },
    { slug: "claude-sub", door: "messages", outcome: "answers" },
    { slug: "codex", door: "chat", outcome: "answers" },
    { slug: "codex", door: "responses", outcome: "answers" },
    { slug: "codex", door: "messages", outcome: "answers" },
    { slug: "openrouter", door: "chat", outcome: "answers" },
    // OpenRouter serves no Responses API and answers 501 rather than pretending.
    { slug: "openrouter", door: "responses", outcome: "declines", status: 501 },
    { slug: "openrouter", door: "messages", outcome: "answers" },
];

function pathFor(door: Door): string {
    if (door === "chat") {
        return "/v1/chat/completions";
    }

    return door === "responses" ? "/v1/responses" : "/v1/messages";
}

function bodyFor(door: Door, model: string): Record<string, unknown> {
    if (door === "responses") {
        // Reasoning upstreams spend their budget thinking; too small a cap
        // returns an empty output rather than an answer.
        return { model, max_output_tokens: 600, input: [{ role: "user", content: PROMPT }] };
    }

    return { model, max_tokens: 64, messages: [{ role: "user", content: PROMPT }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The GENERATED text only, per door. Searching the whole response body for "4"
 * matched the echoed `"model":"grok-4.6"` field, so a translator that dropped
 * the answer entirely still passed.
 */
function answerTextFrom(door: Door, body: string): string | undefined {
    try {
        const parsed = SafeJSON.parse(body, { strict: true });

        if (!isRecord(parsed)) {
            return undefined;
        }

        if (door === "chat") {
            const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
            const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
            return typeof message?.content === "string" ? message.content : undefined;
        }

        if (door === "messages") {
            if (!Array.isArray(parsed.content)) {
                return undefined;
            }

            return parsed.content
                .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
                .map((block) => (typeof block.text === "string" ? block.text : ""))
                .join("");
        }

        if (!Array.isArray(parsed.output)) {
            return undefined;
        }

        const parts: string[] = [];

        for (const item of parsed.output) {
            if (!isRecord(item) || !Array.isArray(item.content)) {
                continue;
            }

            for (const part of item.content) {
                if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
                    parts.push(part.text);
                }
            }
        }

        return parts.join("");
    } catch (err) {
        logger.debug({ err }, "flow-matrix: answer body was not parseable — treating as no answer text");
        return undefined;
    }
}

maybe("ai-proxy flow matrix (live)", () => {
    it("answers 2+2 on every supported provider/door pair", async () => {
        const config = await loadConfigFresh();
        const base = buildLocalBaseUrl(config).replace(/\/v1$/, "");
        const key = config.proxyApiKey;

        const health = await fetch(`${base}/health`).catch(() => null);
        expect(health?.ok, `ai-proxy is not answering on ${base} — run \`tools ai-proxy up\``).toBe(true);

        const models = (await (
            await fetch(`${base}/v1/models`, {
                headers: { authorization: `Bearer ${key}` },
            })
        ).json()) as { data?: { id: string }[] };

        const failures: string[] = [];
        let exercised = 0;

        for (const expectation of EXPECTED) {
            // First advertised model for this provider; the matrix is about the
            // PATH, not about any one model id staying available forever.
            const model = models.data?.find((entry) => entry.id.split("/")[1] === expectation.slug)?.id;

            if (!model) {
                // An account nobody configured is not a regression.
                continue;
            }

            const response = await fetch(`${base}${pathFor(expectation.door)}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${key}`,
                    "x-api-key": key,
                },
                body: SafeJSON.stringify(bodyFor(expectation.door, model)),
            });

            const text = await response.text();
            const label = `${expectation.slug} ${expectation.door} (${model})`;
            exercised += 1;

            if (expectation.outcome === "declines") {
                if (response.status !== expectation.status) {
                    failures.push(
                        `${label}: expected the documented ${expectation.status}, got ${response.status} ${text.slice(0, 120)}`
                    );
                }

                continue;
            }

            if (!response.ok) {
                failures.push(`${label}: HTTP ${response.status} ${text.slice(0, 120)}`);
                continue;
            }

            const answer = answerTextFrom(expectation.door, text);

            if (answer === undefined) {
                failures.push(
                    `${label}: 200 but the ${expectation.door} shape carried no text — ${text.slice(0, 120)}`
                );
                continue;
            }

            if (!answer.includes("4")) {
                failures.push(`${label}: 200 but no answer in the generated text — ${answer.slice(0, 120)}`);
            }
        }

        expect(failures).toEqual([]);
        // A sandboxed run finds no models, skips every case and passes in half a
        // second. The doc warns about it; now the test refuses it.
        expect(
            exercised,
            "no provider/door pair ran — set GENESIS_TOOLS_TEST_ALLOW_REAL_HOME=1 so the suite can see your accounts"
        ).toBeGreaterThan(0);
    }, 600_000);
});
