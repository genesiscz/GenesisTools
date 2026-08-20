import { describe, expect, it } from "bun:test";
import { toAnthropicErrorResponse } from "@app/ai-proxy/lib/translators/formats/anthropic/error-envelope";
import { SafeJSON } from "@genesiscz/utils/json";

function openAiError(status: number, message: string): Response {
    return new Response(SafeJSON.stringify({ error: { message, type: "invalid_request_error", code: "bad" } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

describe("toAnthropicErrorResponse", () => {
    it("re-wraps an OpenAI envelope so an Anthropic client can read the message", async () => {
        // Claude Code checks `body.type === "error"` before reading
        // `body.error.message`; the OpenAI shape showed it a blank failure.
        const out = await toAnthropicErrorResponse(openAiError(400, "Invalid message role"));
        const body = SafeJSON.parse(await out.text(), { strict: true }) as Record<string, unknown>;

        expect(out.status).toBe(400);
        expect(body.type).toBe("error");
        expect(body.error).toEqual({ type: "invalid_request_error", message: "Invalid message role" });
    });

    it("maps the status onto Anthropic's documented error types", async () => {
        const cases: [number, string][] = [
            [401, "authentication_error"],
            [403, "permission_error"],
            [404, "not_found_error"],
            [429, "rate_limit_error"],
            [500, "api_error"],
            [529, "overloaded_error"],
        ];

        for (const [status, type] of cases) {
            const out = await toAnthropicErrorResponse(openAiError(status, "nope"));
            const body = SafeJSON.parse(await out.text(), { strict: true }) as {
                error: { type: string };
            };

            expect(body.error.type).toBe(type);
        }
    });

    it("passes an already-Anthropic error through untouched", async () => {
        const raw = '{"type":"error","error":{"type":"invalid_request_error","message":"upstream said so"}}';
        const out = await toAnthropicErrorResponse(
            new Response(raw, { status: 400, headers: { "Content-Type": "application/json" } })
        );

        expect(await out.text()).toBe(raw);
    });

    it("keeps a non-JSON body as the message rather than losing it", async () => {
        const out = await toAnthropicErrorResponse(new Response("upstream exploded", { status: 502 }));
        const body = SafeJSON.parse(await out.text(), { strict: true }) as { error: { message: string } };

        expect(body.error.message).toBe("upstream exploded");
    });

    it("strips content-encoding/length/transfer-encoding — the body is re-stringified plaintext", async () => {
        // The upstream body was compressed; ours never is (we re-stringify the
        // JSON). Relaying `content-encoding: br` verbatim on plain JSON makes
        // the client try to brotli-decode it and fail, or a stale
        // `content-length` truncates/hangs the read.
        const upstream = new Response(SafeJSON.stringify({ error: { message: "compressed upstream" } }), {
            status: 400,
            headers: {
                "Content-Type": "application/json",
                "Content-Encoding": "br",
                "Content-Length": "9999",
                "Transfer-Encoding": "chunked",
            },
        });

        const out = await toAnthropicErrorResponse(upstream);

        expect(out.headers.get("content-encoding")).toBeNull();
        expect(out.headers.get("transfer-encoding")).toBeNull();
        // Bun recomputes Content-Length from the real body it is about to send;
        // the assertion that matters is that the STALE upstream value (9999) is
        // gone, not a specific number.
        expect(out.headers.get("content-length")).not.toBe("9999");

        const body = SafeJSON.parse(await out.text(), { strict: true }) as { error: { message: string } };
        expect(body.error.message).toBe("compressed upstream");
    });

    it("also strips them on the already-Anthropic-shaped passthrough path", async () => {
        const raw = '{"type":"error","error":{"type":"invalid_request_error","message":"upstream said so"}}';
        const upstream = new Response(raw, {
            status: 400,
            headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
        });

        const out = await toAnthropicErrorResponse(upstream);

        expect(out.headers.get("content-encoding")).toBeNull();
        expect(await out.text()).toBe(raw);
    });
});
