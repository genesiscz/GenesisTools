import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { type CallTarget, coreChat } from "./call";

/**
 * A streamed call whose request is refused used to end with "No output generated. Check the
 * stream for errors." while the SDK printed the raw error to stderr: the real cause sat in an
 * `error` part nobody read. Fourteen minutes of `tools claude warmup` output on 2026-10-16 showed
 * six accounts failing with that one line, each for a different reason.
 */

function refusal(statusCode: number, message: string): APICallError {
    return new APICallError({
        message,
        url: "https://api.example.test/v1/messages",
        requestBodyValues: {},
        statusCode,
        isRetryable: statusCode === 429,
    });
}

function target(doStream: MockLanguageModelV4["doStream"]): CallTarget {
    return {
        model: new MockLanguageModelV4({ doStream }) as unknown as LanguageModel,
        providerType: "anthropic",
        label: "work/claude-haiku-5-5",
        accountId: "acc_work",
        provider: "anthropic-sub",
        modelId: "claude-haiku-5-5",
        app: "warmup",
    };
}

beforeEach(() => {
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "gt-core-stream-error-")));
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
});

describe("coreChat streaming errors", () => {
    test("rejects with the provider's own error and prints nothing to stderr", async () => {
        const error = refusal(403, "organization does not allow this");
        const printed = spyOn(console, "error").mockImplementation(() => {});

        try {
            const outcome = await coreChat({
                target: target(async () => {
                    throw error;
                }),
                prompt: "hi",
                stream: true,
                onChunk: () => {},
            }).then(
                () => undefined,
                (caught: unknown) => caught
            );

            expect(outcome).toBe(error);
            expect(printed).not.toHaveBeenCalled();
        } finally {
            printed.mockRestore();
        }
    });

    test("rejects the provider error after a stream has already produced text", async () => {
        const error = refusal(403, "fixture stream refused after starting");
        const chunks: string[] = [];
        const outcome = await coreChat({
            target: target(async () => ({
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({ type: "stream-start", warnings: [] });
                        controller.enqueue({ type: "text-start", id: "part" });
                        controller.enqueue({ type: "text-delta", id: "part", delta: "before error" });
                        controller.enqueue({ type: "error", error });
                        controller.close();
                    },
                }),
            })),
            prompt: "hi",
            stream: true,
            onChunk: (chunk) => {
                chunks.push(chunk);
            },
        }).then(
            () => undefined,
            (caught: unknown) => caught
        );
        expect(chunks.join("")).toBe("before error");
        expect(outcome).toBe(error);
    });

    test("maxRetries: 0 asks a retryable refusal once", async () => {
        let asked = 0;

        const outcome = await coreChat({
            target: target(async () => {
                asked += 1;
                throw refusal(429, "rate limited");
            }),
            prompt: "hi",
            stream: true,
            maxRetries: 0,
            onChunk: () => {},
        }).then(
            () => undefined,
            (caught: unknown) => caught
        );

        expect(APICallError.isInstance(outcome)).toBe(true);
        expect(asked).toBe(1);
    });
});
