import { defineRoster } from "./define";

/** C31: each ai-proxy provider forwarded a single-shot request with its own fetch and its own error handling. */
export default defineRoster({
    name: "roster-provider-fetch-outside-exchange",
    candidate: "C31",
    message:
        "A provider forwards an upstream request through the one exchange in src/ai-proxy/lib/providers/http-relay.ts " +
        "(abort, timeout, debug capture, error mapping), or through the `fetch` it was given (`this.fetch`, " +
        "`input.fetch`). A bare global `fetch` here bypasses the exchange C31 built.",
    matcher: { rule: { kind: "call_expression", has: { field: "function", regex: "^fetch$" } } },
    onlyIn: /^src\/ai-proxy\/lib\/providers\//,
    allowedIn: /^src\/ai-proxy\/lib\/providers\/http-relay\.ts$/,
});
