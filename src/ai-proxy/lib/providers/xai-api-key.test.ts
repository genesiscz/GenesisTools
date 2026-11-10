import { afterEach, describe, expect, it } from "bun:test";
import { resetWhamItemStore } from "@app/ai-proxy/lib/providers/wham-item-store";
import { XaiApiKeyProvider } from "@app/ai-proxy/lib/providers/xai-api-key";
import { resolveXaiApiKey } from "@app/ai-proxy/lib/providers/xai-api-key-auth";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

const account: AiProxyAccountConfig = {
    name: "work",
    provider: "xai-api-key",
    providerSlug: "xai",
    enabled: true,
    apiKeyEnv: "XAI_API_KEY",
};

describe("resolveXaiApiKey", () => {
    it("reads the env var named in account.apiKeyEnv", () => {
        env.testing.set("XAI_API_KEY", "test-key-from-named");
        env.testing.unset("X_AI_API_KEY");

        try {
            expect(resolveXaiApiKey(account)).toEqual({ key: "test-key-from-named", source: "configEnv" });
        } finally {
            env.testing.unset("XAI_API_KEY");
        }
    });

    it("falls back to standard xAI aliases when named env is empty", () => {
        env.testing.unset("XAI_API_KEY");
        env.testing.set("X_AI_API_KEY", "legacy-alias-key");

        try {
            expect(resolveXaiApiKey({ ...account, apiKeyEnv: "XAI_API_KEY" })).toEqual({
                key: "legacy-alias-key",
                source: "defaultEnv",
            });
        } finally {
            env.testing.unset("X_AI_API_KEY");
        }
    });

    it("prefers the key stored on the account over any environment variable", () => {
        env.testing.set("XAI_API_KEY", "env-key");
        env.testing.set("X_AI_API_KEY", "alias-key");

        try {
            expect(resolveXaiApiKey({ ...account, apiKey: "config-key" })).toEqual({
                key: "config-key",
                source: "config",
            });
        } finally {
            env.testing.unset("XAI_API_KEY");
            env.testing.unset("X_AI_API_KEY");
        }
    });

    it("returns undefined when neither config nor env carries a key", () => {
        env.testing.unset("XAI_API_KEY");
        env.testing.unset("X_AI_API_KEY");

        expect(resolveXaiApiKey(account)).toBeUndefined();
    });
});

describe("XaiApiKeyProvider.responses item_reference chaining", () => {
    afterEach(() => {
        resetWhamItemStore();
    });

    const call = { id: "fc_1", type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" };

    it("inlines turn-1 output items where turn 2 sends item_reference pointers", async () => {
        const seen: Array<Record<string, unknown>> = [];
        const envelope = SafeJSON.stringify({ id: "resp_1", object: "response", output: [call] });
        const provider = new XaiApiKeyProvider(account, "xai-test", async (_input, init) => {
            seen.push(SafeJSON.parse(String(init?.body), { strict: true }) as Record<string, unknown>);
            return new Response(envelope, { headers: { "content-type": "application/json" } });
        });
        const send = (input: unknown[]) => {
            const body = SafeJSON.stringify({ model: "work/xai/grok-4.6", input });

            return provider.responses(
                new Request("http://proxy/v1/responses", { method: "POST", body }),
                "grok-4.6",
                body
            );
        };

        const first = await send([{ role: "user", content: "weather?" }]);
        expect(await first.text()).toBe(envelope);

        await send([
            { type: "item_reference", id: "fc_1" },
            { type: "function_call_output", call_id: "call_1", output: "sunny" },
        ]);

        expect(seen).toHaveLength(2);
        expect(seen[1].model).toBe("grok-4.6");
        expect(seen[1].input).toEqual([call, { type: "function_call_output", call_id: "call_1", output: "sunny" }]);
    });
});

describe("XaiApiKeyProvider.audioTranscriptions", () => {
    /** xAI's /stt takes no model field and wants `file` appended last. */
    it("sends /stt without the model and with the file last", async () => {
        const sent: Array<{ url: string; form: FormData | undefined }> = [];
        const provider = new XaiApiKeyProvider(account, "xai-test", async (input, init) => {
            sent.push({ url: String(input), form: init?.body instanceof FormData ? init.body : undefined });
            return new Response(SafeJSON.stringify({ text: "hello" }), {
                headers: { "content-type": "application/json" },
            });
        });
        const form = new FormData();
        form.append("file", new File(["abc"], "clip.wav"));
        form.append("model", "work/xai/grok-stt");
        form.append("language", "en");

        const response = await provider.audioTranscriptions(
            new Request("http://proxy/v1/audio/transcriptions", { method: "POST" }),
            "grok-stt",
            form
        );

        expect(response.status).toBe(200);
        expect(sent[0].url).toBe("https://api.x.ai/v1/stt");
        expect([...(sent[0].form?.keys() ?? [])]).toEqual(["language", "file"]);
    });
});
