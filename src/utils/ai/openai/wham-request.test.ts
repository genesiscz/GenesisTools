import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { toWhamRequest } from "./wham-request";

const URL = "https://chatgpt.com/backend-api/wham/responses";

function bodyOf(init: RequestInit): Record<string, unknown> {
    return SafeJSON.parse(String(init.body), { strict: true }) as Record<string, unknown>;
}

describe("toWhamRequest", () => {
    test("forces stream and store, adds the encrypted-reasoning include, drops what WHAM rejects", async () => {
        const out = await toWhamRequest(URL, {
            method: "POST",
            body: SafeJSON.stringify({
                model: "gpt-5.4-mini",
                input: [{ role: "user", content: "hi" }],
                max_output_tokens: 5,
                temperature: 0.2,
                top_p: 1,
                previous_response_id: "resp_1",
                store: true,
            }),
        });

        expect(bodyOf(out)).toEqual({
            model: "gpt-5.4-mini",
            input: [{ role: "user", content: "hi" }],
            stream: true,
            store: false,
            include: ["reasoning.encrypted_content"],
        });
        const headers = new Headers(out.headers);
        expect(headers.get("OpenAI-Beta")).toBe("responses=experimental");
        expect(headers.get("originator")).toBe("codex_cli_rs");
        expect(headers.get("Accept")).toBe("text/event-stream");
        expect(headers.get("session_id")).toMatch(/^[0-9a-f-]{36}$/);
    });

    test("keeps an existing include list and does not duplicate the reasoning entry", async () => {
        const out = await toWhamRequest(URL, {
            body: SafeJSON.stringify({ model: "m", input: [], include: ["reasoning.encrypted_content", "x"] }),
        });
        expect(bodyOf(out).include).toEqual(["reasoning.encrypted_content", "x"]);
    });

    test("leaves non-responses calls and non-JSON bodies alone, headers aside", async () => {
        const models = await toWhamRequest("https://chatgpt.com/backend-api/wham/models", { method: "GET" });
        expect(models.body).toBeUndefined();
        expect(new Headers(models.headers).get("originator")).toBe("codex_cli_rs");

        const raw = await toWhamRequest(URL, { body: "not json" });
        expect(raw.body).toBe("not json");
    });
});
// The SDK sends `(url, init)`, but a caller that builds a `Request` first must keep
// its Content-Type and body: headers built from `undefined` dropped both.
test("reads headers and body from a Request input when init does not override them", async () => {
    const request = new Request(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ model: "m", input: [], temperature: 1 }),
    });
    const out = await toWhamRequest(request);

    expect(new Headers(out.headers).get("Content-Type")).toBe("application/json");
    expect(bodyOf(out)).toMatchObject({ model: "m", stream: true, store: false });
    expect(bodyOf(out).temperature).toBeUndefined();

    const overridden = await toWhamRequest(request, { body: SafeJSON.stringify({ model: "n", input: [] }) });
    expect(bodyOf(overridden).model).toBe("n");
});
